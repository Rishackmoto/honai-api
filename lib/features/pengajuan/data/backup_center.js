'use strict';

const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { sql, getPool } = require('../../../core/network/db');
const {
  uploadToB2,
  listB2Objects,
  copyB2Object,
  getB2ObjectBuffer,
  deleteBackupObjectFromB2,
  deleteBackupPrefixFromB2,
} = require('../../../core/storage/backblaze');
const { loadParameterActor, requirePlatformSuperAdmin } = require('./parameter_access_guard');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const router = express.Router();
let schemaReady = false;
let backupRunning = false;
const RETENTION_COUNT = Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION_COUNT || '7', 10) || 7);
const ASSET_PREFIXES = ['pengajuan/', 'profile/', 'tenant-branding/'];

async function ensureSchema(pool) {
  if (schemaReady) return;
  await pool.request().query(`
    IF OBJECT_ID('dbo.backup_history', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.backup_history (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        backup_type VARCHAR(40) NOT NULL,
        scope_code VARCHAR(30) NOT NULL CONSTRAINT DF_backup_scope DEFAULT 'ALL',
        status VARCHAR(20) NOT NULL,
        file_key NVARCHAR(600) NULL,
        file_size_bytes BIGINT NULL,
        sha256 VARCHAR(64) NULL,
        table_count INT NULL,
        row_count BIGINT NULL,
        started_at DATETIME2 NOT NULL CONSTRAINT DF_backup_started DEFAULT SYSDATETIME(),
        finished_at DATETIME2 NULL,
        created_by VARCHAR(30) NULL,
        error_message NVARCHAR(2000) NULL
      );
    END;

    IF COL_LENGTH('dbo.backup_history','manifest_key') IS NULL ALTER TABLE dbo.backup_history ADD manifest_key NVARCHAR(600) NULL;
    IF COL_LENGTH('dbo.backup_history','manifest_sha256') IS NULL ALTER TABLE dbo.backup_history ADD manifest_sha256 VARCHAR(64) NULL;
    IF COL_LENGTH('dbo.backup_history','attachment_prefix') IS NULL ALTER TABLE dbo.backup_history ADD attachment_prefix NVARCHAR(600) NULL;
    IF COL_LENGTH('dbo.backup_history','attachment_count') IS NULL ALTER TABLE dbo.backup_history ADD attachment_count INT NULL;
    IF COL_LENGTH('dbo.backup_history','attachment_bytes') IS NULL ALTER TABLE dbo.backup_history ADD attachment_bytes BIGINT NULL;
    IF COL_LENGTH('dbo.backup_history','verification_status') IS NULL ALTER TABLE dbo.backup_history ADD verification_status VARCHAR(20) NULL;
    IF COL_LENGTH('dbo.backup_history','verified_at') IS NULL ALTER TABLE dbo.backup_history ADD verified_at DATETIME2 NULL;
    IF COL_LENGTH('dbo.backup_history','verification_message') IS NULL ALTER TABLE dbo.backup_history ADD verification_message NVARCHAR(1200) NULL;
    IF COL_LENGTH('dbo.backup_history','retention_status') IS NULL ALTER TABLE dbo.backup_history ADD retention_status VARCHAR(20) NULL;
    IF COL_LENGTH('dbo.backup_history','purged_at') IS NULL ALTER TABLE dbo.backup_history ADD purged_at DATETIME2 NULL;

    UPDATE dbo.backup_history SET retention_status='ACTIVE' WHERE retention_status IS NULL AND status='SUCCESS';
    UPDATE dbo.backup_history SET verification_status='NOT_VERIFIED' WHERE verification_status IS NULL AND status='SUCCESS';

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_backup_history_started' AND object_id=OBJECT_ID('dbo.backup_history'))
      CREATE INDEX IX_backup_history_started ON dbo.backup_history(started_at DESC);
  `);
  schemaReady = true;
}

function qname(value) {
  return `[${String(value || '').replace(/]/g, ']]')}]`;
}

async function buildLogicalSnapshot(pool) {
  const tablesResult = await pool.request().query(`
    SELECT s.name AS schema_name, t.name AS table_name
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id=t.schema_id
    WHERE t.is_ms_shipped=0
      AND NOT (s.name='dbo' AND t.name='backup_history')
    ORDER BY s.name, t.name;
  `);

  const tables = [];
  let totalRows = 0;
  for (const row of tablesResult.recordset || []) {
    const schema = String(row.schema_name);
    const table = String(row.table_name);
    const columns = await pool.request()
      .input('schema_name', sql.NVarChar(128), schema)
      .input('table_name', sql.NVarChar(128), table)
      .query(`
        SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type,
               CHARACTER_MAXIMUM_LENGTH AS max_length,
               NUMERIC_PRECISION AS numeric_precision,
               NUMERIC_SCALE AS numeric_scale,
               IS_NULLABLE AS is_nullable,
               ORDINAL_POSITION AS ordinal_position
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME=@table_name
        ORDER BY ORDINAL_POSITION;
      `);
    const data = await pool.request().query(`SELECT * FROM ${qname(schema)}.${qname(table)};`);
    const rows = data.recordset || [];
    totalRows += rows.length;
    tables.push({ schema, table, columns: columns.recordset || [], rows });
  }

  return {
    format: 'HONAI_LOGICAL_BACKUP_V2',
    generated_at: new Date().toISOString(),
    database: process.env.DB_DATABASE || null,
    table_count: tables.length,
    row_count: totalRows,
    tables,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, runner));
  return results;
}

async function backupAttachments(backupId, stamp) {
  const sourceObjects = [];
  for (const prefix of ASSET_PREFIXES) {
    const rows = await listB2Objects(prefix);
    sourceObjects.push(...rows.filter((row) => row.key && !row.key.startsWith('backup/')));
  }

  const backupPrefix = `backup/attachments/${stamp}-${backupId}/`;
  const copied = await mapLimit(sourceObjects, 6, async (item) => {
    const destinationKey = `${backupPrefix}${item.key}`;
    await copyB2Object(item.key, destinationKey);
    return {
      source_key: item.key,
      backup_key: destinationKey,
      size: Number(item.size || 0),
      etag: item.etag || null,
      last_modified: item.lastModified || null,
    };
  });

  const manifest = {
    format: 'HONAI_ATTACHMENT_BACKUP_MANIFEST_V1',
    generated_at: new Date().toISOString(),
    backup_id: backupId,
    attachment_prefix: backupPrefix,
    attachment_count: copied.length,
    attachment_bytes: copied.reduce((sum, row) => sum + Number(row.size || 0), 0),
    items: copied,
  };
  const manifestRaw = Buffer.from(JSON.stringify(manifest), 'utf8');
  const manifestCompressed = await gzip(manifestRaw, { level: 9 });
  const manifestSha = crypto.createHash('sha256').update(manifestCompressed).digest('hex');
  const manifestKey = `backup/manifests/honai-files-${stamp}-${backupId}.json.gz`;
  await uploadToB2({ key: manifestKey, buffer: manifestCompressed, contentType: 'application/gzip' });

  return {
    attachmentPrefix: backupPrefix,
    attachmentCount: manifest.attachment_count,
    attachmentBytes: manifest.attachment_bytes,
    manifestKey,
    manifestSha256: manifestSha,
  };
}

async function purgeBackupArtifacts(row) {
  if (row.file_key) await deleteBackupObjectFromB2(row.file_key).catch(() => false);
  if (row.manifest_key) await deleteBackupObjectFromB2(row.manifest_key).catch(() => false);
  if (row.attachment_prefix) await deleteBackupPrefixFromB2(row.attachment_prefix).catch(() => 0);
}

async function enforceRetention(pool) {
  const result = await pool.request().input('keep', sql.Int, RETENTION_COUNT).query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn
      FROM dbo.backup_history
      WHERE status='SUCCESS' AND ISNULL(retention_status,'ACTIVE')='ACTIVE'
    )
    SELECT h.id, h.file_key, h.manifest_key, h.attachment_prefix
    FROM dbo.backup_history h
    JOIN ranked r ON r.id=h.id
    WHERE r.rn > @keep
    ORDER BY h.id ASC;
  `);
  for (const row of result.recordset || []) {
    await purgeBackupArtifacts(row);
    await pool.request().input('id', sql.BigInt, row.id).query(`
      UPDATE dbo.backup_history
      SET retention_status='PURGED', purged_at=SYSDATETIME(),
          verification_status=CASE WHEN verification_status='VERIFIED' THEN verification_status ELSE 'PURGED' END
      WHERE id=@id;
    `);
  }
}

async function verifyBackupById(pool, id) {
  const result = await pool.request().input('id', sql.BigInt, id).query(`
    SELECT TOP 1 * FROM dbo.backup_history WHERE id=@id;
  `);
  const row = result.recordset?.[0];
  if (!row) throw Object.assign(new Error('Backup tidak ditemukan.'), { statusCode: 404 });
  if (row.status !== 'SUCCESS') throw Object.assign(new Error('Hanya backup yang berhasil yang dapat diverifikasi.'), { statusCode: 400 });
  if ((row.retention_status || 'ACTIVE') === 'PURGED') throw Object.assign(new Error('Backup ini sudah dihapus sesuai kebijakan retensi.'), { statusCode: 410 });

  try {
    if (!row.file_key || !row.sha256) throw new Error('Metadata backup database tidak lengkap.');
    const db = await getB2ObjectBuffer(row.file_key);
    const dbHash = crypto.createHash('sha256').update(db.buffer).digest('hex');
    if (dbHash !== row.sha256) throw new Error('Checksum database tidak cocok.');
    const snapshotRaw = await gunzip(db.buffer);
    const snapshot = JSON.parse(snapshotRaw.toString('utf8'));
    if (!snapshot || !Array.isArray(snapshot.tables)) throw new Error('Isi backup database tidak dapat dibaca.');

    let attachmentMessage = 'Tidak ada lampiran pada backup ini.';
    if (row.manifest_key && row.manifest_sha256) {
      const mf = await getB2ObjectBuffer(row.manifest_key);
      const mfHash = crypto.createHash('sha256').update(mf.buffer).digest('hex');
      if (mfHash !== row.manifest_sha256) throw new Error('Checksum manifest lampiran tidak cocok.');
      const manifestRaw = await gunzip(mf.buffer);
      const manifest = JSON.parse(manifestRaw.toString('utf8'));
      const stored = await listB2Objects(row.attachment_prefix || manifest.attachment_prefix || '');
      const sizeMap = new Map(stored.map((x) => [x.key, Number(x.size || 0)]));
      const missing = [];
      for (const item of manifest.items || []) {
        if (!sizeMap.has(item.backup_key) || sizeMap.get(item.backup_key) !== Number(item.size || 0)) {
          missing.push(item.backup_key);
          if (missing.length >= 10) break;
        }
      }
      if (missing.length) throw new Error(`Ada lampiran backup yang hilang atau ukuran berubah (${missing.length}+).`);
      if (stored.length !== Number(manifest.attachment_count || 0)) {
        throw new Error(`Jumlah lampiran tidak cocok. Tercatat ${manifest.attachment_count || 0}, ditemukan ${stored.length}.`);
      }
      attachmentMessage = `${stored.length} lampiran terverifikasi.`;
    }

    const message = `Backup valid. ${snapshot.table_count || 0} tabel, ${snapshot.row_count || 0} baris. ${attachmentMessage}`;
    await pool.request()
      .input('id', sql.BigInt, id)
      .input('message', sql.NVarChar(1200), message)
      .query(`UPDATE dbo.backup_history SET verification_status='VERIFIED', verified_at=SYSDATETIME(), verification_message=@message WHERE id=@id;`);
    return { id, valid: true, message };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1100);
    await pool.request()
      .input('id', sql.BigInt, id)
      .input('message', sql.NVarChar(1200), message)
      .query(`UPDATE dbo.backup_history SET verification_status='FAILED', verified_at=SYSDATETIME(), verification_message=@message WHERE id=@id;`);
    throw error;
  }
}

async function createBackup(pool, actor) {
  const insert = await pool.request()
    .input('created_by', sql.VarChar(30), actor.userid)
    .query(`
      INSERT INTO dbo.backup_history (backup_type, scope_code, status, created_by, retention_status, verification_status)
      OUTPUT INSERTED.id
      VALUES ('FULL_LOGICAL', 'ALL', 'RUNNING', @created_by, 'ACTIVE', 'NOT_VERIFIED');
    `);
  const id = Number(insert.recordset?.[0]?.id);

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshot = await buildLogicalSnapshot(pool);
    const raw = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const compressed = await gzip(raw, { level: 9 });
    const sha256 = crypto.createHash('sha256').update(compressed).digest('hex');
    const key = `backup/database/honai-${stamp}-${id}.json.gz`;
    await uploadToB2({ key, buffer: compressed, contentType: 'application/gzip' });

    const attachments = await backupAttachments(id, stamp);

    await pool.request()
      .input('id', sql.BigInt, id)
      .input('file_key', sql.NVarChar(600), key)
      .input('file_size_bytes', sql.BigInt, compressed.length)
      .input('sha256', sql.VarChar(64), sha256)
      .input('table_count', sql.Int, snapshot.table_count)
      .input('row_count', sql.BigInt, snapshot.row_count)
      .input('manifest_key', sql.NVarChar(600), attachments.manifestKey)
      .input('manifest_sha256', sql.VarChar(64), attachments.manifestSha256)
      .input('attachment_prefix', sql.NVarChar(600), attachments.attachmentPrefix)
      .input('attachment_count', sql.Int, attachments.attachmentCount)
      .input('attachment_bytes', sql.BigInt, attachments.attachmentBytes)
      .query(`
        UPDATE dbo.backup_history
        SET status='SUCCESS', file_key=@file_key, file_size_bytes=@file_size_bytes,
            sha256=@sha256, table_count=@table_count, row_count=@row_count,
            manifest_key=@manifest_key, manifest_sha256=@manifest_sha256,
            attachment_prefix=@attachment_prefix, attachment_count=@attachment_count,
            attachment_bytes=@attachment_bytes, finished_at=SYSDATETIME(), error_message=NULL
        WHERE id=@id;
      `);

    const verification = await verifyBackupById(pool, id);
    await enforceRetention(pool);
    return {
      id,
      size: compressed.length,
      table_count: snapshot.table_count,
      row_count: snapshot.row_count,
      attachment_count: attachments.attachmentCount,
      attachment_bytes: attachments.attachmentBytes,
      verification,
    };
  } catch (error) {
    await pool.request()
      .input('id', sql.BigInt, id)
      .input('error_message', sql.NVarChar(2000), String(error?.message || error).slice(0, 1900))
      .query(`UPDATE dbo.backup_history SET status='FAILED', finished_at=SYSDATETIME(), error_message=@error_message WHERE id=@id;`);
    throw error;
  }
}

async function auth(req) {
  const pool = await getPool();
  await ensureSchema(pool);
  const actor = await loadParameterActor(pool, req);
  requirePlatformSuperAdmin(actor);
  return { pool, actor };
}

router.get('/api/backup-center/history', async (req, res) => {
  try {
    const { pool } = await auth(req);
    const result = await pool.request().query(`
      SELECT TOP 50 id, backup_type, scope_code, status, file_size_bytes,
             table_count, row_count, started_at, finished_at, created_by, error_message,
             attachment_count, attachment_bytes, verification_status, verified_at,
             verification_message, retention_status, purged_at
      FROM dbo.backup_history ORDER BY id DESC;
    `);
    res.json({ ok: true, rows: result.recordset || [], running: backupRunning, retention_count: RETENTION_COUNT });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, message: e.message || 'Gagal memuat Backup Center.' });
  }
});

router.post('/api/backup-center/run', async (req, res) => {
  if (backupRunning) return res.status(409).json({ ok: false, message: 'Backup lain masih berjalan.' });
  backupRunning = true;
  try {
    const { pool, actor } = await auth(req);
    const result = await createBackup(pool, actor);
    res.json({ ok: true, message: 'Backup lengkap berhasil dibuat dan diverifikasi.', backup: result });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, message: e.message || 'Backup gagal.' });
  } finally {
    backupRunning = false;
  }
});

router.post('/api/backup-center/:id/verify', async (req, res) => {
  try {
    const { pool } = await auth(req);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: 'ID backup tidak valid.' });
    const result = await verifyBackupById(pool, id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, message: e.message || 'Verifikasi backup gagal.' });
  }
});

async function initializeDatabase() {
  const pool = await getPool();
  await ensureSchema(pool);
}

router.initializeDatabase = initializeDatabase;
module.exports = router;

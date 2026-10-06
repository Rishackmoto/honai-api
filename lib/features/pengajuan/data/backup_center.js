'use strict';

const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { sql, getPool } = require('../../../core/network/db');
const { uploadToB2 } = require('../../../core/storage/backblaze');
const { loadParameterActor, requirePlatformSuperAdmin } = require('./parameter_access_guard');

const gzip = promisify(zlib.gzip);
const router = express.Router();
let schemaReady = false;
let backupRunning = false;

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
    format: 'HONAI_LOGICAL_BACKUP_V1',
    generated_at: new Date().toISOString(),
    database: process.env.DB_DATABASE || null,
    table_count: tables.length,
    row_count: totalRows,
    tables,
  };
}

async function createBackup(pool, actor) {
  const insert = await pool.request()
    .input('created_by', sql.VarChar(30), actor.userid)
    .query(`
      INSERT INTO dbo.backup_history (backup_type, scope_code, status, created_by)
      OUTPUT INSERTED.id
      VALUES ('DATABASE_LOGICAL', 'ALL', 'RUNNING', @created_by);
    `);
  const id = Number(insert.recordset?.[0]?.id);

  try {
    const snapshot = await buildLogicalSnapshot(pool);
    const raw = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const compressed = await gzip(raw, { level: 9 });
    const sha256 = crypto.createHash('sha256').update(compressed).digest('hex');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `backup/database/honai-${stamp}-${id}.json.gz`;
    await uploadToB2({ key, buffer: compressed, contentType: 'application/gzip' });

    await pool.request()
      .input('id', sql.BigInt, id)
      .input('file_key', sql.NVarChar(600), key)
      .input('file_size_bytes', sql.BigInt, compressed.length)
      .input('sha256', sql.VarChar(64), sha256)
      .input('table_count', sql.Int, snapshot.table_count)
      .input('row_count', sql.BigInt, snapshot.row_count)
      .query(`
        UPDATE dbo.backup_history
        SET status='SUCCESS', file_key=@file_key, file_size_bytes=@file_size_bytes,
            sha256=@sha256, table_count=@table_count, row_count=@row_count,
            finished_at=SYSDATETIME(), error_message=NULL
        WHERE id=@id;
      `);
    return { id, key, size: compressed.length, sha256, table_count: snapshot.table_count, row_count: snapshot.row_count };
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
      SELECT TOP 50 id, backup_type, scope_code, status, file_key, file_size_bytes,
             sha256, table_count, row_count, started_at, finished_at, created_by, error_message
      FROM dbo.backup_history ORDER BY id DESC;
    `);
    res.json({ ok: true, rows: result.recordset || [], running: backupRunning });
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
    res.json({ ok: true, message: 'Backup database berhasil disimpan ke B2.', backup: result });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, message: e.message || 'Backup gagal.' });
  } finally {
    backupRunning = false;
  }
});

async function initializeDatabase() {
  const pool = await getPool();
  await ensureSchema(pool);
}

router.initializeDatabase = initializeDatabase;
module.exports = router;

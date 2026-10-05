const express = require('express');
const crypto = require('crypto');
const { sql, getPool } = require('../../../core/network/db');
const { resolveRequestTenant } = require('./tenant');
const {
  isFirebasePushConfigured,
  sendFcmToToken,
} = require('../../../core/notification/firebase_push');

const router = express.Router();
let schemaReady = false;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function ensureDeviceTokenTable(pool) {
  if (schemaReady) return;

  await pool.request().query(`
    IF OBJECT_ID('dbo.user_fcm_token', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.user_fcm_token (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        bpr_id VARCHAR(20) NOT NULL,
        userid VARCHAR(30) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        fcm_token NVARCHAR(1000) NOT NULL,
        device_id NVARCHAR(200) NULL,
        platform VARCHAR(30) NULL,
        device_name NVARCHAR(200) NULL,
        is_active BIT NOT NULL CONSTRAINT DF_user_fcm_token_active DEFAULT 1,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_user_fcm_token_created DEFAULT SYSDATETIME(),
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_user_fcm_token_updated DEFAULT SYSDATETIME(),
        last_seen_at DATETIME2 NULL
      );
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name='UX_user_fcm_token_hash'
        AND object_id=OBJECT_ID('dbo.user_fcm_token')
    )
      CREATE UNIQUE INDEX UX_user_fcm_token_hash
      ON dbo.user_fcm_token(token_hash);

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name='IX_user_fcm_token_user_active'
        AND object_id=OBJECT_ID('dbo.user_fcm_token')
    )
      CREATE INDEX IX_user_fcm_token_user_active
      ON dbo.user_fcm_token(bpr_id, userid, is_active, updated_at DESC);

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name='IX_user_fcm_token_device'
        AND object_id=OBJECT_ID('dbo.user_fcm_token')
    )
      CREATE INDEX IX_user_fcm_token_device
      ON dbo.user_fcm_token(bpr_id, userid, device_id);
  `);

  schemaReady = true;
}

async function actorContext(req) {
  const pool = await getPool();
  await ensureDeviceTokenTable(pool);
  const userid = String(req.get('x-userid') || '').trim();
  if (!userid) {
    const error = new Error('Sesi pengguna tidak teridentifikasi. Silakan login ulang.');
    error.statusCode = 401;
    throw error;
  }
  const bprId = await resolveRequestTenant(pool, req);
  return { pool, userid, bprId };
}

router.post('/api/notification/device-token', async (req, res) => {
  try {
    const { pool, userid, bprId } = await actorContext(req);
    const token = String(req.body?.token || '').trim();
    const deviceId = String(req.body?.device_id || '').trim() || null;
    const platform = String(req.body?.platform || '').trim().slice(0, 30) || null;
    const deviceName = String(req.body?.device_name || '').trim().slice(0, 200) || null;

    if (!token) {
      return res.status(400).json({ success: false, message: 'FCM token wajib diisi.' });
    }

    const hash = tokenHash(token);

    // Bila device_id yang sama pernah mendapat token berbeda (token rotation),
    // token lama dinonaktifkan agar satu perangkat tidak mendapat push ganda.
    if (deviceId) {
      await pool.request()
        .input('bpr_id', sql.VarChar(20), bprId)
        .input('userid', sql.VarChar(30), userid)
        .input('device_id', sql.NVarChar(200), deviceId)
        .input('token_hash', sql.Char(64), hash)
        .query(`
          UPDATE dbo.user_fcm_token
          SET is_active=0, updated_at=SYSDATETIME()
          WHERE bpr_id=@bpr_id AND userid=@userid
            AND device_id=@device_id AND token_hash<>@token_hash;
        `);
    }

    await pool.request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('userid', sql.VarChar(30), userid)
      .input('token_hash', sql.Char(64), hash)
      .input('fcm_token', sql.NVarChar(1000), token)
      .input('device_id', sql.NVarChar(200), deviceId)
      .input('platform', sql.VarChar(30), platform)
      .input('device_name', sql.NVarChar(200), deviceName)
      .query(`
        MERGE dbo.user_fcm_token AS target
        USING (SELECT @token_hash AS token_hash) AS source
          ON target.token_hash=source.token_hash
        WHEN MATCHED THEN UPDATE SET
          bpr_id=@bpr_id,
          userid=@userid,
          fcm_token=@fcm_token,
          device_id=@device_id,
          platform=@platform,
          device_name=@device_name,
          is_active=1,
          updated_at=SYSDATETIME(),
          last_seen_at=SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (bpr_id, userid, token_hash, fcm_token, device_id, platform, device_name, is_active, last_seen_at)
          VALUES (@bpr_id, @userid, @token_hash, @fcm_token, @device_id, @platform, @device_name, 1, SYSDATETIME());
      `);

    return res.json({
      success: true,
      message: 'Perangkat notifikasi berhasil didaftarkan.',
      firebase_configured: isFirebasePushConfigured(),
    });
  } catch (error) {
    console.error('REGISTER FCM TOKEN ERROR:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Gagal mendaftarkan perangkat notifikasi.',
    });
  }
});

router.post('/api/notification/device-token/deactivate', async (req, res) => {
  try {
    const { pool, userid, bprId } = await actorContext(req);
    const token = String(req.body?.token || '').trim();
    const deviceId = String(req.body?.device_id || '').trim();

    if (!token && !deviceId) {
      return res.status(400).json({ success: false, message: 'Token atau device_id wajib diisi.' });
    }

    const request = pool.request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('userid', sql.VarChar(30), userid)
      .input('device_id', sql.NVarChar(200), deviceId || null)
      .input('token_hash', sql.Char(64), token ? tokenHash(token) : null);

    await request.query(`
      UPDATE dbo.user_fcm_token
      SET is_active=0, updated_at=SYSDATETIME()
      WHERE bpr_id=@bpr_id AND userid=@userid
        AND (
          (@device_id IS NOT NULL AND device_id=@device_id)
          OR (@token_hash IS NOT NULL AND token_hash=@token_hash)
        );
    `);

    return res.json({ success: true, message: 'Perangkat notifikasi dinonaktifkan.' });
  } catch (error) {
    console.error('DEACTIVATE FCM TOKEN ERROR:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Gagal menonaktifkan perangkat notifikasi.',
    });
  }
});

router.get('/api/notification/device-token/status', async (req, res) => {
  try {
    const { pool, userid, bprId } = await actorContext(req);
    const result = await pool.request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('userid', sql.VarChar(30), userid)
      .query(`
        SELECT id, device_id, platform, device_name, is_active, created_at, updated_at, last_seen_at
        FROM dbo.user_fcm_token
        WHERE bpr_id=@bpr_id AND userid=@userid
        ORDER BY is_active DESC, updated_at DESC;
      `);

    return res.json({
      success: true,
      firebase_configured: isFirebasePushConfigured(),
      devices: result.recordset,
    });
  } catch (error) {
    console.error('FCM STATUS ERROR:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.post('/api/notification/test-push', async (req, res) => {
  try {
    const { pool, userid, bprId } = await actorContext(req);
    if (!isFirebasePushConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'FCM_NOT_CONFIGURED',
        message: 'Firebase service account belum dikonfigurasi di backend.',
      });
    }

    const title = String(req.body?.title || 'HONAI').trim().slice(0, 150);
    const body = String(
      req.body?.body || 'Notifikasi perangkat berhasil diaktifkan.'
    ).trim().slice(0, 500);

    const result = await pool.request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('userid', sql.VarChar(30), userid)
      .query(`
        SELECT id, fcm_token
        FROM dbo.user_fcm_token
        WHERE bpr_id=@bpr_id AND userid=@userid AND is_active=1
        ORDER BY updated_at DESC;
      `);

    let sent = 0;
    let failed = 0;
    const failures = [];

    for (const row of result.recordset) {
      const push = await sendFcmToToken({
        token: row.fcm_token,
        title,
        body,
        data: { type: 'test', route: 'dashboard', bpr_id: bprId },
      });

      if (push.success) {
        sent += 1;
        continue;
      }

      failed += 1;
      failures.push({ id: row.id, code: push.code, message: push.message });
      const invalidCodes = new Set([
        'UNREGISTERED',
        'INVALID_ARGUMENT',
        'SENDER_ID_MISMATCH',
      ]);
      if (invalidCodes.has(String(push.code || '').toUpperCase())) {
        await pool.request()
          .input('id', sql.BigInt, row.id)
          .query(`UPDATE dbo.user_fcm_token SET is_active=0, updated_at=SYSDATETIME() WHERE id=@id;`);
      }
    }

    return res.json({
      success: sent > 0,
      sent,
      failed,
      registered_devices: result.recordset.length,
      failures,
    });
  } catch (error) {
    console.error('FCM TEST PUSH ERROR:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

async function initializeDatabase() {
  const pool = await getPool();
  await ensureDeviceTokenTable(pool);
}

router.initializeDatabase = initializeDatabase;
router.ensureDeviceTokenTable = ensureDeviceTokenTable;
module.exports = router;

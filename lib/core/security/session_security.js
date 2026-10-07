const crypto = require('crypto');
const { sql, getPool } = require('../network/db');

const SESSION_IDLE_MINUTES = Number(process.env.HONAI_SESSION_IDLE_MINUTES || 30);
const SESSION_ABSOLUTE_HOURS = Number(process.env.HONAI_SESSION_ABSOLUTE_HOURS || 12);

function normalizeUserId(value) {
  return String(value || '').trim();
}

function hashSessionToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function clientIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

function deviceName(req) {
  const bodyName = String(req.body?.device_name || '').trim();
  if (bodyName) return bodyName.slice(0, 160);
  const userAgent = String(req.get('user-agent') || '').trim();
  return (userAgent || 'Perangkat tidak dikenal').slice(0, 160);
}

let sessionSchemaReady = false;
let sessionSchemaPromise = null;

async function ensureSessionSchema(pool) {
  if (sessionSchemaReady) return;
  if (sessionSchemaPromise) return sessionSchemaPromise;

  sessionSchemaPromise = pool.request().query(`
    IF OBJECT_ID('dbo.honai_user_session', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.honai_user_session (
        userid VARCHAR(30) NOT NULL,
        session_id VARCHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        device_name NVARCHAR(160) NULL,
        user_agent NVARCHAR(500) NULL,
        ip_address VARCHAR(64) NULL,
        login_at DATETIME2(0) NOT NULL CONSTRAINT DF_honai_user_session_login_at DEFAULT SYSDATETIME(),
        last_activity_at DATETIME2(0) NOT NULL CONSTRAINT DF_honai_user_session_last_activity DEFAULT SYSDATETIME(),
        expires_at DATETIME2(0) NOT NULL,
        revoked_at DATETIME2(0) NULL,
        updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_honai_user_session_updated_at DEFAULT SYSDATETIME(),
        CONSTRAINT PK_honai_user_session PRIMARY KEY (userid)
      );

      CREATE UNIQUE INDEX UX_honai_user_session_session_id
        ON dbo.honai_user_session(session_id);
    END
  `).then(() => {
    sessionSchemaReady = true;
  }).catch((error) => {
    sessionSchemaPromise = null;
    throw error;
  });

  return sessionSchemaPromise;
}

async function createSingleSession(pool, userid, req) {
  const normalizedUserid = normalizeUserId(userid);
  if (!normalizedUserid) {
    const error = new Error('User ID sesi tidak valid.');
    error.code = 'SESSION_USER_REQUIRED';
    throw error;
  }

  await ensureSessionSchema(pool);

  const sessionId = crypto.randomUUID();
  const token = makeSessionToken();
  const tokenHash = hashSessionToken(token);
  const currentDevice = deviceName(req);
  const userAgent = String(req.get('user-agent') || '').trim().slice(0, 500) || null;
  const ipAddress = clientIp(req);

  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

  try {
    const request = new sql.Request(transaction);
    const existingResult = await request
      .input('userid', sql.VarChar(30), normalizedUserid)
      .input('idle_minutes', sql.Int, SESSION_IDLE_MINUTES)
      .query(`
        SELECT TOP 1
          userid,
          session_id,
          device_name,
          login_at,
          last_activity_at,
          expires_at,
          revoked_at,
          CASE
            WHEN revoked_at IS NULL
             AND expires_at > SYSDATETIME()
             AND last_activity_at > DATEADD(MINUTE, -@idle_minutes, SYSDATETIME())
            THEN 1 ELSE 0
          END AS is_active
        FROM dbo.honai_user_session WITH (UPDLOCK, HOLDLOCK)
        WHERE userid = @userid;
      `);

    const existing = existingResult.recordset?.[0] || null;
    if (existing && Number(existing.is_active) === 1) {
      await transaction.rollback();
      return {
        created: false,
        conflict: true,
        existing: {
          device_name: existing.device_name || 'perangkat lain',
          login_at: existing.login_at,
          last_activity_at: existing.last_activity_at,
          expires_at: existing.expires_at,
        },
      };
    }

    const writeRequest = new sql.Request(transaction);
    const writeResult = await writeRequest
      .input('userid', sql.VarChar(30), normalizedUserid)
      .input('session_id', sql.VarChar(36), sessionId)
      .input('token_hash', sql.Char(64), tokenHash)
      .input('device_name', sql.NVarChar(160), currentDevice)
      .input('user_agent', sql.NVarChar(500), userAgent)
      .input('ip_address', sql.VarChar(64), ipAddress)
      .input('absolute_hours', sql.Int, SESSION_ABSOLUTE_HOURS)
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.honai_user_session WHERE userid = @userid)
        BEGIN
          UPDATE dbo.honai_user_session
          SET session_id = @session_id,
              token_hash = @token_hash,
              device_name = @device_name,
              user_agent = @user_agent,
              ip_address = @ip_address,
              login_at = SYSDATETIME(),
              last_activity_at = SYSDATETIME(),
              expires_at = DATEADD(HOUR, @absolute_hours, SYSDATETIME()),
              revoked_at = NULL,
              updated_at = SYSDATETIME()
          WHERE userid = @userid;
        END
        ELSE
        BEGIN
          INSERT INTO dbo.honai_user_session
            (userid, session_id, token_hash, device_name, user_agent, ip_address,
             login_at, last_activity_at, expires_at, revoked_at, updated_at)
          VALUES
            (@userid, @session_id, @token_hash, @device_name, @user_agent, @ip_address,
             SYSDATETIME(), SYSDATETIME(), DATEADD(HOUR, @absolute_hours, SYSDATETIME()), NULL, SYSDATETIME());
        END;

        SELECT TOP 1 session_id, device_name, login_at, last_activity_at, expires_at
        FROM dbo.honai_user_session
        WHERE userid = @userid;
      `);

    await transaction.commit();

    return {
      created: true,
      conflict: false,
      token,
      ...(writeResult.recordset?.[0] || {}),
    };
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (_) {}
    throw error;
  }
}

async function validateSession(pool, userid, token, { touch = true } = {}) {
  const normalizedUserid = normalizeUserId(userid);
  const normalizedToken = String(token || '').trim();
  if (!normalizedUserid || !normalizedToken) return null;

  await ensureSessionSchema(pool);
  const tokenHash = hashSessionToken(normalizedToken);

  const result = await pool.request()
    .input('userid', sql.VarChar(30), normalizedUserid)
    .input('token_hash', sql.Char(64), tokenHash)
    .input('idle_minutes', sql.Int, SESSION_IDLE_MINUTES)
    .query(`
      SELECT TOP 1
        userid, session_id, device_name, login_at, last_activity_at, expires_at
      FROM dbo.honai_user_session
      WHERE userid = @userid
        AND token_hash = @token_hash
        AND revoked_at IS NULL
        AND expires_at > SYSDATETIME()
        AND last_activity_at > DATEADD(MINUTE, -@idle_minutes, SYSDATETIME());
    `);

  const session = result.recordset?.[0] || null;
  if (!session) return null;

  if (touch) {
    await pool.request()
      .input('userid', sql.VarChar(30), normalizedUserid)
      .input('token_hash', sql.Char(64), tokenHash)
      .query(`
        UPDATE dbo.honai_user_session
        SET last_activity_at = SYSDATETIME(), updated_at = SYSDATETIME()
        WHERE userid = @userid
          AND token_hash = @token_hash
          AND revoked_at IS NULL;
      `);
  }

  return session;
}

async function revokeSession(pool, userid, token) {
  const normalizedUserid = normalizeUserId(userid);
  const normalizedToken = String(token || '').trim();
  if (!normalizedUserid || !normalizedToken) return false;

  await ensureSessionSchema(pool);
  const tokenHash = hashSessionToken(normalizedToken);
  const result = await pool.request()
    .input('userid', sql.VarChar(30), normalizedUserid)
    .input('token_hash', sql.Char(64), tokenHash)
    .query(`
      UPDATE dbo.honai_user_session
      SET revoked_at = SYSDATETIME(), updated_at = SYSDATETIME()
      WHERE userid = @userid
        AND token_hash = @token_hash
        AND revoked_at IS NULL;
      SELECT @@ROWCOUNT AS affected;
    `);

  return Number(result.recordset?.[0]?.affected || 0) > 0;
}

function isSessionFreePath(pathname) {
  return pathname === '/api/login' ||
    pathname === '/api/logout' ||
    pathname === '/api/audit/logout' ||
    pathname === '/health' ||
    pathname === '/';
}

function sessionMiddleware() {
  return async (req, res, next) => {
    const pathname = req.path || String(req.originalUrl || '').split('?')[0];
    if (!pathname.startsWith('/api/') || isSessionFreePath(pathname)) return next();

    const userid = normalizeUserId(req.get('x-userid'));
    const token = String(req.get('x-session-token') || '').trim();

    // Security Pass 1 compatibility:
    // endpoint legacy yang belum membawa konteks user belum diputus pada tahap ini.
    // Tetapi setiap request yang mengaku membawa x-userid WAJIB membawa token sesi.
    if (!userid && !token) return next();

    if (!userid || !token) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_REQUIRED',
        message: 'Sesi HONAI tidak lengkap. Silakan login ulang.',
      });
    }

    try {
      const pool = await getPool();
      const session = await validateSession(pool, userid, token, { touch: true });
      if (!session) {
        return res.status(401).json({
          success: false,
          code: 'SESSION_INVALID',
          message: 'Sesi sudah berakhir atau akun telah aktif pada sesi lain. Silakan login ulang.',
        });
      }
      req.honaiSession = session;
      return next();
    } catch (error) {
      console.error('HONAI SESSION GUARD ERROR:', error);
      return res.status(500).json({
        success: false,
        code: 'SESSION_GUARD_ERROR',
        message: 'Validasi sesi gagal. Silakan coba kembali.',
      });
    }
  };
}

module.exports = {
  SESSION_IDLE_MINUTES,
  SESSION_ABSOLUTE_HOURS,
  ensureSessionSchema,
  createSingleSession,
  validateSession,
  revokeSession,
  sessionMiddleware,
};

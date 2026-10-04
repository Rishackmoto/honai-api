const { sql } = require('../../../core/network/db');
const { ensureTenantSchema, DEFAULT_BPR_ID } = require('./tenant');

const TENANT_ROLE_TABLE = 'dbo.akses_role_tenant';

let _schemaReady = false;
let _schemaPromise = null;

async function _ensureTenantAccessSchemaImpl(pool) {
  await ensureTenantSchema(pool);

  await pool.request().query(`
    IF OBJECT_ID('${TENANT_ROLE_TABLE}', 'U') IS NULL
    BEGIN
      CREATE TABLE ${TENANT_ROLE_TABLE} (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        bpr_id VARCHAR(20) NOT NULL,
        level_akses INT NULL,
        jabatan INT NULL,
        kode_menu VARCHAR(80) NOT NULL,
        can_view BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_view DEFAULT 0,
        can_add BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_add DEFAULT 0,
        can_edit BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_edit DEFAULT 0,
        can_delete BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_delete DEFAULT 0,
        can_print BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_print DEFAULT 0,
        can_upload BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_upload DEFAULT 0,
        can_approve BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_approve DEFAULT 0,
        can_koreksi BIT NOT NULL CONSTRAINT DF_akses_role_tenant_can_koreksi DEFAULT 0,
        updated_at DATETIME NOT NULL CONSTRAINT DF_akses_role_tenant_updated_at DEFAULT GETDATE()
      );
    END;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.foreign_keys
      WHERE name = 'FK_akses_role_tenant_master_bpr'
        AND parent_object_id = OBJECT_ID('${TENANT_ROLE_TABLE}')
    )
    BEGIN
      ALTER TABLE ${TENANT_ROLE_TABLE} WITH CHECK
      ADD CONSTRAINT FK_akses_role_tenant_master_bpr
      FOREIGN KEY (bpr_id) REFERENCES dbo.master_bpr(bpr_id);
    END;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'UX_akses_role_tenant_bpr_jabatan_menu'
        AND object_id = OBJECT_ID('${TENANT_ROLE_TABLE}')
    )
      CREATE UNIQUE INDEX UX_akses_role_tenant_bpr_jabatan_menu
      ON ${TENANT_ROLE_TABLE}(bpr_id, jabatan, kode_menu)
      WHERE jabatan IS NOT NULL;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'UX_akses_role_tenant_bpr_level_menu'
        AND object_id = OBJECT_ID('${TENANT_ROLE_TABLE}')
    )
      CREATE UNIQUE INDEX UX_akses_role_tenant_bpr_level_menu
      ON ${TENANT_ROLE_TABLE}(bpr_id, level_akses, kode_menu)
      WHERE jabatan IS NULL AND level_akses IS NOT NULL;
  `);

  await pool.request().query(`
    IF OBJECT_ID('dbo.akses_role', 'U') IS NOT NULL
    BEGIN
      ;WITH legacy AS (
        SELECT
          level_akses,
          jabatan,
          kode_menu,
          MAX(CAST(ISNULL(can_view,0) AS INT)) AS can_view,
          MAX(CAST(ISNULL(can_add,0) AS INT)) AS can_add,
          MAX(CAST(ISNULL(can_edit,0) AS INT)) AS can_edit,
          MAX(CAST(ISNULL(can_delete,0) AS INT)) AS can_delete,
          MAX(CAST(ISNULL(can_print,0) AS INT)) AS can_print,
          MAX(CAST(ISNULL(can_upload,0) AS INT)) AS can_upload,
          MAX(CAST(ISNULL(can_approve,0) AS INT)) AS can_approve,
          MAX(CAST(ISNULL(can_koreksi,0) AS INT)) AS can_koreksi,
          MAX(updated_at) AS updated_at
        FROM dbo.akses_role
        GROUP BY level_akses, jabatan, kode_menu
      )
      INSERT INTO ${TENANT_ROLE_TABLE} (
        bpr_id, level_akses, jabatan, kode_menu,
        can_view, can_add, can_edit, can_delete,
        can_print, can_upload, can_approve, can_koreksi, updated_at
      )
      SELECT
        b.bpr_id,
        r.level_akses,
        r.jabatan,
        r.kode_menu,
        r.can_view, r.can_add, r.can_edit, r.can_delete,
        r.can_print, r.can_upload, r.can_approve, r.can_koreksi,
        ISNULL(r.updated_at, GETDATE())
      FROM dbo.master_bpr b
      CROSS JOIN legacy r
      WHERE ISNULL(b.aktif,1)=1
        AND NOT EXISTS (
          SELECT 1
          FROM ${TENANT_ROLE_TABLE} t
          WHERE t.bpr_id = b.bpr_id
            AND t.kode_menu = r.kode_menu
            AND (
              (r.jabatan IS NOT NULL AND t.jabatan = r.jabatan)
              OR
              (r.jabatan IS NULL AND t.jabatan IS NULL AND ISNULL(t.level_akses,-1) = ISNULL(r.level_akses,-1))
            )
        );
    END;
  `);
}

async function ensureTenantAccessSchema(pool) {
  if (_schemaReady) return;
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = _ensureTenantAccessSchemaImpl(pool)
    .then(() => { _schemaReady = true; })
    .catch((error) => {
      _schemaPromise = null;
      throw error;
    });
  return _schemaPromise;
}

async function ensureTenantAccessForBpr(pool, bprId) {
  await ensureTenantAccessSchema(pool);
  const id = normalizedBprId(bprId) || DEFAULT_BPR_ID;
  await pool.request()
    .input('bpr_id', sql.VarChar(20), id)
    .query(`
      IF OBJECT_ID('dbo.akses_role', 'U') IS NOT NULL
      BEGIN
        ;WITH legacy AS (
          SELECT
            level_akses,
            jabatan,
            kode_menu,
            MAX(CAST(ISNULL(can_view,0) AS INT)) AS can_view,
            MAX(CAST(ISNULL(can_add,0) AS INT)) AS can_add,
            MAX(CAST(ISNULL(can_edit,0) AS INT)) AS can_edit,
            MAX(CAST(ISNULL(can_delete,0) AS INT)) AS can_delete,
            MAX(CAST(ISNULL(can_print,0) AS INT)) AS can_print,
            MAX(CAST(ISNULL(can_upload,0) AS INT)) AS can_upload,
            MAX(CAST(ISNULL(can_approve,0) AS INT)) AS can_approve,
            MAX(CAST(ISNULL(can_koreksi,0) AS INT)) AS can_koreksi,
            MAX(updated_at) AS updated_at
          FROM dbo.akses_role
          GROUP BY level_akses, jabatan, kode_menu
        )
        INSERT INTO ${TENANT_ROLE_TABLE} (
          bpr_id, level_akses, jabatan, kode_menu,
          can_view, can_add, can_edit, can_delete,
          can_print, can_upload, can_approve, can_koreksi, updated_at
        )
        SELECT
          @bpr_id,
          r.level_akses,
          r.jabatan,
          r.kode_menu,
          r.can_view, r.can_add, r.can_edit, r.can_delete,
          r.can_print, r.can_upload, r.can_approve, r.can_koreksi,
          ISNULL(r.updated_at, GETDATE())
        FROM legacy r
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${TENANT_ROLE_TABLE} t
          WHERE t.bpr_id = @bpr_id
            AND t.kode_menu = r.kode_menu
            AND (
              (r.jabatan IS NOT NULL AND t.jabatan = r.jabatan)
              OR
              (r.jabatan IS NULL AND t.jabatan IS NULL AND ISNULL(t.level_akses,-1) = ISNULL(r.level_akses,-1))
            )
        );
      END;
    `);
}

function normalizedBprId(value) {
  return String(value || '').trim().toUpperCase();
}

function actorUserId(req) {
  return String(
    req.get?.('x-userid') ||
    req.body?.userid ||
    req.query?.userid ||
    ''
  ).trim();
}

async function getAccessActor(pool, req) {
  await ensureTenantSchema(pool);
  const userid = actorUserId(req);
  if (!userid) {
    const error = new Error('Sesi pengguna tidak teridentifikasi. Silakan login ulang.');
    error.statusCode = 401;
    error.code = 'ACCESS_USER_REQUIRED';
    throw error;
  }

  const result = await pool.request()
    .input('userid', sql.VarChar(30), userid)
    .query(`
      SELECT TOP 1 userid, levelid, jabat, bpr_id, ISNULL(is_super_admin,0) AS is_super_admin
      FROM dbo.muser
      WHERE LTRIM(RTRIM(userid)) = LTRIM(RTRIM(@userid))
        AND ISNULL(flag,'1')='1';
    `);

  const actor = result.recordset?.[0];
  if (!actor) {
    const error = new Error('User tidak ditemukan atau tidak aktif.');
    error.statusCode = 401;
    error.code = 'ACCESS_USER_NOT_FOUND';
    throw error;
  }
  return actor;
}

function chooseAccessTenant(actor, requestedBprId) {
  const own = normalizedBprId(actor?.bpr_id) || DEFAULT_BPR_ID;
  const requested = normalizedBprId(requestedBprId);
  const isSuperAdmin = String(actor?.levelid || '').trim() === '5' && Boolean(actor?.is_super_admin);

  if (!requested || requested === own) {
    return { allowed: true, bprId: own, isSuperAdmin };
  }
  if (isSuperAdmin) {
    return { allowed: true, bprId: requested, isSuperAdmin };
  }
  return { allowed: false, bprId: own, isSuperAdmin, reason: 'CROSS_TENANT_DENIED' };
}

async function assertActiveTenant(pool, bprId) {
  const id = normalizedBprId(bprId);
  const r = await pool.request()
    .input('bpr_id', sql.VarChar(20), id)
    .query(`
      SELECT TOP 1 bpr_id
      FROM dbo.master_bpr
      WHERE bpr_id=@bpr_id AND ISNULL(aktif,1)=1;
    `);
  if (!r.recordset?.[0]) {
    const error = new Error('BPR/Tenant tidak ditemukan atau tidak aktif.');
    error.statusCode = 404;
    error.code = 'TENANT_NOT_FOUND';
    throw error;
  }
  return id;
}

async function resolveAccessTenant(pool, req, requestedBprId) {
  await ensureTenantAccessSchema(pool);
  const actor = await getAccessActor(pool, req);
  const decision = chooseAccessTenant(actor, requestedBprId);
  if (!decision.allowed) {
    const error = new Error('Anda tidak memiliki akses ke tenant tersebut.');
    error.statusCode = 403;
    error.code = decision.reason;
    throw error;
  }
  const bprId = await assertActiveTenant(pool, decision.bprId);
  await ensureTenantAccessForBpr(pool, bprId);
  return { actor, bprId, isSuperAdmin: decision.isSuperAdmin };
}

module.exports = {
  TENANT_ROLE_TABLE,
  ensureTenantAccessSchema,
  ensureTenantAccessForBpr,
  getAccessActor,
  chooseAccessTenant,
  resolveAccessTenant,
};

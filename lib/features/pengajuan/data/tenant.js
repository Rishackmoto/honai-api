const { sql } = require('../../../core/network/db');

const DEFAULT_BPR_ID = 'ANP';

async function _ensureTenantSchemaImpl(pool) {
  // Pisah per batch agar SQL Server tidak meng-compile referensi kolom baru
  // sebelum ALTER TABLE selesai (penyebab Msg 207 pada V1 awal).
  await pool.request().query(`
    IF OBJECT_ID('dbo.master_bpr', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.master_bpr (
        bpr_id VARCHAR(20) NOT NULL PRIMARY KEY,
        kode_bpr VARCHAR(20) NULL,
        nama_bpr NVARCHAR(200) NOT NULL,
        nama_singkat NVARCHAR(100) NULL,
        alamat NVARCHAR(500) NULL,
        kota NVARCHAR(100) NULL,
        provinsi NVARCHAR(100) NULL,
        telepon VARCHAR(50) NULL,
        email VARCHAR(120) NULL,
        website VARCHAR(200) NULL,
        logo_url NVARCHAR(500) NULL,
        primary_color VARCHAR(20) NULL,
        secondary_color VARCHAR(20) NULL,
        aktif BIT NOT NULL CONSTRAINT DF_master_bpr_aktif DEFAULT 1,
        created_at DATETIME NOT NULL CONSTRAINT DF_master_bpr_created_at DEFAULT GETDATE(),
        updated_at DATETIME NULL
      );
    END;
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.master_bpr WHERE bpr_id = '${DEFAULT_BPR_ID}')
    BEGIN
      INSERT INTO dbo.master_bpr (
        bpr_id, kode_bpr, nama_bpr, nama_singkat, kota, provinsi,
        primary_color, secondary_color, aktif
      ) VALUES (
        '${DEFAULT_BPR_ID}', 'ANP', N'PT. BPR Anak Negeri Papua', N'BPR Anak Negeri Papua',
        N'Jayapura', N'Papua', '#0D47A1', '#D4AF37', 1
      );
    END;
  `);

  await pool.request().query(`
    IF COL_LENGTH('dbo.muser', 'bpr_id') IS NULL
      ALTER TABLE dbo.muser ADD bpr_id VARCHAR(20) NULL;
  `);


  // Multi-BPR V2.5: bedakan satu Super Admin platform dengan Admin internal tenant.
  // levelid=5 tetap Administrator. is_super_admin=1 hanya boleh satu akun aktif.
  await pool.request().query(`
    IF COL_LENGTH('dbo.muser', 'is_super_admin') IS NULL
      ALTER TABLE dbo.muser ADD is_super_admin BIT NULL;
  `);

  await pool.request().query(`
    UPDATE dbo.muser
       SET is_super_admin = 0
     WHERE is_super_admin IS NULL;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.default_constraints dc
      JOIN sys.columns c ON c.default_object_id = dc.object_id
      WHERE dc.parent_object_id = OBJECT_ID('dbo.muser')
        AND c.name = 'is_super_admin'
    )
      ALTER TABLE dbo.muser
      ADD CONSTRAINT DF_muser_is_super_admin DEFAULT 0 FOR is_super_admin;
  `);

  // Jika saat migrasi hanya ada satu Administrator aktif, jadikan akun itu
  // Super Admin secara otomatis. Jika ada lebih dari satu, tidak memilih
  // secara acak; administrator dapat ditetapkan eksplisit via SQL satu kali.
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.muser WHERE ISNULL(is_super_admin,0)=1)
       AND (SELECT COUNT(1) FROM dbo.muser WHERE CAST(levelid AS VARCHAR(10))='5' AND ISNULL(flag,'1')='1') = 1
    BEGIN
      UPDATE dbo.muser
         SET is_super_admin = 1
       WHERE CAST(levelid AS VARCHAR(10))='5'
         AND ISNULL(flag,'1')='1';
    END;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'UX_muser_single_super_admin'
        AND object_id = OBJECT_ID('dbo.muser')
    )
      CREATE UNIQUE INDEX UX_muser_single_super_admin
      ON dbo.muser(is_super_admin)
      WHERE is_super_admin = 1;
  `);

  await pool.request().query(`
    UPDATE dbo.muser
       SET bpr_id = '${DEFAULT_BPR_ID}'
     WHERE bpr_id IS NULL OR LTRIM(RTRIM(bpr_id)) = '';
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.foreign_keys
      WHERE name = 'FK_muser_master_bpr'
        AND parent_object_id = OBJECT_ID('dbo.muser')
    )
    BEGIN
      ALTER TABLE dbo.muser WITH CHECK
      ADD CONSTRAINT FK_muser_master_bpr
      FOREIGN KEY (bpr_id) REFERENCES dbo.master_bpr(bpr_id);
    END;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_muser_bpr_userid'
        AND object_id = OBJECT_ID('dbo.muser')
    )
      CREATE INDEX IX_muser_bpr_userid ON dbo.muser(bpr_id, userid);
  `);
}


let _tenantSchemaReady = false;
let _tenantSchemaPromise = null;

async function ensureTenantSchema(pool) {
  if (_tenantSchemaReady) return;
  if (_tenantSchemaPromise) return _tenantSchemaPromise;

  _tenantSchemaPromise = _ensureTenantSchemaImpl(pool)
    .then(() => {
      _tenantSchemaReady = true;
    })
    .catch((error) => {
      _tenantSchemaPromise = null;
      throw error;
    });

  return _tenantSchemaPromise;
}

async function _ensurePengajuanTenantSchemaImpl(pool) {
  await ensureTenantSchema(pool);

  await pool.request().query(`
    IF COL_LENGTH('dbo.t_pengajuan', 'bpr_id') IS NULL
      ALTER TABLE dbo.t_pengajuan ADD bpr_id VARCHAR(20) NULL;
  `);

  await pool.request().query(`
    UPDATE dbo.t_pengajuan
       SET bpr_id = '${DEFAULT_BPR_ID}'
     WHERE bpr_id IS NULL OR LTRIM(RTRIM(bpr_id)) = '';
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.default_constraints dc
      JOIN sys.columns c
        ON c.default_object_id = dc.object_id
      WHERE dc.parent_object_id = OBJECT_ID('dbo.t_pengajuan')
        AND c.name = 'bpr_id'
    )
      ALTER TABLE dbo.t_pengajuan
      ADD CONSTRAINT DF_t_pengajuan_bpr_id DEFAULT '${DEFAULT_BPR_ID}' FOR bpr_id;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.foreign_keys
      WHERE name = 'FK_t_pengajuan_master_bpr'
        AND parent_object_id = OBJECT_ID('dbo.t_pengajuan')
    )
    BEGIN
      ALTER TABLE dbo.t_pengajuan WITH CHECK
      ADD CONSTRAINT FK_t_pengajuan_master_bpr
      FOREIGN KEY (bpr_id) REFERENCES dbo.master_bpr(bpr_id);
    END;
  `);

  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_t_pengajuan_bpr_status_ao'
        AND object_id = OBJECT_ID('dbo.t_pengajuan')
    )
      CREATE INDEX IX_t_pengajuan_bpr_status_ao
      ON dbo.t_pengajuan(bpr_id, stsflag, id_ao, id_pengajuan);
  `);
}


let _pengajuanTenantSchemaReady = false;
let _pengajuanTenantSchemaPromise = null;

async function ensurePengajuanTenantSchema(pool) {
  if (_pengajuanTenantSchemaReady) return;
  if (_pengajuanTenantSchemaPromise) return _pengajuanTenantSchemaPromise;

  _pengajuanTenantSchemaPromise = _ensurePengajuanTenantSchemaImpl(pool)
    .then(() => {
      _pengajuanTenantSchemaReady = true;
    })
    .catch((error) => {
      _pengajuanTenantSchemaPromise = null;
      throw error;
    });

  return _pengajuanTenantSchemaPromise;
}

async function getTenantById(pool, bprId) {
  const id = String(bprId || DEFAULT_BPR_ID).trim() || DEFAULT_BPR_ID;
  const result = await pool.request()
    .input('bpr_id', sql.VarChar(20), id)
    .query(`
      SELECT TOP 1
        bpr_id, kode_bpr, nama_bpr, nama_singkat, app_name, tagline,
        alamat, kota, provinsi, telepon, email, website, logo_url,
        primary_color, secondary_color, report_footer, aktif
      FROM dbo.master_bpr
      WHERE bpr_id = @bpr_id AND ISNULL(aktif, 1) = 1;
    `);
  return result.recordset[0] || null;
}

function actorUserId(req) {
  const body = req.body?.payload && typeof req.body.payload === 'object'
    ? { ...req.body, ...req.body.payload }
    : (req.body || {});
  return String(
    req.get?.('x-userid') ||
    body.userid || body.id_user || body.id_ao ||
    req.query?.userid || req.query?.id_user || req.query?.id_ao || ''
  ).trim();
}

async function resolveRequestTenant(pool, req) {
  await ensureTenantSchema(pool);
  const userid = actorUserId(req);

  // Selama migrasi V1.1, request lama yang belum mengirim identitas tetap ANP.
  if (!userid) return DEFAULT_BPR_ID;

  const result = await pool.request()
    .input('userid', sql.VarChar(30), userid)
    .query(`
      SELECT TOP 1 bpr_id
      FROM dbo.muser
      WHERE LTRIM(RTRIM(userid)) = LTRIM(RTRIM(@userid))
        AND ISNULL(flag, '1') = '1';
    `);

  const user = result.recordset[0];
  if (!user) {
    const error = new Error('User tenant tidak ditemukan atau user tidak aktif.');
    error.code = 'TENANT_USER_NOT_FOUND';
    throw error;
  }
  return String(user.bpr_id || DEFAULT_BPR_ID).trim() || DEFAULT_BPR_ID;
}

async function assertPengajuanTenant(pool, idPengajuan, bprId) {
  await ensurePengajuanTenantSchema(pool);
  const result = await pool.request()
    .input('id_pengajuan', sql.VarChar(80), String(idPengajuan || '').trim())
    .input('bpr_id', sql.VarChar(20), String(bprId || DEFAULT_BPR_ID).trim())
    .query(`
      SELECT TOP 1 1 AS ok
      FROM dbo.t_pengajuan
      WHERE CAST(id_pengajuan AS VARCHAR(80)) = @id_pengajuan
        AND bpr_id = @bpr_id;
    `);
  return Boolean(result.recordset[0]);
}

module.exports = {
  DEFAULT_BPR_ID,
  ensureTenantSchema,
  ensurePengajuanTenantSchema,
  getTenantById,
  resolveRequestTenant,
  assertPengajuanTenant,
};

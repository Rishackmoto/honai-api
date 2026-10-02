const { sql } = require('../../../core/network/db');

const DEFAULT_BPR_ID = 'ANP';

async function ensureTenantSchema(pool) {
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
      )
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.master_bpr WHERE bpr_id = '${DEFAULT_BPR_ID}')
    BEGIN
      INSERT INTO dbo.master_bpr (
        bpr_id, kode_bpr, nama_bpr, nama_singkat, kota, provinsi,
        primary_color, secondary_color, aktif
      ) VALUES (
        '${DEFAULT_BPR_ID}', 'ANP', N'PT. BPR Anak Negeri Papua', N'BPR Anak Negeri Papua',
        N'Jayapura', N'Papua', '#0D47A1', '#D4AF37', 1
      )
    END

    IF COL_LENGTH('dbo.muser', 'bpr_id') IS NULL
    BEGIN
      ALTER TABLE dbo.muser ADD bpr_id VARCHAR(20) NULL
    END

    UPDATE dbo.muser
       SET bpr_id = '${DEFAULT_BPR_ID}'
     WHERE NULLIF(LTRIM(RTRIM(bpr_id)), '') IS NULL

    IF NOT EXISTS (
      SELECT 1
      FROM sys.foreign_keys
      WHERE name = 'FK_muser_master_bpr'
    )
    BEGIN
      ALTER TABLE dbo.muser WITH CHECK
      ADD CONSTRAINT FK_muser_master_bpr
      FOREIGN KEY (bpr_id) REFERENCES dbo.master_bpr(bpr_id)
    END

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_muser_bpr_userid' AND object_id = OBJECT_ID('dbo.muser')
    )
    BEGIN
      CREATE INDEX IX_muser_bpr_userid ON dbo.muser(bpr_id, userid)
    END
  `);
}

async function getTenantById(pool, bprId) {
  const id = String(bprId || DEFAULT_BPR_ID).trim() || DEFAULT_BPR_ID;
  const result = await pool.request()
    .input('bpr_id', sql.VarChar(20), id)
    .query(`
      SELECT TOP 1
        bpr_id, kode_bpr, nama_bpr, nama_singkat, alamat, kota, provinsi,
        telepon, email, website, logo_url, primary_color, secondary_color, aktif
      FROM dbo.master_bpr
      WHERE bpr_id = @bpr_id AND ISNULL(aktif, 1) = 1
    `);
  return result.recordset[0] || null;
}

module.exports = {
  DEFAULT_BPR_ID,
  ensureTenantSchema,
  getTenantById,
};

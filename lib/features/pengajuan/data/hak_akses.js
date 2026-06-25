const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../lib/config/db');

const toBool = (v) => v === true || v === 1 || v === '1';

async function ensureTables(pool) {
  await pool.request().query(`
IF OBJECT_ID('dbo.akses_menu', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.akses_menu (
    id INT IDENTITY(1,1) PRIMARY KEY,
    kode_menu VARCHAR(80) NOT NULL UNIQUE,
    nama_menu VARCHAR(120) NOT NULL,
    parent_menu VARCHAR(80) NULL,
    icon VARCHAR(80) NULL,
    urut INT NOT NULL DEFAULT 0,
    aktif BIT NOT NULL DEFAULT 1
  );
END;

IF OBJECT_ID('dbo.akses_role', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.akses_role (
    id INT IDENTITY(1,1) PRIMARY KEY,
    level_akses INT NOT NULL,
    jabatan INT NULL,
    kode_menu VARCHAR(80) NOT NULL,
    can_view BIT NOT NULL DEFAULT 0,
    can_add BIT NOT NULL DEFAULT 0,
    can_edit BIT NOT NULL DEFAULT 0,
    can_delete BIT NOT NULL DEFAULT 0,
    can_print BIT NOT NULL DEFAULT 0,
    can_upload BIT NOT NULL DEFAULT 0,
    can_approve BIT NOT NULL DEFAULT 0,
    can_koreksi BIT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT GETDATE(),
    CONSTRAINT uq_akses_role UNIQUE(level_akses, jabatan, kode_menu)
  );
END;
`);

  await pool.request().query(`
IF NOT EXISTS (SELECT 1 FROM dbo.akses_menu)
BEGIN
  INSERT INTO dbo.akses_menu(kode_menu,nama_menu,parent_menu,urut) VALUES
  ('dashboard','Dashboard',NULL,10),
  ('pengajuan','Pengajuan',NULL,20),
  ('pengajuan_buat','Buat Pengajuan','pengajuan',21),
  ('pengajuan_daftar','Daftar Pengajuan','pengajuan',22),
  ('pengajuan_monitoring','Monitoring Pengajuan','pengajuan',23),
  ('verifikasi','Verifikasi',NULL,30),
  ('slik','SLIK',NULL,40),
  ('survei','Survei',NULL,50),
  ('survei_debitur','Survei Debitur','survei',51),
  ('survei_agunan','Survei Agunan','survei',52),
  ('rekap_analisa','Rekap & Analisa',NULL,60),
  ('muk','MUK',NULL,70),
  ('dokumen','Dokumen',NULL,80),
  ('laporan','Laporan',NULL,90),
  ('parameter','Parameter',NULL,100),
  ('parameter_user','User','parameter',101),
  ('parameter_hak_akses','Hak Akses','parameter',102),
  ('log_aktivitas','Log Aktivitas',NULL,110);
END;
`);
}

router.get('/level-akses', async (req, res) => {
  try {
    const data = [
      { kode: 1, nama: 'Operator' },
      { kode: 2, nama: 'Supervisor' },
      { kode: 3, nama: 'Signer' },
      { kode: 4, nama: 'Approval' },
      { kode: 5, nama: 'Administrator' },
    ];
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/jabatan', async (req, res) => {
  try {
    const data = [
      { kode: 11, nama: 'Super User' },
      { kode: 12, nama: 'AO' },
      { kode: 13, nama: 'Admin Kredit' },
      { kode: 14, nama: 'Supervisor' },
      { kode: 15, nama: 'Manager' },
      { kode: 16, nama: 'Kepatuhan' },
      { kode: 17, nama: 'Direksi' },
      { kode: 18, nama: 'Komisaris' },
      { kode: 19, nama: 'SKAI' },
    ];
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/role', async (req, res) => {
  try {
    const levelAkses = Number(req.query.level_akses || 0);
    const jabatan = req.query.jabatan === undefined || req.query.jabatan === '' ? null : Number(req.query.jabatan);
    if (!levelAkses) return res.status(400).json({ success: false, message: 'level_akses wajib diisi' });

    const pool = await getPool();
    await ensureTables(pool);

    const request = pool.request()
      .input('level_akses', sql.Int, levelAkses)
      .input('jabatan', sql.Int, jabatan);

    const result = await request.query(`
SELECT
  m.kode_menu,
  m.nama_menu,
  m.parent_menu,
  m.urut,
  ISNULL(r.can_view,0) can_view,
  ISNULL(r.can_add,0) can_add,
  ISNULL(r.can_edit,0) can_edit,
  ISNULL(r.can_delete,0) can_delete,
  ISNULL(r.can_print,0) can_print,
  ISNULL(r.can_upload,0) can_upload,
  ISNULL(r.can_approve,0) can_approve,
  ISNULL(r.can_koreksi,0) can_koreksi
FROM dbo.akses_menu m
LEFT JOIN dbo.akses_role r
  ON r.kode_menu = m.kode_menu
 AND r.level_akses = @level_akses
 AND ((@jabatan IS NULL AND r.jabatan IS NULL) OR r.jabatan = @jabatan)
WHERE m.aktif = 1
ORDER BY m.urut, m.id;
`);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/role', async (req, res) => {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  try {
    await ensureTables(pool);
    const levelAkses = Number(req.body.level_akses || 0);
    const jabatan = req.body.jabatan === undefined || req.body.jabatan === null || req.body.jabatan === '' ? null : Number(req.body.jabatan);
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    if (!levelAkses) return res.status(400).json({ success: false, message: 'level_akses wajib diisi' });

    await tx.begin();

    for (const p of permissions) {
      const kodeMenu = String(p.kode_menu || '').trim();
      if (!kodeMenu) continue;
      const rq = new sql.Request(tx)
        .input('level_akses', sql.Int, levelAkses)
        .input('jabatan', sql.Int, jabatan)
        .input('kode_menu', sql.VarChar(80), kodeMenu)
        .input('can_view', sql.Bit, toBool(p.can_view))
        .input('can_add', sql.Bit, toBool(p.can_add))
        .input('can_edit', sql.Bit, toBool(p.can_edit))
        .input('can_delete', sql.Bit, toBool(p.can_delete))
        .input('can_print', sql.Bit, toBool(p.can_print))
        .input('can_upload', sql.Bit, toBool(p.can_upload))
        .input('can_approve', sql.Bit, toBool(p.can_approve))
        .input('can_koreksi', sql.Bit, toBool(p.can_koreksi));

      await rq.query(`
MERGE dbo.akses_role AS target
USING (SELECT @level_akses level_akses, @jabatan jabatan, @kode_menu kode_menu) AS src
ON target.level_akses = src.level_akses
AND ((target.jabatan IS NULL AND src.jabatan IS NULL) OR target.jabatan = src.jabatan)
AND target.kode_menu = src.kode_menu
WHEN MATCHED THEN UPDATE SET
  can_view=@can_view,
  can_add=@can_add,
  can_edit=@can_edit,
  can_delete=@can_delete,
  can_print=@can_print,
  can_upload=@can_upload,
  can_approve=@can_approve,
  can_koreksi=@can_koreksi,
  updated_at=GETDATE()
WHEN NOT MATCHED THEN INSERT
  (level_akses,jabatan,kode_menu,can_view,can_add,can_edit,can_delete,can_print,can_upload,can_approve,can_koreksi)
VALUES
  (@level_akses,@jabatan,@kode_menu,@can_view,@can_add,@can_edit,@can_delete,@can_print,@can_upload,@can_approve,@can_koreksi);
`);
    }

    await tx.commit();
    res.json({ success: true, message: 'Hak akses berhasil disimpan' });
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

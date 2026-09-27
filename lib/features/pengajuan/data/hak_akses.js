const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../core/network/db');

const toBool = (v) =>
  v === true || v === 1 || v === '1' || v === 'true';

const quoteIdentifier = (value) => `[${String(value).replace(/]/g, ']]')}]`;

const ROLE_LEVEL = Object.freeze({
  11: 5,
  12: 1,
  13: 1,
  14: 2,
  15: 4,
  16: 3,
  17: 4,
  18: 4,
  19: 6,
  20: 6,
});

const normalizeCode = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_|_$/g, '');

function permission(view = false, add = false, edit = false, del = false, print = false, upload = false, approve = false, koreksi = false) {
  return {
    can_view: view ? 1 : 0,
    can_add: add ? 1 : 0,
    can_edit: edit ? 1 : 0,
    can_delete: del ? 1 : 0,
    can_print: print ? 1 : 0,
    can_upload: upload ? 1 : 0,
    can_approve: approve ? 1 : 0,
    can_koreksi: koreksi ? 1 : 0,
  };
}

function defaultPermissionForJabatan(jabatan, menu = {}) {
  const kode = normalizeCode(menu.kode_menu);
  const nama = normalizeCode(menu.nama_menu);
  const parent = normalizeCode(menu.parent_menu);
  const key = `${kode} ${nama} ${parent}`;

  const has = (...tokens) => tokens.some((token) => key.includes(normalizeCode(token)));
  const isDashboard = has('dashboard');
  const isDailySales = has('daily_sales_activity');
  const isDailySalesReport = has('daily_sales_report');
  const isPermohonan = has('permohonan_kredit', 'pengajuan_prefpk', 'pre_fpk', 'pipeline_kredit');
  const isVerifikasi = has('pengajuan_verifikasi', 'verifikasi_pengajuan');
  const isApprovalAwal = has('approval_awal', 'pengajuan_approval_awal', 'approval_supervisor');
  const isFpk = has('pengajuan_fpk', 'fpk_pengajuan');
  const isChecklist = has('pengajuan_checklist', 'checklist_kelengkapan');
  const isRekapAnalisa = has('pengajuan_rekap_analisa', 'rekap_analisa');
  const isSurveyDebitur = has('pengajuan_survey_debitur', 'survey_debitur');
  const isSurveyAgunan = has('pengajuan_survey_agunan', 'survey_agunan');
  const isApproval = has(
    'pengajuan_approval',
    'review_muk',
    'pengajuan_review_muk',
    'approval_muk',
    'review_dan_putusan',
    'putusan_kredit',
  ) || kode === 'approval' || nama === 'approval';
  const isMuk = !isApproval && (has('pengajuan_muk') || kode === 'muk' || nama === 'muk');
  const isSlik = has('slik', 'bi_checking');
  const isDokumen = has('dokumen', 'perjanjian_kredit', 'tanda_tangan_dokumen');
  const isLaporan = has('laporan');
  const isNotifikasi = has('notifikasi');
  const isLog = has('log_aktivitas', 'audit_trail');
  const isAdminParam = has(
    'parameter',
    'data_user',
    'parameter_user',
    'hak_akses',
    'parameter_hak_akses',
    'matriks_kewenangan',
    'approval_policy',
  );

  if (jabatan === 11) return permission(true, true, true, true, true, true, true, true);

  if (jabatan === 12) {
    if (isDashboard || isNotifikasi) return permission(true);
    if (isDailySales) return permission(true, true, true, false, true, true);
    if (isPermohonan || isFpk || isSurveyDebitur || isSurveyAgunan || isRekapAnalisa || isMuk) {
      return permission(true, true, true, false, true, true);
    }
    if (isDokumen || isSlik) return permission(true, false, false, false, true);
    return permission();
  }

  if (jabatan === 13) {
    if (isDashboard || isNotifikasi) return permission(true);
    if (isVerifikasi || isChecklist || isSlik) return permission(true, true, true, false, true, true);
    if (isPermohonan || isFpk || isRekapAnalisa || isSurveyDebitur || isSurveyAgunan || isMuk || isDokumen) {
      return permission(true, false, false, false, true);
    }
    return permission();
  }

  if (jabatan === 14) {
    if (isDashboard || isNotifikasi || isDailySalesReport) return permission(true, false, false, false, true);
    if (isApprovalAwal) return permission(true, false, true, false, true, false, true, true);
    if (isMuk) return permission(true, false, true, false, true);
    if (isPermohonan || isVerifikasi || isChecklist || isRekapAnalisa || isSurveyDebitur || isSurveyAgunan || isSlik || isDokumen) {
      return permission(true, false, false, false, true);
    }
    return permission();
  }

  if (jabatan === 15) {
    if (isDashboard || isNotifikasi || isPermohonan || isMuk || isLaporan || isDokumen || isSlik) {
      return permission(true, false, false, false, true);
    }
    if (isApproval) return permission(true, false, false, false, true, false, true, true);
    return permission();
  }

  if (jabatan === 16) {
    if (isDashboard || isNotifikasi || isPermohonan || isLaporan || isSlik || isDokumen) {
      return permission(true, false, false, false, true);
    }
    if (isMuk) return permission(true, true, true, false, true);
    if (isApproval) return permission(true, false, false, false, true);
    return permission();
  }

  if (jabatan === 17 || jabatan === 18) {
    if (isDashboard || isNotifikasi || isPermohonan || isMuk || isLaporan || isSlik || isDokumen) {
      return permission(true, false, false, false, true);
    }
    if (isApproval) return permission(true, false, false, false, true, false, true, true);
    return permission();
  }

  if (jabatan === 19 || jabatan === 20) {
    if (isAdminParam) return permission();
    if (isDashboard || isPermohonan || isVerifikasi || isApprovalAwal || isFpk ||
        isChecklist || isRekapAnalisa || isSurveyDebitur || isSurveyAgunan || isMuk ||
        isApproval || isSlik || isDokumen || isLaporan || isNotifikasi || isLog ||
        isDailySalesReport) {
      return permission(true);
    }
    return permission();
  }

  return permission();
}

async function findTable(pool, tableName) {
  const result = await pool
    .request()
    .input('table_name', sql.VarChar(128), tableName)
    .query(`
      SELECT TOP 1
        s.name AS schema_name,
        t.name AS table_name
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.name = @table_name
      ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name;
    `);

  const row = result.recordset?.[0];
  if (!row) return null;

  return `${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}`;
}

async function getAccessTables(pool) {
  const menuTable = await findTable(pool, 'akses_menu');
  const roleTable = await findTable(pool, 'akses_role');

  if (!menuTable || !roleTable) {
    const missing = [];
    if (!menuTable) missing.push('akses_menu');
    if (!roleTable) missing.push('akses_role');

    throw new Error(
      `Tabel ${missing.join(', ')} tidak ditemukan di database aktif. Pastikan tabel dibuat pada database yang dipakai API Railway.`,
    );
  }

  return { menuTable, roleTable };
}

router.get('/level-akses', async (req, res) => {
  res.json({
    success: true,
    data: [
      { kode: 1, nama: 'Operator' },
      { kode: 2, nama: 'Supervisor' },
      { kode: 3, nama: 'Signer / Reviewer' },
      { kode: 4, nama: 'Approval' },
      { kode: 5, nama: 'Administrator' },
      { kode: 6, nama: 'Auditor / Read Only' },
    ],
  });
});

router.get('/jabatan', async (req, res) => {
  res.json({
    success: true,
    data: [
      { kode: 11, nama: 'Super User' },
      { kode: 12, nama: 'AO' },
      { kode: 13, nama: 'Admin Kredit' },
      { kode: 14, nama: 'Supervisor' },
      { kode: 15, nama: 'Manager' },
      { kode: 16, nama: 'Kepatuhan' },
      { kode: 17, nama: 'Direksi' },
      { kode: 18, nama: 'Komisaris' },
      { kode: 19, nama: 'SKAI' },
      { kode: 20, nama: 'External Reviewer / Regulator' },
    ],
  });
});

router.get('/role', async (req, res) => {
  try {
    const jabatan = Number(req.query.jabatan || 0);
    if (!jabatan) {
      return res.status(400).json({ success: false, message: 'jabatan wajib diisi' });
    }

    const pool = await getPool();
    const { menuTable, roleTable } = await getAccessTables(pool);
    const result = await pool
      .request()
      .input('jabatan', sql.Int, jabatan)
      .query(`
        SELECT
          m.kode_menu,
          m.nama_menu,
          m.parent_menu,
          m.urut,
          ISNULL(r.can_view, 0) AS can_view,
          ISNULL(r.can_add, 0) AS can_add,
          ISNULL(r.can_edit, 0) AS can_edit,
          ISNULL(r.can_delete, 0) AS can_delete,
          ISNULL(r.can_print, 0) AS can_print,
          ISNULL(r.can_upload, 0) AS can_upload,
          ISNULL(r.can_approve, 0) AS can_approve,
          ISNULL(r.can_koreksi, 0) AS can_koreksi
        FROM ${menuTable} m
        LEFT JOIN ${roleTable} r
          ON r.kode_menu = m.kode_menu
         AND r.jabatan = @jabatan
        WHERE ISNULL(m.aktif, 1) = 1
        ORDER BY m.urut, m.id;
      `);

    return res.json({ success: true, default_level: ROLE_LEVEL[jabatan] || 1, data: result.recordset || [] });
  } catch (err) {
    console.error('GET HAK AKSES ROLE ERROR:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/role/defaults', async (req, res) => {
  let tx;
  try {
    const jabatan = Number(req.body.jabatan || 0);
    if (!jabatan || !ROLE_LEVEL[jabatan]) {
      return res.status(400).json({ success: false, message: 'jabatan tidak valid' });
    }

    const pool = await getPool();
    const { menuTable, roleTable } = await getAccessTables(pool);
    const menuResult = await pool.request().query(`
      SELECT kode_menu, nama_menu, parent_menu
      FROM ${menuTable}
      WHERE ISNULL(aktif, 1) = 1
      ORDER BY urut, id;
    `);

    tx = new sql.Transaction(pool);
    await tx.begin();

    await new sql.Request(tx)
      .input('jabatan', sql.Int, jabatan)
      .query(`DELETE FROM ${roleTable} WHERE jabatan = @jabatan`);

    for (const menu of menuResult.recordset || []) {
      const p = defaultPermissionForJabatan(jabatan, menu);
      if (!Object.values(p).some((v) => Number(v) === 1)) continue;

      const rq = new sql.Request(tx);
      rq.input('level_akses', sql.Int, ROLE_LEVEL[jabatan]);
      rq.input('jabatan', sql.Int, jabatan);
      rq.input('kode_menu', sql.VarChar(80), String(menu.kode_menu || '').trim());
      rq.input('can_view', sql.Bit, p.can_view);
      rq.input('can_add', sql.Bit, p.can_add);
      rq.input('can_edit', sql.Bit, p.can_edit);
      rq.input('can_delete', sql.Bit, p.can_delete);
      rq.input('can_print', sql.Bit, p.can_print);
      rq.input('can_upload', sql.Bit, p.can_upload);
      rq.input('can_approve', sql.Bit, p.can_approve);
      rq.input('can_koreksi', sql.Bit, p.can_koreksi);
      await rq.query(`
        INSERT INTO ${roleTable} (
          level_akses, jabatan, kode_menu,
          can_view, can_add, can_edit, can_delete,
          can_print, can_upload, can_approve, can_koreksi, updated_at
        ) VALUES (
          @level_akses, @jabatan, @kode_menu,
          @can_view, @can_add, @can_edit, @can_delete,
          @can_print, @can_upload, @can_approve, @can_koreksi, GETDATE()
        )
      `);
    }

    await tx.commit();
    return res.json({
      success: true,
      message: 'Default hak akses jabatan berhasil diterapkan',
      default_level: ROLE_LEVEL[jabatan],
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    console.error('APPLY DEFAULT HAK AKSES ERROR:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/role', async (req, res) => {
  let tx;

  try {
    const jabatan = Number(req.body.jabatan || 0);
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    if (!jabatan) {
      return res.status(400).json({ success: false, message: 'jabatan wajib diisi' });
    }

    const pool = await getPool();
    const { roleTable } = await getAccessTables(pool);
    tx = new sql.Transaction(pool);
    await tx.begin();

    for (const p of permissions) {
      const kodeMenu = String(p.kode_menu || '').trim();
      if (!kodeMenu) continue;

      const rq = new sql.Request(tx);
      const isAuditor = jabatan === 19 || jabatan === 20;
      rq.input('level_akses', sql.Int, ROLE_LEVEL[jabatan] || null);
      rq.input('jabatan', sql.Int, jabatan);
      rq.input('kode_menu', sql.VarChar(80), kodeMenu);
      rq.input('can_view', sql.Bit, toBool(p.can_view));
      rq.input('can_add', sql.Bit, isAuditor ? false : toBool(p.can_add));
      rq.input('can_edit', sql.Bit, isAuditor ? false : toBool(p.can_edit));
      rq.input('can_delete', sql.Bit, isAuditor ? false : toBool(p.can_delete));
      rq.input('can_print', sql.Bit, isAuditor ? false : toBool(p.can_print));
      rq.input('can_upload', sql.Bit, isAuditor ? false : toBool(p.can_upload));
      rq.input('can_approve', sql.Bit, isAuditor ? false : toBool(p.can_approve));
      rq.input('can_koreksi', sql.Bit, isAuditor ? false : toBool(p.can_koreksi));

      await rq.query(`
        IF EXISTS (
          SELECT 1 FROM ${roleTable}
          WHERE jabatan = @jabatan AND kode_menu = @kode_menu
        )
        BEGIN
          UPDATE ${roleTable}
          SET level_akses = @level_akses,
              can_view = @can_view,
              can_add = @can_add,
              can_edit = @can_edit,
              can_delete = @can_delete,
              can_print = @can_print,
              can_upload = @can_upload,
              can_approve = @can_approve,
              can_koreksi = @can_koreksi,
              updated_at = GETDATE()
          WHERE jabatan = @jabatan AND kode_menu = @kode_menu
        END
        ELSE
        BEGIN
          INSERT INTO ${roleTable} (
            level_akses, jabatan, kode_menu,
            can_view, can_add, can_edit, can_delete,
            can_print, can_upload, can_approve, can_koreksi, updated_at
          ) VALUES (
            @level_akses, @jabatan, @kode_menu,
            @can_view, @can_add, @can_edit, @can_delete,
            @can_print, @can_upload, @can_approve, @can_koreksi, GETDATE()
          )
        END
      `);
    }

    await tx.commit();
    return res.json({ success: true, message: 'Hak akses jabatan berhasil disimpan' });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    console.error('SAVE HAK AKSES ROLE ERROR:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

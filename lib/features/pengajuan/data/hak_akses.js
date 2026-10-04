const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../core/network/db');
const {
  TENANT_ROLE_TABLE,
  ensureTenantAccessSchema,
  getAccessActor,
  resolveAccessTenant,
} = require('./tenant_access');

const toBool = (v) =>
  v === true || v === 1 || v === '1' || v === 'true';

const quoteIdentifier = (value) => `[${String(value).replace(/]/g, ']]')}]`;

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
  if (!menuTable) {
    throw new Error(
      'Tabel akses_menu tidak ditemukan di database aktif. Pastikan tabel dibuat pada database yang dipakai API Railway.',
    );
  }
  await ensureTenantAccessSchema(pool);
  return { menuTable, roleTable: TENANT_ROLE_TABLE };
}

async function requireAccessAdmin(req, res, next) {
  try {
    const pool = await getPool();
    const actor = await getAccessActor(pool, req);
    if (String(actor.levelid || '').trim() !== '5') {
      return res.status(403).json({
        success: false,
        message: 'Pengaturan hak akses hanya dapat dikelola Administrator.',
      });
    }
    req.accessActor = actor;
    return next();
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Gagal memvalidasi sesi pengguna.',
    });
  }
}

router.use(requireAccessAdmin);

router.get('/level-akses', async (_req, res) => {
  return res.json({
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

router.get('/jabatan', async (_req, res) => {
  return res.json({
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
      return res.status(400).json({
        success: false,
        message: 'jabatan wajib diisi',
      });
    }

    const pool = await getPool();
    const { menuTable } = await getAccessTables(pool);
    const { bprId } = await resolveAccessTenant(pool, req, req.query.bpr_id);

    const result = await pool
      .request()
      .input('jabatan', sql.Int, jabatan)
      .input('bpr_id', sql.VarChar(20), bprId)
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
        LEFT JOIN ${TENANT_ROLE_TABLE} r
          ON r.kode_menu = m.kode_menu
         AND r.jabatan = @jabatan
         AND r.bpr_id = @bpr_id
        WHERE ISNULL(m.aktif, 1) = 1
        ORDER BY m.urut, m.id;
      `);

    return res.json({
      success: true,
      bpr_id: bprId,
      data: result.recordset || [],
    });
  } catch (err) {
    console.error('GET HAK AKSES ROLE ERROR:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Gagal memuat hak akses',
    });
  }
});

router.post('/role', async (req, res) => {
  let tx;

  try {
    const jabatan = Number(req.body.jabatan || 0);
    const permissions = Array.isArray(req.body.permissions)
      ? req.body.permissions
      : [];

    if (!jabatan) {
      return res.status(400).json({
        success: false,
        message: 'jabatan wajib diisi',
      });
    }

    const pool = await getPool();
    await getAccessTables(pool);
    const { bprId } = await resolveAccessTenant(pool, req, req.body.bpr_id);

    tx = new sql.Transaction(pool);
    await tx.begin();

    for (const p of permissions) {
      const kodeMenu = String(p.kode_menu || '').trim();
      if (!kodeMenu) continue;

      const rq = new sql.Request(tx);
      rq.input('bpr_id', sql.VarChar(20), bprId);
      rq.input('jabatan', sql.Int, jabatan);
      rq.input('kode_menu', sql.VarChar(80), kodeMenu);
      const isAuditor = jabatan === 19 || jabatan === 20;
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
          SELECT 1
          FROM ${TENANT_ROLE_TABLE}
          WHERE bpr_id = @bpr_id
            AND jabatan = @jabatan
            AND kode_menu = @kode_menu
        )
        BEGIN
          UPDATE ${TENANT_ROLE_TABLE}
          SET
            can_view = @can_view,
            can_add = @can_add,
            can_edit = @can_edit,
            can_delete = @can_delete,
            can_print = @can_print,
            can_upload = @can_upload,
            can_approve = @can_approve,
            can_koreksi = @can_koreksi,
            updated_at = GETDATE()
          WHERE bpr_id = @bpr_id
            AND jabatan = @jabatan
            AND kode_menu = @kode_menu
        END
        ELSE
        BEGIN
          INSERT INTO ${TENANT_ROLE_TABLE} (
            bpr_id,
            level_akses,
            jabatan,
            kode_menu,
            can_view,
            can_add,
            can_edit,
            can_delete,
            can_print,
            can_upload,
            can_approve,
            can_koreksi,
            updated_at
          )
          VALUES (
            @bpr_id,
            NULL,
            @jabatan,
            @kode_menu,
            @can_view,
            @can_add,
            @can_edit,
            @can_delete,
            @can_print,
            @can_upload,
            @can_approve,
            @can_koreksi,
            GETDATE()
          )
        END
      `);
    }

    await tx.commit();

    return res.json({
      success: true,
      bpr_id: bprId,
      message: `Hak akses jabatan untuk tenant ${bprId} berhasil disimpan`,
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch (_) {}
    }
    console.error('SAVE HAK AKSES ROLE ERROR:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Gagal menyimpan hak akses',
    });
  }
});

module.exports = router;
module.exports.getAccessTables = getAccessTables;

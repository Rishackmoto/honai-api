const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../core/network/db');

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
  try {
    res.json({
      success: true,
      data: [
        { kode: 1, nama: 'Operator' },
        { kode: 2, nama: 'Supervisor' },
        { kode: 3, nama: 'Signer' },
        { kode: 4, nama: 'Approval' },
        { kode: 5, nama: 'Administrator' },
      ],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/jabatan', async (req, res) => {
  try {
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
      ],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/role', async (req, res) => {
  try {
    const levelAkses = Number(req.query.level_akses || 0);
    const jabatan =
      req.query.jabatan === undefined || req.query.jabatan === ''
        ? null
        : Number(req.query.jabatan);

    if (!levelAkses) {
      return res.status(400).json({
        success: false,
        message: 'level_akses wajib diisi',
      });
    }

    const pool = await getPool();
    const { menuTable, roleTable } = await getAccessTables(pool);

    const result = await pool
      .request()
      .input('level_akses', sql.Int, levelAkses)
      .input('jabatan', sql.Int, jabatan)
      .query(`
        WITH selected_role AS (
          SELECT *
          FROM ${roleTable}
          WHERE level_akses = @level_akses
            AND (
                 (@jabatan IS NOT NULL AND jabatan = @jabatan)
                 OR jabatan IS NULL
            )
        ),
        ranked_role AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY kode_menu
              ORDER BY CASE WHEN @jabatan IS NOT NULL AND jabatan = @jabatan THEN 0 ELSE 1 END
            ) AS rn
          FROM selected_role
        )
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
        LEFT JOIN ranked_role r
          ON r.kode_menu = m.kode_menu
         AND r.rn = 1
        WHERE ISNULL(m.aktif, 1) = 1
        ORDER BY m.urut, m.id;
      `);

    return res.json({
      success: true,
      data: result.recordset || [],
    });
  } catch (err) {
    console.error('GET HAK AKSES ROLE ERROR:', err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.post('/role', async (req, res) => {
  let tx;

  try {
    const levelAkses = Number(req.body.level_akses || 0);
    const jabatan =
      req.body.jabatan === undefined ||
      req.body.jabatan === null ||
      req.body.jabatan === ''
        ? null
        : Number(req.body.jabatan);

    const permissions = Array.isArray(req.body.permissions)
      ? req.body.permissions
      : [];

    if (!levelAkses) {
      return res.status(400).json({
        success: false,
        message: 'level_akses wajib diisi',
      });
    }

    const pool = await getPool();
    const { roleTable } = await getAccessTables(pool);
    tx = new sql.Transaction(pool);
    await tx.begin();

    for (const p of permissions) {
      const kodeMenu = String(p.kode_menu || '').trim();
      if (!kodeMenu) continue;

      const rq = new sql.Request(tx);

      rq.input('level_akses', sql.Int, levelAkses);
      rq.input('jabatan', sql.Int, jabatan);
      rq.input('kode_menu', sql.VarChar(80), kodeMenu);
      rq.input('can_view', sql.Bit, toBool(p.can_view));
      rq.input('can_add', sql.Bit, toBool(p.can_add));
      rq.input('can_edit', sql.Bit, toBool(p.can_edit));
      rq.input('can_delete', sql.Bit, toBool(p.can_delete));
      rq.input('can_print', sql.Bit, toBool(p.can_print));
      rq.input('can_upload', sql.Bit, toBool(p.can_upload));
      rq.input('can_approve', sql.Bit, toBool(p.can_approve));
      rq.input('can_koreksi', sql.Bit, toBool(p.can_koreksi));

      await rq.query(`
        IF EXISTS (
          SELECT 1
          FROM ${roleTable}
          WHERE level_akses = @level_akses
            AND kode_menu = @kode_menu
            AND (
                 (@jabatan IS NULL AND jabatan IS NULL)
                 OR jabatan = @jabatan
            )
        )
        BEGIN
          UPDATE ${roleTable}
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
          WHERE level_akses = @level_akses
            AND kode_menu = @kode_menu
            AND (
                 (@jabatan IS NULL AND jabatan IS NULL)
                 OR jabatan = @jabatan
            )
        END
        ELSE
        BEGIN
          INSERT INTO ${roleTable} (
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
            @level_akses,
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
      message: 'Hak akses berhasil disimpan',
    });
  } catch (err) {
    if (tx) {
      try {
        await tx.rollback();
      } catch (_) {}
    }

    console.error('SAVE HAK AKSES ROLE ERROR:', err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;

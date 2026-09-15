const express = require('express');
const { getPool, sql } = require('../../../core/network/db');

const MENU = 'daily_sales_activity';
const TYPES = ['Kunjungan', 'Telepon', 'WhatsApp', 'Pertemuan', 'Follow up'];
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateActivity(body) {
  const data = {};
  for (const [key, max] of Object.entries({ nama_prospek: 150, kontak: 50, lokasi: 250, produk: 100, hasil: 2000, tindak_lanjut: 2000 })) {
    data[key] = String(body[key] ?? '').trim();
    if (data[key].length > max) throw new Error(`${key} maksimal ${max} karakter`);
  }
  if (!data.nama_prospek || !data.produk || !data.hasil) throw new Error('Nama prospek, produk, dan hasil wajib diisi');
  if (!validDate(body.tanggal)) throw new Error('Tanggal aktivitas tidak valid');
  if (!TYPES.includes(body.jenis_aktivitas)) throw new Error('Jenis aktivitas tidak valid');
  if (body.tanggal_follow_up && !validDate(body.tanggal_follow_up)) throw new Error('Tanggal follow up tidak valid');
  if (body.tanggal_follow_up && body.tanggal_follow_up < body.tanggal) throw new Error('Tanggal follow up tidak boleh sebelum aktivitas');
  return { ...data, tanggal: body.tanggal, jenis_aktivitas: body.jenis_aktivitas, tanggal_follow_up: body.tanggal_follow_up || null };
}

function createRouter({ getUserMenuAccess, poolProvider = getPool }) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    try {
      const userid = String(req.get('x-userid') || '').trim();
      if (!userid || userid.length > 30) return res.status(401).json({ success: false, message: 'Sesi pengguna tidak valid' });
      const pool = await poolProvider();
      const result = await pool.request().input('userid', sql.VarChar(30), userid)
        .query("SELECT TOP 1 userid, username, jabat, levelid, kdcab FROM muser WHERE userid = @userid AND ISNULL(flag, '1') = '1'");
      const user = result.recordset[0];
      if (!user) return res.status(401).json({ success: false, message: 'Pengguna tidak aktif' });
      const permissions = await getUserMenuAccess(pool, user);
      const access = permissions.find(p => p.kode_menu === MENU);
      const granted = v => v === true || v === 1;
      if (!granted(access?.can_view) || (req.method === 'POST' && !granted(access?.can_add))) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki hak akses aktivitas harian' });
      }
      req.sales = { pool, user };
      next();
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      if (!validDate(req.query.tanggal)) return res.status(400).json({ success: false, message: 'Tanggal tidak valid' });
      const { pool, user } = req.sales;
      const result = await pool.request().input('userid', sql.VarChar(30), user.userid)
        .input('tanggal', sql.Date, req.query.tanggal)
        .query('SELECT * FROM dbo.daily_sales_activity WHERE userid = @userid AND tanggal = @tanggal ORDER BY id DESC');
      res.json({ success: true, data: result.recordset });
    } catch (error) { next(error); }
  });
  router.post('/', async (req, res, next) => {
    let data;
    try { data = validateActivity(req.body || {}); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    try {
      const { pool, user } = req.sales;
      const request = pool.request().input('userid', sql.VarChar(30), user.userid);
      for (const [key, value] of Object.entries(data)) {
        request.input(key, key.startsWith('tanggal') ? sql.Date : sql.NVarChar, value);
      }
      const result = await request.query(`INSERT INTO dbo.daily_sales_activity
        (userid, tanggal, jenis_aktivitas, nama_prospek, kontak, lokasi, produk, hasil, tindak_lanjut, tanggal_follow_up)
        OUTPUT INSERTED.* VALUES
        (@userid, @tanggal, @jenis_aktivitas, @nama_prospek, @kontak, @lokasi, @produk, @hasil, @tindak_lanjut, @tanggal_follow_up)`);
      res.status(201).json({ success: true, data: result.recordset[0] });
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    console.error('DAILY SALES ERROR:', error);
    res.status(500).json({ success: false, message: 'Gagal memproses aktivitas harian. Silakan coba kembali.' });
  });
  return router;
}
async function initializeDatabase({ getAccessTables }) {
  const pool = await getPool();
  const fs = require('fs');
  const path = require('path');
  await pool.request().query(fs.readFileSync(path.join(__dirname, 'daily_sales_schema.sql'), 'utf8'));
  const tables = await getAccessTables(pool);
  if (!tables) throw new Error('Tabel akses_menu dan akses_role diperlukan untuk Daily Sales Activity');
  const { menuTable, roleTable } = tables;
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM ${menuTable} WHERE kode_menu = '${MENU}')
      INSERT INTO ${menuTable} (kode_menu, nama_menu, parent_menu, urut, aktif)
      VALUES ('${MENU}', 'Daily Sales Activity Report', NULL, 25, 1);
    IF NOT EXISTS (SELECT 1 FROM ${roleTable} WHERE kode_menu = '${MENU}' AND jabatan = 12)
      INSERT INTO ${roleTable} (level_akses, jabatan, kode_menu, can_view, can_add,
        can_edit, can_delete, can_print, can_upload, can_approve, can_koreksi, updated_at)
      VALUES (NULL, 12, '${MENU}', 1, 1, 0, 0, 0, 0, 0, 0, GETDATE());
  `);
}
module.exports = { createRouter, validateActivity, initializeDatabase };

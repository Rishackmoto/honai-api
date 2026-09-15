const express = require('express');
const { getPool, sql } = require('../../../core/network/db');
const multer = require('multer');

const MENU = 'daily_sales_activity';
const REPORT_MENU = 'daily_sales_report';
const LEADERS = [14, 15, 17];
const granted = v => v === true || v === 1;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
function fileType(file) {
  const b = file?.buffer;
  const ext = require('path').extname(file?.originalname || '').toLowerCase();
  if (!b?.length) return null;
  if (ext === '.pdf' && b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (['.jpg', '.jpeg'].includes(ext) && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (ext === '.png' && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return null;
}
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
      const team = req.query.scope === 'team';
      const access = permissions.find(p => p.kode_menu === (team ? REPORT_MENU : MENU));
      if (team && (!LEADERS.includes(Number(user.jabat)) || !String(user.kdcab || '').trim())) {
        return res.status(403).json({ success: false, message: 'Laporan pimpinan hanya untuk SPV/Manager/Direksi dengan cabang yang terdaftar' });
      }
      const action = req.method === 'POST' ? (/\/attachments\/?$/i.test(req.path) ? 'can_upload' : 'can_add') :
        req.query.print === '1' ? 'can_print' : 'can_view';
      if (!granted(access?.can_view) || !granted(access?.[action]) || (team && req.method !== 'GET')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki hak akses aktivitas harian' });
      }
      req.sales = { pool, user, team };
      next();
    } catch (error) { next(error); }
  });
  router.get('/report', async (req, res, next) => {
    try {
      const { from, to, ao } = req.query;
      if (!validDate(from) || !validDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 365) {
        return res.status(400).json({ success: false, message: 'Pilih periode valid maksimal 366 hari' });
      }
      const { pool, user, team } = req.sales;
      const result = await pool.request().input('userid', sql.VarChar(30), user.userid)
        .input('kdcab', sql.VarChar(30), user.kdcab).input('from', sql.Date, from).input('to', sql.Date, to)
        .input('ao', sql.VarChar(30), team && ao ? String(ao).slice(0, 30) : null)
        .query(`SELECT TOP (1001) a.*, u.username AS nama_ao, u.kdcab,
          (SELECT COUNT(*) FROM dbo.daily_sales_attachment f WHERE f.activity_id = a.id) AS jumlah_lampiran
          FROM dbo.daily_sales_activity a INNER JOIN muser u ON u.userid = a.userid
          WHERE a.tanggal BETWEEN @from AND @to AND ${team ? "u.kdcab = @kdcab AND TRY_CONVERT(INT, u.jabat) = 12 AND (@ao IS NULL OR a.userid = @ao)" : 'a.userid = @userid'}
          ORDER BY a.tanggal, a.userid, a.id`);
      if (result.recordset.length > 1000) return res.status(400).json({ success: false, message: 'Lebih dari 1.000 aktivitas. Persempit periode atau pilih AO.' });
      res.json({ success: true, data: result.recordset, owner: { userid: user.userid, username: user.username, kdcab: user.kdcab } });
    } catch (error) { next(error); }
  });

  // Resolve the activity before accepting file bytes or returning attachment data.
  router.use('/:id/attachments', async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.id) || Number(req.params.id) > 2147483647) return res.status(400).json({ success: false, message: 'Aktivitas tidak valid' });
      const { pool, user, team } = req.sales;
      const result = await pool.request().input('id', sql.Int, Number(req.params.id))
        .input('userid', sql.VarChar(30), user.userid).input('kdcab', sql.VarChar(30), user.kdcab)
        .query(`SELECT a.id FROM dbo.daily_sales_activity a INNER JOIN muser u ON u.userid = a.userid
          WHERE a.id = @id AND ${team ? 'u.kdcab = @kdcab AND TRY_CONVERT(INT, u.jabat) = 12' : 'a.userid = @userid'}`);
      if (!result.recordset.length) return res.status(404).json({ success: false, message: 'Aktivitas tidak ditemukan' });
      req.sales.activityId = Number(req.params.id);
      next();
    } catch (error) { next(error); }
  });
  router.get('/:id/attachments', async (req, res, next) => {
    try {
      const result = await req.sales.pool.request().input('id', sql.Int, req.sales.activityId)
        .query('SELECT id, filename, content_type, file_size, created_at FROM dbo.daily_sales_attachment WHERE activity_id = @id ORDER BY id');
      res.json({ success: true, data: result.recordset });
    } catch (error) { next(error); }
  });
  router.post('/:id/attachments', upload.single('file'), async (req, res, next) => {
    try {
      const type = fileType(req.file);
      if (!type) return res.status(400).json({ success: false, message: 'File harus PDF, JPG, atau PNG yang valid (maksimal 5 MB)' });
      const name = req.file.originalname.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180);
      await req.sales.pool.request().input('id', sql.Int, req.sales.activityId)
        .input('filename', sql.NVarChar(180), name).input('type', sql.VarChar(50), type)
        .input('size', sql.Int, req.file.size).input('data', sql.VarBinary(sql.MAX), req.file.buffer)
        .query(`INSERT INTO dbo.daily_sales_attachment (activity_id, filename, content_type, file_size, file_data)
          VALUES (@id, @filename, @type, @size, @data)`);
      res.status(201).json({ success: true });
    } catch (error) { next(error); }
  });
  router.get('/:id/attachments/:fileId', async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.fileId) || Number(req.params.fileId) > 2147483647) return res.status(400).json({ success: false, message: 'Lampiran tidak valid' });
      const result = await req.sales.pool.request().input('id', sql.Int, req.sales.activityId)
        .input('fileId', sql.Int, Number(req.params.fileId))
        .query('SELECT filename, content_type, file_data FROM dbo.daily_sales_attachment WHERE activity_id = @id AND id = @fileId');
      const file = result.recordset[0];
      if (!file) return res.status(404).json({ success: false, message: 'Lampiran tidak ditemukan' });
      res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff')
        .set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
        .type(file.content_type).send(file.file_data);
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
    if (error instanceof multer.MulterError) return res.status(400).json({ success: false, message: 'Upload satu file PDF/JPG/PNG maksimal 5 MB' });
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
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    IF NOT EXISTS (SELECT 1 FROM dbo.daily_sales_migration WITH (UPDLOCK, HOLDLOCK) WHERE version = 2)
    BEGIN
      UPDATE ${roleTable} SET can_print = 1, can_upload = 1, updated_at = GETDATE()
        WHERE kode_menu = '${MENU}' AND jabatan = 12;
      INSERT INTO dbo.daily_sales_migration (version) VALUES (2);
    END;
    IF NOT EXISTS (SELECT 1 FROM ${menuTable} WHERE kode_menu = '${REPORT_MENU}')
      INSERT INTO ${menuTable} (kode_menu, nama_menu, parent_menu, urut, aktif)
      VALUES ('${REPORT_MENU}', 'Laporan DSAR Pimpinan', NULL, 26, 1);
    INSERT INTO ${roleTable} (level_akses, jabatan, kode_menu, can_view, can_add,
        can_edit, can_delete, can_print, can_upload, can_approve, can_koreksi, updated_at)
      SELECT NULL, j.jabatan, '${REPORT_MENU}', 1, 0, 0, 0, 0, 0, 0, 0, GETDATE()
      FROM (VALUES (14), (15), (17)) j(jabatan)
      WHERE NOT EXISTS (SELECT 1 FROM ${roleTable} r WHERE r.kode_menu = '${REPORT_MENU}' AND r.jabatan = j.jabatan);
    COMMIT;
  `);
}
module.exports = { createRouter, validateActivity, initializeDatabase, fileType };

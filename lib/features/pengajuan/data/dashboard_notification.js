const express = require('express');
const router = express.Router();
const { sql, getPool } = require('../../../core/network/db');
const { ensureInAppNotificationTable } = require('./in_app_notification');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function dashboardScope({ userid = '', jabat = '', kdcab = '' } = {}) {
  const role = digits(jabat);
  const user = String(userid || '').trim();
  const branch = String(kdcab || '').trim();

  if (role === '12' && user) {
    return { where: 'p.id_ao = @scope_userid', userid: user, kdcab: null, label: 'Pengajuan AO saya' };
  }
  if (['13', '14', '15'].includes(role) && branch) {
    return { where: "ISNULL(ao.kdcab, '') = @scope_kdcab", userid: null, kdcab: branch, label: `Cabang ${branch}` };
  }
  return { where: '1 = 1', userid: null, kdcab: null, label: 'Seluruh pengajuan' };
}

function pendingStatusesForRole(jabat) {
  switch (digits(jabat)) {
    case '12': return ['2', '5', '6', '90'];
    case '13': return ['1', '3', '91'];
    case '14': return ['10', '4'];
    case '15': return ['7'];
    case '17': return ['9'];
    case '18': return ['11'];
    default: return [];
  }
}

function applyScopeInputs(request, scope) {
  if (scope.userid) request.input('scope_userid', sql.VarChar(30), scope.userid);
  if (scope.kdcab) request.input('scope_kdcab', sql.VarChar(20), scope.kdcab);
  return request;
}

function pendingSql(statuses) {
  if (!statuses.length) return '0';
  return `SUM(CASE WHEN p.stsflag IN (${statuses.map((item) => `'${item}'`).join(',')}) THEN 1 ELSE 0 END)`;
}

function buildMonthlySeries(rows = [], now = new Date()) {
  const values = new Map();
  for (const row of rows) {
    const year = Number(row.tahun);
    const month = Number(row.bulan);
    values.set(`${year}-${month}`, Number(row.total || 0));
  }

  const result = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    result.push({
      year,
      month,
      label: MONTH_NAMES[month - 1],
      total: values.get(`${year}-${month}`) || 0,
    });
  }
  return result;
}

router.get('/api/dashboard/summary', async (req, res) => {
  try {
    const pool = await getPool();
    const context = {
      userid: req.query.userid || req.headers['x-userid'] || '',
      jabat: req.query.jabat || '',
      kdcab: req.query.kdcab || '',
    };
    const scope = dashboardScope(context);
    const pendingStatuses = pendingStatusesForRole(context.jabat);

    const summaryRequest = applyScopeInputs(pool.request(), scope);
    const summary = await summaryRequest.query(`
      SELECT
        COUNT(1) AS total_permohonan,
        SUM(CASE WHEN p.stsflag NOT IN ('0','99','100') THEN 1 ELSE 0 END) AS dalam_proses,
        SUM(CASE WHEN p.stsflag = '100' THEN 1 ELSE 0 END) AS disetujui,
        SUM(CASE WHEN p.stsflag = '99' THEN 1 ELSE 0 END) AS ditolak,
        SUM(CASE WHEN p.stsflag = '0' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN p.stsflag = '1' THEN 1 ELSE 0 END) AS pre_fpk,
        SUM(CASE WHEN p.stsflag = '2' THEN 1 ELSE 0 END) AS fpk_pengajuan,
        SUM(CASE WHEN p.stsflag = '3' THEN 1 ELSE 0 END) AS checklist,
        SUM(CASE WHEN p.stsflag = '4' THEN 1 ELSE 0 END) AS rekap_analisa,
        SUM(CASE WHEN p.stsflag = '5' THEN 1 ELSE 0 END) AS survey_debitur,
        SUM(CASE WHEN p.stsflag = '6' THEN 1 ELSE 0 END) AS survey_agunan,
        SUM(CASE WHEN p.stsflag IN ('7','8') THEN 1 ELSE 0 END) AS muk,
        SUM(CASE WHEN p.stsflag IN ('7','9','11') THEN 1 ELSE 0 END) AS approval_pending,
        ${pendingSql(pendingStatuses)} AS menunggu_tindakan,
        COALESCE(SUM(CASE WHEN p.stsflag NOT IN ('0','99') THEN TRY_CONVERT(DECIMAL(18,2), p.plafon_pengajuan) ELSE 0 END), 0) AS total_plafon_pipeline
      FROM dbo.t_pengajuan p
      LEFT JOIN dbo.muser ao ON p.id_ao = ao.userid
      WHERE ${scope.where}
    `);

    const monthlyRequest = applyScopeInputs(pool.request(), scope);
    const monthlyRows = await monthlyRequest.query(`
      SELECT YEAR(p.tgl_pengajuan) AS tahun,
             MONTH(p.tgl_pengajuan) AS bulan,
             COUNT(1) AS total
      FROM dbo.t_pengajuan p
      LEFT JOIN dbo.muser ao ON p.id_ao = ao.userid
      WHERE ${scope.where}
        AND p.tgl_pengajuan >= DATEADD(MONTH, -5, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
      GROUP BY YEAR(p.tgl_pengajuan), MONTH(p.tgl_pengajuan)
      ORDER BY tahun, bulan
    `);

    const recentRequest = applyScopeInputs(pool.request(), scope);
    const recent = await recentRequest.query(`
      SELECT TOP 8
        p.id_pengajuan,
        p.status_pengajuan,
        p.stsflag,
        p.tgl_pengajuan,
        p.plafon_pengajuan,
        p.id_ao,
        COALESCE(dp.nama_debitur, dbu.nama_perusahaan, '-') AS nama
      FROM dbo.t_pengajuan p
      LEFT JOIN dbo.muser ao ON p.id_ao = ao.userid
      LEFT JOIN dbo.t_debitur_perorangan dp
        ON p.id_pengajuan = CAST(dp.id_pengajuan AS VARCHAR(50))
      LEFT JOIN dbo.t_debitur_badan_usaha dbu
        ON p.id_pengajuan = CAST(dbu.id_pengajuan AS VARCHAR(50))
      WHERE ${scope.where}
      ORDER BY p.tgl_pengajuan DESC, p.id_pengajuan DESC
    `);

    return res.json({
      success: true,
      scope: scope.label,
      role: digits(context.jabat),
      data: summary.recordset[0] || {},
      monthly: buildMonthlySeries(monthlyRows.recordset || []),
      recent: recent.recordset || [],
    });
  } catch (error) {
    console.error('GET DASHBOARD SUMMARY ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat dashboard', error: error.message });
  }
});

router.get('/api/notifications', async (req, res) => {
  try {
    const userid = String(req.query.userid || req.headers['x-userid'] || '').trim();
    if (!userid) return res.status(400).json({ success: false, message: 'userid wajib diisi' });

    const limit = Math.max(1, Math.min(Number(req.query.limit || 30), 100));
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unread_only || '').toLowerCase());
    const pool = await getPool();
    await ensureInAppNotificationTable(pool);

    const request = pool.request()
      .input('userid', sql.VarChar(30), userid)
      .input('limit', sql.Int, limit);
    const result = await request.query(`
      SELECT TOP (@limit)
        id_notification, userid, id_pengajuan, title, message, menu,
        stsflag, event_type, is_read, created_at, read_at
      FROM dbo.t_notification
      WHERE userid = @userid
        ${unreadOnly ? 'AND is_read = 0' : ''}
      ORDER BY created_at DESC, id_notification DESC
    `);

    const count = await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .query('SELECT COUNT(1) AS unread_count FROM dbo.t_notification WHERE userid = @userid AND is_read = 0');

    return res.json({
      success: true,
      unread_count: Number(count.recordset[0]?.unread_count || 0),
      data: result.recordset || [],
    });
  } catch (error) {
    console.error('GET NOTIFICATIONS ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal memuat notifikasi', error: error.message });
  }
});

router.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const userid = String(req.body?.userid || req.headers['x-userid'] || '').trim();
    const id = Number(req.params.id);
    if (!userid || !Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'userid dan id_notification wajib valid' });
    }
    const pool = await getPool();
    await ensureInAppNotificationTable(pool);
    const result = await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .input('id', sql.BigInt, id)
      .query(`
        UPDATE dbo.t_notification
        SET is_read = 1, read_at = COALESCE(read_at, SYSDATETIME())
        WHERE id_notification = @id AND userid = @userid;
        SELECT @@ROWCOUNT AS affected;
      `);
    return res.json({ success: true, affected: Number(result.recordset[0]?.affected || 0) });
  } catch (error) {
    console.error('READ NOTIFICATION ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal menandai notifikasi' });
  }
});

router.put('/api/notifications/read-all', async (req, res) => {
  try {
    const userid = String(req.body?.userid || req.headers['x-userid'] || '').trim();
    if (!userid) return res.status(400).json({ success: false, message: 'userid wajib diisi' });
    const pool = await getPool();
    await ensureInAppNotificationTable(pool);
    await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .query(`
        UPDATE dbo.t_notification
        SET is_read = 1, read_at = COALESCE(read_at, SYSDATETIME())
        WHERE userid = @userid AND is_read = 0
      `);
    return res.json({ success: true });
  } catch (error) {
    console.error('READ ALL NOTIFICATIONS ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal menandai semua notifikasi' });
  }
});

module.exports = router;
module.exports.dashboardScope = dashboardScope;
module.exports.pendingStatusesForRole = pendingStatusesForRole;
module.exports.buildMonthlySeries = buildMonthlySeries;

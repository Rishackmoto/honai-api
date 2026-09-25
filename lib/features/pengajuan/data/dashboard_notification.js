const express = require('express');
const router = express.Router();
const { sql, getPool } = require('../../../core/network/db');
const { ensureInAppNotificationTable } = require('./in_app_notification');
const {
  digits,
  dashboardScope,
  pendingStatusesForRole,
  taskDefinitionsForRole,
  applyTaskCounts,
  buildMonthlySeries,
  pipelinePhaseFromStatus,
} = require('./dashboard_helper');

function applyScopeInputs(request, scope) {
  if (scope.userid) request.input('scope_userid', sql.VarChar(30), scope.userid);
  if (scope.kdcab) request.input('scope_kdcab', sql.VarChar(20), scope.kdcab);
  return request;
}

function pendingSql(statuses) {
  if (!statuses.length) return '0';
  return `SUM(CASE WHEN p.stsflag IN (${statuses.map((item) => `'${item}'`).join(',')}) THEN 1 ELSE 0 END)`;
}

function suppliedUserid(req) {
  return String(
    req.headers['x-userid'] || req.query?.userid || req.body?.userid || '',
  ).trim();
}

function hasUseridMismatch(req) {
  const header = String(req.headers['x-userid'] || '').trim();
  const supplied = String(req.query?.userid || req.body?.userid || '').trim();
  return Boolean(header && supplied && header !== supplied);
}

async function loadTrustedDashboardContext(pool, req) {
  if (hasUseridMismatch(req)) {
    const error = new Error('userid request tidak konsisten');
    error.statusCode = 403;
    throw error;
  }

  const userid = suppliedUserid(req);
  if (!userid) {
    const error = new Error('userid wajib diisi');
    error.statusCode = 400;
    throw error;
  }

  const result = await pool.request()
    .input('userid', sql.VarChar(30), userid)
    .query(`
      SELECT TOP 1 userid, username, jabat, kdcab
      FROM dbo.muser
      WHERE userid = @userid
        AND ISNULL(flag, '1') = '1'
    `);

  const user = result.recordset?.[0];
  if (!user) {
    const error = new Error('User aktif tidak ditemukan');
    error.statusCode = 403;
    throw error;
  }

  return {
    userid: String(user.userid || '').trim(),
    username: String(user.username || '').trim(),
    jabat: digits(user.jabat),
    kdcab: String(user.kdcab || '').trim(),
  };
}

router.get('/api/dashboard/summary', async (req, res) => {
  try {
    const pool = await getPool();
    const context = await loadTrustedDashboardContext(pool, req);
    const scope = dashboardScope(context);
    const taskDefinitions = taskDefinitionsForRole(context.jabat);
    const pendingStatuses = taskDefinitions.map((item) => item.stsflag);

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

    let taskRows = [];
    if (pendingStatuses.length) {
      const taskRequest = applyScopeInputs(pool.request(), scope);
      const taskResult = await taskRequest.query(`
        SELECT p.stsflag, COUNT(1) AS total
        FROM dbo.t_pengajuan p
        LEFT JOIN dbo.muser ao ON p.id_ao = ao.userid
        WHERE ${scope.where}
          AND p.stsflag IN (${pendingStatuses.map((item) => `'${item}'`).join(',')})
        GROUP BY p.stsflag
      `);
      taskRows = taskResult.recordset || [];
    }

    return res.json({
      success: true,
      scope: scope.label,
      role: context.jabat,
      branch: context.kdcab || null,
      context_source: 'server',
      server_time: new Date().toISOString(),
      data: summary.recordset[0] || {},
      tasks: applyTaskCounts(taskDefinitions, taskRows),
      monthly: buildMonthlySeries(monthlyRows.recordset || []),
      recent: recent.recordset || [],
    });
  } catch (error) {
    console.error('GET DASHBOARD SUMMARY ERROR:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Gagal memuat dashboard',
      ...(error.statusCode ? {} : { error: error.message }),
    });
  }
});


router.get('/api/dashboard/pipeline', async (req, res) => {
  try {
    const pool = await getPool();
    const context = await loadTrustedDashboardContext(pool, req);
    const scope = dashboardScope(context);
    const requestedLimit = Number(req.query?.limit || 500);
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1000));

    const request = applyScopeInputs(pool.request(), scope);
    request.input('limit', sql.Int, limit);
    const result = await request.query(`
      SELECT TOP (@limit)
        p.id_pengajuan,
        p.jenis_debitur,
        p.plafon_pengajuan,
        p.status_pengajuan,
        COALESCE(p.stsflag, '0') AS stsflag,
        p.tgl_pengajuan,
        p.id_ao,
        COALESCE(NULLIF(LTRIM(RTRIM(ao.username)), ''), p.id_ao, '-') AS nama_ao,
        ISNULL(ao.kdcab, '') AS kdcab,
        COALESCE(dp.nama_debitur, dbu.nama_perusahaan, '-') AS nama
      FROM dbo.t_pengajuan p
      LEFT JOIN dbo.muser ao ON p.id_ao = ao.userid
      LEFT JOIN dbo.t_debitur_perorangan dp
        ON p.id_pengajuan = CAST(dp.id_pengajuan AS VARCHAR(50))
      LEFT JOIN dbo.t_debitur_badan_usaha dbu
        ON p.id_pengajuan = CAST(dbu.id_pengajuan AS VARCHAR(50))
      WHERE ${scope.where}
      ORDER BY COALESCE(p.tgl_pengajuan, '19000101') DESC, p.id_pengajuan DESC
    `);

    const rows = (result.recordset || []).map((row) => ({
      ...row,
      phase: pipelinePhaseFromStatus(row.stsflag),
    }));

    return res.json({
      success: true,
      scope: scope.label,
      role: context.jabat,
      branch: context.kdcab || null,
      server_time: new Date().toISOString(),
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error('GET DASHBOARD PIPELINE ERROR:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Gagal memuat pipeline kredit',
      ...(error.statusCode ? {} : { error: error.message }),
    });
  }
});

router.get('/api/notifications', async (req, res) => {
  try {
    if (hasUseridMismatch(req)) {
      return res.status(403).json({ success: false, message: 'userid request tidak konsisten' });
    }
    const userid = suppliedUserid(req);
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
      server_time: new Date().toISOString(),
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
    if (hasUseridMismatch(req)) {
      return res.status(403).json({ success: false, message: 'userid request tidak konsisten' });
    }
    const userid = suppliedUserid(req);
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
    const affected = Number(result.recordset[0]?.affected || 0);
    if (!affected) {
      return res.status(404).json({ success: false, message: 'Notifikasi tidak ditemukan untuk user ini', affected: 0 });
    }
    return res.json({ success: true, affected });
  } catch (error) {
    console.error('READ NOTIFICATION ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal menandai notifikasi' });
  }
});

router.put('/api/notifications/read-all', async (req, res) => {
  try {
    if (hasUseridMismatch(req)) {
      return res.status(403).json({ success: false, message: 'userid request tidak konsisten' });
    }
    const userid = suppliedUserid(req);
    if (!userid) return res.status(400).json({ success: false, message: 'userid wajib diisi' });
    const pool = await getPool();
    await ensureInAppNotificationTable(pool);
    const result = await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .query(`
        UPDATE dbo.t_notification
        SET is_read = 1, read_at = COALESCE(read_at, SYSDATETIME())
        WHERE userid = @userid AND is_read = 0;
        SELECT @@ROWCOUNT AS affected;
      `);
    return res.json({ success: true, affected: Number(result.recordset[0]?.affected || 0) });
  } catch (error) {
    console.error('READ ALL NOTIFICATIONS ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal menandai semua notifikasi' });
  }
});

module.exports = router;
module.exports.dashboardScope = dashboardScope;
module.exports.pendingStatusesForRole = pendingStatusesForRole;
module.exports.buildMonthlySeries = buildMonthlySeries;
module.exports.loadTrustedDashboardContext = loadTrustedDashboardContext;

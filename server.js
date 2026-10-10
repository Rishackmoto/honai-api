const express = require('express');
const cors = require('cors');
const path = require('path');

require('./lib/config/env');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// IMPORT ROUTE
const pengajuanRoute = require('./lib/features/pengajuan/data/pengajuan');
const pengajuanStatusRoute = require('./lib/features/pengajuan/data/status');
const listPengajuanRoute = require('./lib/features/pengajuan/data/listpengajuan');
const hakAksesRoute = require('./lib/features/pengajuan/data/hak_akses');
const dailySales = require('./lib/features/pengajuan/data/daily_sales');
const tenantAdminRoute = require('./lib/features/pengajuan/data/tenant_admin');
const notificationDeviceRoute = require('./lib/features/pengajuan/data/notification_device');
const creditScoringRoute = require('./lib/features/pengajuan/data/credit_scoring');
const { sessionMiddleware } = require('./lib/core/security/session_security');
const { corsOptions, securityHeadersMiddleware, corsErrorHandler } = require('./lib/core/security/http_security');
const { createHonaiRateLimiters } = require('./lib/core/security/rate_limit');
const { createPerformanceMonitor } = require('./lib/core/network/performance_monitor');

// MIDDLEWARE - Security Pass 3
// Railway berada di belakang reverse proxy. Satu trusted proxy diperlukan agar
// req.ip dan deteksi HTTPS memakai alamat/protokol klien yang benar.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Performance Pass 1: opt-in latency logs, before API middlewares/routes.
app.use(createPerformanceMonitor());

app.use(securityHeadersMiddleware());

const honaiCorsOptions = corsOptions();
app.use(cors(honaiCorsOptions));

const { login: loginRateLimiter, api: apiRateLimiter, upload: uploadRateLimiter } = createHonaiRateLimiters();

// Login dibatasi terpisah untuk menahan brute-force tanpa mengganggu trafik
// normal aplikasi. API limiter umum melindungi backend/DB dari request burst.
app.use('/api/login', loginRateLimiter);
app.use('/api', apiRateLimiter);

// Payload JSON HONAI seharusnya berupa data/form, bukan file. File wajib lewat
// multipart upload sehingga limit JSON dapat dibuat jauh lebih kecil dari 50 MB.
const jsonLimit = process.env.HONAI_JSON_BODY_LIMIT || '5mb';
app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: jsonLimit }));

// Security Pass 2: seluruh endpoint /api/* protected kecuali allowlist publik.
// Performance Pass 3: measure security middleware independently of route work.
// Preserve sessionMiddleware's original allowlist, checks and error handling.
const honaiSessionGuard = sessionMiddleware();
app.use((req, res, next) => {
  if (process.env.HONAI_PERF_LOG !== 'true') return honaiSessionGuard(req, res, next);
  const started = process.hrtime.bigint();
  const done = (err) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const routeGroup = /^\/api\/pengajuan\/[^/]+$/.test(req.path)
      ? 'draft-detail-or-pengajuan'
      : req.path === '/api/pengajuan/listCheckKelengkapan' ? 'checklist'
      : req.path.startsWith('/api/dashboard/') ? 'dashboard'
      : req.path.startsWith('/api/notifications') ? 'notifications'
      : req.path === '/api/login' ? 'login' : 'other';
    if (ms >= Number(process.env.HONAI_PERF_SLOW_MS || 800) / 4 || routeGroup !== 'other') {
      console.log(`[HONAI PERF3] group=${routeGroup} stage=session ms=${ms.toFixed(1)}`);
    }
    next(err);
  };
  try { return honaiSessionGuard(req, res, done); } catch (err) { return done(err); }
});

// Upload limiter dijalankan setelah sesi tervalidasi supaya key user dapat
// dipercaya. Middleware ini hanya menghitung request multipart POST/PUT/PATCH.
app.use('/api', uploadRateLimiter);

// UPLOAD GAMBAR
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ROUTE
app.use(pengajuanStatusRoute);
app.use(pengajuanRoute);
app.use(listPengajuanRoute);
app.use('/api/parameter/hak-akses', hakAksesRoute);
app.use('/api/hak-akses', hakAksesRoute); // alias supaya frontend lama tetap jalan
app.use('/api/daily-sales', dailySales.createRouter(pengajuanRoute));
app.use(tenantAdminRoute);
app.use(notificationDeviceRoute);
app.use(creditScoringRoute);

// TEST
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send('API HONAI berjalan...');
});


// CORS denial menggunakan error middleware agar response tetap JSON dan tidak
// membocorkan stack trace/default Express error page.
app.use(corsErrorHandler);

// Error boundary terakhir: jangan kirim stack trace / halaman error Express ke
// client production. Error lengkap tetap dicatat di log Railway.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('HONAI UNHANDLED API ERROR:', err);

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      code: 'BODY_TOO_LARGE',
      message: 'Ukuran request terlalu besar.',
    });
  }

  if (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_JSON',
      message: 'Format JSON tidak valid.',
    });
  }

  return res.status(Number(err?.statusCode || err?.status || 500)).json({
    success: false,
    code: err?.code || 'INTERNAL_ERROR',
    message: Number(err?.statusCode || err?.status || 500) >= 500
      ? 'Terjadi gangguan pada HONAI API. Silakan coba kembali.'
      : (err?.message || 'Request tidak dapat diproses.'),
  });
});

// JALANKAN SERVER
(async () => {
  try {
    if (typeof pengajuanRoute.initializeDatabase === 'function') {
      await pengajuanRoute.initializeDatabase();
    }
    await dailySales.initializeDatabase(pengajuanRoute);
    if (typeof notificationDeviceRoute.initializeDatabase === 'function') {
      await notificationDeviceRoute.initializeDatabase();
    }
    if (typeof creditScoringRoute.initializeDatabase === 'function') {
      await creditScoringRoute.initializeDatabase();
    }

    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT}`);
    });
  } catch (error) {
    console.error('STARTUP ERROR:', error);
    process.exit(1);
  }
})();

module.exports = app;

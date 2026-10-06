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
const backupCenterRoute = require('./lib/features/pengajuan/data/backup_center');

// MIDDLEWARE
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-userid', 'x-username', 'x-bpr-id'],
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-userid, x-username, x-bpr-id'
  );
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
app.use(backupCenterRoute);

// TEST
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send('API HONAI berjalan...');
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
    if (typeof backupCenterRoute.initializeDatabase === 'function') {
      await backupCenterRoute.initializeDatabase();
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

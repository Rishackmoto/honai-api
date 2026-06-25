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
const hakAksesRoute = require('./lib/features/parameter/data/hak_akses');

// MIDDLEWARE
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-userid', 'x-username'],
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-userid, x-username'
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

    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT}`);
    });
  } catch (error) {
    console.error('STARTUP ERROR:', error);
    process.exit(1);
  }
})();

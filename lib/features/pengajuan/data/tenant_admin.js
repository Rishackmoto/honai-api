const express = require('express');
const multer = require('multer');
const { getPool, sql } = require('../../../core/network/db');
const { ensureTenantSchema } = require('./tenant');
const { uploadToB2, getSignedB2Url } = require('../../../core/storage/backblaze');

const path = require('path');

const router = express.Router();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },

  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();

    const allowedMime = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'application/octet-stream',
    ];

    const allowedExt = [
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
    ];

    const ok =
      allowedMime.includes(mime) &&
      allowedExt.includes(ext);

    if (!ok) {
      return cb(
        new Error(
          `Logo harus PNG, JPG/JPEG, atau WEBP. File: ${file.originalname}, MIME: ${file.mimetype}`
        ),
        false,
      );
    }

    cb(null, true);
  },
});

function clean(v) { return v == null ? null : String(v).trim(); }
function color(v, fallback) {
  const x = clean(v) || fallback;
  return /^#[0-9A-Fa-f]{6}$/.test(x) ? x.toUpperCase() : fallback;
}
function requestBaseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}
function tenantLogoUrl(req, bprId) {
  const base = requestBaseUrl(req);
  return base ? `${base}/api/tenant/${encodeURIComponent(bprId)}/logo` : null;
}

async function ensureBrandingColumns(pool) {
  await ensureTenantSchema(pool);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','app_name') IS NULL ALTER TABLE dbo.master_bpr ADD app_name NVARCHAR(100) NULL;`);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','tagline') IS NULL ALTER TABLE dbo.master_bpr ADD tagline NVARCHAR(200) NULL;`);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','report_footer') IS NULL ALTER TABLE dbo.master_bpr ADD report_footer NVARCHAR(300) NULL;`);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','logo_key') IS NULL ALTER TABLE dbo.master_bpr ADD logo_key NVARCHAR(500) NULL;`);
}

function withRuntimeLogo(req, row) {
  if (!row) return row;
  const x = { ...row };
  if (clean(x.logo_key)) x.logo_url = tenantLogoUrl(req, x.bpr_id);
  return x;
}

router.get('/api/tenants', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const r = await pool.request().query(`
      SELECT bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
             logo_url,logo_key,primary_color,secondary_color,app_name,tagline,report_footer,aktif,created_at,updated_at
      FROM dbo.master_bpr ORDER BY nama_bpr,bpr_id`);
    res.json({success:true,data:r.recordset.map(x => withRuntimeLogo(req, x))});
  } catch(e) { console.error('TENANTS LIST ERROR',e); res.status(500).json({success:false,message:e.message}); }
});

router.get('/api/tenant/:bprId', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const r = await pool.request().input('bpr_id',sql.VarChar(20),req.params.bprId).query(`
      SELECT TOP 1 bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
             logo_url,logo_key,primary_color,secondary_color,app_name,tagline,report_footer,aktif
      FROM dbo.master_bpr WHERE bpr_id=@bpr_id`);
    if(!r.recordset[0]) return res.status(404).json({success:false,message:'BPR tidak ditemukan'});
    res.json({success:true,data:withRuntimeLogo(req,r.recordset[0])});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// Stable tenant logo endpoint. Bucket stays private; browser is redirected to a short-lived signed B2 URL.
router.get('/api/tenant/:bprId/logo', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const r = await pool.request().input('bpr_id',sql.VarChar(20),String(req.params.bprId).toUpperCase()).query(
      'SELECT TOP 1 logo_key, logo_url FROM dbo.master_bpr WHERE bpr_id=@bpr_id AND aktif=1'
    );
    const row = r.recordset[0];
    if (!row) return res.status(404).send('Logo BPR tidak ditemukan');
    if (clean(row.logo_key)) {
      const signed = await getSignedB2Url(row.logo_key, 300);
      return res.redirect(302, signed);
    }
    if (clean(row.logo_url) && /^https?:\/\//i.test(row.logo_url)) return res.redirect(302, row.logo_url);
    return res.status(404).send('Logo BPR belum diunggah');
  } catch(e) {
    console.error('TENANT LOGO GET ERROR', e);
    res.status(500).send('Gagal membaca logo BPR');
  }
});

router.post('/api/tenants', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const b = req.body || {};
    const bprId = clean(b.bpr_id)?.toUpperCase();
    const nama = clean(b.nama_bpr);
    if(!bprId || !/^[A-Z0-9_-]{2,20}$/.test(bprId)) return res.status(400).json({success:false,message:'BPR ID wajib 2-20 karakter A-Z/0-9/_/-'});
    if(!nama) return res.status(400).json({success:false,message:'Nama BPR wajib diisi'});
    const exists = await pool.request().input('bpr_id',sql.VarChar(20),bprId).query('SELECT TOP 1 1 ok FROM dbo.master_bpr WHERE bpr_id=@bpr_id');
    if(exists.recordset.length) return res.status(409).json({success:false,message:'BPR ID sudah terdaftar'});
    await pool.request()
      .input('bpr_id',sql.VarChar(20),bprId).input('kode_bpr',sql.VarChar(20),clean(b.kode_bpr) || bprId)
      .input('nama_bpr',sql.NVarChar(200),nama).input('nama_singkat',sql.NVarChar(100),clean(b.nama_singkat))
      .input('alamat',sql.NVarChar(500),clean(b.alamat)).input('kota',sql.NVarChar(100),clean(b.kota)).input('provinsi',sql.NVarChar(100),clean(b.provinsi))
      .input('telepon',sql.VarChar(50),clean(b.telepon)).input('email',sql.VarChar(120),clean(b.email)).input('website',sql.VarChar(200),clean(b.website))
      .input('logo_url',sql.NVarChar(500),clean(b.logo_url)).input('primary_color',sql.VarChar(20),color(b.primary_color,'#0D47A1'))
      .input('secondary_color',sql.VarChar(20),color(b.secondary_color,'#D4AF37')).input('app_name',sql.NVarChar(100),clean(b.app_name)||'HONAI')
      .input('tagline',sql.NVarChar(200),clean(b.tagline)||'Solusi Data, Keputusan Tepat').input('report_footer',sql.NVarChar(300),clean(b.report_footer)||nama)
      .query(`INSERT dbo.master_bpr(bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,logo_url,primary_color,secondary_color,app_name,tagline,report_footer,aktif)
              VALUES(@bpr_id,@kode_bpr,@nama_bpr,@nama_singkat,@alamat,@kota,@provinsi,@telepon,@email,@website,@logo_url,@primary_color,@secondary_color,@app_name,@tagline,@report_footer,1)`);
    res.status(201).json({success:true,message:'BPR berhasil ditambahkan',bpr_id:bprId});
  } catch(e) { console.error('TENANT CREATE ERROR',e); res.status(500).json({success:false,message:e.message}); }
});

router.put('/api/tenants/:bprId', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool); const b=req.body||{};
    const id=req.params.bprId.toUpperCase();
    const result=await pool.request()
      .input('bpr_id',sql.VarChar(20),id).input('kode_bpr',sql.VarChar(20),clean(b.kode_bpr))
      .input('nama_bpr',sql.NVarChar(200),clean(b.nama_bpr)).input('nama_singkat',sql.NVarChar(100),clean(b.nama_singkat))
      .input('alamat',sql.NVarChar(500),clean(b.alamat)).input('kota',sql.NVarChar(100),clean(b.kota)).input('provinsi',sql.NVarChar(100),clean(b.provinsi))
      .input('telepon',sql.VarChar(50),clean(b.telepon)).input('email',sql.VarChar(120),clean(b.email)).input('website',sql.VarChar(200),clean(b.website))
      .input('logo_url',sql.NVarChar(500),clean(b.logo_url)).input('primary_color',sql.VarChar(20),color(b.primary_color,'#0D47A1'))
      .input('secondary_color',sql.VarChar(20),color(b.secondary_color,'#D4AF37')).input('app_name',sql.NVarChar(100),clean(b.app_name)||'HONAI')
      .input('tagline',sql.NVarChar(200),clean(b.tagline)||'Solusi Data, Keputusan Tepat').input('report_footer',sql.NVarChar(300),clean(b.report_footer))
      .input('aktif',sql.Bit,b.aktif===false||b.aktif===0?0:1)
      .query(`UPDATE dbo.master_bpr SET kode_bpr=COALESCE(@kode_bpr,kode_bpr),nama_bpr=COALESCE(@nama_bpr,nama_bpr),nama_singkat=@nama_singkat,
              alamat=@alamat,kota=@kota,provinsi=@provinsi,telepon=@telepon,email=@email,website=@website,
              logo_url=COALESCE(@logo_url,logo_url),primary_color=@primary_color,secondary_color=@secondary_color,app_name=@app_name,
              tagline=@tagline,report_footer=@report_footer,aktif=@aktif,updated_at=GETDATE()
              WHERE bpr_id=@bpr_id; SELECT @@ROWCOUNT affected;`);
    if(!(result.recordset[0]?.affected)) return res.status(404).json({success:false,message:'BPR tidak ditemukan'});
    res.json({success:true,message:'Data BPR berhasil diperbarui'});
  } catch(e) { console.error('TENANT UPDATE ERROR',e); res.status(500).json({success:false,message:e.message}); }
});

router.post('/api/tenants/:bprId/logo', logoUpload.single('logo'), async (req,res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({success:false,message:'Pilih file logo terlebih dahulu'});
    const id = String(req.params.bprId || '').trim().toUpperCase();
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const exists = await pool.request().input('bpr_id',sql.VarChar(20),id).query('SELECT TOP 1 bpr_id FROM dbo.master_bpr WHERE bpr_id=@bpr_id');
    if (!exists.recordset[0]) return res.status(404).json({success:false,message:'BPR tidak ditemukan'});

    // Constant object key means replacing a logo overwrites the previous B2 object cleanly.
    const key = `tenant-branding/${id}/logo`;
    await uploadToB2({ key, buffer:req.file.buffer, contentType:req.file.mimetype });
    const logoUrl = tenantLogoUrl(req,id);
    await pool.request()
      .input('bpr_id',sql.VarChar(20),id)
      .input('logo_key',sql.NVarChar(500),key)
      .input('logo_url',sql.NVarChar(500),logoUrl)
      .query('UPDATE dbo.master_bpr SET logo_key=@logo_key, logo_url=@logo_url, updated_at=GETDATE() WHERE bpr_id=@bpr_id');

    res.json({success:true,message:'Logo BPR berhasil diunggah ke B2',logo_key:key,logo_url:logoUrl});
  } catch(e) {
    console.error('TENANT LOGO UPLOAD ERROR',e);
    res.status(500).json({success:false,message:e.message});
  }
});

module.exports = router;

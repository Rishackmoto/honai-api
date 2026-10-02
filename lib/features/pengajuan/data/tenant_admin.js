const express = require('express');
const { getPool, sql } = require('../../../core/network/db');
const { ensureTenantSchema, DEFAULT_BPR_ID } = require('./tenant');

const router = express.Router();

function clean(v) { return v == null ? null : String(v).trim(); }
function color(v, fallback) {
  const x = clean(v) || fallback;
  return /^#[0-9A-Fa-f]{6}$/.test(x) ? x.toUpperCase() : fallback;
}

async function ensureBrandingColumns(pool) {
  await ensureTenantSchema(pool);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','app_name') IS NULL ALTER TABLE dbo.master_bpr ADD app_name NVARCHAR(100) NULL;`);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','tagline') IS NULL ALTER TABLE dbo.master_bpr ADD tagline NVARCHAR(200) NULL;`);
  await pool.request().query(`IF COL_LENGTH('dbo.master_bpr','report_footer') IS NULL ALTER TABLE dbo.master_bpr ADD report_footer NVARCHAR(300) NULL;`);
}

router.get('/api/tenants', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const r = await pool.request().query(`
      SELECT bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
             logo_url,primary_color,secondary_color,app_name,tagline,report_footer,aktif,created_at,updated_at
      FROM dbo.master_bpr ORDER BY nama_bpr,bpr_id`);
    res.json({success:true,data:r.recordset});
  } catch(e) { console.error('TENANTS LIST ERROR',e); res.status(500).json({success:false,message:e.message}); }
});

router.get('/api/tenant/:bprId', async (req,res) => {
  try {
    const pool = await getPool(); await ensureBrandingColumns(pool);
    const r = await pool.request().input('bpr_id',sql.VarChar(20),req.params.bprId).query(`
      SELECT TOP 1 bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
             logo_url,primary_color,secondary_color,app_name,tagline,report_footer,aktif
      FROM dbo.master_bpr WHERE bpr_id=@bpr_id`);
    if(!r.recordset[0]) return res.status(404).json({success:false,message:'BPR tidak ditemukan'});
    res.json({success:true,data:r.recordset[0]});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
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
              alamat=@alamat,kota=@kota,provinsi=@provinsi,telepon=@telepon,email=@email,website=@website,logo_url=@logo_url,
              primary_color=@primary_color,secondary_color=@secondary_color,app_name=@app_name,tagline=@tagline,report_footer=@report_footer,aktif=@aktif,updated_at=GETDATE()
              WHERE bpr_id=@bpr_id; SELECT @@ROWCOUNT affected;`);
    if(!(result.recordset[0]?.affected)) return res.status(404).json({success:false,message:'BPR tidak ditemukan'});
    res.json({success:true,message:'Data BPR berhasil diperbarui'});
  } catch(e) { console.error('TENANT UPDATE ERROR',e); res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;

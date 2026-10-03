const express = require('express');
const multer = require('multer');
const path = require('path');
const { getPool, sql } = require('../../../core/network/db');
const { ensureTenantSchema } = require('./tenant');
const { uploadToB2, getB2Object } = require('../../../core/storage/backblaze');

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
    const allowedExt = ['.png', '.jpg', '.jpeg', '.webp'];

    const ok = allowedMime.includes(mime) && allowedExt.includes(ext);

    if (!ok) {
      return cb(
        new Error(
          `Logo harus PNG, JPG/JPEG, atau WEBP. File: ${file.originalname}, MIME: ${file.mimetype}`
        ),
        false
      );
    }

    cb(null, true);
  },
});

function clean(v) {
  return v == null ? null : String(v).trim();
}


async function requireSuperAdmin(req, res, next) {
  try {
    const userid = String(req.get('x-userid') || '').trim();
    if (!userid) {
      return res.status(401).json({ success: false, message: 'Identitas Super Admin wajib dikirim.' });
    }
    const pool = await getPool();
    await ensureTenantSchema(pool);
    const r = await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .query(`
        SELECT TOP 1 userid, levelid, ISNULL(is_super_admin,0) AS is_super_admin
        FROM dbo.muser
        WHERE userid=@userid AND ISNULL(flag,'1')='1'
      `);
    const user = r.recordset?.[0];
    if (!user || String(user.levelid || '').trim() !== '5' || !Boolean(user.is_super_admin)) {
      return res.status(403).json({ success: false, message: 'Fitur Master BPR hanya untuk Super Admin HONAI.' });
    }
    req.superAdminUser = user;
    return next();
  } catch (e) {
    console.error('SUPER ADMIN CHECK ERROR', e);
    return res.status(500).json({ success: false, message: 'Gagal memvalidasi Super Admin.' });
  }
}

function color(v, fallback) {
  const x = clean(v) || fallback;
  return /^#[0-9A-Fa-f]{6}$/.test(x) ? x.toUpperCase() : fallback;
}

function requestBaseUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  return host ? `${proto}://${host}` : '';
}

function tenantLogoUrl(req, bprId) {
  const base = requestBaseUrl(req);
  return base ? `${base}/api/tenant/${encodeURIComponent(bprId)}/logo` : null;
}

async function ensureBrandingColumns(pool) {
  await ensureTenantSchema(pool);
  await pool.request().query(
    `IF COL_LENGTH('dbo.master_bpr','app_name') IS NULL ALTER TABLE dbo.master_bpr ADD app_name NVARCHAR(100) NULL;`
  );
  await pool.request().query(
    `IF COL_LENGTH('dbo.master_bpr','tagline') IS NULL ALTER TABLE dbo.master_bpr ADD tagline NVARCHAR(200) NULL;`
  );
  await pool.request().query(
    `IF COL_LENGTH('dbo.master_bpr','report_footer') IS NULL ALTER TABLE dbo.master_bpr ADD report_footer NVARCHAR(300) NULL;`
  );
  await pool.request().query(
    `IF COL_LENGTH('dbo.master_bpr','logo_key') IS NULL ALTER TABLE dbo.master_bpr ADD logo_key NVARCHAR(500) NULL;`
  );
}

function withRuntimeLogo(req, row) {
  if (!row) return row;
  const x = { ...row };
  if (clean(x.logo_key)) x.logo_url = tenantLogoUrl(req, x.bpr_id);
  return x;
}

function extensionForLogo(file) {
  const mime = (file?.mimetype || '').toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';

  const ext = path.extname(file?.originalname || '').toLowerCase();
  if (ext === '.jpeg') return '.jpg';
  if (['.png', '.jpg', '.webp'].includes(ext)) return ext;
  return '.png';
}

function contentTypeFromKey(key, fallback) {
  if (fallback && /^image\//i.test(fallback)) return fallback;
  const lower = String(key || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);

  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (typeof body.transformToString === 'function') {
    const text = await body.transformToString();
    return Buffer.from(text);
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

router.get('/api/tenants', requireSuperAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    await ensureBrandingColumns(pool);

    const r = await pool.request().query(`
      SELECT bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
             logo_url,logo_key,primary_color,secondary_color,app_name,tagline,report_footer,aktif,created_at,updated_at
      FROM dbo.master_bpr
      ORDER BY nama_bpr,bpr_id
    `);

    res.json({
      success: true,
      data: r.recordset.map((x) => withRuntimeLogo(req, x)),
    });
  } catch (e) {
    console.error('TENANTS LIST ERROR', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/api/tenant/:bprId', async (req, res) => {
  try {
    const pool = await getPool();
    await ensureBrandingColumns(pool);

    const r = await pool
      .request()
      .input('bpr_id', sql.VarChar(20), String(req.params.bprId || '').toUpperCase())
      .query(`
        SELECT TOP 1
          bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
          logo_url,logo_key,primary_color,secondary_color,app_name,tagline,report_footer,aktif
        FROM dbo.master_bpr
        WHERE bpr_id=@bpr_id
      `);

    if (!r.recordset[0]) {
      return res.status(404).json({
        success: false,
        message: 'BPR tidak ditemukan',
      });
    }

    res.json({
      success: true,
      data: withRuntimeLogo(req, r.recordset[0]),
    });
  } catch (e) {
    console.error('TENANT DETAIL ERROR', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Menyajikan logo private B2 sebagai image inline melalui backend HONAI.
// Ini juga kompatibel dengan logo lama yang key-nya belum memiliki ekstensi.
router.get('/api/tenant/:bprId/logo', async (req, res) => {
  try {
    const id = String(req.params.bprId || '').trim().toUpperCase();

    const pool = await getPool();
    await ensureBrandingColumns(pool);

    const r = await pool
      .request()
      .input('bpr_id', sql.VarChar(20), id)
      .query(`
        SELECT TOP 1 logo_key, logo_url
        FROM dbo.master_bpr
        WHERE bpr_id=@bpr_id AND aktif=1
      `);

    const row = r.recordset[0];
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Logo BPR tidak ditemukan',
      });
    }

    if (clean(row.logo_key)) {
      const { key, result } = await getB2Object(row.logo_key);
      const buffer = await bodyToBuffer(result.Body);

      if (!buffer.length) {
        throw new Error('File logo B2 kosong');
      }

      const contentType = contentTypeFromKey(key, result.ContentType);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      return res.status(200).send(buffer);
    }

    // Kompatibilitas jika tenant lama masih memakai URL eksternal.
    if (clean(row.logo_url) && /^https?:\/\//i.test(row.logo_url)) {
      return res.redirect(302, row.logo_url);
    }

    return res.status(404).json({
      success: false,
      message: 'Logo BPR belum diunggah',
    });
  } catch (e) {
    console.error('TENANT LOGO GET ERROR', e);
    return res.status(500).json({
      success: false,
      message: 'Gagal membaca logo BPR',
      error: e.message,
    });
  }
});

router.post('/api/tenants', requireSuperAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    await ensureBrandingColumns(pool);

    const b = req.body || {};
    const bprId = clean(b.bpr_id)?.toUpperCase();
    const nama = clean(b.nama_bpr);

    if (!bprId || !/^[A-Z0-9_-]{2,20}$/.test(bprId)) {
      return res.status(400).json({
        success: false,
        message: 'BPR ID wajib 2-20 karakter A-Z/0-9/_/-',
      });
    }

    if (!nama) {
      return res.status(400).json({
        success: false,
        message: 'Nama BPR wajib diisi',
      });
    }

    const exists = await pool
      .request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .query('SELECT TOP 1 1 ok FROM dbo.master_bpr WHERE bpr_id=@bpr_id');

    if (exists.recordset.length) {
      return res.status(409).json({
        success: false,
        message: 'BPR ID sudah terdaftar',
      });
    }

    await pool
      .request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('kode_bpr', sql.VarChar(20), clean(b.kode_bpr) || bprId)
      .input('nama_bpr', sql.NVarChar(200), nama)
      .input('nama_singkat', sql.NVarChar(100), clean(b.nama_singkat))
      .input('alamat', sql.NVarChar(500), clean(b.alamat))
      .input('kota', sql.NVarChar(100), clean(b.kota))
      .input('provinsi', sql.NVarChar(100), clean(b.provinsi))
      .input('telepon', sql.VarChar(50), clean(b.telepon))
      .input('email', sql.VarChar(120), clean(b.email))
      .input('website', sql.VarChar(200), clean(b.website))
      .input('logo_url', sql.NVarChar(500), clean(b.logo_url))
      .input('primary_color', sql.VarChar(20), color(b.primary_color, '#0D47A1'))
      .input('secondary_color', sql.VarChar(20), color(b.secondary_color, '#D4AF37'))
      .input('app_name', sql.NVarChar(100), clean(b.app_name) || 'HONAI')
      .input('tagline', sql.NVarChar(200), clean(b.tagline) || 'Solusi Data, Keputusan Tepat')
      .input('report_footer', sql.NVarChar(300), clean(b.report_footer) || nama)
      .query(`
        INSERT dbo.master_bpr(
          bpr_id,kode_bpr,nama_bpr,nama_singkat,alamat,kota,provinsi,telepon,email,website,
          logo_url,primary_color,secondary_color,app_name,tagline,report_footer,aktif
        )
        VALUES(
          @bpr_id,@kode_bpr,@nama_bpr,@nama_singkat,@alamat,@kota,@provinsi,@telepon,@email,@website,
          @logo_url,@primary_color,@secondary_color,@app_name,@tagline,@report_footer,1
        )
      `);

    res.status(201).json({
      success: true,
      message: 'BPR berhasil ditambahkan',
      bpr_id: bprId,
    });
  } catch (e) {
    console.error('TENANT CREATE ERROR', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/api/tenants/:bprId', requireSuperAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    await ensureBrandingColumns(pool);
    const b = req.body || {};
    const id = String(req.params.bprId || '').toUpperCase();

    const result = await pool
      .request()
      .input('bpr_id', sql.VarChar(20), id)
      .input('kode_bpr', sql.VarChar(20), clean(b.kode_bpr))
      .input('nama_bpr', sql.NVarChar(200), clean(b.nama_bpr))
      .input('nama_singkat', sql.NVarChar(100), clean(b.nama_singkat))
      .input('alamat', sql.NVarChar(500), clean(b.alamat))
      .input('kota', sql.NVarChar(100), clean(b.kota))
      .input('provinsi', sql.NVarChar(100), clean(b.provinsi))
      .input('telepon', sql.VarChar(50), clean(b.telepon))
      .input('email', sql.VarChar(120), clean(b.email))
      .input('website', sql.VarChar(200), clean(b.website))
      .input('logo_url', sql.NVarChar(500), clean(b.logo_url))
      .input('primary_color', sql.VarChar(20), color(b.primary_color, '#0D47A1'))
      .input('secondary_color', sql.VarChar(20), color(b.secondary_color, '#D4AF37'))
      .input('app_name', sql.NVarChar(100), clean(b.app_name) || 'HONAI')
      .input('tagline', sql.NVarChar(200), clean(b.tagline) || 'Solusi Data, Keputusan Tepat')
      .input('report_footer', sql.NVarChar(300), clean(b.report_footer))
      .input('aktif', sql.Bit, b.aktif === false || b.aktif === 0 ? 0 : 1)
      .query(`
        UPDATE dbo.master_bpr
        SET
          kode_bpr=COALESCE(@kode_bpr,kode_bpr),
          nama_bpr=COALESCE(@nama_bpr,nama_bpr),
          nama_singkat=@nama_singkat,
          alamat=@alamat,
          kota=@kota,
          provinsi=@provinsi,
          telepon=@telepon,
          email=@email,
          website=@website,
          logo_url=COALESCE(@logo_url,logo_url),
          primary_color=@primary_color,
          secondary_color=@secondary_color,
          app_name=@app_name,
          tagline=@tagline,
          report_footer=@report_footer,
          aktif=@aktif,
          updated_at=GETDATE()
        WHERE bpr_id=@bpr_id;

        SELECT @@ROWCOUNT affected;
      `);

    if (!(result.recordset[0]?.affected)) {
      return res.status(404).json({
        success: false,
        message: 'BPR tidak ditemukan',
      });
    }

    res.json({
      success: true,
      message: 'Data BPR berhasil diperbarui',
    });
  } catch (e) {
    console.error('TENANT UPDATE ERROR', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post(
  '/api/tenants/:bprId/logo',
  requireSuperAdmin,
  (req, res, next) => {
    logoUpload.single('logo')(req, res, (err) => {
      if (!err) return next();

      console.error('TENANT LOGO MULTER ERROR', err);
      return res.status(400).json({
        success: false,
        message: err.message || 'File logo tidak valid',
      });
    });
  },
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({
          success: false,
          message: 'Pilih file logo terlebih dahulu',
        });
      }

      const id = String(req.params.bprId || '').trim().toUpperCase();
      const pool = await getPool();
      await ensureBrandingColumns(pool);

      const exists = await pool
        .request()
        .input('bpr_id', sql.VarChar(20), id)
        .query(
          'SELECT TOP 1 bpr_id FROM dbo.master_bpr WHERE bpr_id=@bpr_id'
        );

      if (!exists.recordset[0]) {
        return res.status(404).json({
          success: false,
          message: 'BPR tidak ditemukan',
        });
      }

      const ext = extensionForLogo(req.file);
      const key = `tenant-branding/${id}/logo${ext}`;

      await uploadToB2({
        key,
        buffer: req.file.buffer,
        contentType:
          req.file.mimetype === 'application/octet-stream'
            ? contentTypeFromKey(key)
            : req.file.mimetype,
        contentDisposition: 'inline',
      });

      const logoUrl = tenantLogoUrl(req, id);

      await pool
        .request()
        .input('bpr_id', sql.VarChar(20), id)
        .input('logo_key', sql.NVarChar(500), key)
        .input('logo_url', sql.NVarChar(500), logoUrl)
        .query(`
          UPDATE dbo.master_bpr
          SET logo_key=@logo_key,
              logo_url=@logo_url,
              updated_at=GETDATE()
          WHERE bpr_id=@bpr_id
        `);

      res.json({
        success: true,
        message: 'Logo BPR berhasil disimpan',
        logo_key: key,
        logo_url: logoUrl,
      });
    } catch (e) {
      console.error('TENANT LOGO UPLOAD ERROR', e);
      res.status(500).json({
        success: false,
        message: e.message,
      });
    }
  }
);

module.exports = router;

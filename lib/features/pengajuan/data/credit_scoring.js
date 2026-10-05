const express = require('express');
const { sql, getPool } = require('../../../core/network/db');
const { resolveRequestTenant } = require('./tenant');

const router = express.Router();
let schemaReady = false;

const DEFAULT_FACTORS = [
  ['SLIK', 'Kualitas SLIK', 25, 'Riwayat kolektibilitas, tunggakan, dan fasilitas berjalan.'],
  ['DSR', 'Kemampuan Bayar / DSR', 20, 'Rasio kewajiban terhadap penghasilan atau arus kas tersedia.'],
  ['CASHFLOW', 'Penghasilan & Cashflow', 15, 'Kecukupan dan kestabilan penghasilan, omzet, laba, atau cashflow.'],
  ['STABILITY', 'Stabilitas Usaha / Pekerjaan', 10, 'Lama usaha/kerja dan keberlanjutan sumber penghasilan.'],
  ['COLLATERAL', 'Agunan / Coverage', 15, 'Coverage nilai agunan setelah adjustment terhadap plafon kredit.'],
  ['CREDIT_HISTORY', 'Riwayat Kredit', 10, 'Pengalaman dan perilaku pembayaran kredit sebelumnya.'],
  ['COMPLETENESS', 'Kelengkapan Dokumen', 5, 'Kelengkapan dan konsistensi dokumen pendukung pengajuan.'],
];

const DEFAULT_GRADES = [
  ['A', 'Risiko Rendah', 85, 100, 'LAYAK DIPERTIMBANGKAN'],
  ['B', 'Risiko Rendah - Menengah', 70, 84.99, 'LAYAK DENGAN REVIEW NORMAL'],
  ['C', 'Perlu Review', 55, 69.99, 'PERLU REVIEW DAN MITIGASI'],
  ['D', 'Risiko Tinggi', 40, 54.99, 'PERLU PERSETUJUAN / MITIGASI KHUSUS'],
  ['E', 'Risiko Sangat Tinggi', 0, 39.99, 'TIDAK DIREKOMENDASIKAN'],
];

async function ensureSchema(pool) {
  if (schemaReady) return;
  await pool.request().query(`
    IF OBJECT_ID('dbo.credit_scoring_factor', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.credit_scoring_factor (
        id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        bpr_id VARCHAR(20) NOT NULL,
        factor_code VARCHAR(40) NOT NULL,
        factor_name NVARCHAR(160) NOT NULL,
        weight DECIMAL(8,2) NOT NULL,
        description NVARCHAR(500) NULL,
        sort_order INT NOT NULL CONSTRAINT DF_credit_scoring_factor_sort DEFAULT 0,
        is_active BIT NOT NULL CONSTRAINT DF_credit_scoring_factor_active DEFAULT 1,
        updated_by VARCHAR(30) NULL,
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_credit_scoring_factor_updated DEFAULT SYSDATETIME()
      );
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name='UX_credit_scoring_factor_bpr_code'
        AND object_id=OBJECT_ID('dbo.credit_scoring_factor')
    )
      CREATE UNIQUE INDEX UX_credit_scoring_factor_bpr_code
      ON dbo.credit_scoring_factor(bpr_id, factor_code);

    IF OBJECT_ID('dbo.credit_scoring_grade', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.credit_scoring_grade (
        id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        bpr_id VARCHAR(20) NOT NULL,
        grade_code VARCHAR(10) NOT NULL,
        grade_name NVARCHAR(120) NOT NULL,
        min_score DECIMAL(8,2) NOT NULL,
        max_score DECIMAL(8,2) NOT NULL,
        recommendation NVARCHAR(300) NULL,
        sort_order INT NOT NULL CONSTRAINT DF_credit_scoring_grade_sort DEFAULT 0,
        is_active BIT NOT NULL CONSTRAINT DF_credit_scoring_grade_active DEFAULT 1,
        updated_by VARCHAR(30) NULL,
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_credit_scoring_grade_updated DEFAULT SYSDATETIME()
      );
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name='UX_credit_scoring_grade_bpr_code'
        AND object_id=OBJECT_ID('dbo.credit_scoring_grade')
    )
      CREATE UNIQUE INDEX UX_credit_scoring_grade_bpr_code
      ON dbo.credit_scoring_grade(bpr_id, grade_code);
  `);
  schemaReady = true;
}

async function actorContext(req) {
  const pool = await getPool();
  await ensureSchema(pool);
  const userid = String(req.get('x-userid') || '').trim();
  if (!userid) {
    const error = new Error('Sesi pengguna tidak teridentifikasi. Silakan login ulang.');
    error.statusCode = 401;
    throw error;
  }
  const bprId = await resolveRequestTenant(pool, req);
  return { pool, userid, bprId };
}

async function ensureDefaults(pool, bprId) {
  const existing = await pool.request()
    .input('bpr_id', sql.VarChar(20), bprId)
    .query(`SELECT COUNT(1) AS total FROM dbo.credit_scoring_factor WHERE bpr_id=@bpr_id;`);

  if (Number(existing.recordset?.[0]?.total || 0) === 0) {
    for (let i = 0; i < DEFAULT_FACTORS.length; i += 1) {
      const [code, name, weight, description] = DEFAULT_FACTORS[i];
      await pool.request()
        .input('bpr_id', sql.VarChar(20), bprId)
        .input('code', sql.VarChar(40), code)
        .input('name', sql.NVarChar(160), name)
        .input('weight', sql.Decimal(8, 2), weight)
        .input('description', sql.NVarChar(500), description)
        .input('sort_order', sql.Int, i + 1)
        .query(`
          INSERT INTO dbo.credit_scoring_factor
            (bpr_id, factor_code, factor_name, weight, description, sort_order, is_active)
          VALUES (@bpr_id, @code, @name, @weight, @description, @sort_order, 1);
        `);
    }
  }

  const gradeExisting = await pool.request()
    .input('bpr_id', sql.VarChar(20), bprId)
    .query(`SELECT COUNT(1) AS total FROM dbo.credit_scoring_grade WHERE bpr_id=@bpr_id;`);

  if (Number(gradeExisting.recordset?.[0]?.total || 0) === 0) {
    for (let i = 0; i < DEFAULT_GRADES.length; i += 1) {
      const [code, name, minScore, maxScore, recommendation] = DEFAULT_GRADES[i];
      await pool.request()
        .input('bpr_id', sql.VarChar(20), bprId)
        .input('code', sql.VarChar(10), code)
        .input('name', sql.NVarChar(120), name)
        .input('min_score', sql.Decimal(8, 2), minScore)
        .input('max_score', sql.Decimal(8, 2), maxScore)
        .input('recommendation', sql.NVarChar(300), recommendation)
        .input('sort_order', sql.Int, i + 1)
        .query(`
          INSERT INTO dbo.credit_scoring_grade
            (bpr_id, grade_code, grade_name, min_score, max_score, recommendation, sort_order, is_active)
          VALUES (@bpr_id, @code, @name, @min_score, @max_score, @recommendation, @sort_order, 1);
        `);
    }
  }
}

async function canManage(pool, userid, bprId) {
  const result = await pool.request()
    .input('userid', sql.VarChar(30), userid)
    .input('bpr_id', sql.VarChar(20), bprId)
    .query(`
      SELECT TOP 1 levelid, jabat, ISNULL(is_super_admin,0) AS is_super_admin
      FROM dbo.muser
      WHERE userid=@userid AND (bpr_id=@bpr_id OR ISNULL(is_super_admin,0)=1);
    `);
  const row = result.recordset?.[0];
  if (!row) return false;
  return String(row.levelid || '').trim() === '5' ||
    ['11', '17'].includes(String(row.jabat || '').trim()) ||
    Number(row.is_super_admin || 0) === 1;
}

router.get('/api/credit-scoring/config', async (req, res) => {
  try {
    const { pool, bprId } = await actorContext(req);
    await ensureDefaults(pool, bprId);
    const [factorsResult, gradesResult] = await Promise.all([
      pool.request().input('bpr_id', sql.VarChar(20), bprId).query(`
        SELECT id, factor_code, factor_name, weight, description, sort_order, is_active, updated_at
        FROM dbo.credit_scoring_factor
        WHERE bpr_id=@bpr_id
        ORDER BY sort_order, id;
      `),
      pool.request().input('bpr_id', sql.VarChar(20), bprId).query(`
        SELECT id, grade_code, grade_name, min_score, max_score, recommendation, sort_order, is_active, updated_at
        FROM dbo.credit_scoring_grade
        WHERE bpr_id=@bpr_id
        ORDER BY sort_order, min_score DESC, id;
      `),
    ]);
    return res.json({ success: true, bpr_id: bprId, factors: factorsResult.recordset, grades: gradesResult.recordset });
  } catch (error) {
    console.error('GET CREDIT SCORING CONFIG ERROR:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Gagal memuat parameter scoring.' });
  }
});

router.put('/api/credit-scoring/config', async (req, res) => {
  try {
    const { pool, userid, bprId } = await actorContext(req);
    if (!(await canManage(pool, userid, bprId))) {
      return res.status(403).json({ success: false, message: 'Anda tidak memiliki kewenangan mengubah Credit Scoring.' });
    }

    const factors = Array.isArray(req.body?.factors) ? req.body.factors : [];
    const grades = Array.isArray(req.body?.grades) ? req.body.grades : [];
    const activeFactors = factors.filter((x) => x?.is_active !== false);
    const totalWeight = activeFactors.reduce((sum, item) => sum + Number(item?.weight || 0), 0);
    if (Math.abs(totalWeight - 100) > 0.01) {
      return res.status(400).json({ success: false, message: `Total bobot faktor aktif harus 100%. Saat ini ${totalWeight.toFixed(2)}%.` });
    }

    for (let i = 0; i < factors.length; i += 1) {
      const item = factors[i] || {};
      const code = String(item.factor_code || '').trim().toUpperCase();
      if (!code) continue;
      await pool.request()
        .input('bpr_id', sql.VarChar(20), bprId)
        .input('code', sql.VarChar(40), code)
        .input('name', sql.NVarChar(160), String(item.factor_name || code).trim())
        .input('weight', sql.Decimal(8, 2), Number(item.weight || 0))
        .input('description', sql.NVarChar(500), String(item.description || '').trim() || null)
        .input('sort_order', sql.Int, Number(item.sort_order || i + 1))
        .input('is_active', sql.Bit, item.is_active === false ? 0 : 1)
        .input('userid', sql.VarChar(30), userid)
        .query(`
          UPDATE dbo.credit_scoring_factor
          SET factor_name=@name, weight=@weight, description=@description,
              sort_order=@sort_order, is_active=@is_active, updated_by=@userid, updated_at=SYSDATETIME()
          WHERE bpr_id=@bpr_id AND factor_code=@code;
        `);
    }

    for (let i = 0; i < grades.length; i += 1) {
      const item = grades[i] || {};
      const code = String(item.grade_code || '').trim().toUpperCase();
      if (!code) continue;
      const minScore = Number(item.min_score || 0);
      const maxScore = Number(item.max_score || 0);
      if (minScore < 0 || maxScore > 100 || minScore > maxScore) {
        return res.status(400).json({ success: false, message: `Rentang grade ${code} tidak valid.` });
      }
      await pool.request()
        .input('bpr_id', sql.VarChar(20), bprId)
        .input('code', sql.VarChar(10), code)
        .input('name', sql.NVarChar(120), String(item.grade_name || code).trim())
        .input('min_score', sql.Decimal(8, 2), minScore)
        .input('max_score', sql.Decimal(8, 2), maxScore)
        .input('recommendation', sql.NVarChar(300), String(item.recommendation || '').trim() || null)
        .input('sort_order', sql.Int, Number(item.sort_order || i + 1))
        .input('is_active', sql.Bit, item.is_active === false ? 0 : 1)
        .input('userid', sql.VarChar(30), userid)
        .query(`
          UPDATE dbo.credit_scoring_grade
          SET grade_name=@name, min_score=@min_score, max_score=@max_score,
              recommendation=@recommendation, sort_order=@sort_order, is_active=@is_active,
              updated_by=@userid, updated_at=SYSDATETIME()
          WHERE bpr_id=@bpr_id AND grade_code=@code;
        `);
    }

    return res.json({ success: true, message: 'Parameter Credit Scoring berhasil disimpan.' });
  } catch (error) {
    console.error('PUT CREDIT SCORING CONFIG ERROR:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Gagal menyimpan parameter scoring.' });
  }
});

router.post('/api/credit-scoring/simulate', async (req, res) => {
  try {
    const { pool, bprId } = await actorContext(req);
    await ensureDefaults(pool, bprId);
    const scores = req.body?.scores && typeof req.body.scores === 'object' ? req.body.scores : {};
    const factorsResult = await pool.request().input('bpr_id', sql.VarChar(20), bprId).query(`
      SELECT factor_code, factor_name, weight
      FROM dbo.credit_scoring_factor
      WHERE bpr_id=@bpr_id AND is_active=1
      ORDER BY sort_order, id;
    `);
    let finalScore = 0;
    const details = factorsResult.recordset.map((factor) => {
      const raw = Math.max(0, Math.min(100, Number(scores[factor.factor_code] || 0)));
      const contribution = raw * Number(factor.weight || 0) / 100;
      finalScore += contribution;
      return { ...factor, score: raw, contribution };
    });
    finalScore = Math.round(finalScore * 100) / 100;
    const gradeResult = await pool.request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('score', sql.Decimal(8, 2), finalScore)
      .query(`
        SELECT TOP 1 grade_code, grade_name, recommendation
        FROM dbo.credit_scoring_grade
        WHERE bpr_id=@bpr_id AND is_active=1 AND @score BETWEEN min_score AND max_score
        ORDER BY min_score DESC;
      `);
    return res.json({ success: true, score: finalScore, grade: gradeResult.recordset?.[0] || null, details });
  } catch (error) {
    console.error('SIMULATE CREDIT SCORING ERROR:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Gagal menghitung simulasi scoring.' });
  }
});

async function initializeDatabase() {
  const pool = await getPool();
  await ensureSchema(pool);
}

module.exports = router;
module.exports.initializeDatabase = initializeDatabase;

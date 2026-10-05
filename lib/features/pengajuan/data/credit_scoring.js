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


    IF OBJECT_ID('dbo.credit_scoring_result', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.credit_scoring_result (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        bpr_id VARCHAR(20) NOT NULL,
        id_pengajuan VARCHAR(50) NOT NULL,
        final_score DECIMAL(8,2) NOT NULL,
        grade_code VARCHAR(10) NULL,
        grade_name NVARCHAR(120) NULL,
        recommendation NVARCHAR(300) NULL,
        factor_snapshot NVARCHAR(MAX) NULL,
        source_snapshot NVARCHAR(MAX) NULL,
        calculated_by VARCHAR(30) NULL,
        calculated_at DATETIME2 NOT NULL CONSTRAINT DF_credit_scoring_result_at DEFAULT SYSDATETIME()
      );
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name='UX_credit_scoring_result_bpr_pengajuan'
        AND object_id=OBJECT_ID('dbo.credit_scoring_result')
    )
      CREATE UNIQUE INDEX UX_credit_scoring_result_bpr_pengajuan
      ON dbo.credit_scoring_result(bpr_id, id_pengajuan);
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


function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

function looseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const normalized = raw
    .replace(/Rp/gi, '')
    .replace(/%/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '.');
  const parsed = Number(normalized.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function yearsFromLoose(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value).trim().toLowerCase();
  if (!text) return 0;
  const years = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(tahun|thn|th)/);
  if (years) return Number(years[1].replace(',', '.')) || 0;
  const months = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*(bulan|bln)/);
  if (months) return (Number(months[1].replace(',', '.')) || 0) / 12;
  return looseNumber(text);
}

function scoreDsr(dsr, available) {
  if (!available) return { score: 0, note: 'DSR belum tersedia.' };
  if (dsr <= 30) return { score: 100, note: `DSR ${dsr.toFixed(2)}% sangat sehat.` };
  if (dsr <= 40) return { score: 85, note: `DSR ${dsr.toFixed(2)}% masih sehat.` };
  if (dsr <= 50) return { score: 65, note: `DSR ${dsr.toFixed(2)}% perlu perhatian.` };
  if (dsr <= 60) return { score: 45, note: `DSR ${dsr.toFixed(2)}% relatif tinggi.` };
  return { score: 20, note: `DSR ${dsr.toFixed(2)}% tinggi.` };
}

function scoreCashflow(penghasilan, sisa, available) {
  if (!available || penghasilan <= 0) return { score: 0, ratio: 0, note: 'Cashflow belum tersedia.' };
  const ratio = (sisa / penghasilan) * 100;
  let score = 0;
  if (ratio >= 40) score = 100;
  else if (ratio >= 30) score = 85;
  else if (ratio >= 20) score = 70;
  else if (ratio >= 10) score = 50;
  else if (ratio > 0) score = 35;
  return { score, ratio, note: `Sisa cashflow ${ratio.toFixed(2)}% dari penghasilan.` };
}

function scoreStability(years, available) {
  if (!available) return { score: 0, note: 'Lama usaha/kerja belum tersedia.' };
  let score = 35;
  if (years >= 5) score = 100;
  else if (years >= 3) score = 85;
  else if (years >= 2) score = 70;
  else if (years >= 1) score = 55;
  return { score, note: `Stabilitas sumber penghasilan ${years.toFixed(1)} tahun.` };
}

function scoreCollateral(coverage, available) {
  if (!available) return { score: 0, note: 'Coverage agunan belum tersedia.' };
  let score = 30;
  if (coverage >= 150) score = 100;
  else if (coverage >= 120) score = 85;
  else if (coverage >= 100) score = 70;
  else if (coverage >= 80) score = 50;
  return { score, note: `Coverage agunan setelah adjustment ${coverage.toFixed(2)}%.` };
}

function slikScores(rows) {
  if (!rows.length) {
    return {
      slik: { score: 0, note: 'Data SLIK belum tersedia.' },
      history: { score: 0, note: 'Riwayat kredit belum tersedia.' },
      maxKolek: 0,
      facilities: 0,
    };
  }
  let maxKolek = 0;
  let facilities = 0;
  let nihil = false;
  for (const row of rows) {
    let data = {};
    try { data = typeof row.slik_data === 'string' ? JSON.parse(row.slik_data) : (row.slik_data || {}); } catch (_) { data = {}; }
    nihil = nihil || data.is_nihil === true || String(data.status_slik || '').toUpperCase() === 'NIHIL';
    const kredit = Array.isArray(data.kredit) ? data.kredit : [];
    facilities += kredit.length;
    for (const item of kredit) {
      const k = Number(item?.kolektibilitas ?? item?.kualitas ?? 0);
      if (Number.isFinite(k) && k > maxKolek) maxKolek = k;
    }
  }
  if (nihil && facilities === 0) {
    return {
      slik: { score: 100, note: 'SLIK nihil / tidak terdapat fasilitas tercatat.' },
      history: { score: 85, note: 'Belum terdapat riwayat fasilitas kredit yang dapat dinilai.' },
      maxKolek: 0,
      facilities,
    };
  }
  const slikMap = { 1: 100, 2: 70, 3: 40, 4: 20, 5: 0 };
  const historyMap = { 1: 100, 2: 65, 3: 35, 4: 15, 5: 0 };
  const effective = maxKolek || 1;
  return {
    slik: { score: slikMap[effective] ?? 50, note: `Kolektibilitas terburuk ${effective}; ${facilities} fasilitas terbaca.` },
    history: { score: historyMap[effective] ?? 50, note: `Riwayat kredit dinilai dari ${facilities} fasilitas SLIK.` },
    maxKolek: effective,
    facilities,
  };
}

function extractCoverage(surveyData) {
  if (!surveyData) return { coverage: 0, count: 0 };
  let parsed = surveyData;
  try { parsed = typeof surveyData === 'string' ? JSON.parse(surveyData) : surveyData; } catch (_) { parsed = {}; }
  const penilaian = Array.isArray(parsed?.penilaian) ? parsed.penilaian : [];
  let totalBinding = 0;
  let maxCoverage = 0;
  let count = 0;
  for (const item of penilaian) {
    const binding = looseNumber(item?.nilai_pengikatan ?? item?.nilai_pengikatan_umum);
    const coverage = looseNumber(item?.coverage_agunan ?? item?.coverage_agunan_umum);
    if (binding > 0) totalBinding += binding;
    if (coverage > maxCoverage) maxCoverage = coverage;
    if (binding > 0 || coverage > 0) count += 1;
  }
  return { totalBinding, coverage: maxCoverage, count };
}

async function calculateActualScore(pool, bprId, idPengajuan) {
  await ensureDefaults(pool, bprId);
  const [appResult, rekapResult, slikResult, surveyAgunanResult, surveyDebiturResult, kelengkapanResult, factorsResult, gradesResult] = await Promise.all([
    pool.request().input('id', sql.VarChar(50), idPengajuan).input('bpr_id', sql.VarChar(20), bprId).query(`
      SELECT TOP 1 p.id_pengajuan, p.jenis_debitur, p.plafon_pengajuan,
             ud.lama_bekerja, ud.lama_usaha, ud.gaji, ud.hasil_usaha,
             bu.lama_usaha AS bu_lama_usaha, bu.total_penghasilan AS bu_total_penghasilan,
             dp.total_penghasilan_debitur, dp.total_biaya_perbulan
      FROM dbo.t_pengajuan p
      LEFT JOIN dbo.t_detail_usaha_debitur ud ON p.id_pengajuan=CAST(ud.id_pengajuan AS VARCHAR(50))
      LEFT JOIN dbo.t_debitur_badan_usaha bu ON p.id_pengajuan=CAST(bu.id_pengajuan AS VARCHAR(50))
      LEFT JOIN dbo.t_debitur_data_penghasilan dp ON p.id_pengajuan=CAST(dp.id_pengajuan AS VARCHAR(50))
      WHERE p.id_pengajuan=@id AND p.bpr_id=@bpr_id;
    `),
    pool.request().input('id', sql.VarChar(50), idPengajuan).query(`IF OBJECT_ID('dbo.t_pengajuan_rekap_analisa','U') IS NOT NULL SELECT TOP 1 penghasilan, biaya, sisa_penghasilan, angsuran, dsr FROM dbo.t_pengajuan_rekap_analisa WHERE id_pengajuan=@id; ELSE SELECT TOP 0 CAST(NULL AS DECIMAL(18,2)) penghasilan, CAST(NULL AS DECIMAL(18,2)) biaya, CAST(NULL AS DECIMAL(18,2)) sisa_penghasilan, CAST(NULL AS DECIMAL(18,2)) angsuran, CAST(NULL AS DECIMAL(9,2)) dsr;`),
    pool.request().input('id', sql.VarChar(50), idPengajuan).query(`IF OBJECT_ID('dbo.t_pengajuan_slik','U') IS NOT NULL SELECT slik_data, created_at FROM dbo.t_pengajuan_slik WHERE CAST(id_pengajuan AS VARCHAR(50))=@id ORDER BY created_at DESC; ELSE SELECT TOP 0 CAST(NULL AS NVARCHAR(MAX)) slik_data, CAST(NULL AS DATETIME2) created_at;`),
    pool.request().input('id', sql.VarChar(50), idPengajuan).query(`IF OBJECT_ID('dbo.t_pengajuan_survey_agunan','U') IS NOT NULL SELECT TOP 1 survey_data FROM dbo.t_pengajuan_survey_agunan WHERE id_pengajuan=@id; ELSE SELECT TOP 0 CAST(NULL AS NVARCHAR(MAX)) survey_data;`),
    pool.request().input('id', sql.VarChar(50), idPengajuan).query(`IF OBJECT_ID('dbo.t_pengajuan_survey_debitur_info','U') IS NOT NULL SELECT TOP 1 id_pengajuan FROM dbo.t_pengajuan_survey_debitur_info WHERE id_pengajuan=@id; ELSE SELECT TOP 0 CAST(NULL AS VARCHAR(50)) id_pengajuan;`),
    pool.request().input('id', sql.VarChar(50), idPengajuan).query(`IF OBJECT_ID('dbo.t_pengajuan_kelengkapan_dokumen','U') IS NOT NULL SELECT COUNT(1) AS total FROM dbo.t_pengajuan_kelengkapan_dokumen WHERE id_pengajuan=@id; ELSE SELECT 0 AS total;`),
    pool.request().input('bpr_id', sql.VarChar(20), bprId).query(`SELECT factor_code, factor_name, weight FROM dbo.credit_scoring_factor WHERE bpr_id=@bpr_id AND is_active=1 ORDER BY sort_order,id;`),
    pool.request().input('bpr_id', sql.VarChar(20), bprId).query(`SELECT grade_code, grade_name, min_score, max_score, recommendation FROM dbo.credit_scoring_grade WHERE bpr_id=@bpr_id AND is_active=1 ORDER BY min_score DESC;`),
  ]);

  const app = appResult.recordset?.[0];
  if (!app) {
    const error = new Error('Pengajuan tidak ditemukan pada tenant/BPR aktif.');
    error.statusCode = 404;
    throw error;
  }
  const rekap = rekapResult.recordset?.[0] || {};
  const dsrValue = looseNumber(rekap.dsr);
  const penghasilan = looseNumber(rekap.penghasilan || app.total_penghasilan_debitur || app.bu_total_penghasilan || app.gaji || app.hasil_usaha);
  const sisa = looseNumber(rekap.sisa_penghasilan || (penghasilan - looseNumber(rekap.biaya || app.total_biaya_perbulan) - looseNumber(rekap.angsuran)));
  const stabilityYears = Math.max(yearsFromLoose(app.lama_bekerja), yearsFromLoose(app.lama_usaha), yearsFromLoose(app.bu_lama_usaha));
  const collateral = extractCoverage(surveyAgunanResult.recordset?.[0]?.survey_data);
  const plafon = looseNumber(app.plafon_pengajuan);
  if (collateral.coverage <= 0 && collateral.totalBinding > 0 && plafon > 0) collateral.coverage = (collateral.totalBinding / plafon) * 100;
  const slik = slikScores(slikResult.recordset || []);
  const docCount = Number(kelengkapanResult.recordset?.[0]?.total || 0);
  const milestones = [
    slikResult.recordset?.length > 0,
    !!rekapResult.recordset?.length,
    !!surveyDebiturResult.recordset?.length,
    !!surveyAgunanResult.recordset?.length,
    docCount > 0,
    stabilityYears > 0 || penghasilan > 0,
  ];
  const completed = milestones.filter(Boolean).length;
  const completenessScore = Math.round((completed / milestones.length) * 100);

  const raw = {
    SLIK: slik.slik,
    DSR: scoreDsr(dsrValue, rekap.dsr !== null && rekap.dsr !== undefined),
    CASHFLOW: scoreCashflow(penghasilan, sisa, penghasilan > 0),
    STABILITY: scoreStability(stabilityYears, stabilityYears > 0),
    COLLATERAL: scoreCollateral(collateral.coverage, collateral.count > 0 || collateral.coverage > 0),
    CREDIT_HISTORY: slik.history,
    COMPLETENESS: { score: completenessScore, note: `${completed}/${milestones.length} komponen proses utama tersedia; ${docCount} dokumen kelengkapan tersimpan.` },
  };

  let finalScore = 0;
  let totalWeight = 0;
  const details = factorsResult.recordset.map((factor) => {
    const code = String(factor.factor_code || '').toUpperCase();
    const source = raw[code] || { score: 0, note: 'Sumber data belum dipetakan.' };
    const weight = Number(factor.weight || 0);
    const score = clampScore(source.score);
    const contribution = score * weight / 100;
    finalScore += contribution;
    totalWeight += weight;
    return {
      factor_code: code,
      factor_name: factor.factor_name,
      weight,
      score,
      contribution: Math.round(contribution * 100) / 100,
      note: source.note,
    };
  });
  finalScore = clampScore(finalScore);
  const grade = gradesResult.recordset.find((g) => finalScore >= Number(g.min_score) && finalScore <= Number(g.max_score)) || null;
  return {
    id_pengajuan: idPengajuan,
    score: finalScore,
    grade,
    details,
    source: {
      dsr: dsrValue,
      penghasilan,
      sisa_penghasilan: sisa,
      stability_years: Math.round(stabilityYears * 100) / 100,
      collateral_coverage: Math.round(collateral.coverage * 100) / 100,
      collateral_binding: collateral.totalBinding,
      slik_worst_kolek: slik.maxKolek,
      slik_facilities: slik.facilities,
      document_count: docCount,
      completeness_components: completed,
      total_weight: totalWeight,
    },
  };
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


router.get('/api/credit-scoring/application/:id', async (req, res) => {
  try {
    const { pool, userid, bprId } = await actorContext(req);
    const result = await calculateActualScore(pool, bprId, String(req.params.id || '').trim());
    const grade = result.grade || {};
    await pool.request()
      .input('bpr_id', sql.VarChar(20), bprId)
      .input('id_pengajuan', sql.VarChar(50), result.id_pengajuan)
      .input('score', sql.Decimal(8, 2), result.score)
      .input('grade_code', sql.VarChar(10), grade.grade_code || null)
      .input('grade_name', sql.NVarChar(120), grade.grade_name || null)
      .input('recommendation', sql.NVarChar(300), grade.recommendation || null)
      .input('factors', sql.NVarChar(sql.MAX), JSON.stringify(result.details))
      .input('sources', sql.NVarChar(sql.MAX), JSON.stringify(result.source))
      .input('userid', sql.VarChar(30), userid)
      .query(`
        MERGE dbo.credit_scoring_result AS target
        USING (SELECT @bpr_id AS bpr_id, @id_pengajuan AS id_pengajuan) AS src
        ON target.bpr_id=src.bpr_id AND target.id_pengajuan=src.id_pengajuan
        WHEN MATCHED THEN UPDATE SET
          final_score=@score, grade_code=@grade_code, grade_name=@grade_name,
          recommendation=@recommendation, factor_snapshot=@factors,
          source_snapshot=@sources, calculated_by=@userid, calculated_at=SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (bpr_id,id_pengajuan,final_score,grade_code,grade_name,recommendation,factor_snapshot,source_snapshot,calculated_by)
          VALUES (@bpr_id,@id_pengajuan,@score,@grade_code,@grade_name,@recommendation,@factors,@sources,@userid);
      `);
    return res.json({ success: true, bpr_id: bprId, ...result });
  } catch (error) {
    console.error('ACTUAL CREDIT SCORING ERROR:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Gagal menghitung Credit Scoring dari data pengajuan.' });
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

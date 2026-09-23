const APPROVAL_ROLES = Object.freeze(['MANAGER', 'DIREKSI', 'KOMISARIS']);
const SOURCE_CATEGORIES = Object.freeze([
  'SEMUA',
  'GAJI',
  'HASIL_USAHA',
  'GAJI_USAHA',
  'PENDAPATAN_LAIN',
  'LAINNYA',
]);
const DEBTOR_CATEGORIES = Object.freeze([
  'SEMUA',
  'PERORANGAN_UMUM',
  'KARYAWAN_INTERNAL',
  'BADAN_USAHA',
]);
const PLAFOND_MODES = Object.freeze([
  'SEMUA',
  'DI_BAWAH_BATAS',
  'MINIMAL_BATAS',
  'CUSTOM',
]);

function boolFlag(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function normalizeRepaymentCategory(value, fallbackText = '') {
  const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const aliases = {
    GAJI: 'GAJI',
    SALARY: 'GAJI',
    USAHA: 'HASIL_USAHA',
    HASIL_USAHA: 'HASIL_USAHA',
    GAJI_DAN_USAHA: 'GAJI_USAHA',
    GAJI_USAHA: 'GAJI_USAHA',
    PENDAPATAN_LAIN: 'PENDAPATAN_LAIN',
    PENDAPATAN_LAINNYA: 'PENDAPATAN_LAIN',
    LAINNYA: 'LAINNYA',
  };
  if (aliases[raw]) return aliases[raw];

  const text = String(fallbackText || value || '').toLowerCase();
  const hasGaji = /gaji|salary|payroll/.test(text);
  const hasUsaha = /usaha|bisnis|dagang|penjualan/.test(text);
  if (hasGaji && hasUsaha) return 'GAJI_USAHA';
  if (hasGaji) return 'GAJI';
  if (hasUsaha) return 'HASIL_USAHA';
  if (/pendapatan|honor|sewa|pensiun/.test(text)) return 'PENDAPATAN_LAIN';
  return 'LAINNYA';
}

function normalizeDebtorCategory(jenisDebitur, isInternal) {
  const jenis = String(jenisDebitur || '').trim().toUpperCase();
  if (jenis === 'BADAN_USAHA') return 'BADAN_USAHA';
  if (boolFlag(isInternal)) return 'KARYAWAN_INTERNAL';
  return 'PERORANGAN_UMUM';
}

function routeFromRule(rule = {}) {
  return APPROVAL_ROLES.filter((role) => {
    if (role === 'MANAGER') return boolFlag(rule.require_manager);
    if (role === 'DIREKSI') return boolFlag(rule.require_direksi);
    return boolFlag(rule.require_komisaris);
  });
}

function normalizeRoute(route = []) {
  const aliases = {
    MANAGER: 'MANAGER',
    DIREKSI: 'DIREKSI',
    KOMISARIS: 'KOMISARIS',
  };
  const values = Array.isArray(route) ? route : [];
  const normalized = new Set();
  for (const item of values) {
    const key = String(item || '').trim().toUpperCase();
    if (aliases[key]) normalized.add(aliases[key]);
  }
  return APPROVAL_ROLES.filter((role) => normalized.has(role));
}

function routeLabel(route = []) {
  const labels = { MANAGER: 'Manager', DIREKSI: 'Direksi', KOMISARIS: 'Komisaris' };
  return normalizeRoute(route).map((r) => labels[r]).join(' → ');
}

function plafondMatches(rule, plafon, threshold) {
  const mode = String(rule.plafon_mode || 'SEMUA').toUpperCase();
  const amount = Number(plafon || 0);
  const limit = Number(threshold || 0);
  if (mode === 'DI_BAWAH_BATAS') return amount < limit;
  if (mode === 'MINIMAL_BATAS') return amount >= limit;
  if (mode === 'CUSTOM') {
    const min = rule.min_plafon == null || rule.min_plafon === '' ? null : Number(rule.min_plafon);
    const max = rule.max_plafon == null || rule.max_plafon === '' ? null : Number(rule.max_plafon);
    if (min != null && Number.isFinite(min) && amount < min) return false;
    if (max != null && Number.isFinite(max) && amount > max) return false;
    return true;
  }
  return true;
}

function ruleMatches(rule, context, threshold) {
  if (!boolFlag(rule.aktif)) return false;
  const category = String(rule.kategori_debitur || 'SEMUA').toUpperCase();
  const source = String(rule.sumber_pengembalian || 'SEMUA').toUpperCase();
  if (category !== 'SEMUA' && category !== context.kategori_debitur) return false;
  if (source !== 'SEMUA' && source !== context.sumber_pengembalian) return false;
  return plafondMatches(rule, context.plafon_pengajuan, threshold);
}

function selectApprovalRule(rules = [], context, threshold) {
  const sorted = [...rules].sort((a, b) => {
    const pa = Number(a.priority ?? 9999);
    const pb = Number(b.priority ?? 9999);
    if (pa !== pb) return pa - pb;
    return Number(a.id_rule ?? 0) - Number(b.id_rule ?? 0);
  });
  return sorted.find((rule) => ruleMatches(rule, context, threshold)) || null;
}

function firstApprovalRole(route) {
  return normalizeRoute(route)[0] || null;
}

function nextApprovalRole(route, currentRole) {
  const normalized = normalizeRoute(route);
  const idx = normalized.indexOf(String(currentRole || '').toUpperCase());
  if (idx < 0) return null;
  return normalized[idx + 1] || null;
}

function statusForRole(role) {
  return ({ MANAGER: '7', DIREKSI: '9', KOMISARIS: '11' })[String(role || '').toUpperCase()] || null;
}

module.exports = {
  APPROVAL_ROLES,
  SOURCE_CATEGORIES,
  DEBTOR_CATEGORIES,
  PLAFOND_MODES,
  boolFlag,
  normalizeRepaymentCategory,
  normalizeDebtorCategory,
  routeFromRule,
  normalizeRoute,
  routeLabel,
  plafondMatches,
  ruleMatches,
  selectApprovalRule,
  firstApprovalRole,
  nextApprovalRole,
  statusForRole,
};

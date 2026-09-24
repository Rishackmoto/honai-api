const assert = require('assert');
const {
  normalizeRepaymentCategory,
  normalizeDebtorCategory,
  selectApprovalRule,
  routeFromRule,
  firstApprovalRole,
  nextApprovalRole,
  statusForRole,
} = require('../lib/features/pengajuan/data/approval_matrix');

const threshold = 100000000;
const rules = [
  { id_rule: 1, priority: 10, aktif: true, nama_rule: '>= batas', kategori_debitur: 'SEMUA', sumber_pengembalian: 'SEMUA', plafon_mode: 'MINIMAL_BATAS', require_manager: true, require_direksi: true, require_komisaris: true },
  { id_rule: 2, priority: 20, aktif: true, nama_rule: 'internal gaji < batas', kategori_debitur: 'KARYAWAN_INTERNAL', sumber_pengembalian: 'GAJI', plafon_mode: 'DI_BAWAH_BATAS', require_manager: true, require_direksi: true, require_komisaris: false },
  { id_rule: 3, priority: 30, aktif: true, nama_rule: 'internal non-gaji < batas', kategori_debitur: 'KARYAWAN_INTERNAL', sumber_pengembalian: 'SEMUA', plafon_mode: 'DI_BAWAH_BATAS', require_manager: true, require_direksi: true, require_komisaris: true },
  { id_rule: 4, priority: 40, aktif: true, nama_rule: 'umum < batas', kategori_debitur: 'SEMUA', sumber_pengembalian: 'SEMUA', plafon_mode: 'DI_BAWAH_BATAS', require_manager: true, require_direksi: true, require_komisaris: false },
];

function route(ctx) {
  const rule = selectApprovalRule(rules, ctx, threshold);
  assert(rule, 'rule harus ditemukan');
  return { rule, route: routeFromRule(rule) };
}

{
  const { rule, route: r } = route({ plafon_pengajuan: 75000000, kategori_debitur: 'PERORANGAN_UMUM', sumber_pengembalian: 'GAJI' });
  assert.equal(rule.id_rule, 4);
  assert.deepEqual(r, ['MANAGER', 'DIREKSI']);
}
{
  const { rule, route: r } = route({ plafon_pengajuan: 100000000, kategori_debitur: 'PERORANGAN_UMUM', sumber_pengembalian: 'GAJI' });
  assert.equal(rule.id_rule, 1);
  assert.deepEqual(r, ['MANAGER', 'DIREKSI', 'KOMISARIS']);
}
{
  const { rule, route: r } = route({ plafon_pengajuan: 50000000, kategori_debitur: 'KARYAWAN_INTERNAL', sumber_pengembalian: 'GAJI' });
  assert.equal(rule.id_rule, 2);
  assert.deepEqual(r, ['MANAGER', 'DIREKSI']);
}
{
  const { rule, route: r } = route({ plafon_pengajuan: 50000000, kategori_debitur: 'KARYAWAN_INTERNAL', sumber_pengembalian: 'HASIL_USAHA' });
  assert.equal(rule.id_rule, 3);
  assert.deepEqual(r, ['MANAGER', 'DIREKSI', 'KOMISARIS']);
}
{
  const managerOnly = { require_manager: true, require_direksi: false, require_komisaris: false };
  const r = routeFromRule(managerOnly);
  assert.deepEqual(r, ['MANAGER']);
  assert.equal(firstApprovalRole(r), 'MANAGER');
  assert.equal(nextApprovalRole(r, 'MANAGER'), null);
  assert.equal(statusForRole(firstApprovalRole(r)), '7');
}
{
  const skipManager = { require_manager: false, require_direksi: true, require_komisaris: true };
  const r = routeFromRule(skipManager);
  assert.deepEqual(r, ['DIREKSI', 'KOMISARIS']);
  assert.equal(statusForRole(firstApprovalRole(r)), '9');
  assert.equal(nextApprovalRole(r, 'DIREKSI'), 'KOMISARIS');
}
assert.equal(normalizeRepaymentCategory('', 'Gaji bulanan BPR ANP'), 'GAJI');
assert.equal(normalizeRepaymentCategory('', 'hasil usaha toko'), 'HASIL_USAHA');
assert.equal(normalizeDebtorCategory('PERORANGAN', true), 'KARYAWAN_INTERNAL');
assert.equal(normalizeDebtorCategory('BADAN_USAHA', false), 'BADAN_USAHA');

console.log('V10.2 approval matrix tests: 10 scenarios passed');

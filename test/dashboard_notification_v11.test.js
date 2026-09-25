const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dashboardScope,
  pendingStatusesForRole,
  buildMonthlySeries,
} = require('../lib/features/pengajuan/data/dashboard_notification');

test('AO dashboard is scoped to own userid', () => {
  const scope = dashboardScope({ userid: 'AO01', jabat: '12', kdcab: '001' });
  assert.match(scope.where, /p\.id_ao/);
  assert.equal(scope.userid, 'AO01');
});

test('Admin, Supervisor and Manager use branch scope when branch exists', () => {
  for (const jabat of ['13', '14', '15']) {
    const scope = dashboardScope({ userid: 'X', jabat, kdcab: '001' });
    assert.match(scope.where, /ao\.kdcab/);
    assert.equal(scope.kdcab, '001');
  }
});

test('Direksi and Komisaris use organization scope', () => {
  assert.equal(dashboardScope({ jabat: '17', kdcab: '001' }).where, '1 = 1');
  assert.equal(dashboardScope({ jabat: '18', kdcab: '001' }).where, '1 = 1');
});

test('role pending statuses are correct for decision makers', () => {
  assert.deepEqual(pendingStatusesForRole('15'), ['7']);
  assert.deepEqual(pendingStatusesForRole('17'), ['9']);
  assert.deepEqual(pendingStatusesForRole('18'), ['11']);
});

test('monthly series always returns six months and fills missing months', () => {
  const now = new Date(2026, 8, 25); // Sep 2026
  const series = buildMonthlySeries([
    { tahun: 2026, bulan: 9, total: 5 },
    { tahun: 2026, bulan: 7, total: 2 },
  ], now);
  assert.equal(series.length, 6);
  assert.equal(series.at(-1).label, 'Sep');
  assert.equal(series.at(-1).total, 5);
  assert.equal(series.find((x) => x.month === 7)?.total, 2);
});

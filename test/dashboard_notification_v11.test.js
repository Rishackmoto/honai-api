const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dashboardScope,
  pendingStatusesForRole,
  taskDefinitionsForRole,
  applyTaskCounts,
  buildMonthlySeries,
} = require('../lib/features/pengajuan/data/dashboard_helper');

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

test('branch role without branch is deny-by-default, not organization-wide', () => {
  for (const jabat of ['13', '14', '15']) {
    assert.equal(dashboardScope({ userid: 'X', jabat, kdcab: '' }).where, '1 = 0');
  }
});

test('Direksi, Komisaris and control roles use organization scope', () => {
  for (const jabat of ['11', '16', '17', '18', '19']) {
    assert.equal(dashboardScope({ userid: 'X', jabat, kdcab: '001' }).where, '1 = 1');
  }
});

test('unknown role is limited to own AO data instead of all organization data', () => {
  const scope = dashboardScope({ userid: 'X01', jabat: '77', kdcab: '001' });
  assert.match(scope.where, /p\.id_ao/);
  assert.equal(scope.userid, 'X01');
});

test('role pending statuses are correct for decision makers', () => {
  assert.deepEqual(pendingStatusesForRole('15'), ['7']);
  assert.deepEqual(pendingStatusesForRole('17'), ['9']);
  assert.deepEqual(pendingStatusesForRole('18'), ['11']);
});

test('task definitions expose role-specific queue menus', () => {
  assert.equal(taskDefinitionsForRole('12').find((x) => x.stsflag === '5')?.menu, 'Survey Debitur');
  assert.equal(taskDefinitionsForRole('14').find((x) => x.stsflag === '10')?.label, 'Approval Awal');
  assert.equal(taskDefinitionsForRole('18')[0]?.label, 'Persetujuan Komisaris');
});

test('task counts fill missing statuses with zero', () => {
  const tasks = applyTaskCounts(taskDefinitionsForRole('13'), [
    { stsflag: '1', total: 3 },
    { stsflag: '91', total: 1 },
  ]);
  assert.equal(tasks.find((x) => x.stsflag === '1')?.count, 3);
  assert.equal(tasks.find((x) => x.stsflag === '3')?.count, 0);
  assert.equal(tasks.find((x) => x.stsflag === '91')?.count, 1);
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

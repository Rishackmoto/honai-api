'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recommendedLevelForJabatan,
  isAuditorUser,
  isExternalReviewer,
  accessWindowState,
} = require('../lib/features/pengajuan/data/user_access_policy');

test('recommended role mapping', () => {
  assert.equal(recommendedLevelForJabatan('12'), '1');
  assert.equal(recommendedLevelForJabatan('14'), '2');
  assert.equal(recommendedLevelForJabatan('16'), '3');
  assert.equal(recommendedLevelForJabatan('15'), '4');
  assert.equal(recommendedLevelForJabatan('17'), '4');
  assert.equal(recommendedLevelForJabatan('18'), '4');
  assert.equal(recommendedLevelForJabatan('11'), '5');
  assert.equal(recommendedLevelForJabatan('19'), '6');
  assert.equal(recommendedLevelForJabatan('20'), '6');
});

test('auditor identification', () => {
  assert.equal(isAuditorUser({ jabat: '19', levelid: '1' }), true);
  assert.equal(isAuditorUser({ jabat: '20', levelid: '1' }), true);
  assert.equal(isAuditorUser({ jabat: '12', levelid: '6' }), true);
  assert.equal(isAuditorUser({ jabat: '17', levelid: '4' }), false);
  assert.equal(isExternalReviewer({ jabat: '20' }), true);
  assert.equal(isExternalReviewer({ jabat: '19' }), false);
});

test('external access window', () => {
  const now = new Date('2026-09-27T12:00:00+09:00');
  assert.equal(accessWindowState({
    access_start_at: '2026-09-27T00:00:00+09:00',
    access_end_at: '2026-09-30T23:59:59+09:00',
  }, now).allowed, true);
  assert.equal(accessWindowState({
    access_start_at: '2026-09-28T00:00:00+09:00',
    access_end_at: '2026-09-30T23:59:59+09:00',
  }, now).reason, 'NOT_STARTED');
  assert.equal(accessWindowState({
    access_start_at: '2026-09-20T00:00:00+09:00',
    access_end_at: '2026-09-26T23:59:59+09:00',
  }, now).reason, 'EXPIRED');
});

test('external reviewer dashboard scope can be branch-limited', () => {
  const { dashboardScope } = require('../lib/features/pengajuan/data/dashboard_helper');
  const branch = dashboardScope({ userid: 'OJK01', jabat: '20', kdcab: '001' });
  assert.equal(branch.kdcab, '001');
  assert.match(branch.label, /Cabang 001/);
  const all = dashboardScope({ userid: 'OJK01', jabat: '20', kdcab: '' });
  assert.equal(all.where, '1 = 1');
});

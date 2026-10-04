const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAccessTenant } = require('../lib/features/pengajuan/data/tenant_access');

test('tenant admin stays in own BPR', () => {
  const d = chooseAccessTenant({ levelid: 5, bpr_id: 'PTA', is_super_admin: 0 }, 'PTA');
  assert.equal(d.allowed, true);
  assert.equal(d.bprId, 'PTA');
  assert.equal(d.isSuperAdmin, false);
});

test('tenant admin cannot configure another BPR', () => {
  const d = chooseAccessTenant({ levelid: 5, bpr_id: 'PTA', is_super_admin: 0 }, 'ANP');
  assert.equal(d.allowed, false);
  assert.equal(d.bprId, 'PTA');
  assert.equal(d.reason, 'CROSS_TENANT_DENIED');
});

test('super admin can configure another BPR', () => {
  const d = chooseAccessTenant({ levelid: 5, bpr_id: 'ANP', is_super_admin: 1 }, 'PTA');
  assert.equal(d.allowed, true);
  assert.equal(d.bprId, 'PTA');
  assert.equal(d.isSuperAdmin, true);
});

test('ordinary user cannot cross tenant', () => {
  const d = chooseAccessTenant({ levelid: 1, bpr_id: 'ANP', is_super_admin: 0 }, 'PTA');
  assert.equal(d.allowed, false);
  assert.equal(d.bprId, 'ANP');
});

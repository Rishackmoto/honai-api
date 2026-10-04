const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseApprovalPolicyTenant } = require('../lib/features/pengajuan/data/approval_matrix_tenant');

test('Admin BPR stays inside own tenant', () => {
  const d = chooseApprovalPolicyTenant({ bpr_id: 'PTA', is_super_admin: false }, 'PTA');
  assert.equal(d.allowed, true);
  assert.equal(d.bprId, 'PTA');
});

test('Admin BPR cannot choose another tenant', () => {
  const d = chooseApprovalPolicyTenant({ bpr_id: 'PTA', is_super_admin: false }, 'ANP');
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'CROSS_TENANT_DENIED');
  assert.equal(d.bprId, 'PTA');
});

test('Super Admin can choose ANP or PTA', () => {
  const anp = chooseApprovalPolicyTenant({ bpr_id: 'ANP', is_super_admin: true }, 'ANP');
  const pta = chooseApprovalPolicyTenant({ bpr_id: 'ANP', is_super_admin: true }, 'PTA');
  assert.equal(anp.allowed, true);
  assert.equal(anp.bprId, 'ANP');
  assert.equal(pta.allowed, true);
  assert.equal(pta.bprId, 'PTA');
});

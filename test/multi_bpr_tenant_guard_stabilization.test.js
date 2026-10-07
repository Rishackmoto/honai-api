'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequestTenant } = require('../lib/features/pengajuan/data/tenant');

function fakePool(userRows = {}) {
  return {
    request() {
      const inputs = {};
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query(text) {
          if (text.includes('FROM dbo.muser')) {
            const row = userRows[String(inputs.userid || '').trim()];
            return { recordset: row ? [row] : [] };
          }
          if (text.includes('FROM dbo.master_bpr')) {
            const id = String(inputs.bpr_id || '').trim();
            return { recordset: id ? [{ bpr_id: id }] : [] };
          }
          return { recordset: [] };
        },
      };
    },
  };
}

function req({ headerUserid = '', headerBprId = '', queryUserid = '', bodyUserid = '' } = {}) {
  return {
    body: bodyUserid ? { userid: bodyUserid } : {},
    query: queryUserid ? { userid: queryUserid } : {},
    get(name) {
      if (name.toLowerCase() === 'x-userid') return headerUserid;
      if (name.toLowerCase() === 'x-bpr-id') return headerBprId;
      return undefined;
    },
  };
}

test('tenant guard rejects operational request without active user context', async () => {
  await assert.rejects(
    () => resolveRequestTenant(fakePool(), req()),
    (error) => error?.code === 'TENANT_USER_REQUIRED' && error?.statusCode === 401,
  );
});

test('tenant guard resolves BPR from active userid', async () => {
  const pool = fakePool({ AO_PTA: { bpr_id: 'PTA' } });
  assert.equal(await resolveRequestTenant(pool, req({ headerUserid: 'AO_PTA' })), 'PTA');
});

test('tenant guard rejects unknown/inactive userid instead of falling back to ANP', async () => {
  await assert.rejects(
    () => resolveRequestTenant(fakePool(), req({ headerUserid: 'UNKNOWN' })),
    (error) => error?.code === 'TENANT_USER_NOT_FOUND',
  );
});


test('super admin can switch to an active selected tenant', async () => {
  const pool = fakePool({ ROOT: { bpr_id: 'ANP', levelid: '5', is_super_admin: 1 } });
  assert.equal(await resolveRequestTenant(pool, req({ headerUserid: 'ROOT', headerBprId: 'PTA' })), 'PTA');
});

test('regular user cannot switch to another tenant', async () => {
  const pool = fakePool({ AO_ANP: { bpr_id: 'ANP', levelid: '2', is_super_admin: 0 } });
  await assert.rejects(
    () => resolveRequestTenant(pool, req({ headerUserid: 'AO_ANP', headerBprId: 'PTA' })),
    (error) => error?.code === 'TENANT_SCOPE_FORBIDDEN' && error?.statusCode === 403,
  );
});

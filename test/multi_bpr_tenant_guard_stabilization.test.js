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
          if (text.includes('SELECT TOP 1 bpr_id') && text.includes('FROM dbo.muser')) {
            const row = userRows[String(inputs.userid || '').trim()];
            return { recordset: row ? [row] : [] };
          }
          return { recordset: [] };
        },
      };
    },
  };
}

function req({ headerUserid = '', queryUserid = '', bodyUserid = '' } = {}) {
  return {
    body: bodyUserid ? { userid: bodyUserid } : {},
    query: queryUserid ? { userid: queryUserid } : {},
    get(name) {
      return name.toLowerCase() === 'x-userid' ? headerUserid : undefined;
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadParameterActor,
  requirePlatformSuperAdmin,
  requireTenantAdministrator,
} = require('../lib/features/pengajuan/data/parameter_access_guard');

function fakePool(rows = {}) {
  return {
    request() {
      const inputs = {};
      return {
        input(name, _type, value) {
          inputs[name] = value;
          return this;
        },
        async query() {
          const row = rows[String(inputs.userid || '').trim()];
          return { recordset: row ? [row] : [] };
        },
      };
    },
  };
}

function req(userid = '') {
  return {
    get(name) {
      return String(name).toLowerCase() === 'x-userid' ? userid : undefined;
    },
  };
}

test('parameter actor requires x-userid', async () => {
  await assert.rejects(
    () => loadParameterActor(fakePool(), req()),
    (error) => error?.statusCode === 401 && error?.code === 'PARAMETER_USER_REQUIRED',
  );
});

test('parameter actor rejects inactive/unknown user', async () => {
  await assert.rejects(
    () => loadParameterActor(fakePool(), req('UNKNOWN')),
    (error) => error?.statusCode === 401 && error?.code === 'PARAMETER_USER_INACTIVE',
  );
});

test('super admin guard accepts only level 5 + is_super_admin', async () => {
  const actor = await loadParameterActor(fakePool({
    ROOT: { userid: 'ROOT', levelid: '5', jabat: '11', bpr_id: 'ANP', is_super_admin: 1 },
  }), req('ROOT'));
  assert.equal(requirePlatformSuperAdmin(actor).userid, 'ROOT');

  assert.throws(
    () => requirePlatformSuperAdmin({ userid: 'ADMIN_PTA', levelid: '5', bpr_id: 'PTA', is_super_admin: false }),
    (error) => error?.statusCode === 403 && error?.code === 'SUPER_ADMIN_REQUIRED',
  );
});

test('tenant administrator guard allows internal admin but not operator', () => {
  assert.equal(
    requireTenantAdministrator({ userid: 'ADMIN_PTA', levelid: '5', bpr_id: 'PTA' }).userid,
    'ADMIN_PTA',
  );
  assert.throws(
    () => requireTenantAdministrator({ userid: 'AO_PTA', levelid: '1', bpr_id: 'PTA' }),
    (error) => error?.statusCode === 403,
  );
});

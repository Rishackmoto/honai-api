const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

// Mock only database imports. Never connect to production for unit tests.
const target = path.resolve(__dirname, '../lib/core/security/session_security.js');
const originalLoad = Module._load;
const sql = { VarChar: x => `VarChar(${x})`, Char: x => `Char(${x})`, Int: 'Int' };
Module._load = function(request, parent, isMain) {
  if (parent && parent.filename === target && request === '../network/db') {
    return { sql, getPool: async () => { throw Error('unexpected db'); } };
  }
  return originalLoad.apply(this, arguments);
};
let api;
try { api = require(target); } finally { Module._load = originalLoad; }

function mockPool(rows) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = [];
      return {
        input(...args) { inputs.push(args); return this; },
        async query(query) {
          calls.push({ query, inputs });
          if (query.includes('CREATE TABLE')) return { recordset: [] };
          return { recordset: rows };
        },
      };
    },
  };
}

test('atomic valid session requires all authorization conditions in one UPDATE', async () => {
  process.env.HONAI_PERF4_SESSION_ATOMIC = 'true';
  const pool = mockPool([{ userid:'abc', session_id:'s1' }]);
  assert.equal((await api.validateSession(pool, 'abc', 'token')).session_id, 's1');
  assert.equal(pool.calls.filter(x => x.query.includes('UPDATE dbo.honai_user_session')).length, 1);
  const sqlText = pool.calls.find(x=>x.query.includes('UPDATE dbo.honai_user_session')).query;
  for (const requirement of ['token_hash = @token_hash', 'revoked_at IS NULL', 'expires_at > SYSDATETIME()', 'last_activity_at > DATEADD', 'OUTPUT inserted.userid']) {
    assert.ok(sqlText.includes(requirement), requirement);
  }
  assert.ok(!pool.calls.some(x=>x.query.includes('SELECT TOP 1')));
});

test('revoked, expired or mismatched token is rejected when update returns no row', async () => {
  const pool = mockPool([]);
  assert.equal(await api.validateSession(pool, 'abc', 'token'), null);
});

test('read-only validation and rollback preserve original SELECT path', async () => {
  const pool = mockPool([{ userid:'abc' }]);
  await api.validateSession(pool, 'abc', 'token', { touch:false });
  assert.ok(pool.calls.some(x=>x.query.includes('SELECT TOP 1')));
  process.env.HONAI_PERF4_SESSION_ATOMIC = 'false';
  const fallback = mockPool([{ userid:'abc' }]);
  await api.validateSession(fallback, 'abc', 'token');
  assert.ok(fallback.calls.some(x=>x.query.includes('SELECT TOP 1')));
  delete process.env.HONAI_PERF4_SESSION_ATOMIC;
});

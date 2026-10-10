const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchemaCheckCache } = require('../lib/core/network/schema_check_cache');
test('caches only successful check until TTL', async () => {
  let calls=0, now=100;
  const f=createSchemaCheckCache(async()=>{calls++;}, {ttlMs:1000, clock:()=>now});
  await f(null); await f(null); assert.equal(calls,1);
  now=1101; await f(null); assert.equal(calls,2);
});
test('deduplicates concurrent cold checks', async () => {
  let calls=0;
  const f=createSchemaCheckCache(async()=>{calls++;await new Promise(r=>setTimeout(r,10));});
  await Promise.all(Array.from({length:8},()=>f(null)));
  assert.equal(calls,1);
});
test('failed check is retried', async () => {
  let calls=0; const f=createSchemaCheckCache(async()=>{if(++calls===1)throw Error('db');});
  await assert.rejects(f(null),/db/); await f(null); assert.equal(calls,2);
});
test('zero ttl disables cache', async () => {
  let calls=0; const f=createSchemaCheckCache(async()=>{calls++;},{ttlMs:0});
  await f(); await f(); assert.equal(calls,2);
});

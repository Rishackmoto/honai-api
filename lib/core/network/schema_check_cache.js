'use strict';
/** Per-process successful schema-check cache, with concurrent-call deduplication. */
function createSchemaCheckCache(check, { ttlMs = 600000, clock = Date.now } = {}) {
  if (typeof check !== 'function') throw new TypeError('check must be a function');
  const duration = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  let validUntil = 0;
  let pending = null;
  return async function ensure(pool) {
    if (duration > 0 && validUntil > clock()) return;
    if (pending) return pending;
    pending = (async () => {
      await check(pool);
      validUntil = duration > 0 ? clock() + duration : 0;
    })();
    try { await pending; } finally { pending = null; }
  };
}
module.exports = { createSchemaCheckCache };

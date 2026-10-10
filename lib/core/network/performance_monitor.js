'use strict';

// Performance Pass 1: opt-in request timing, without logging user data,
// authorization headers, query strings or request bodies.
function createPerformanceMonitor({ enabled = process.env.HONAI_PERF_LOG === 'true',
  slowMs = Number(process.env.HONAI_PERF_SLOW_MS || 800),
  logger = console.info } = {}) {
  const threshold = Number.isFinite(slowMs) && slowMs >= 0 ? slowMs : 800;
  return (req, res, next) => {
    if (!enabled || !req.path.startsWith('/api/')) return next();
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms < threshold && res.statusCode < 500) return;
      // Express route.path removes raw IDs where a route was matched.
      // For unmatched endpoints use only a constant placeholder.
      const routePath = req.route?.path;
      const safePath = typeof routePath === 'string'
        ? `${req.baseUrl || ''}${routePath}`
        : '[unmatched]';
      logger(`[HONAI PERF] ${req.method} ${safePath} status=${res.statusCode} ms=${ms.toFixed(1)}`);
    });
    next();
  };
}
module.exports = { createPerformanceMonitor };

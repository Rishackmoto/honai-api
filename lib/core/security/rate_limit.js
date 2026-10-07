function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientKey(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 96);
  return ip || 'unknown';
}

function createRateLimiter({
  windowMs,
  max,
  prefix = 'api',
  keyGenerator = clientKey,
  skip = () => false,
  message = 'Terlalu banyak request. Silakan coba beberapa saat lagi.',
  code = 'RATE_LIMITED',
  maxEntries = 20000,
} = {}) {
  const records = new Map();
  let lastSweep = 0;

  const safeWindowMs = positiveInt(windowMs, 60_000);
  const safeMax = positiveInt(max, 300);

  function sweep(now) {
    if (now - lastSweep < Math.min(safeWindowMs, 60_000) && records.size < maxEntries) return;
    lastSweep = now;
    for (const [key, value] of records.entries()) {
      if (!value || value.resetAt <= now) records.delete(key);
    }
    if (records.size > maxEntries) {
      const overflow = records.size - maxEntries;
      let removed = 0;
      for (const key of records.keys()) {
        records.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  return (req, res, next) => {
    try {
      if (skip(req)) return next();

      const now = Date.now();
      sweep(now);
      const rawKey = String(keyGenerator(req) || 'unknown');
      const key = `${prefix}:${rawKey}`;
      let entry = records.get(key);

      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + safeWindowMs };
        records.set(key, entry);
      }

      entry.count += 1;
      const remaining = Math.max(0, safeMax - entry.count);
      const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

      res.setHeader('RateLimit-Limit', String(safeMax));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(resetSeconds));

      if (entry.count > safeMax) {
        res.setHeader('Retry-After', String(resetSeconds));
        return res.status(429).json({
          success: false,
          code,
          message,
          retry_after_seconds: resetSeconds,
        });
      }

      return next();
    } catch (error) {
      console.error('HONAI RATE LIMIT ERROR:', error);
      return next();
    }
  };
}

function isMultipartMutation(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return false;
  return /^multipart\/form-data\b/i.test(String(req.get('content-type') || ''));
}

function createHonaiRateLimiters() {
  const loginWindowMin = positiveInt(process.env.HONAI_LOGIN_RATE_WINDOW_MIN, 15);
  const loginMax = positiveInt(process.env.HONAI_LOGIN_RATE_MAX, 12);
  const apiWindowMin = positiveInt(process.env.HONAI_API_RATE_WINDOW_MIN, 1);
  const apiMax = positiveInt(process.env.HONAI_API_RATE_MAX, 600);
  const uploadWindowMin = positiveInt(process.env.HONAI_UPLOAD_RATE_WINDOW_MIN, 10);
  const uploadMax = positiveInt(process.env.HONAI_UPLOAD_RATE_MAX, 40);

  const login = createRateLimiter({
    prefix: 'login',
    windowMs: loginWindowMin * 60_000,
    max: loginMax,
    message: 'Terlalu banyak percobaan login dari perangkat/jaringan ini. Tunggu beberapa menit lalu coba lagi.',
    code: 'LOGIN_RATE_LIMITED',
  });

  const api = createRateLimiter({
    prefix: 'api',
    windowMs: apiWindowMin * 60_000,
    max: apiMax,
    skip: (req) => req.method === 'OPTIONS' || String(req.originalUrl || '').split('?')[0] === '/api/login',
    message: 'Terlalu banyak request ke HONAI API. Silakan ulangi sebentar lagi.',
    code: 'API_RATE_LIMITED',
  });

  const upload = createRateLimiter({
    prefix: 'upload',
    windowMs: uploadWindowMin * 60_000,
    max: uploadMax,
    skip: (req) => !isMultipartMutation(req),
    keyGenerator: (req) => {
      const userid = String(req.get('x-userid') || 'anonymous').trim().slice(0, 40);
      return `${userid}:${clientKey(req)}`;
    },
    message: 'Upload terlalu sering. Tunggu beberapa saat sebelum mengirim file lagi.',
    code: 'UPLOAD_RATE_LIMITED',
  });

  return { login, api, upload };
}

module.exports = {
  createRateLimiter,
  createHonaiRateLimiters,
  isMultipartMutation,
};

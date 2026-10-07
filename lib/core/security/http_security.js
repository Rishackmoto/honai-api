const DEFAULT_ALLOWED_ORIGINS = ['https://honai.bankanp.com'];

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function allowedOrigins() {
  const raw = String(process.env.HONAI_ALLOWED_ORIGINS || '').trim();
  const configured = raw
    ? raw.split(',').map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  return new Set(configured);
}

function isLocalOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function corsOptions() {
  const allowAll = envBool('HONAI_CORS_ALLOW_ALL', false);
  const allowLocalhost = envBool('HONAI_ALLOW_LOCALHOST_ORIGIN', false);
  const allowlist = allowedOrigins();

  return {
    origin(origin, callback) {
      // Native/mobile clients normally do not send Origin. They are still
      // protected by HONAI's server-side session token.
      if (!origin) return callback(null, true);
      if (allowAll) return callback(null, true);
      if (allowlist.has(origin)) return callback(null, true);
      if (allowLocalhost && isLocalOrigin(origin)) return callback(null, true);

      const error = new Error('Origin tidak diizinkan oleh HONAI CORS policy.');
      error.code = 'HONAI_CORS_DENIED';
      return callback(error);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-userid',
      'x-username',
      'x-bpr-id',
      'x-session-token',
      'x-requested-with',
    ],
    exposedHeaders: [
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
      'Server-Timing',
      'X-Honai-Save-Ms',
    ],
    maxAge: 600,
    optionsSuccessStatus: 204,
    credentials: false,
  };
}

function requestUsesHttps(req) {
  if (req.secure) return true;
  const forwarded = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https';
}

function securityHeadersMiddleware() {
  return (req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // File preview lama masih dapat dibuka sebagai iframe/document. Jangan
    // memberi X-Frame-Options pada stream tersebut agar fallback preview tidak
    // rusak. Endpoint JSON lain tetap tidak boleh di-frame.
    const pathname = req.path || String(req.originalUrl || '').split('?')[0];
    const renderableAsset = pathname === '/api/files/view' || /^\/api\/tenant\/[^/]+\/logo$/.test(pathname);
    if (!renderableAsset) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    }

    // Railway / reverse proxy terminates TLS before Node. Honor the forwarded
    // protocol and only emit HSTS when the original request was HTTPS.
    if (requestUsesHttps(req)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}

function corsErrorHandler(err, req, res, next) {
  if (err?.code !== 'HONAI_CORS_DENIED') return next(err);
  return res.status(403).json({
    success: false,
    code: 'CORS_DENIED',
    message: 'Origin aplikasi tidak diizinkan mengakses HONAI API.',
  });
}

module.exports = {
  corsOptions,
  securityHeadersMiddleware,
  corsErrorHandler,
  allowedOrigins,
};

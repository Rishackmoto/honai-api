const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TYPE,
  UploadSecurityError,
  validateUploadedFile,
  secureStoredFilename,
} = require('../lib/core/security/upload_security');
const { corsOptions } = require('../lib/core/security/http_security');
const { createRateLimiter } = require('../lib/core/security/rate_limit');

test('upload hardening menerima PDF valid dan canonical MIME', () => {
  const file = {
    originalname: 'rekening.pdf',
    mimetype: 'application/octet-stream',
    buffer: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'ascii'),
  };
  validateUploadedFile(file, { allowedTypes: [TYPE.PDF] });
  assert.equal(file.mimetype, 'application/pdf');
  assert.equal(file.honaiExtension, '.pdf');
});

test('upload hardening menolak file palsu walau ekstensi PDF', () => {
  const file = {
    originalname: 'evil.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('<script>alert(1)</script>', 'utf8'),
  };
  assert.throws(
    () => validateUploadedFile(file, { allowedTypes: [TYPE.PDF] }),
    (error) => error instanceof UploadSecurityError && error.code === 'UPLOAD_SIGNATURE_INVALID'
  );
});

test('upload hardening menolak extension mismatch', () => {
  const file = {
    originalname: 'gambar.pdf',
    mimetype: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]),
  };
  assert.throws(
    () => validateUploadedFile(file, { allowedTypes: [TYPE.JPEG] }),
    (error) => error instanceof UploadSecurityError && error.code === 'UPLOAD_EXTENSION_MISMATCH'
  );
});

test('nama file storage tidak memakai nama file client', () => {
  const file = { originalname: '../../nama rahasia.pdf', honaiExtension: '.pdf' };
  const stored = secureStoredFilename(file, 'dokumen');
  assert.match(stored, /^\d+-dokumen-[a-f0-9]{24}\.pdf$/);
  assert.equal(stored.includes('nama'), false);
});

test('CORS default hanya mengizinkan origin HONAI production dan client tanpa Origin', async () => {
  const oldOrigins = process.env.HONAI_ALLOWED_ORIGINS;
  const oldAll = process.env.HONAI_CORS_ALLOW_ALL;
  const oldLocal = process.env.HONAI_ALLOW_LOCALHOST_ORIGIN;
  delete process.env.HONAI_ALLOWED_ORIGINS;
  process.env.HONAI_CORS_ALLOW_ALL = 'false';
  process.env.HONAI_ALLOW_LOCALHOST_ORIGIN = 'false';

  const options = corsOptions();
  const call = (origin) => new Promise((resolve) => options.origin(origin, (err, allowed) => resolve({ err, allowed })));

  assert.deepEqual(await call(undefined), { err: null, allowed: true });
  assert.deepEqual(await call('https://honai.bankanp.com'), { err: null, allowed: true });
  const denied = await call('https://evil.example');
  assert.equal(denied.allowed, undefined);
  assert.equal(denied.err?.code, 'HONAI_CORS_DENIED');

  if (oldOrigins === undefined) delete process.env.HONAI_ALLOWED_ORIGINS; else process.env.HONAI_ALLOWED_ORIGINS = oldOrigins;
  if (oldAll === undefined) delete process.env.HONAI_CORS_ALLOW_ALL; else process.env.HONAI_CORS_ALLOW_ALL = oldAll;
  if (oldLocal === undefined) delete process.env.HONAI_ALLOW_LOCALHOST_ORIGIN; else process.env.HONAI_ALLOW_LOCALHOST_ORIGIN = oldLocal;
});

test('rate limiter menghasilkan 429 setelah batas tercapai', () => {
  const middleware = createRateLimiter({ windowMs: 60_000, max: 2, prefix: 'test' });
  const req = { ip: '203.0.113.10', socket: {}, get: () => null };

  function invoke() {
    let status = 200;
    let body = null;
    const headers = {};
    let nextCalled = false;
    const res = {
      setHeader(k, v) { headers[k] = v; },
      status(v) { status = v; return this; },
      json(v) { body = v; return this; },
    };
    middleware(req, res, () => { nextCalled = true; });
    return { status, body, headers, nextCalled };
  }

  assert.equal(invoke().nextCalled, true);
  assert.equal(invoke().nextCalled, true);
  const blocked = invoke();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'RATE_LIMITED');
});

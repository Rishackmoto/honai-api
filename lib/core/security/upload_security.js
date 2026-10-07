const path = require('path');
const crypto = require('crypto');

const TYPE = Object.freeze({
  PDF: 'pdf',
  JPEG: 'jpeg',
  PNG: 'png',
  WEBP: 'webp',
  TXT: 'txt',
});

const TYPE_META = Object.freeze({
  [TYPE.PDF]: { mime: 'application/pdf', ext: '.pdf', extensions: ['.pdf'] },
  [TYPE.JPEG]: { mime: 'image/jpeg', ext: '.jpg', extensions: ['.jpg', '.jpeg'] },
  [TYPE.PNG]: { mime: 'image/png', ext: '.png', extensions: ['.png'] },
  [TYPE.WEBP]: { mime: 'image/webp', ext: '.webp', extensions: ['.webp'] },
  [TYPE.TXT]: { mime: 'text/plain', ext: '.txt', extensions: ['.txt'] },
});

const MIME_ALIASES = new Map([
  ['application/pdf', TYPE.PDF],
  ['image/jpeg', TYPE.JPEG],
  ['image/jpg', TYPE.JPEG],
  ['image/png', TYPE.PNG],
  ['image/webp', TYPE.WEBP],
  ['text/plain', TYPE.TXT],
  ['application/octet-stream', null],
  ['', null],
]);

class UploadSecurityError extends Error {
  constructor(message, code = 'UPLOAD_INVALID', statusCode = 400) {
    super(message);
    this.name = 'UploadSecurityError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function sanitizeOriginalFilename(value) {
  const base = path.basename(String(value || 'file'))
    .replace(/\0/g, '')
    .replace(/[\\/\x00-\x1f\x7f]/g, '_')
    .trim();
  const cleaned = base.replace(/\s+/g, ' ').slice(0, 180);
  return cleaned || 'file';
}

function firstMeaningfulOffset(buffer) {
  let i = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) i = 3;
  while (i < buffer.length && [0x09, 0x0a, 0x0d, 0x20].includes(buffer[i])) i += 1;
  return i;
}

function isLikelyText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0x00) return false;
    if (byte < 0x20 && ![0x09, 0x0a, 0x0d, 0x0c].includes(byte)) controls += 1;
  }
  return controls / sample.length < 0.01;
}

function detectFileType(buffer, extensionHint = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;

  const offset = firstMeaningfulOffset(buffer);
  if (buffer.subarray(offset, offset + 5).toString('ascii') === '%PDF-') return TYPE.PDF;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return TYPE.JPEG;
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return TYPE.PNG;
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return TYPE.WEBP;

  if (String(extensionHint || '').toLowerCase() === '.txt' && isLikelyText(buffer)) return TYPE.TXT;
  return null;
}

function typeAllowed(type, allowedTypes) {
  if (!allowedTypes || !allowedTypes.length) return true;
  return allowedTypes.includes(type);
}

function validateUploadedFile(file, {
  allowedTypes = [TYPE.PDF, TYPE.JPEG, TYPE.PNG],
  maxBytes,
  label = 'File',
} = {}) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new UploadSecurityError(`${label} kosong atau tidak dapat dibaca.`, 'UPLOAD_EMPTY');
  }

  const safeName = sanitizeOriginalFilename(file.originalname);
  const extension = path.extname(safeName).toLowerCase();
  const detectedType = detectFileType(file.buffer, extension);

  if (!detectedType) {
    throw new UploadSecurityError(
      `${label} tidak dikenali atau isi file tidak sesuai format yang diizinkan.`,
      'UPLOAD_SIGNATURE_INVALID'
    );
  }

  if (!typeAllowed(detectedType, allowedTypes)) {
    throw new UploadSecurityError(`${label} menggunakan tipe file yang tidak diizinkan.`, 'UPLOAD_TYPE_DENIED');
  }

  const meta = TYPE_META[detectedType];
  if (!meta.extensions.includes(extension)) {
    throw new UploadSecurityError(
      `${label} ditolak karena ekstensi nama file tidak cocok dengan isi file.`,
      'UPLOAD_EXTENSION_MISMATCH'
    );
  }

  const claimedMime = normalizeMime(file.mimetype);
  const claimedType = MIME_ALIASES.has(claimedMime) ? MIME_ALIASES.get(claimedMime) : undefined;
  if (claimedType !== undefined && claimedType !== null && claimedType !== detectedType) {
    throw new UploadSecurityError(
      `${label} ditolak karena MIME type tidak cocok dengan isi file.`,
      'UPLOAD_MIME_MISMATCH'
    );
  }

  if (claimedType === undefined) {
    throw new UploadSecurityError(`${label} memiliki MIME type yang tidak diizinkan.`, 'UPLOAD_MIME_DENIED');
  }

  if (maxBytes && file.buffer.length > maxBytes) {
    throw new UploadSecurityError(`${label} melebihi batas ukuran yang diizinkan.`, 'UPLOAD_TOO_LARGE', 413);
  }

  // Mulai titik ini aplikasi hanya memakai metadata yang telah diverifikasi,
  // bukan Content-Type yang dikirim browser/client.
  file.originalname = safeName;
  file.mimetype = meta.mime;
  file.size = file.buffer.length;
  file.honaiFileType = detectedType;
  file.honaiExtension = meta.ext;
  return file;
}

function flattenFiles(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') {
    return Object.values(value).flatMap((entry) => Array.isArray(entry) ? entry : [entry]).filter(Boolean);
  }
  return [];
}

function requestFiles(req) {
  const files = [];
  if (req?.file) files.push(req.file);
  files.push(...flattenFiles(req?.files));
  return [...new Set(files)];
}

function validateRequestFiles(req, {
  allowedTypes = [TYPE.PDF, TYPE.JPEG, TYPE.PNG],
  fieldRules = null,
  maxTotalBytes = 60 * 1024 * 1024,
  maxCount = 50,
} = {}) {
  const files = requestFiles(req);
  if (files.length > maxCount) {
    throw new UploadSecurityError(`Jumlah file melebihi batas ${maxCount}.`, 'UPLOAD_TOO_MANY_FILES', 413);
  }

  const total = files.reduce((sum, file) => sum + Number(file?.buffer?.length || file?.size || 0), 0);
  if (maxTotalBytes && total > maxTotalBytes) {
    throw new UploadSecurityError('Total ukuran upload dalam satu request terlalu besar.', 'UPLOAD_TOTAL_TOO_LARGE', 413);
  }

  for (const file of files) {
    const rule = fieldRules?.[file.fieldname] || null;
    if (fieldRules && !rule) {
      throw new UploadSecurityError(`Field file tidak dikenali: ${file.fieldname}`, 'UPLOAD_FIELD_DENIED');
    }
    validateUploadedFile(file, {
      allowedTypes: rule?.allowedTypes || allowedTypes,
      maxBytes: rule?.maxBytes,
      label: rule?.label || `File ${file.fieldname || ''}`.trim(),
    });
  }

  req.honaiUpload = { count: files.length, totalBytes: total };
  return files;
}

function secureStoredFilename(file, label = 'file') {
  const ext = file?.honaiExtension || TYPE_META[file?.honaiFileType]?.ext || path.extname(file?.originalname || '').toLowerCase();
  const safeLabel = String(label || 'file').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || 'file';
  return `${Date.now()}-${safeLabel}-${crypto.randomBytes(12).toString('hex')}${ext || ''}`;
}

function secureMemoryStorage({ maxTotalBytes = 60 * 1024 * 1024 } = {}) {
  return {
    _handleFile(req, file, cb) {
      const chunks = [];
      let size = 0;
      let finished = false;

      const done = (error, info) => {
        if (finished) return;
        finished = true;
        cb(error, info);
      };

      file.stream.on('data', (chunk) => {
        if (finished) return;
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.length;
        req._honaiMultipartBytes = Number(req._honaiMultipartBytes || 0) + part.length;

        if (req._honaiMultipartBytes > maxTotalBytes) {
          chunks.length = 0;
          const error = new UploadSecurityError(
            'Total ukuran file dalam satu request terlalu besar.',
            'UPLOAD_TOTAL_TOO_LARGE',
            413
          );
          // Tetap drain stream supaya parser multipart dapat berhenti secara rapi.
          file.stream.resume();
          return done(error);
        }

        chunks.push(part);
      });

      file.stream.on('error', (error) => done(error));
      file.stream.on('end', () => {
        if (finished) return;
        done(null, { buffer: Buffer.concat(chunks, size), size });
      });
    },
    _removeFile(_req, file, cb) {
      delete file.buffer;
      cb(null);
    },
  };
}

function uploadErrorPayload(error, fallbackMessage = 'File upload tidak valid.') {
  if (!error) return null;
  if (error instanceof UploadSecurityError) {
    return {
      statusCode: error.statusCode || 400,
      body: { success: false, status: 'error', code: error.code, message: error.message },
    };
  }

  const multerCode = String(error.code || '');
  if (multerCode === 'LIMIT_FILE_SIZE') {
    return { statusCode: 413, body: { success: false, status: 'error', code: multerCode, message: 'Ukuran file melebihi batas upload.' } };
  }
  if (multerCode === 'LIMIT_FILE_COUNT' || multerCode === 'LIMIT_UNEXPECTED_FILE' || multerCode === 'LIMIT_PART_COUNT') {
    return { statusCode: 400, body: { success: false, status: 'error', code: multerCode, message: 'Jumlah atau field file tidak sesuai aturan upload.' } };
  }

  return {
    statusCode: 400,
    body: { success: false, status: 'error', code: multerCode || 'UPLOAD_ERROR', message: error.message || fallbackMessage },
  };
}

module.exports = {
  TYPE,
  UploadSecurityError,
  detectFileType,
  validateUploadedFile,
  validateRequestFiles,
  sanitizeOriginalFilename,
  secureStoredFilename,
  secureMemoryStorage,
  uploadErrorPayload,
};

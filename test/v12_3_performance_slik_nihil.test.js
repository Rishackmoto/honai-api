const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'lib', 'features', 'pengajuan', 'data');
const pengajuan = fs.readFileSync(path.join(dataDir, 'pengajuan.js'), 'utf8');
const slik = fs.readFileSync(path.join(dataDir, 'slik.js'), 'utf8');

test('V12.3 menyediakan endpoint SLIK nihil dengan bukti', () => {
  assert.match(slik, /\/api\/pengajuan\/slik\/:id\/nihil/);
  assert.match(slik, /proof_file/);
  assert.match(slik, /\.pdf.*\.jpg.*\.jpeg.*\.png/s);
  assert.match(slik, /status_slik:\s*'NIHIL'/);
  assert.match(slik, /file_hasil_slik:\s*uploadedPath/);
});

test('SLIK nihil dengan bukti dihitung valid untuk screening', () => {
  assert.match(pengajuan, /isNihil/);
  assert.match(pengajuan, /hasProof/);
  assert.match(pengajuan, /\(isNihil && hasProof\)/);
});

test('save FPK memiliki performance timing', () => {
  assert.match(pengajuan, /createPerformanceTimer/);
  assert.match(pengajuan, /SAVE_CREATE/);
  assert.match(pengajuan, /SAVE_UPDATE/);
  assert.match(pengajuan, /X-Honai-Save-Ms/);
  assert.match(pengajuan, /Server-Timing/);
});

test('pool database dan upload B2 dimulai paralel pada hot save path', () => {
  assert.match(pengajuan, /const filesPromise = saveUploadedFiles/);
  assert.match(pengajuan, /const poolPromise = getPool\(\)/);
  assert.match(pengajuan, /Promise\.all\(\[poolPromise, filesPromise\]\)/);
});

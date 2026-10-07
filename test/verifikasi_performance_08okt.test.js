const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pengajuan = fs.readFileSync(path.join(root, 'lib/features/pengajuan/data/pengajuan.js'), 'utf8');
const slik = fs.readFileSync(path.join(root, 'lib/features/pengajuan/data/slik.js'), 'utf8');
const verifikasiUi = fs.readFileSync(path.join(root, '../lib/features/pengajuan/ui/verifikasi_detail_page.dart'), 'utf8');

test('SLIK save memakai batch delete dan mengembalikan timing', () => {
  assert.match(slik, /DELETE FROM t_pengajuan_slik WHERE id_slik IN/);
  assert.match(slik, /X-Honai-Slik-Save-Ms/);
  assert.match(slik, /save_ms/);
});

test('UI SLIK tidak reload seluruh detail setelah save', () => {
  const start = verifikasiUi.indexOf('Future<void> _saveSlikResult');
  const end = verifikasiUi.indexOf('// ==================== LOAD DATA', start);
  assert.ok(start >= 0 && end > start);
  const block = verifikasiUi.slice(start, end);
  assert.doesNotMatch(block, /await\s+_loadData\s*\(/);
  assert.match(block, /_markSlikSavedLocally/);
});

test('save verifikasi mem-paralelkan B2 dan query preload', () => {
  assert.match(pengajuan, /SAVE_VERIFIKASI/);
  assert.match(pengajuan, /const uploadPromise = saveUploadedFiles/);
  assert.match(pengajuan, /Promise\.all\(\[/);
  assert.match(pengajuan, /b2_db_preload/);
});

test('penjamin dan pengurus DUKCAPIL ditulis batch', () => {
  assert.match(pengajuan, /replacePengajuanDukcapilBatch/);
  assert.match(pengajuan, /VALUES \$\{valueRows\.join\(', '\)\}/);
  assert.match(pengajuan, /detail_batch/);
});

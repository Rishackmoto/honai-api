'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pengajuanPath = path.join(
  __dirname,
  '../lib/features/pengajuan/data/pengajuan.js',
);
const source = fs.readFileSync(pengajuanPath, 'utf8');

test('document credit endpoint exists', () => {
  assert.match(source, /router\.get\('\/api\/nasabah\/dokumen-kredit'/);
});

test('document credit endpoint only exposes final approved status 100', () => {
  const start = source.indexOf("router.get('/api/nasabah/dokumen-kredit'");
  const end = source.indexOf("router.get('/api/nasabah/proses'", start);
  assert.ok(start >= 0 && end > start, 'route block not found');
  const block = source.slice(start, end);
  assert.match(block, /WHERE ISNULL\(p\.stsflag, 0\) = 100/);
  assert.match(block, /'Dokumen Kredit' AS progress_terakhir/);
  assert.match(block, /'DISETUJUI'/);
});

test('generic process endpoint stays separate from final document endpoint', () => {
  const start = source.indexOf("router.get('/api/nasabah/proses'");
  assert.ok(start >= 0, 'generic route missing');
  const block = source.slice(start, start + 2200);
  assert.doesNotMatch(block, /IN \([^)]*100[^)]*\)/);
});

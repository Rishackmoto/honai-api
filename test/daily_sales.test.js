const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRouter, validateActivity, fileType } = require('../lib/features/pengajuan/data/daily_sales');

const activity = {
  tanggal: '2026-09-15', jenis_aktivitas: 'Kunjungan', nama_prospek: 'Prospek A',
  produk: 'Kredit usaha', hasil: 'Meminta brosur', tanggal_follow_up: '2026-09-16',
};
test('validasi tanggal kalender, kolom wajib, panjang, dan follow up', () => {
  assert.equal(validateActivity(activity).kontak, '');
  for (const patch of [
    { tanggal: '2026-02-30' }, { nama_prospek: ' ' }, { hasil: '' },
    { produk: 'x'.repeat(101) }, { tanggal_follow_up: '2026-09-14' },
    { jenis_aktivitas: 'Tidak dikenal' },
  ]) assert.throws(() => validateActivity({ ...activity, ...patch }));
});

async function fixture(t, { view = true, add = true, active = true, print = false, upload = false,
  role = 12, branch = '001', teamView = false, foundActivity = true, reportRows, file } = {}) {
  const queries = [];
  const pool = { request() {
    const inputs = {};
    return { input(key, type, value) { inputs[key] = value; return this; },
      async query(query) {
        queries.push({ query, inputs });
        if (query.includes('FROM muser')) return { recordset: active ? [{ userid: 'AO01', username: 'AO Satu', jabat: role, levelid: 1, kdcab: branch }] : [] };
        if (query.includes('SELECT a.id')) return { recordset: foundActivity ? [{ id: inputs.id }] : [] };
        if (query.includes('TOP (1001)') && reportRows) return { recordset: reportRows };
        if (query.includes('SELECT filename, content_type, file_data')) return { recordset: file ? [file] : [] };
        return { recordset: [{ id: 1, ...inputs }] };
      },
    };
  } };
  const app = express();
  app.use(express.json());
  app.use('/api/daily-sales', createRouter({ poolProvider: async () => pool,
    getUserMenuAccess: async () => [
      { kode_menu: 'daily_sales_activity', can_view: view, can_add: add, can_print: print, can_upload: upload },
      { kode_menu: 'daily_sales_report', can_view: teamView },
    ],
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { queries, url: `http://127.0.0.1:${server.address().port}/api/daily-sales` };
}
test('pengguna tanpa sesi, nonaktif, dan tanpa hak lihat ditolak', async t => {
  const a = await fixture(t);
  assert.equal((await fetch(a.url)).status, 401);
  const b = await fixture(t, { active: false });
  assert.equal((await fetch(b.url, { headers: { 'x-userid': 'AO01' } })).status, 401);
  const c = await fixture(t, { view: false });
  assert.equal((await fetch(c.url, { headers: { 'x-userid': 'AO01' } })).status, 403);
});
test('cetak pribadi memerlukan can_print dan mengabaikan AO/cabang dari klien', async t => {
  const denied = await fixture(t);
  const headers = { 'x-userid': 'AO01' };
  assert.equal((await fetch(`${denied.url}/report?from=2026-09-01&to=2026-09-16&print=1`, { headers })).status, 403);
  const allowed = await fixture(t, { print: true });
  const response = await fetch(`${allowed.url}/report?from=2026-09-01&to=2026-09-16&print=1&ao=AO02&kdcab=002`, { headers });
  assert.equal(response.status, 200);
  assert.match(allowed.queries.at(-1).query, /a.userid = @userid/);
  assert.equal(allowed.queries.at(-1).inputs.userid, 'AO01');
  assert.equal(allowed.queries.at(-1).inputs.ao, null);
});
test('laporan pimpinan hanya SPV/Manager/Direksi dengan cabang dan hak lihat', async t => {
  for (const role of [11, 12, 13, 16, 18, 19]) {
    const { url } = await fixture(t, { role, teamView: true });
    assert.equal((await fetch(`${url}/report?scope=team&from=2026-09-01&to=2026-09-16`, { headers: { 'x-userid': 'AO01' } })).status, 403);
  }
  for (const options of [{ role: 14, teamView: false }, { role: 14, teamView: true, branch: '' }]) {
    const { url } = await fixture(t, options);
    assert.equal((await fetch(`${url}/report?scope=team&from=2026-09-01&to=2026-09-16`, { headers: { 'x-userid': 'AO01' } })).status, 403);
  }
  for (const role of [14, 15, 17]) {
    const { url, queries } = await fixture(t, { role, teamView: true, view: false });
    const response = await fetch(`${url}/report?scope=team&from=2026-09-01&to=2026-09-16&ao=AO02&kdcab=999`, { headers: { 'x-userid': 'AO01' } });
    assert.equal(response.status, 200);
    assert.equal(queries.at(-1).inputs.kdcab, '001');
    assert.equal(queries.at(-1).inputs.ao, 'AO02');
    assert.match(queries.at(-1).query, /u.kdcab = @kdcab AND TRY_CONVERT\(INT, u.jabat\) = 12/);
  }
});
test('laporan menolak periode tidak valid dan hasil terlalu banyak tanpa pemotongan diam-diam', async t => {
  const { url } = await fixture(t, { reportRows: Array(1001).fill({ id: 1 }) });
  for (const range of ['from=2026-09-20&to=2026-09-01', 'from=2025-01-01&to=2026-09-16', 'from=2026-02-30&to=2026-03-01', 'from=2026-09-01&to=2026-09-16']) {
    assert.equal((await fetch(`${url}/report?${range}`, { headers: { 'x-userid': 'AO01' } })).status, 400);
  }
});
test('lampiran milik AO/cabang lain tidak dapat didaftar, diunduh, atau diupload', async t => {
  const { url, queries } = await fixture(t, { upload: true, foundActivity: false });
  const headers = { 'x-userid': 'AO01' };
  for (const suffix of ['/5/attachments', '/5/attachments/1']) {
    assert.equal((await fetch(url + suffix, { headers })).status, 404);
  }
  assert.equal((await fetch(`${url}/5/attachments`, { method: 'POST', headers })).status, 404);
  assert.ok(!queries.some(q => q.query.includes('file_data')));
  assert.match(queries.at(-1).query, /a.userid = @userid/);
  const team = await fixture(t, { role: 17, teamView: true, foundActivity: false });
  assert.equal((await fetch(`${team.url}/5/attachments?scope=team`, { headers })).status, 404);
  assert.match(team.queries.at(-1).query, /u.kdcab = @kdcab/);
});
test('upload wajib izin upload termasuk trailing slash/case; pimpinan read-only', async t => {
  const a = await fixture(t, { add: true, upload: false });
  for (const path of ['/5/attachments', '/5/attachments/', '/5/Attachments']) {
    assert.equal((await fetch(a.url + path, { method: 'POST', headers: { 'x-userid': 'AO01' } })).status, 403);
  }
  const b = await fixture(t, { role: 14, teamView: true, upload: true });
  assert.equal((await fetch(`${b.url}/5/attachments?scope=team`, { method: 'POST', headers: { 'x-userid': 'AO01' } })).status, 403);
});
test('upload memeriksa format, ukuran, dan menyimpan file pada aktivitas terpilih', async t => {
  const { url, queries } = await fixture(t, { upload: true, add: false });
  async function send(name, bytes) {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    return fetch(`${url}/5/attachments`, { method: 'POST', headers: { 'x-userid': 'AO01' }, body: form });
  }
  assert.equal((await send('kunjungan.pdf', Buffer.from('%PDF-1.7\nfixture'))).status, 201);
  assert.equal(queries.at(-1).inputs.id, 5);
  assert.equal(queries.at(-1).inputs.type, 'application/pdf');
  assert.equal((await send('palsu.pdf', Buffer.from('text'))).status, 400);
  assert.equal((await send('besar.pdf', Buffer.alloc(5 * 1024 * 1024 + 1))).status, 400);
  assert.equal(fileType({ originalname: 'gambar.png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }), 'image/png');
  assert.equal(fileType({ originalname: 'gambar.jpg', buffer: Buffer.from([255, 216, 255, 0]) }), 'image/jpeg');
  assert.equal(fileType({ originalname: 'program.exe', buffer: Buffer.from('%PDF-1.7') }), null);
});
test('unduhan mengikat file ke aktivitas dan tidak dipublikasikan melalui URL umum', async t => {
  const file = { filename: 'bukti.pdf', content_type: 'application/pdf', file_data: Buffer.from('%PDF-1.7 test') };
  const { url, queries } = await fixture(t, { file });
  const response = await fetch(`${url}/5/attachments/8`, { headers: { 'x-userid': 'AO01' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '%PDF-1.7 test');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(queries.at(-1).inputs.id, 5);
  assert.equal(queries.at(-1).inputs.fileId, 8);
  const missing = await fixture(t);
  assert.equal((await fetch(`${missing.url}/5/attachments/8`, { headers: { 'x-userid': 'AO01' } })).status, 404);
});
test('hak lihat tidak memberi hak tambah', async t => {
  const { url } = await fixture(t, { add: false });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'x-userid': 'AO01', 'Content-Type': 'application/json' }, body: JSON.stringify(activity) })).status, 403);
});
test('riwayat dan input selalu menggunakan pemilik dari sesi, bukan body/query', async t => {
  const { url, queries } = await fixture(t);
  const headers = { 'x-userid': 'AO01', 'Content-Type': 'application/json' };
  const list = await fetch(`${url}?tanggal=2026-09-15&userid=AO02`, { headers });
  assert.equal(list.status, 200);
  assert.equal(queries.at(-1).inputs.userid, 'AO01');
  assert.match(queries.at(-1).query, /WHERE userid = @userid AND tanggal = @tanggal/);
  const save = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...activity, userid: 'AO02' }) });
  assert.equal(save.status, 201);
  assert.equal(queries.at(-1).inputs.userid, 'AO01');
});
test('input tidak valid tidak melakukan INSERT', async t => {
  const { url, queries } = await fixture(t);
  const response = await fetch(url, { method: 'POST', headers: { 'x-userid': 'AO01', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...activity, hasil: '' }) });
  assert.equal(response.status, 400);
  assert.ok(!queries.some(q => q.query.includes('INSERT')));
});

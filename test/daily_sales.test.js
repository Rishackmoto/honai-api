const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRouter, validateActivity } = require('../lib/features/pengajuan/data/daily_sales');

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

async function fixture(t, { view = true, add = true, active = true } = {}) {
  const queries = [];
  const pool = { request() {
    const inputs = {};
    return { input(key, type, value) { inputs[key] = value; return this; },
      async query(query) {
        queries.push({ query, inputs });
        if (query.includes('FROM muser')) return { recordset: active ? [{ userid: 'AO01', jabat: 12, levelid: 1 }] : [] };
        return { recordset: [{ id: 1, ...inputs }] };
      },
    };
  } };
  const app = express();
  app.use(express.json());
  app.use('/api/daily-sales', createRouter({ poolProvider: async () => pool,
    getUserMenuAccess: async () => [{ kode_menu: 'daily_sales_activity', can_view: view, can_add: add }],
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

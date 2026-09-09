const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/features/pengajuan/data/pengajuan.js'), 'utf8');
const parser = vm.runInNewContext(source.slice(source.indexOf('function normalizeOcrLine('), source.indexOf("router.post('/api/ktp/scan'")) + '\nparseKtpOcrText;');

test('standard KTP lines retain inline address, RT/RW and identity', () => {
    const result = parser(`NIK : 0000000101900001
Nama : ORANG UJI
Tempat/Tgl Lahir : JAYAPURA, 01-01-1990
Jenis Kelamin : LAKI-LAKI
Alamat : JL. CONTOH 10
RT/RW : 001/002
Kelurahan : CONTOH
Kecamatan : DISTRIK UJI
Agama : KRISTEN
Status Perkawinan : KAWIN`);
    assert.equal(result.nik, '0000000101900001');
    assert.equal(result.nama, 'ORANG UJI');
    assert.equal(result.tanggal_lahir, '1990-01-01');
    assert.equal(result.alamat, 'JL. CONTOH 10');
    assert.equal(result.rt_rw, 'RT 001 / RW 002');
    assert.equal(result.jenis_kelamin, 'LAKI-LAKI');
});

test('multiline address ends before identity labels and empty OCR stays empty', () => {
    const result = parser('Alamat\nJL. CONTOH\nBLOK 2\nRT 003 / RW 004\nAgama : ISLAM');
    assert.equal(result.alamat, 'JL. CONTOH BLOK 2');
    assert.equal(result.rt_rw, 'RT 003 / RW 004');
    assert.equal(parser('').nama, '');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { screeningSubmissionError, screeningDecision } = require('../lib/features/pengajuan/data/screening');
const initial = { screening_awal: true, stsflag: '1', jenis_debitur: 'PERORANGAN', plafon_pengajuan: 10000000, tenor_bulan: 12,
    persetujuan_slik: { text: 'Persetujuan uji', signature: 'gambar-uji' }, data_perorangan: { nama_debitur: 'UJI', no_ktp: '0000000000000000' } };
const files = [{ fieldname: 'file_debitur' }];
test('initial identity submission requires KTP and consent, draft is allowed incomplete', () => {
    assert.equal(screeningSubmissionError(initial, files), null);
    assert.ok(screeningSubmissionError(initial));
    assert.ok(screeningSubmissionError({ ...initial, persetujuan_slik: null }, files));
    assert.equal(screeningSubmissionError({ screening_awal: true, stsflag: '0' }), null);
});
test('locked financial data and forged transitions are rejected', () => {
    for (const extra of [{ form_lengkap: true }, { data_kredit: {} }, { data_penghasilan: {} }, { stsflag: '3' }]) {
        assert.ok(screeningSubmissionError({ ...initial, ...extra }, files));
    }
    assert.ok(screeningSubmissionError({ stsflag: '3', form_lengkap: true }, [], { screening_awal: true, stsflag: '1' }));
    assert.equal(screeningSubmissionError({ stsflag: '3', form_lengkap: true }, [], { screening_awal: true, stsflag: '2' }), null);
    assert.equal(screeningSubmissionError(initial, [], { screening_awal: true, stsflag: '90', foto_ktp: 'existing.png' }), null);
});
test('admin decision requires evidence, valid identity, and a correction/rejection note', () => {
    assert.equal(screeningDecision({ decision: 'lanjut', hasSlik: true, hasDukcapil: true, identityValid: true }).status, '2');
    for (const decision of ['perbaikan', 'tidak_lanjut']) assert.ok(screeningDecision({ decision }).error);
    assert.ok(screeningDecision({ decision: 'lanjut', hasSlik: true, hasDukcapil: true, identityValid: false }).error);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the real route handlers with isolated database and notification adapters.
// No database, file storage, or WhatsApp connection is opened by these tests.
function fixture(hasSurvey = true, options = {}) {
    const filename = path.resolve(__dirname, '../lib/features/pengajuan/data/pengajuan.js');
    const localRequire = createRequire(filename);
    const queries = [];
    const notifications = [];
    const transactions = [];
    const pool = { request() {
        const inputs = {};
        return {
            input(name, type, value) { inputs[name] = value; return this; },
            async query(text) {
                queries.push({ text, inputs });
                if (text.includes('SELECT p.stsflag, p.screening_awal, d.foto_ktp')) {
                    return { recordset: [{ stsflag: options.stage ?? '1', screening_awal: true, foto_ktp: 'test/ktp.png' }] };
                }
                if (text.includes('effective_ttd_debitur') && text.includes('SELECT * FROM t_detail_debitur')) {
                    return { recordsets: [[{ no_ktp: '0000000000000000', nama_debitur: 'UJI', effective_ttd_debitur: 'existing-signature', foto_ktp: 'test/ktp.png' }], [], [], [], [], [], [], [], [], []] };
                }
                if (text.includes('SELECT stsflag, screening_awal FROM t_pengajuan')) {
                    return { recordset: options.missing ? [] : [{ stsflag: options.stage ?? '1', screening_awal: options.screening ?? true }] };
                }
                if (text.includes('SELECT slik_data FROM t_pengajuan_slik')) {
                    return { recordset: options.slik === false ? [] : [{ slik_data: JSON.stringify({ jenis: 'DEBITUR', nama_debitur: 'UJI' }) }] };
                }
                if (text.includes('SELECT TOP 1 file_hasil_dukcapil_debitur')) {
                    return { recordset: options.dukcapil === false ? [] : [{ file_hasil_dukcapil_debitur: 'test/dukcapil.pdf' }] };
                }
                if (/SELECT(?: TOP 1)? stsflag\s+FROM t_pengajuan/.test(text)) {
                    return { recordset: options.missing ? [] : [{ stsflag: options.stage ?? '7' }] };
                }
                if (text.includes('SELECT TOP 1 id_pengajuan FROM t_pengajuan_muk')) {
                    return { recordset: options.hasMuk === false ? [] : [{ id_pengajuan: 'TEST' }] };
                }
                return { recordset: text.includes('SELECT TOP 1 id_pengajuan FROM t_pengajuan_survey_agunan') && hasSurvey
                    ? [{ id_pengajuan: 'TEST' }] : [] };
            },
        };
    } };
    const fakeSql = { ...localRequire('mssql'),
        Request: class { constructor() { return pool.request(); } },
        Transaction: class {
            async begin() { transactions.push('begin'); }
            async commit() { transactions.push('commit'); }
            async rollback() { transactions.push('rollback'); }
        },
    };
    const module = { exports: {} };
    const fakeRequire = (name) => {
        if (name.endsWith('/network/db')) return { sql: fakeSql, getPool: async () => pool };
        if (name.endsWith('/storage/backblaze') || name.endsWith('/notification/whatsapp')) return {};
        if (name === './notifikasi') return { queueWorkflowNotification: (_, data) => { notifications.push(data); return {}; } };
        if (name === './slik') return localRequire('express').Router();
        return localRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: fakeRequire, module, exports: module.exports,
        process: { env: {} }, console, Buffer, __dirname: path.dirname(filename),
    }, { filename });
    return {
        queries, notifications, transactions,
        async post(endpoint, body, expectedStatus = 200, method = 'post') {
            const route = module.exports.stack.find(layer => layer.route?.path === endpoint && layer.route.methods[method]).route;
            const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
            await route.stack.at(-1).handle({ params: { id: 'TEST' }, body, files: [], get: () => undefined }, res);
            assert.equal(res.statusCode, expectedStatus, JSON.stringify(res.body));
            return res.body;
        },
    };
}

for (const endpoint of ['muk', 'rekap-analisa']) {
    test(`${endpoint}: draft persists data without changing stage or notifying`, async () => {
        const app = fixture();
        const response = await app.post(`/api/pengajuan/:id/${endpoint}`, { is_draft: true });
        assert.equal(response.is_draft, true);
        assert.ok(app.queries.some(q => q.text.includes('INSERT INTO')));
        assert.equal(app.queries.filter(q => /SET stsflag\s*=/.test(q.text)).length, 0);
        assert.equal(app.notifications.length, 0);
    });
}

test('MUK submit enters review, not final decision', async () => {
    const app = fixture();
    await app.post('/api/pengajuan/:id/muk', {});
    assert.equal(app.queries.find(q => /SET stsflag\s*=/.test(q.text)).inputs.stsflag, '7');
    assert.equal(app.notifications[0].targetStsflag, '7');
});

for (const [decision, status] of [['lanjut', '2'], ['perbaikan', '90'], ['tidak_lanjut', '99']]) {
    test(`screening admin ${decision} persists verification and returns correct stage`, async () => {
        const app = fixture();
        const result = await app.post('/api/pengajuan/verifikasi/:id', { keputusan_screening: decision, status_debitur: true, catatan_admin: 'Catatan uji' });
        assert.equal(result.stsflag, status);
        assert.deepEqual(app.transactions, ['begin', 'commit']);
        assert.equal(app.notifications[0].targetStsflag, status);
        assert.equal(app.queries.find(q => q.text.includes('INSERT INTO t_verifikasi_dukcapil')).inputs.file_hasil_dukcapil_debitur, 'test/dukcapil.pdf');
    });
}
for (const options of [{ slik: false }, { dukcapil: false }]) {
    test(`screening cannot continue with missing evidence ${JSON.stringify(options)}`, async () => {
        const app = fixture(true, options);
        await app.post('/api/pengajuan/verifikasi/:id', { keputusan_screening: 'lanjut', status_debitur: true }, 400);
        assert.deepEqual(app.transactions, ['begin', 'rollback']);
        assert.equal(app.notifications.length, 0);
        assert.equal(app.queries.some(q => q.text.includes('INSERT INTO t_verifikasi_dukcapil')), false);
    });
}
test('screening requires decision and blocks repeated admin submission', async () => {
    await fixture().post('/api/pengajuan/verifikasi/:id', { status_debitur: true }, 400);
    await fixture(true, { stage: '2' }).post('/api/pengajuan/verifikasi/:id', { keputusan_screening: 'lanjut', status_debitur: true }, 409);
});

test('AO continuation is rejected before admin decision and accepted after stage 2', async () => {
    const body = { id_pengajuan: 'TEST', jenis_debitur: 'PERORANGAN', stsflag: '3', form_lengkap: true, data_perorangan: { nama_debitur: 'UJI', no_ktp: '0000000000000000' }, data_kredit: { jumlah_pengajuan_kredit: 10000000 } };
    const blocked = fixture(true, { stage: '1' });
    await blocked.post('/api/pengajuan/:id', body, 400, 'put');
    assert.deepEqual(blocked.transactions, ['begin', 'rollback']);
    assert.equal(blocked.queries.some(q => q.text.includes('DELETE FROM')), false);
    const allowed = fixture(true, { stage: '2' });
    await allowed.post('/api/pengajuan/:id', body, 200, 'put');
    assert.deepEqual(allowed.transactions, ['begin', 'commit']);
    assert.ok(allowed.queries.some(q => q.text.includes('INSERT INTO t_debitur_data_kredit')));
    assert.equal(allowed.queries.find(q => q.text.includes('INSERT INTO t_debitur_perorangan')).inputs.ttd_debitur, 'existing-signature');
});

for (const hasSurvey of [true, false]) {
    test(`analysis routes correctly when survey exists=${hasSurvey}`, async () => {
        const app = fixture(hasSurvey);
        await app.post('/api/pengajuan/:id/rekap-analisa', {});
        const expected = hasSurvey ? '8' : '5';
        assert.equal(app.queries.find(q => /SET stsflag\s*=/.test(q.text)).inputs.stsflag, expected);
        assert.equal(app.notifications[0].targetStsflag, expected);
    });
}

for (const [action, hasMuk, expected] of [
    ['approve', true, '9'], ['approve', false, '8'],
    ['koreksi', true, '8'], ['tolak', true, '99'],
]) {
    test(`MUK review: ${action}, MUK exists=${hasMuk}`, async () => {
        const app = fixture(true, { stage: '7', hasMuk });
        const result = await app.post('/api/pengajuan/:id/approval-muk', {
            action, catatan: 'Catatan pengujian',
        });
        assert.equal(result.stsflag, expected);
        assert.equal(app.queries.find(q => /SET stsflag\s*=/.test(q.text)).inputs.stsflag, expected);
        assert.ok(app.queries.some(q => q.text.includes('INSERT INTO t_pengajuan_approval_muk')));
    });
}

for (const [action, expected] of [['approve', '100'], ['koreksi', '8'], ['tolak', '99']]) {
    test(`final decision: ${action}`, async () => {
        const app = fixture(true, { stage: '9' });
        const result = await app.post('/api/pengajuan/:id/approval-direksi', {
            action, catatan: 'Catatan pengujian',
        });
        assert.equal(result.stsflag, expected);
        assert.ok(app.queries.some(q => q.text.includes('INSERT INTO t_pengajuan_approval_direksi')));
    });
}

for (const [endpoint, stage, status] of [
    ['approval-muk', '8', 400], ['approval-direksi', '7', 409],
    ['approval-direksi', '100', 409],
]) {
    test(`${endpoint} rejects action at stage ${stage}`, async () => {
        const app = fixture(true, { stage });
        await app.post(`/api/pengajuan/:id/${endpoint}`, { action: 'approve' }, status);
        assert.equal(app.queries.filter(q => /SET stsflag\s*=/.test(q.text)).length, 0);
    });
}

test('final correction requires a reason', async () => {
    const app = fixture(true, { stage: '9' });
    await app.post('/api/pengajuan/:id/approval-direksi', { action: 'koreksi' }, 400);
    assert.equal(app.queries.length, 0);
});

for (const jenis of ['PERORANGAN', 'BADAN_USAHA']) {
    for (const stage of ['0', '1']) {
        test(`complete ${jenis} form stores credit, income, collateral at stage ${stage}`, async () => {
            const app = fixture();
            await app.post('/api/pengajuan/baru', {
                id_pengajuan: 'TEST', jenis_debitur: jenis, id_ao: 'TEST_AO',
                form_lengkap: true, stsflag: stage,
                data_perorangan: { nama_debitur: 'Debitur Uji' },
                data_badan_usaha: { nama_perusahaan: 'Badan Usaha Uji' },
                data_penghasilan: { total_penghasilan_debitur: 6000000 },
                data_kredit: { jumlah_pengajuan_kredit: 10000000, jangka_waktu_bulan: '12' },
                list_jaminan: [{ jenis_jaminan: 'TANAH' }],
            }, 201);
            assert.deepEqual(app.transactions, ['begin', 'commit']);
            for (const table of ['t_debitur_data_penghasilan', 't_debitur_data_kredit', 't_debitur_data_jaminan']) {
                assert.ok(app.queries.some(q => q.text.includes(`INSERT INTO ${table}`)), table);
            }
            assert.equal(app.queries.find(q => q.text.includes('INSERT INTO t_pengajuan (')).inputs.stsflag, stage);
            const credit = app.queries.find(q => q.text.includes('INSERT INTO t_debitur_data_kredit')).inputs;
            assert.equal(credit.jumlah_pengajuan_kredit, 10000000);
            assert.equal(credit.jangka_waktu_bulan, 12);
            const income = app.queries.find(q => q.text.includes('INSERT INTO t_debitur_data_penghasilan')).inputs;
            assert.equal(income.total_penghasilan_debitur, 6000000);
            const collateral = app.queries.find(q => q.text.includes('INSERT INTO t_debitur_data_jaminan')).inputs;
            assert.equal(JSON.parse(collateral.data_jaminan).jenis_jaminan, 'TANAH');
        });
    }
}

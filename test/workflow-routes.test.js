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
        async post(endpoint, body, expectedStatus = 200) {
            const route = module.exports.stack.find(layer => layer.route?.path === endpoint && layer.route.methods.post).route;
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

// Explicit integration diagnostic for the authorized local LAS_ANP database.
// Default: read-only probe. --run: synthetic writes enclosed in a rollback.
// --apply-schema-fix: explicitly authorized permanent column migration (commits).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sql = require('mssql');
const dotenv = require('dotenv');

const config = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env.local')));
assert.equal(config.DB_DATABASE, 'LAS_ANP', 'Only the authorized LAS_ANP target is allowed');
const pool = new sql.ConnectionPool({
    server: config.DB_SERVER, database: config.DB_DATABASE,
    user: config.DB_USER, password: config.DB_PASSWORD,
    port: Number(config.DB_PORT || 1433), connectionTimeout: 8000,
    requestTimeout: 15000,
    options: { encrypt: config.DB_ENCRYPT === 'true', trustServerCertificate: config.DB_TRUST_SERVER_CERTIFICATE !== 'false' },
});

async function main() {
    await pool.connect();
    const target = await pool.request().query('SELECT DB_NAME() AS database_name');
    assert.equal(target.recordset[0].database_name, 'LAS_ANP');
    console.log('CONNECTED: LAS_ANP');
    const tables = await pool.request().query(`
        SELECT t.name, COUNT(tr.object_id) AS enabled_triggers
        FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
        LEFT JOIN sys.triggers tr ON tr.parent_id = t.object_id AND tr.is_disabled = 0
        WHERE s.name = 'dbo' AND (t.name LIKE 't_pengajuan%' OR t.name LIKE 't_debitur%'
            OR t.name LIKE 't_detail%' OR t.name = 't_keluarga_tidak_serumah')
        GROUP BY t.name ORDER BY t.name
    `);
    console.log(`SCHEMA: ${tables.recordset.length} tables checked; enabled triggers=${tables.recordset.reduce((n, t) => n + t.enabled_triggers, 0)}`);
    if (process.argv.includes('--apply-schema-fix')) {
        assert.equal(process.argv.includes('--with-schema-fix'), false,
            'Permanent and rollback migration modes cannot be combined');
        const migrationTx = new sql.Transaction(pool);
        let migrationActive = false;
        try {
            await migrationTx.begin();
            migrationActive = true;
            const request = new sql.Request(migrationTx);
            const migration = fs.readFileSync(path.resolve(__dirname, '../../database/widen_pengajuan_stsflag.sql'), 'utf8');
            await request.query('SET LOCK_TIMEOUT 10000;\n' + migration);
            const check = await new sql.Request(migrationTx).query(`
                SELECT COL_LENGTH('dbo.t_pengajuan', 'stsflag') AS status_length
            `);
            assert.ok(check.recordset[0].status_length >= 10 || check.recordset[0].status_length === -1);
            await migrationTx.commit();
            migrationActive = false;
            console.log('COMMITTED: permanent stsflag column widening');
        } finally {
            if (migrationActive) await migrationTx.rollback();
        }
    }
    if (!process.argv.includes('--run')) return;
    assert.equal(tables.recordset.some(t => t.enabled_triggers > 0), false,
        'Integration writes stopped: enabled triggers need review first');
    await runRollback();
}

async function runRollback() {
    const tx = new sql.Transaction(pool);
    let active = false;
    const ids = [];
    const schemaQuery = `SELECT COL_LENGTH('dbo.t_pengajuan', 'stsflag') AS status_length,
        OBJECT_ID('dbo.t_pengajuan_approval_muk') AS approval_muk,
        OBJECT_ID('dbo.t_pengajuan_approval_direksi') AS approval_direksi`;
    const beforeSchema = (await pool.request().query(schemaQuery)).recordset[0];
    try {
        await tx.begin();
        active = true;
        const adapter = { request: () => new sql.Request(tx) };
        if (process.argv.includes('--with-schema-fix')) {
            const migration = fs.readFileSync(path.resolve(__dirname, '../../database/widen_pengajuan_stsflag.sql'), 'utf8');
            await adapter.request().query(migration);
            console.log('CANDIDATE FIX: stsflag widened inside rollback transaction only');
        }
        const boundSql = { ...sql,
            Request: class { constructor() { return new sql.Request(tx); } },
            Transaction: class {
                async begin() {}
                async commit() {} // Only the outer diagnostic owns the transaction.
                async rollback() {}
            },
        };
        const filename = path.resolve(__dirname, '../lib/features/pengajuan/data/pengajuan.js');
        const localRequire = createRequire(filename);
        const module = { exports: {} };
        const noExternalWrite = () => { throw new Error('External storage/notification disabled in integration test'); };
        const requireAdapter = name => {
            if (name.endsWith('/network/db')) return { sql: boundSql, getPool: async () => adapter };
            if (name.endsWith('/storage/backblaze')) return {
                uploadToB2: noExternalWrite, deleteManyFromB2: noExternalWrite,
                deletePrefixFromB2: noExternalWrite, getB2Object: noExternalWrite,
            };
            if (name.endsWith('/notification/whatsapp')) return { sendWhatsAppTemplate: noExternalWrite };
            if (name === './notifikasi') return { queueWorkflowNotification: () => ({ suppressed_for_test: true }) };
            if (name === './slik') return localRequire('express').Router();
            return localRequire(name);
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: requireAdapter, module, exports: module.exports,
            process: { env: {}, cwd: () => path.resolve(__dirname, '..') }, console, Buffer, Date, __dirname: path.dirname(filename),
        }, { filename });
        async function post(endpoint, id, body, code = 200) {
            const route = module.exports.stack.find(l => l.route?.path === endpoint && l.route.methods.post).route;
            const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
            await route.stack.at(-1).handle({ params: { id }, body, files: [], get: () => undefined }, res);
            assert.equal(res.code, code, JSON.stringify(res.body));
        }
        async function stage(id) {
            const r = await adapter.request().input('id', sql.VarChar, id)
                .query('SELECT stsflag FROM t_pengajuan WHERE id_pengajuan = @id');
            return String(r.recordset[0].stsflag);
        }
        for (const [i, jenis] of ['PERORANGAN', 'BADAN_USAHA'].entries()) {
            const id = `TST${Date.now()}${i}`;
            ids.push(id);
            await post('/api/pengajuan/baru', id, {
                id_pengajuan: id, jenis_debitur: jenis, id_ao: 'TEST_AO',
                plafon_pengajuan: 10000000, tenor_bulan: 12,
                tgl_pengajuan: '2026-09-09', status_pengajuan: 'BARU',
                form_lengkap: true, stsflag: '0', is_draft: true,
                data_perorangan: { nama_debitur: 'UJI ROLLBACK', no_ktp: '0000000000000000' },
                data_badan_usaha: { nama_perusahaan: 'UJI ROLLBACK', npwp: '0000000000000000' },
                data_penghasilan: { total_penghasilan_debitur: 6000000 },
                data_kredit: { jumlah_pengajuan_kredit: 10000000, jangka_waktu_bulan: '12' },
                list_jaminan: [{ jenis_jaminan: 'TANAH' }],
            }, 201);
            assert.equal(await stage(id), '0');
            const credit = await adapter.request().input('id', sql.VarChar, id)
                .query('SELECT jumlah_pengajuan_kredit, jangka_waktu_bulan FROM t_debitur_data_kredit WHERE id_pengajuan = @id');
            assert.equal(Number(credit.recordset[0].jumlah_pengajuan_kredit), 10000000);
            assert.equal(Number(credit.recordset[0].jangka_waktu_bulan), 12);
            // Move the synthetic draft to submission, then exercise real stage handlers.
            await adapter.request().input('id', sql.VarChar, id)
                .query("UPDATE t_pengajuan SET stsflag = '1' WHERE id_pengajuan = @id");
            await post('/api/pengajuan/verifikasi/:id', id, { status_debitur: 'SESUAI', catatan_admin: 'UJI ROLLBACK' });
            assert.equal(await stage(id), '3');
            // File upload is excluded: use the progress endpoint after the document checkpoint.
            await post('/api/pengajuan/:id/progress', id, { stsflag: '5' });
            assert.equal(await stage(id), '5');
            await post('/api/pengajuan/:id/survey-debitur', id, { tanggal_survey: '2026-09-09', is_draft: false });
            assert.equal(await stage(id), '6');
            await post('/api/pengajuan/:id/survey-agunan', id, { is_draft: false });
            assert.equal(await stage(id), '4');
            await post('/api/pengajuan/:id/rekap-analisa', id, { is_draft: true, penghasilan: 6000000 });
            assert.equal(await stage(id), '4');
            await post('/api/pengajuan/:id/rekap-analisa', id, { is_draft: false, penghasilan: 6000000 });
            assert.equal(await stage(id), '8');
            await post('/api/pengajuan/:id/muk', id, { is_draft: true });
            assert.equal(await stage(id), '8');
            await post('/api/pengajuan/:id/muk', id, { is_draft: false });
            assert.equal(await stage(id), '7');
            await post('/api/pengajuan/:id/approval-muk', id, { action: 'approve' });
            assert.equal(await stage(id), '9');
            await post('/api/pengajuan/:id/approval-direksi', id, { action: 'approve' });
            assert.equal(await stage(id), '100');
            console.log(`PASS: ${jenis} payload, verification, surveys, analysis/drafts, MUK review, final decision`);
        }
    } finally {
        if (active) {
            await tx.rollback();
            console.log('ROLLBACK complete');
        }
        for (const id of ids) {
            const r = await pool.request().input('id', sql.VarChar, id)
                .query('SELECT COUNT(*) AS remaining FROM t_pengajuan WHERE id_pengajuan = @id');
            assert.equal(r.recordset[0].remaining, 0, 'Synthetic row remained after rollback');
        }
        if (ids.length) console.log('VERIFIED: no synthetic applications remain');
        const afterSchema = (await pool.request().query(schemaQuery)).recordset[0];
        assert.deepEqual(afterSchema, beforeSchema, 'Schema did not return to its original state');
        console.log('VERIFIED: original schema restored, stsflag bytes=' + afterSchema.status_length);
    }
}

main().catch(error => {
    // Avoid emitting connection configuration or credentials.
    console.error('FAILED:', error.code || error.name, ['ELOGIN', 'ESOCKET', 'ETIMEOUT'].includes(error.code) ? '(database connection failed)' : error.message);
    process.exitCode = 1;
}).finally(() => pool.close());

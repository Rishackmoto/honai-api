const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { sql, getPool } = require('../../../core/network/db');
const { uploadToB2, deleteManyFromB2, getB2Object } = require('../../../core/storage/backblaze');
const { safeFilename } = require('./helper');

async function cleanupSavedFiles(savedFiles = []) {
    const urls = savedFiles.map((file) => file.path || file.key).filter(Boolean);
    if (!urls.length) return 0;
    return deleteManyFromB2(urls);
}

router.get('/api/pengajuan/:id/slik-owners', async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;

        const result = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_slik, slik_data, created_at
                FROM t_pengajuan_slik
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
                ORDER BY created_at DESC
            `);

        const owners = new Map();

        for (const row of result.recordset || []) {
            let data = {};
            try {
                data = typeof row.slik_data === 'string'
                    ? JSON.parse(row.slik_data)
                    : row.slik_data || {};
            } catch (_) {
                data = {};
            }

            const jenis = (data.jenis || data.jenis_pemilik || 'DEBITUR')
                .toString()
                .toUpperCase()
                .trim();

            const nama = (data.nama_debitur || data.nama || data.nama_pemilik || '')
                .toString()
                .trim();

            if (!nama) continue;

            const key = `${jenis}|${nama}`;

            if (!owners.has(key)) {
                owners.set(key, {
                    jenis,
                    nama,
                    jumlah: 0,
                });
            }

            owners.get(key).jumlah += 1;
        }

        res.json({
            status: 'success',
            data: [...owners.values()],
        });
    } catch (error) {
        console.error('GET slik owners error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.get('/api/pengajuan/:id/slik-owner-detail', async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        const jenisFilter = (req.query.jenis || '').toString().toUpperCase().trim();
        const namaFilter = (req.query.nama || '').toString().toUpperCase().trim();

        const result = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_slik, slik_data, created_at
                FROM t_pengajuan_slik
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
                ORDER BY created_at DESC
            `);

        const rows = [];

        for (const row of result.recordset || []) {
            let data = {};
            try {
                data = typeof row.slik_data === 'string'
                    ? JSON.parse(row.slik_data)
                    : row.slik_data || {};
            } catch (_) {
                data = {};
            }

            const jenis = (data.jenis || data.jenis_pemilik || 'DEBITUR')
                .toString()
                .toUpperCase()
                .trim();

            const nama = (data.nama_debitur || data.nama || data.nama_pemilik || '')
                .toString()
                .toUpperCase()
                .trim();

            if (jenisFilter && jenis !== jenisFilter) continue;
            if (namaFilter && nama !== namaFilter) continue;

            rows.push({
                ...data,
                id_slik: row.id_slik,
                id_pengajuan: id,
                jenis_pemilik: jenis,
                nama: data.nama_debitur || data.nama || data.nama_pemilik || '',
            });
        }

        res.json({
            status: 'success',
            data: rows,
        });
    } catch (error) {
        console.error('GET slik owner detail error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/slik/:id', async (req, res) => {
    const { id } = req.params;
    const { slik_data, jenis, index } = req.body;

    try {
        const pool = await getPool();

        const normalizedJenis = (jenis || slik_data?.jenis || 'DEBITUR')
            .toString()
            .toUpperCase();

        const normalizedIndex =
            index ?? slik_data?.index ?? slik_data?.index_ke ?? null;

        const finalSlikData = {
            ...(slik_data || {}),
            jenis: normalizedJenis,
            index: normalizedIndex,
        };

        // Ambil data lama, filter JSON di Node.js supaya aman untuk SQL Server lama.
        const existing = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT id_slik, slik_data
                FROM t_pengajuan_slik
                WHERE id_pengajuan = @id_pengajuan
            `);

        const idsToDelete = [];

        for (const row of existing.recordset || []) {
            let parsed = {};
            try {
                parsed = typeof row.slik_data === 'string'
                    ? JSON.parse(row.slik_data)
                    : row.slik_data || {};
            } catch (_) {}

            const oldJenis = (parsed.jenis || 'DEBITUR')
                .toString()
                .toUpperCase();

            const oldIndex = parsed.index ?? parsed.index_ke ?? null;

            if (
                oldJenis === normalizedJenis &&
                String(oldIndex ?? '') === String(normalizedIndex ?? '')
            ) {
                idsToDelete.push(row.id_slik);
            }
        }

        if (idsToDelete.length > 0) {
            await pool.request()
                .input('ids', sql.VarChar, idsToDelete.join(','))
                .query(`
                    DELETE FROM t_pengajuan_slik
                    WHERE id_slik IN (
                        SELECT TRY_CAST(value AS INT)
                        FROM STRING_SPLIT(@ids, ',')
                        WHERE TRY_CAST(value AS INT) IS NOT NULL
                    )
                `);
        }

        await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .input('slik_data', sql.NVarChar, JSON.stringify(finalSlikData))
            .input('created_at', sql.DateTime, new Date())
            .query(`
                INSERT INTO t_pengajuan_slik
                    (id_pengajuan, slik_data, created_at)
                VALUES
                    (@id_pengajuan, @slik_data, @created_at)
            `);

        res.json({
            status: 'success',
            success: true,
            message: 'Data SLIK berhasil disimpan',
        });
    } catch (error) {
        console.error('SAVE SLIK ERROR:', error);
        res.status(500).json({
            status: 'error',
            success: false,
            message: error.message,
        });
    }
});

// =======================================================
// SLIK UPLOAD PDF + TXT
// =======================================================

const uploadSlik = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024,
        files: 2,
    },
    fileFilter: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();

        if (file.fieldname === 'pdf_file' && extension !== '.pdf') {
            return callback(new Error('File PDF SLIK harus berformat .pdf'));
        }

        if (file.fieldname === 'txt_file' && extension !== '.txt') {
            return callback(new Error('File TXT SLIK harus berformat .txt'));
        }

        if (!['pdf_file', 'txt_file'].includes(file.fieldname)) {
            return callback(new Error(`Field file tidak dikenali: ${file.fieldname}`));
        }

        callback(null, true);
    },
});

async function ensureSlikUploadTable(pool) {
    await pool.request().query(`
        IF OBJECT_ID('dbo.slik_upload', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.slik_upload (
                id INT IDENTITY(1,1) PRIMARY KEY,
                upload_id VARCHAR(50) NOT NULL UNIQUE,
                userid VARCHAR(50) NULL,
                nama_debitur VARCHAR(200) NULL,
                no_identitas VARCHAR(100) NULL,

                pdf_filename NVARCHAR(255) NULL,
                pdf_b2_key NVARCHAR(500) NULL,
                pdf_url NVARCHAR(MAX) NULL,
                pdf_size BIGINT NULL,

                txt_filename NVARCHAR(255) NULL,
                txt_b2_key NVARCHAR(500) NULL,
                txt_url NVARCHAR(MAX) NULL,
                txt_size BIGINT NULL,

                status VARCHAR(30) NOT NULL DEFAULT 'uploaded',
                parse_status VARCHAR(30) NULL,
                parse_message NVARCHAR(MAX) NULL,

                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END
    `);
}

function parseSlikTxtBasic(buffer) {
    const text = buffer.toString('utf8');
    const clean = text.replace(/\r/g, '');

    const findValue = (patterns) => {
        for (const p of patterns) {
            const match = clean.match(p);
            if (match && match[1]) return match[1].trim().replace(/\s+/g, ' ');
        }
        return null;
    };

    return {
        nama_debitur: findValue([
            /Nama\s+Debitur\s*[:=]\s*(.+)/i,
            /Nama\s*[:=]\s*(.+)/i,
        ]),
        no_identitas: findValue([
            /NIK\s*[:=]\s*(.+)/i,
            /No\.?\s*Identitas\s*[:=]\s*(.+)/i,
            /Nomor\s+Identitas\s*[:=]\s*(.+)/i,
        ]),
        raw_length: text.length,
    };
}

async function readB2BodyBuffer(body) {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);

    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function parseSlikTxtForPreview(buffer) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    const basic = parseSlikTxtBasic(buffer);

    if (!text) {
        return {
            ...basic,
            fasilitas: [],
            kesimpulan: 'File TXT SLIK kosong atau tidak terbaca',
        };
    }

    try {
        const json = JSON.parse(text);
        if (json && typeof json === 'object') {
            return json;
        }
    } catch (_) {}

    return {
        ...basic,
        fasilitas: [],
        kesimpulan: basic.nama_debitur || basic.no_identitas
            ? 'TXT berhasil dibaca, namun detail fasilitas kredit tidak tersedia dalam format JSON.'
            : 'TXT berhasil dibaca, namun format detail SLIK belum dikenali.',
    };
}

router.get('/api/slik/health', async (req, res) => {
    res.json({
        success: true,
        message: 'SLIK route aktif',
    });
});

router.post(
    '/api/slik/upload',
    uploadSlik.fields([
        { name: 'pdf_file', maxCount: 1 },
        { name: 'txt_file', maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            const pool = await getPool();
            await ensureSlikUploadTable(pool);

            const userid =
                req.body?.userid?.toString().trim() ||
                req.get('x-userid') ||
                null;

            const pdfFile = req.files?.pdf_file?.[0] || null;
            const txtFile = req.files?.txt_file?.[0] || null;

            if (!pdfFile && !txtFile) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimal upload file PDF atau TXT SLIK.',
                });
            }

            const uploadId = `SLIK${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const savedFiles = await saveSlikFiles(uploadId, [pdfFile, txtFile].filter(Boolean));

            const pdfSaved = savedFiles.find((f) => f.field === 'pdf_file') || null;
            const txtSaved = savedFiles.find((f) => f.field === 'txt_file') || null;

            let parsed = null;

            if (txtFile) {
                parsed = parseSlikTxtBasic(txtFile.buffer);
            }

            await pool.request()
                .input('upload_id', sql.VarChar, uploadId)
                .input('userid', sql.VarChar, userid)
                .input('nama_debitur', sql.VarChar, parsed?.nama_debitur || null)
                .input('no_identitas', sql.VarChar, parsed?.no_identitas || null)

                .input('pdf_filename', sql.NVarChar, pdfSaved?.original_name || null)
                .input('pdf_b2_key', sql.NVarChar, pdfSaved?.key || null)
                .input('pdf_url', sql.NVarChar, pdfSaved?.path || null)
                .input('pdf_size', sql.BigInt, pdfSaved?.size || null)

                .input('txt_filename', sql.NVarChar, txtSaved?.original_name || null)
                .input('txt_b2_key', sql.NVarChar, txtSaved?.key || null)
                .input('txt_url', sql.NVarChar, txtSaved?.path || null)
                .input('txt_size', sql.BigInt, txtSaved?.size || null)

                .input('status', sql.VarChar, 'uploaded')
                .input('parse_status', sql.VarChar, txtFile ? 'parsed_basic' : 'no_txt')
                .input(
                    'parse_message',
                    sql.NVarChar,
                    txtFile
                        ? `TXT terbaca. Panjang karakter: ${parsed?.raw_length || 0}`
                        : 'Upload tanpa file TXT, parsing belum dilakukan.'
                )
                .query(`
                    INSERT INTO dbo.slik_upload (
                        upload_id, userid, nama_debitur, no_identitas,
                        pdf_filename, pdf_b2_key, pdf_url, pdf_size,
                        txt_filename, txt_b2_key, txt_url, txt_size,
                        status, parse_status, parse_message
                    )
                    VALUES (
                        @upload_id, @userid, @nama_debitur, @no_identitas,
                        @pdf_filename, @pdf_b2_key, @pdf_url, @pdf_size,
                        @txt_filename, @txt_b2_key, @txt_url, @txt_size,
                        @status, @parse_status, @parse_message
                    )
                `);

            res.json({
                success: true,
                message: txtFile
                    ? 'File SLIK berhasil diupload ke Backblaze dan TXT berhasil dibaca awal.'
                    : 'File PDF SLIK berhasil diupload ke Backblaze. TXT belum dipilih.',
                data: {
                    upload_id: uploadId,
                    userid,
                    nama_debitur: parsed?.nama_debitur || null,
                    no_identitas: parsed?.no_identitas || null,
                    pdf_file: pdfSaved,
                    txt_file: txtSaved,
                    parsed,
                },
            });
        } catch (error) {
            console.error('SLIK UPLOAD ERROR:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Gagal upload SLIK',
            });
        }
    }
);

async function saveSlikFiles(uploadId, files = []) {
    if (!files.length) return [];

    const uploadTasks = files.map((file) => {
        const filename = `${Date.now()}-${file.fieldname}-${safeFilename(file.originalname)}`;
       const key = `pengajuan/slik_upload/${uploadId}/${filename}`;

        return {
            field: file.fieldname,
            original_name: file.originalname,
            filename,
            key,
            mimetype: file.mimetype,
            size: file.size,
            promise: uploadToB2({
                key,
                buffer: file.buffer,
                contentType: file.mimetype,
            }),
        };
    });

    const results = await Promise.allSettled(uploadTasks.map((task) => task.promise));

    const savedFiles = [];
    const failedFiles = [];

    results.forEach((result, index) => {
        const task = uploadTasks[index];

        if (result.status === 'fulfilled') {
            savedFiles.push({
                field: task.field,
                original_name: task.original_name,
                filename: task.filename,
                key: task.key,
                path: result.value,
                mimetype: task.mimetype,
                size: task.size,
            });
        } else {
            failedFiles.push({
                field: task.field,
                original_name: task.original_name,
                key: task.key,
                error: result.reason?.message || String(result.reason),
            });
        }
    });

    if (failedFiles.length > 0) {
        await cleanupSavedFiles(savedFiles);
        throw new Error(
            `Upload SLIK gagal untuk ${failedFiles.length} file: ` +
            failedFiles.map((f) => f.original_name).join(', ')
        );
    }

    return savedFiles;
}

router.get('/api/slik/uploads', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureSlikUploadTable(pool);

        const search = req.query.search?.toString().trim() || '';

        const result = await pool.request()
            .input('search', sql.NVarChar, `%${search}%`)
            .query(`
                SELECT TOP 100
                    id,
                    upload_id,
                    userid,
                    nama_debitur,
                    no_identitas,
                    pdf_filename,
                    pdf_b2_key,
                    pdf_url,
                    pdf_size,
                    txt_filename,
                    txt_b2_key,
                    txt_url,
                    txt_size,
                    status,
                    parse_status,
                    parse_message,
                    created_at,
                    updated_at
                FROM dbo.slik_upload
                WHERE
                    @search = '%%'
                    OR ISNULL(upload_id, '') LIKE @search
                    OR ISNULL(userid, '') LIKE @search
                    OR ISNULL(nama_debitur, '') LIKE @search
                    OR ISNULL(no_identitas, '') LIKE @search
                    OR ISNULL(pdf_filename, '') LIKE @search
                    OR ISNULL(txt_filename, '') LIKE @search
                ORDER BY created_at DESC
            `);

        res.json({
            success: true,
            data: result.recordset,
        });
    } catch (error) {
        console.error('SLIK LIST ERROR:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Gagal memuat upload SLIK',
        });
    }
});

router.get('/api/slik/uploads/:uploadId/parsing', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureSlikUploadTable(pool);

        const result = await pool.request()
            .input('upload_id', sql.VarChar, req.params.uploadId)
            .query(`
                SELECT TOP 1
                    upload_id,
                    nama_debitur,
                    no_identitas,
                    txt_filename,
                    txt_b2_key,
                    txt_url,
                    parse_status,
                    parse_message
                FROM dbo.slik_upload
                WHERE upload_id = @upload_id
            `);

        const row = result.recordset[0];

        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Data upload SLIK tidak ditemukan',
            });
        }

        const txtKey = row.txt_b2_key || row.txt_url;
        if (!txtKey) {
            return res.status(404).json({
                success: false,
                message: 'File TXT SLIK belum tersedia untuk parsing lengkap',
            });
        }

        const { result: b2Result } = await getB2Object(txtKey);
        const buffer = await readB2BodyBuffer(b2Result.Body);
        const parsed = parseSlikTxtForPreview(buffer);

        res.json({
            success: true,
            data: {
                ...parsed,
                nama_debitur: parsed.nama_debitur || row.nama_debitur,
                no_identitas: parsed.no_identitas || row.no_identitas,
                txt_filename: row.txt_filename,
                parse_status: row.parse_status,
                parse_message: row.parse_message,
            },
        });
    } catch (error) {
        console.error('SLIK PARSING DETAIL ERROR:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Gagal membuka hasil parsing SLIK',
        });
    }
});

router.get('/api/slik/uploads/:uploadId', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureSlikUploadTable(pool);

        const result = await pool.request()
            .input('upload_id', sql.VarChar, req.params.uploadId)
            .query(`
                SELECT TOP 1 *
                FROM dbo.slik_upload
                WHERE upload_id = @upload_id
            `);

        if (!result.recordset.length) {
            return res.status(404).json({
                success: false,
                message: 'Data upload SLIK tidak ditemukan',
            });
        }

        res.json({
            success: true,
            data: result.recordset[0],
        });
    } catch (error) {
        console.error('SLIK DETAIL ERROR:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Gagal memuat detail SLIK',
        });
    }
});

router.delete('/api/slik/uploads/:uploadId', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureSlikUploadTable(pool);

        const uploadId = req.params.uploadId;

        const result = await pool.request()
            .input('upload_id', sql.VarChar, uploadId)
            .query(`
                SELECT TOP 1
                    upload_id,
                    pdf_b2_key,
                    txt_b2_key,
                    pdf_url,
                    txt_url
                FROM dbo.slik_upload
                WHERE upload_id = @upload_id
            `);

        const row = result.recordset[0];

        if (!row) {
            return res.status(404).json({
                success: false,
                message: 'Data upload SLIK tidak ditemukan',
            });
        }

        const filesToDelete = [
            row.pdf_b2_key,
            row.txt_b2_key,
            row.pdf_url,
            row.txt_url,
        ].filter((value) => value && value.toString().trim());

        if (filesToDelete.length > 0) {
            await deleteManyFromB2(filesToDelete);
        }

        await pool.request()
            .input('upload_id', sql.VarChar, uploadId)
            .query(`
                DELETE FROM dbo.slik_upload
                WHERE upload_id = @upload_id
            `);

        res.json({
            success: true,
            message: 'Data SLIK dan file Backblaze berhasil dihapus',
            deleted_files: filesToDelete.length,
        });
    } catch (error) {
        console.error('DELETE SLIK UPLOAD ERROR:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Gagal menghapus data SLIK',
        });
    }
});

module.exports = router;

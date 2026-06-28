const { sql } = require('../../../core/network/db');
const { sendWhatsAppNotification } = require('../../../core/notification/whatsapp');
const { formatRupiah, pickDebiturName } = require('./helper');

const PENGAJUAN_STATUS = Object.freeze({
    DRAFT: '0',
    VERIFIKASI_ADMIN: '1',
    APPROVAL_AWAL: '10',
    FPK_AO: '2',
    CHECKLIST_ADMIN: '3',
    REKAP_ANALISA: '4',
    SURVEY_DEBITUR: '5',
    SURVEY_AGUNAN: '6',
    MUK_REVIEW: '7',
    APPROVAL_FINAL: '8',
    KOREKSI_AO: '90',
    KOREKSI_ADMIN: '91',
    DITOLAK: '99',
});

const workflowNotificationTargets = {
    [PENGAJUAN_STATUS.VERIFIKASI_ADMIN]: {
        jabatanCodes: ['13'],
        menu: 'Verifikasi Pengajuan',
        action: 'melakukan verifikasi pengajuan',
    },
    [PENGAJUAN_STATUS.FPK_AO]: {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'FPK Pengajuan',
        action: 'melengkapi FPK pengajuan',
    },
    [PENGAJUAN_STATUS.CHECKLIST_ADMIN]: {
        jabatanCodes: ['13'],
        menu: 'Checklist Kelengkapan',
        action: 'melakukan checklist kelengkapan dokumen',
    },
    [PENGAJUAN_STATUS.REKAP_ANALISA]: {
        jabatanCodes: ['13', '14'],
        menu: 'Rekap dan Analisa',
        action: 'melakukan rekap dan analisa kredit',
    },
    [PENGAJUAN_STATUS.SURVEY_DEBITUR]: {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'Survey Debitur',
        action: 'melakukan survey debitur',
    },
    [PENGAJUAN_STATUS.SURVEY_AGUNAN]: {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'Survey Agunan',
        action: 'melakukan survey agunan',
    },
    [PENGAJUAN_STATUS.MUK_REVIEW]: {
        jabatanCodes: ['15'],
        menu: 'MUK',
        action: 'melakukan review MUK',
    },
    [PENGAJUAN_STATUS.APPROVAL_FINAL]: {
        jabatanCodes: ['15', '17'],
        menu: 'MUK',
        action: 'menindaklanjuti MUK',
    },
    [PENGAJUAN_STATUS.APPROVAL_AWAL]: {
        jabatanCodes: ['14'],
        menu: 'Approval Awal',
        action: 'melakukan approval awal',
    },
    [PENGAJUAN_STATUS.KOREKSI_AO]: {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'Pengajuan',
        action: 'menindaklanjuti koreksi pengajuan',
    },
    [PENGAJUAN_STATUS.KOREKSI_ADMIN]: {
        jabatanCodes: ['13'],
        menu: 'Verifikasi Pengajuan',
        action: 'menindaklanjuti koreksi verifikasi',
    },
    [PENGAJUAN_STATUS.DITOLAK]: {
        jabatanCodes: ['13', '15'],
        targetAo: true,
        menu: 'Pengajuan',
        action: 'mengetahui pengajuan ditolak atau dibatalkan',
    },
};

const deleteNotificationTarget = {
    jabatanCodes: ['13', '15'],
    targetAo: true,
    menu: 'Pengajuan',
    action: 'mengetahui pengajuan yang dihapus',
};

async function getPengajuanNotificationSummary(pool, idPengajuan, fallback = {}) {
    const id = idPengajuan || fallback.id_pengajuan;
    if (!id) return { ...fallback };

    const result = await pool.request()
        .input('id_pengajuan', sql.VarChar, id)
        .query(`
            SELECT TOP 1
                   a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan,
                   a.tenor_bulan, a.status_pengajuan, a.id_ao, a.stsflag,
                   b.nama_debitur, c.nama_perusahaan
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.id_pengajuan = @id_pengajuan
        `);

    return {
        ...fallback,
        ...(result.recordset[0] || {}),
        id_pengajuan: id,
    };
}

async function getActiveNotificationUsers(pool, target = {}, summary = {}) {
    const codes = (target.jabatanCodes || [])
        .map((code) => code.toString().replace(/\D/g, ''))
        .filter(Boolean);
    const aoUserid = target.targetAo ? summary.id_ao?.toString().trim() : '';
    if (!codes.length && !aoUserid) return [];

    const request = pool.request();
    const conditions = [];

    if (codes.length) {
        conditions.push(`jabat IN (${codes.map((code) => `'${code}'`).join(', ')})`);
    }
    if (aoUserid) {
        request.input('ao_userid', sql.VarChar, aoUserid);
        conditions.push('userid = @ao_userid');
    }

    const result = await request.query(`
        SELECT userid, username, nohp, jabat, kdcab
        FROM muser
        WHERE ISNULL(flag, '1') = '1'
          AND nohp IS NOT NULL
          AND LTRIM(RTRIM(nohp)) <> ''
          AND (${conditions.join(' OR ')})
    `);

    const byPhone = new Map();
    for (const user of result.recordset || []) {
        const phone = user.nohp?.toString().replace(/\D/g, '');
        if (!phone) continue;
        byPhone.set(phone, user);
    }
    return [...byPhone.values()];
}

function getDebiturName(summary = {}) {
    return summary.nama_debitur || summary.nama_perusahaan || pickDebiturName(summary);
}

function buildWorkflowNotificationMessage({ summary, target, event, previousStsflag, catatan }) {
    const eventText = {
        save: `Pengajuan sudah disimpan dan menunggu ${target.action}.`,
        koreksi: `Pengajuan dikoreksi dari status ${previousStsflag || '-'} dan dikembalikan untuk ${target.action}.`,
        delete: 'Pengajuan telah dihapus dari sistem.',
        muk: 'MUK pengajuan telah disimpan dan siap ditindaklanjuti.',
    }[event] || `Pengajuan menunggu ${target.action}.`;

    const lines = [
        '*HONAI - Pengajuan Kredit*',
        '',
        eventText,
        '',
        `ID Pengajuan: ${summary.id_pengajuan || '-'}`,
        `Debitur: ${getDebiturName(summary)}`,
        `Jenis Debitur: ${summary.jenis_debitur || '-'}`,
        `Plafon: ${formatRupiah(summary.plafon_pengajuan)}`,
        `Tenor: ${summary.tenor_bulan || '-'} bulan`,
        `AO: ${summary.id_ao || '-'}`,
    ];

    if (catatan) {
        lines.push('', `Catatan: ${catatan}`);
    }

    if (event !== 'delete') {
        lines.push('', `Silakan buka menu ${target.menu}.`);
    }

    return lines.join('\n');
}

async function notifyWorkflowUsers(pool, {
    idPengajuan,
    fallback = {},
    targetStsflag,
    targetOverride,
    event = 'save',
    previousStsflag = null,
    catatan = null,
}) {
    const target = targetOverride || workflowNotificationTargets[String(targetStsflag || '')];
    if (!target) {
        return { skipped: true, reason: `Tidak ada target notifikasi untuk stsflag ${targetStsflag}` };
    }

    const summary = await getPengajuanNotificationSummary(pool, idPengajuan || fallback.id_pengajuan, fallback);
    const recipients = await getActiveNotificationUsers(pool, target, summary);
    if (!recipients.length) {
        console.log(`[WA] skipped ${event} ${summary.id_pengajuan || '-'} -> ${target.menu}: no recipients`);
        return { skipped: true, reason: 'Tidak ada user penerima WA yang aktif/bernomor HP' };
    }

    console.log(`[WA] sending ${event} ${summary.id_pengajuan || '-'} -> ${target.menu} to ${recipients.length} user(s): ${recipients.map((user) => user.userid).join(', ')}`);
    const text = buildWorkflowNotificationMessage({
        summary,
        target,
        event,
        previousStsflag,
        catatan,
    });
    const results = [];
    for (const user of recipients) {
        try {
            const result = await sendWhatsAppNotification(user.nohp, text);
            results.push({ userid: user.userid, nohp: user.nohp, success: true, result });
        } catch (error) {
            console.error(`WA notification failed for ${user.userid}:`, error.message);
            results.push({ userid: user.userid, nohp: user.nohp, success: false, error: error.message });
        }
    }

    const summaryResult = {
        sent: results.filter((item) => item.success).length,
        failed: results.filter((item) => !item.success).length,
        recipients: results.length,
        results,
    };
    console.log(`[WA] result ${event} ${summary.id_pengajuan || '-'}: sent=${summaryResult.sent}, failed=${summaryResult.failed}`);
    return summaryResult;
}

async function notifyWorkflowUsersSafe(pool, options) {
    try {
        return await notifyWorkflowUsers(pool, options);
    } catch (notificationError) {
        console.error('WA notification error:', notificationError.message);
        return {
            failed: true,
            error: notificationError.message,
        };
    }
}

function queueWorkflowNotification(pool, options) {
    notifyWorkflowUsersSafe(pool, options).catch((error) => {
        console.error('WA notification queue error:', error.message);
    });

    return {
        queued: true,
        message: 'Notifikasi WhatsApp diproses di background',
    };
}

module.exports = {
    deleteNotificationTarget,
    getPengajuanNotificationSummary,
    notifyWorkflowUsersSafe,
    queueWorkflowNotification,
};

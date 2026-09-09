const INITIAL_STAGES = ['0', '90'];
function screeningSubmissionError(body, files = [], existing = {}) {
    if (!body.screening_awal && !existing.screening_awal) return null;
    const stage = String(existing.stsflag ?? '0');
    if (INITIAL_STAGES.includes(stage)) {
        if (body.form_lengkap === true || body.data_kredit || body.data_penghasilan || body.list_jaminan?.length) {
            return 'Data lanjutan baru dapat diisi setelah pemeriksaan admin.';
        }
        if (!['0', '1'].includes(String(body.stsflag))) return 'Pengajuan awal hanya dapat disimpan sebagai draft atau dikirim ke admin.';
        if (String(body.stsflag) === '1') {
            const consent = body.persetujuan_slik;
            if (!consent?.text?.trim() || !consent?.signature?.trim()) return 'Tanda tangan persetujuan SLIK & Dukcapil wajib disimpan.';
            if (!(Number(body.plafon_pengajuan) > 0) || !(Number(body.tenor_bulan) > 0)) return 'Plafon dan tenor wajib diisi.';
            if (body.jenis_debitur === 'PERORANGAN') {
                const d = body.data_perorangan || {};
                if (!d.nama_debitur?.trim() || !/^\d{16}$/.test(d.no_ktp || '')) return 'Nama dan NIK 16 digit wajib diisi.';
                if (!files.some(f => f.fieldname === 'file_debitur') && !existing.foto_ktp) return 'Foto KTP debitur wajib dilampirkan.';
            }
        }
    } else if (stage === '2') {
        if (!['2', '3'].includes(String(body.stsflag))) return 'Lengkapi data pengajuan pada tahap AO.';
    } else {
        return 'Pengajuan tidak berada pada tahap input AO.';
    }
    return null;
}

function screeningDecision({ decision, note, hasSlik, hasDukcapil, identityValid }) {
    if (!['lanjut', 'perbaikan', 'tidak_lanjut'].includes(decision)) return { error: 'Pilih keputusan pemeriksaan admin.' };
    if (decision !== 'lanjut' && !String(note || '').trim()) return { error: 'Catatan wajib diisi untuk perbaikan atau tidak dilanjutkan.' };
    if (decision === 'lanjut' && (!hasSlik || !hasDukcapil || !identityValid)) return { error: 'Lengkapi hasil SLIK, hasil Dukcapil, dan verifikasi identitas sebelum melanjutkan.' };
    return { status: { lanjut: '2', perbaikan: '90', tidak_lanjut: '99' }[decision] };
}
module.exports = { screeningSubmissionError, screeningDecision };

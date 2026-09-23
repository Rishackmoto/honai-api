const INITIAL_STAGES = ['0', '90'];
function readConsent(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}
const text = value => String(value ?? '').trim();
function identityError(person, keys, hasPhoto, signature, label) {
    if (!text(person[keys[0]]) || !/^\d{16}$/.test(text(person[keys[1]])) ||
        !text(person[keys[2]]) || !text(person[keys[3]]) || !text(person[keys[4]]) ||
        !hasPhoto || !text(signature)) {
        return `${label}: lengkapi nama, NIK 16 digit, tempat/tanggal lahir, alamat KTP, foto KTP, dan tanda tangan persetujuan.`;
    }
    const date = new Date(person[keys[3]]);
    if (!Number.isFinite(date.getTime()) || date > new Date()) return `${label}: tanggal lahir tidak valid.`;
    return null;
}
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
                if (!['Belum Menikah', 'Menikah', 'Duda', 'Janda'].includes(d.status_menikah)) return 'Pilih status pernikahan untuk menentukan kebutuhan data pasangan.';
                if (!d.nama_debitur?.trim() || !/^\d{16}$/.test(d.no_ktp || '')) return 'Nama dan NIK 16 digit wajib diisi.';
                if (!files.some(f => f.fieldname === 'file_debitur') && !existing.foto_ktp) return 'Foto KTP debitur wajib dilampirkan.';
                const error = identityError(d, ['nama_debitur', 'no_ktp', 'tempat_lahir', 'tanggal_lahir', 'alamat_debitur'],
                    files.some(f => f.fieldname === 'file_debitur') || existing.foto_ktp, consent.signature, 'Debitur');
                if (error) return error;
                if (d.status_menikah === 'Menikah' || text(d.nama_pasangan) || text(d.ktp_pasangan)) {
                    const spouseError = identityError(d, ['nama_pasangan', 'ktp_pasangan', 'tempat_lahir_pasangan', 'tanggal_lahir_pasangan', 'alamat_pasangan'],
                        files.some(f => f.fieldname === 'file_pasangan') || existing.foto_pasangan, d.ttd_pasangan, 'Pasangan');
                    if (spouseError) return spouseError;
                }
            } else if (body.jenis_debitur === 'BADAN_USAHA') {
                const d = body.data_badan_usaha || {};
                if (!text(d.nama_perusahaan) || !text(d.npwp) || !text(d.tgl_berdiri)) return 'Nama perusahaan, NPWP, dan tanggal berdiri wajib diisi.';
                if (!Array.isArray(body.list_pendiri) || !body.list_pendiri.length) return 'Tambahkan pengurus yang akan diperiksa.';
            }
            for (const role of ['pendiri', 'penjamin']) {
                const people = body[`list_${role}`] || [];
                if (!Array.isArray(people)) return `Daftar ${role} tidak valid.`;
                for (let i = 0; i < people.length; i++) {
                    const p = people[i];
                    const error = identityError(p, [`nama_${role}`, `ktp_${role}`, 'tempat_lahir', 'tanggal_lahir', 'alamat_ktp'],
                        files.some(f => f.fieldname === `file_${role}_${i}`) || p[`foto_${role}_url`] || p[`foto_${role}`],
                        p[`ttd_${role}`], `${role === 'pendiri' ? 'Pengurus' : 'Penjamin'} ${i + 1}`);
                    if (error) return error;
                }
            }
        }
    } else if (stage === '2') {
        if (readConsent(existing.persetujuan_slik).ao_decision !== 'lanjut') return 'Pilih Lanjutkan Pengajuan setelah membaca hasil pemeriksaan admin.';
        if (!['2', '3'].includes(String(body.stsflag))) return 'Lengkapi data pengajuan pada tahap AO.';
    } else {
        return 'Pengajuan tidak berada pada tahap input AO.';
    }
    return null;
}

// Changes to screened identities must return through the existing correction flow.
function screeningIdentityChanged(body, old, files = []) {
    const normalized = value => value instanceof Date ? value.toISOString().slice(0, 10) : (/^\d{4}-\d{2}-\d{2}T/.test(text(value)) ? text(value).slice(0, 10) : text(value));
    const changed = (next, previous, fields) => fields.some(key =>
        Object.prototype.hasOwnProperty.call(next || {}, key) && normalized(next[key]) !== normalized(previous[key]));
    if (files.some(f => /^(file_debitur|file_pasangan|file_penjamin_\d+|file_pendiri_\d+|ttd_penjamin_\d+|ttd_pendiri_\d+)$/.test(f.fieldname))) return true;
    if (changed(body.data_perorangan, old.perorangan, ['nama_debitur', 'no_ktp', 'tempat_lahir', 'tanggal_lahir', 'alamat_debitur', 'status_menikah',
        'nama_pasangan', 'ktp_pasangan', 'tempat_lahir_pasangan', 'tanggal_lahir_pasangan', 'alamat_pasangan', 'ttd_debitur', 'ttd_pasangan'])) return true;
    if (changed(body.data_badan_usaha, old.badanUsaha, ['nama_perusahaan', 'npwp', 'tgl_berdiri'])) return true;
    for (const role of ['pendiri', 'penjamin']) {
        const next = body[`list_${role}`];
        if (next == null) continue;
        const previous = old[role];
        if (!Array.isArray(next) || next.length !== previous.length) return true;
        // Keep order too: screening results use the person's list position.
        if (next.some((p, i) => changed(p, previous[i], [`nama_${role}`, `ktp_${role}`, 'tempat_lahir', 'tanggal_lahir', 'alamat_ktp', `ttd_${role}`]) ||
            (Object.prototype.hasOwnProperty.call(p, `foto_${role}_url`) && text(p[`foto_${role}_url`]) !== text(previous[i][`foto_${role}`])))) return true;
    }
    return false;
}

function screeningDecision({ decision, note, hasSlik, hasDukcapil, identityValid }) {
    if (!['lanjut', 'perbaikan', 'tidak_lanjut'].includes(decision)) return { error: 'Pilih keputusan pemeriksaan admin.' };
    if (decision !== 'lanjut' && !String(note || '').trim()) return { error: 'Catatan wajib diisi untuk perbaikan atau tidak dilanjutkan.' };
    if (decision === 'lanjut' && (!hasSlik || !hasDukcapil || !identityValid)) return { error: 'Lengkapi hasil SLIK, hasil Dukcapil, dan verifikasi identitas sebelum melanjutkan.' };
    return { status: { lanjut: '10', perbaikan: '90', tidak_lanjut: '99' }[decision] };
}
module.exports = { screeningSubmissionError, screeningDecision, readConsent, screeningIdentityChanged };

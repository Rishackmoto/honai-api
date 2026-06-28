function formatRupiah(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return '-';
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0,
    }).format(number);
}

function pickDebiturName(body = {}) {
    if (body.jenis_debitur === 'BADAN_USAHA') {
        return body.data_badan_usaha?.nama_perusahaan || '-';
    }
    return body.data_perorangan?.nama_debitur || '-';
}

function safeFilename(filename = '') {
    return filename.toString().replace(/[^a-zA-Z0-9._-]/g, '_');
}

module.exports = {
    formatRupiah,
    pickDebiturName,
    safeFilename,
};

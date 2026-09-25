const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

const ORGANIZATION_ROLES = new Set(['11', '16', '17', '18', '19']);
const BRANCH_ROLES = new Set(['13', '14', '15']);

function dashboardScope({ userid = '', jabat = '', kdcab = '' } = {}) {
  const role = digits(jabat);
  const user = String(userid || '').trim();
  const branch = String(kdcab || '').trim();

  if (role === '12') {
    if (!user) return { where: '1 = 0', userid: null, kdcab: null, label: 'AO belum teridentifikasi' };
    return { where: 'p.id_ao = @scope_userid', userid: user, kdcab: null, label: 'Pengajuan AO saya' };
  }

  if (BRANCH_ROLES.has(role)) {
    if (!branch) return { where: '1 = 0', userid: null, kdcab: null, label: 'Cabang user belum terpetakan' };
    return { where: "ISNULL(ao.kdcab, '') = @scope_kdcab", userid: null, kdcab: branch, label: `Cabang ${branch}` };
  }

  if (ORGANIZATION_ROLES.has(role)) {
    return { where: '1 = 1', userid: null, kdcab: null, label: 'Seluruh pengajuan' };
  }

  // Safe fallback: role yang belum dipetakan tidak mendapat scope organisasi.
  if (user) {
    return { where: 'p.id_ao = @scope_userid', userid: user, kdcab: null, label: 'Akses terbatas ke pengajuan sendiri' };
  }
  return { where: '1 = 0', userid: null, kdcab: null, label: 'Akses dashboard belum terpetakan' };
}

const TASKS_BY_ROLE = Object.freeze({
  '12': [
    { stsflag: '2', label: 'Lengkapi Pengajuan', menu: 'FPK Pengajuan' },
    { stsflag: '5', label: 'Survey Debitur', menu: 'Survey Debitur' },
    { stsflag: '6', label: 'Survey Agunan', menu: 'Survey Agunan' },
    { stsflag: '90', label: 'Koreksi AO', menu: 'FPK Pengajuan' },
  ],
  '13': [
    { stsflag: '1', label: 'Verifikasi Pengajuan', menu: 'Verifikasi Pengajuan' },
    { stsflag: '3', label: 'Checklist Kelengkapan', menu: 'Checklist Kelengkapan' },
    { stsflag: '91', label: 'Koreksi Admin', menu: 'Verifikasi Pengajuan' },
  ],
  '14': [
    { stsflag: '10', label: 'Approval Awal', menu: 'Approval' },
    { stsflag: '4', label: 'Rekap dan Analisa', menu: 'Rekap dan Analisa' },
  ],
  '15': [
    { stsflag: '7', label: 'Review MUK', menu: 'Approval' },
  ],
  '17': [
    { stsflag: '9', label: 'Putusan Kredit', menu: 'Approval' },
  ],
  '18': [
    { stsflag: '11', label: 'Persetujuan Komisaris', menu: 'Approval' },
  ],
});

function taskDefinitionsForRole(jabat) {
  return (TASKS_BY_ROLE[digits(jabat)] || []).map((item) => ({ ...item }));
}

function pendingStatusesForRole(jabat) {
  return taskDefinitionsForRole(jabat).map((item) => item.stsflag);
}

function applyTaskCounts(definitions = [], rows = []) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(String(row.stsflag ?? '').trim(), Number(row.total || 0));
  }
  return definitions.map((item) => ({
    ...item,
    count: counts.get(item.stsflag) || 0,
  }));
}


function pipelinePhaseFromStatus(value) {
  const status = String(value ?? '').trim();
  if (['0', '2', '90'].includes(status)) return 'PENGAJUAN';
  if (['1', '3', '10', '91'].includes(status)) return 'VERIFIKASI';
  if (['5', '6'].includes(status)) return 'SURVEI';
  if (['4', '41', '8', '7'].includes(status)) return 'ANALISA_MUK';
  if (['9', '11'].includes(status)) return 'PUTUSAN';
  if (status === '100') return 'SELESAI';
  if (status === '99') return 'DITOLAK';
  return 'LAINNYA';
}

function buildMonthlySeries(rows = [], now = new Date()) {
  const values = new Map();
  for (const row of rows) {
    const year = Number(row.tahun);
    const month = Number(row.bulan);
    values.set(`${year}-${month}`, Number(row.total || 0));
  }

  const result = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    result.push({
      year,
      month,
      label: MONTH_NAMES[month - 1],
      total: values.get(`${year}-${month}`) || 0,
    });
  }
  return result;
}

module.exports = {
  digits,
  dashboardScope,
  pendingStatusesForRole,
  taskDefinitionsForRole,
  applyTaskCounts,
  buildMonthlySeries,
  pipelinePhaseFromStatus,
};

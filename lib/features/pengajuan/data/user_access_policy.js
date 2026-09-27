'use strict';

const ROLE_LEVEL = Object.freeze({
  '11': '5', // Super User -> Administrator
  '12': '1', // AO -> Operator
  '13': '1', // Admin Kredit -> Operator
  '14': '2', // Supervisor -> Supervisor
  '15': '4', // Manager -> Approval
  '16': '3', // Kepatuhan -> Signer / Reviewer
  '17': '4', // Direksi -> Approval
  '18': '4', // Komisaris -> Approval
  '19': '6', // SKAI -> Auditor / Read Only
  '20': '6', // External Reviewer -> Auditor / Read Only
});

function recommendedLevelForJabatan(jabat) {
  return ROLE_LEVEL[String(jabat || '').trim()] || '1';
}

function isAuditorUser(user) {
  const level = String(user?.levelid || '').trim();
  const jabatan = String(user?.jabat || '').trim();
  return level === '6' || jabatan === '19' || jabatan === '20';
}

function isExternalReviewer(user) {
  return String(user?.jabat || '').trim() === '20';
}

function toDateOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function accessWindowState(user, now = new Date()) {
  const start = toDateOrNull(user?.access_start_at);
  const end = toDateOrNull(user?.access_end_at);
  if (start && now < start) return { allowed: false, reason: 'NOT_STARTED', start, end };
  if (end && now > end) return { allowed: false, reason: 'EXPIRED', start, end };
  return { allowed: true, reason: 'ACTIVE', start, end };
}

module.exports = {
  ROLE_LEVEL,
  recommendedLevelForJabatan,
  isAuditorUser,
  isExternalReviewer,
  toDateOrNull,
  accessWindowState,
};

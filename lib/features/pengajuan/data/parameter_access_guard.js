'use strict';

const { sql } = require('../../../core/network/db');

function normalizeBprId(value, fallback = 'ANP') {
  return String(value || fallback).trim().toUpperCase() || fallback;
}

async function loadParameterActor(pool, req) {
  const userid = String(req.get?.('x-userid') || '').trim();
  if (!userid) {
    const error = new Error('Sesi pengguna tidak teridentifikasi. Silakan login ulang.');
    error.statusCode = 401;
    error.code = 'PARAMETER_USER_REQUIRED';
    throw error;
  }

  const result = await pool.request()
    .input('userid', sql.VarChar(30), userid)
    .query(`
      SELECT TOP 1 userid, username, levelid, jabat, bpr_id,
             ISNULL(flag,'1') AS flag,
             ISNULL(is_super_admin,0) AS is_super_admin
      FROM dbo.muser
      WHERE LTRIM(RTRIM(userid)) = LTRIM(RTRIM(@userid))
        AND ISNULL(flag,'1') = '1'
    `);

  const actor = result.recordset?.[0];
  if (!actor) {
    const error = new Error('Sesi pengguna sudah tidak aktif. Silakan login ulang.');
    error.statusCode = 401;
    error.code = 'PARAMETER_USER_INACTIVE';
    throw error;
  }

  actor.userid = String(actor.userid || '').trim();
  actor.levelid = String(actor.levelid || '').trim();
  actor.jabat = String(actor.jabat || '').trim();
  actor.bpr_id = normalizeBprId(actor.bpr_id);
  actor.is_super_admin = Boolean(actor.is_super_admin);
  return actor;
}

function requirePlatformSuperAdmin(actor) {
  if (!actor || actor.levelid !== '5' || !actor.is_super_admin) {
    const error = new Error('Fitur ini hanya dapat dikelola oleh Super Admin HONAI.');
    error.statusCode = 403;
    error.code = 'SUPER_ADMIN_REQUIRED';
    throw error;
  }
  return actor;
}

function requireTenantAdministrator(actor) {
  if (!actor || actor.levelid !== '5') {
    const error = new Error('Fitur ini hanya dapat dikelola oleh Administrator.');
    error.statusCode = 403;
    error.code = 'ADMIN_REQUIRED';
    throw error;
  }
  return actor;
}

module.exports = {
  normalizeBprId,
  loadParameterActor,
  requirePlatformSuperAdmin,
  requireTenantAdministrator,
};

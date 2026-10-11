// HONAI Refactoring R2: Login route; dependency injection retains original behavior.
const express = require('express');
module.exports = function createLoginRoutes(deps) {
  const router = express.Router();
  const { getPool, pass2StageLog, maybeEnsureSchema, ensureMuserProfileColumn, ensureMuserThemeModeColumn, ensureMuserAuditAccessColumns, ensureTenantSchema, sql, isExternalReviewer, accessWindowState, hashPassword, getUserMenuAccess, getTenantById, DEFAULT_BPR_ID, createSingleSession, levelName, jabatanName, isDbLoginError, getDbTarget } = deps;
  router.post('/api/login', async (req, res) => {
      const timer = `LOGIN-${Date.now()}-${Math.random()}`;
      console.time(timer);

      try {
          const { userid, pass } = req.body || {};

          if (!userid || !pass) {
              return res.status(400).json({
                  success: false,
                  message: 'User ID dan password wajib diisi',
              });
          }

          let loginStageAt = process.hrtime.bigint();
          const pool = await getPool();
          pass2StageLog("login", "pool", loginStageAt); loginStageAt = process.hrtime.bigint();
          await maybeEnsureSchema(ensureMuserProfileColumn, pool);
          await maybeEnsureSchema(ensureMuserThemeModeColumn, pool);
          await maybeEnsureSchema(ensureMuserAuditAccessColumns, pool);
          await ensureTenantSchema(pool);
          pass2StageLog("login", "schema", loginStageAt); loginStageAt = process.hrtime.bigint();

          const result = await pool.request()
              .input('userid', sql.VarChar(30), userid)
              .query(`
                  SELECT TOP 1
                      noref, userid, username, levelid, flag, email, nohp,
                      jabat, kdcab, foto_profile, theme_mode, pass,
                      access_start_at, access_end_at, external_institution,
                      allow_print, allow_download, bpr_id, ISNULL(is_super_admin,0) AS is_super_admin
                  FROM muser
                  WHERE userid = @userid
                    AND ISNULL(flag, '1') = '1'
              `);

          pass2StageLog("login", "user-query", loginStageAt); loginStageAt = process.hrtime.bigint();
          const user = result.recordset[0];

          if (!user) {
              return res.status(401).json({
                  success: false,
                  message: 'User ID atau password salah / user tidak aktif',
              });
          }

          if (isExternalReviewer(user)) {
              const windowState = accessWindowState(user);
              if (!windowState.allowed) {
                  return res.status(403).json({
                      success: false,
                      message: windowState.reason === 'NOT_STARTED'
                          ? 'Akses pemeriksa eksternal belum memasuki periode aktif.'
                          : 'Masa akses pemeriksa eksternal telah berakhir.',
                  });
              }
          }

          const inputHash = hashPassword(pass);
          const storedPass = (user.pass || '').toString().trim();
          const isValidPassword = storedPass === pass || storedPass === inputHash;

          if (!isValidPassword) {
              return res.status(401).json({
                  success: false,
                  message: 'User ID atau password salah / user tidak aktif',
              });
          }

          if (storedPass === pass) {
              await pool.request()
                  .input('userid', sql.VarChar(30), userid)
                  .input('pass', sql.VarChar(128), inputHash)
                  .query('UPDATE muser SET pass = @pass WHERE userid = @userid');
          }

          const { pass: _ignoredPass, ...safeUser } = user;
          const access = await getUserMenuAccess(pool, user);
          pass2StageLog("login", "access", loginStageAt); loginStageAt = process.hrtime.bigint();
          const tenant = await getTenantById(pool, user.bpr_id || DEFAULT_BPR_ID);
          pass2StageLog("login", "tenant", loginStageAt); loginStageAt = process.hrtime.bigint();

          // Security Pass 1: satu userid hanya boleh memiliki satu sesi aktif.
          // Sesi lama yang sudah idle/expired boleh digantikan; sesi yang masih aktif
          // harus logout terlebih dahulu dari perangkat asal.
          const sessionResult = await createSingleSession(pool, userid, req);
          pass2StageLog("login", "create-session", loginStageAt);
          if (sessionResult.conflict) {
              const activeDevice = sessionResult.existing?.device_name || 'perangkat lain';
              return res.status(409).json({
                  success: false,
                  code: 'USER_ALREADY_LOGGED_IN',
                  message: `Akun sedang digunakan pada ${activeDevice}. Silakan logout dari perangkat tersebut sebelum login kembali.`,
                  active_session: sessionResult.existing,
              });
          }

          return res.json({
              success: true,
              message: 'Login berhasil',
              user: {
                  ...safeUser,
                  level_name: Boolean(user.is_super_admin) ? 'Super Admin' : levelName(user.levelid),
                  jabatan_name: jabatanName(user.jabat),
                  tenant,
              },
              access,
              tenant,
              session: {
                  session_id: sessionResult.session_id,
                  token: sessionResult.token,
                  device_name: sessionResult.device_name,
                  login_at: sessionResult.login_at,
                  expires_at: sessionResult.expires_at,
              },
          });

      } catch (error) {
          console.error('LOGIN ERROR:', error);

          if (isDbLoginError(error)) {
              return res.status(503).json({
                  success: false,
                  message: `Login database gagal untuk ${getDbTarget()}.`,
              });
          }

          return res.status(500).json({
              success: false,
              message: 'Terjadi kesalahan server',
          });

      } finally {
          console.timeEnd(timer);
      }
  });
  return router;
};

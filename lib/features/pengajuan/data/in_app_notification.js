const { sql } = require('../../../core/network/db');

let schemaReady = false;
const DEDUPE_SECONDS = 120;

async function ensureInAppNotificationTable(pool) {
  if (schemaReady) return;

  await pool.request().query(`
    IF OBJECT_ID('dbo.t_notification', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.t_notification (
        id_notification BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        userid VARCHAR(30) NOT NULL,
        id_pengajuan VARCHAR(50) NULL,
        title NVARCHAR(200) NOT NULL,
        message NVARCHAR(1000) NULL,
        menu NVARCHAR(120) NULL,
        stsflag VARCHAR(10) NULL,
        event_type VARCHAR(30) NULL,
        is_read BIT NOT NULL CONSTRAINT DF_t_notification_is_read DEFAULT 0,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_t_notification_created_at DEFAULT SYSDATETIME(),
        read_at DATETIME2 NULL
      );
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_t_notification_user_read_created'
        AND object_id = OBJECT_ID('dbo.t_notification')
    )
    BEGIN
      CREATE INDEX IX_t_notification_user_read_created
      ON dbo.t_notification(userid, is_read, created_at DESC);
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_t_notification_pengajuan'
        AND object_id = OBJECT_ID('dbo.t_notification')
    )
    BEGIN
      CREATE INDEX IX_t_notification_pengajuan
      ON dbo.t_notification(id_pengajuan, created_at DESC);
    END;

    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_t_notification_dedupe'
        AND object_id = OBJECT_ID('dbo.t_notification')
    )
    BEGIN
      CREATE INDEX IX_t_notification_dedupe
      ON dbo.t_notification(userid, id_pengajuan, stsflag, event_type, is_read, created_at DESC);
    END;
  `);

  schemaReady = true;
}

function workflowNotificationTitle(target = {}, event = 'save') {
  if (event === 'delete') return 'Pengajuan dihapus';
  if (event === 'koreksi') return 'Pengajuan perlu tindak lanjut';
  if (target.menu) return `Tugas baru: ${target.menu}`;
  return 'Update Pengajuan Kredit';
}

function workflowNotificationMessage({ summary = {}, target = {}, event = 'save', catatan = null }) {
  const debtor = summary.nama_debitur || summary.nama_perusahaan || '-';
  const id = summary.id_pengajuan || '-';
  const verb = event === 'koreksi'
    ? 'dikembalikan untuk ditindaklanjuti'
    : event === 'delete'
      ? 'telah dihapus'
      : 'menunggu tindak lanjut';
  const note = catatan ? ` Catatan: ${String(catatan).trim()}` : '';
  return `${id} - ${debtor} ${verb}.${note}`.trim();
}

async function createWorkflowInAppNotifications(pool, {
  users = [],
  summary = {},
  target = {},
  targetStsflag = null,
  event = 'save',
  catatan = null,
}) {
  if (!users.length) return { inserted: 0, suppressed: 0 };

  await ensureInAppNotificationTable(pool);

  const title = workflowNotificationTitle(target, event);
  const message = workflowNotificationMessage({ summary, target, event, catatan });
  let inserted = 0;
  let suppressed = 0;

  const seen = new Set();
  for (const user of users) {
    const userid = user?.userid?.toString().trim();
    if (!userid || seen.has(userid)) continue;
    seen.add(userid);

    const result = await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .input('id_pengajuan', sql.VarChar(50), summary.id_pengajuan || null)
      .input('title', sql.NVarChar(200), title)
      .input('message', sql.NVarChar(1000), message)
      .input('menu', sql.NVarChar(120), target.menu || null)
      .input('stsflag', sql.VarChar(10), targetStsflag == null ? null : String(targetStsflag))
      .input('event_type', sql.VarChar(30), event)
      .input('dedupe_seconds', sql.Int, DEDUPE_SECONDS)
      .query(`
        IF NOT EXISTS (
          SELECT 1
          FROM dbo.t_notification WITH (READPAST)
          WHERE userid = @userid
            AND ISNULL(id_pengajuan, '') = ISNULL(@id_pengajuan, '')
            AND ISNULL(stsflag, '') = ISNULL(@stsflag, '')
            AND ISNULL(event_type, '') = ISNULL(@event_type, '')
            AND ISNULL(menu, '') = ISNULL(@menu, '')
            AND title = @title
            AND ISNULL(message, '') = ISNULL(@message, '')
            AND is_read = 0
            AND created_at >= DATEADD(SECOND, -@dedupe_seconds, SYSDATETIME())
        )
        BEGIN
          INSERT INTO dbo.t_notification
            (userid, id_pengajuan, title, message, menu, stsflag, event_type, is_read, created_at)
          VALUES
            (@userid, @id_pengajuan, @title, @message, @menu, @stsflag, @event_type, 0, SYSDATETIME());
          SELECT CAST(1 AS INT) AS inserted;
        END
        ELSE
        BEGIN
          SELECT CAST(0 AS INT) AS inserted;
        END
      `);

    if (Number(result.recordset?.[0]?.inserted || 0) === 1) inserted += 1;
    else suppressed += 1;
  }

  return { inserted, suppressed };
}

module.exports = {
  DEDUPE_SECONDS,
  ensureInAppNotificationTable,
  createWorkflowInAppNotifications,
  workflowNotificationTitle,
  workflowNotificationMessage,
};

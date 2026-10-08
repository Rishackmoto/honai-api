/* HONAI Checklist Workflow V2 - 08 Oktober 2026
   AO upload -> Admin check -> SPV review/approval
*/

IF COL_LENGTH('dbo.t_pengajuan_kelengkapan_dokumen', 'admin_status') IS NULL
    ALTER TABLE dbo.t_pengajuan_kelengkapan_dokumen ADD admin_status VARCHAR(20) NULL;
IF COL_LENGTH('dbo.t_pengajuan_kelengkapan_dokumen', 'admin_note') IS NULL
    ALTER TABLE dbo.t_pengajuan_kelengkapan_dokumen ADD admin_note NVARCHAR(500) NULL;
IF COL_LENGTH('dbo.t_pengajuan_kelengkapan_dokumen', 'admin_checked_by') IS NULL
    ALTER TABLE dbo.t_pengajuan_kelengkapan_dokumen ADD admin_checked_by VARCHAR(30) NULL;
IF COL_LENGTH('dbo.t_pengajuan_kelengkapan_dokumen', 'admin_checked_at') IS NULL
    ALTER TABLE dbo.t_pengajuan_kelengkapan_dokumen ADD admin_checked_at DATETIME NULL;

IF OBJECT_ID('dbo.t_pengajuan_kelengkapan_workflow', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.t_pengajuan_kelengkapan_workflow (
        id_pengajuan VARCHAR(50) NOT NULL PRIMARY KEY,
        workflow_status VARCHAR(30) NOT NULL CONSTRAINT DF_kelengkapan_workflow_status DEFAULT 'DRAFT_AO',
        submitted_by VARCHAR(30) NULL,
        submitted_at DATETIME NULL,
        admin_checked_by VARCHAR(30) NULL,
        admin_checked_at DATETIME NULL,
        admin_note NVARCHAR(1000) NULL,
        spv_checked_by VARCHAR(30) NULL,
        spv_checked_at DATETIME NULL,
        spv_note NVARCHAR(1000) NULL,
        updated_at DATETIME NOT NULL CONSTRAINT DF_kelengkapan_workflow_updated DEFAULT GETDATE()
    );
END;

IF OBJECT_ID('dbo.t_pengajuan_kelengkapan_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.t_pengajuan_kelengkapan_log (
        id_log INT IDENTITY(1,1) PRIMARY KEY,
        id_pengajuan VARCHAR(50) NOT NULL,
        action_code VARCHAR(40) NOT NULL,
        from_status VARCHAR(30) NULL,
        to_status VARCHAR(30) NULL,
        actor_userid VARCHAR(30) NULL,
        actor_jabat VARCHAR(10) NULL,
        note NVARCHAR(1000) NULL,
        created_at DATETIME NOT NULL DEFAULT GETDATE()
    );
END;

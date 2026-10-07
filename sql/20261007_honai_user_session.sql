/* HONAI Security Pass 1 - Single active session per user
   Safe to run repeatedly on SQL Server.
*/
IF OBJECT_ID('dbo.honai_user_session', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.honai_user_session (
        userid VARCHAR(30) NOT NULL,
        session_id VARCHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        device_name NVARCHAR(160) NULL,
        user_agent NVARCHAR(500) NULL,
        ip_address VARCHAR(64) NULL,
        login_at DATETIME2(0) NOT NULL CONSTRAINT DF_honai_user_session_login_at DEFAULT SYSDATETIME(),
        last_activity_at DATETIME2(0) NOT NULL CONSTRAINT DF_honai_user_session_last_activity DEFAULT SYSDATETIME(),
        expires_at DATETIME2(0) NOT NULL,
        revoked_at DATETIME2(0) NULL,
        updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_honai_user_session_updated_at DEFAULT SYSDATETIME(),
        CONSTRAINT PK_honai_user_session PRIMARY KEY (userid)
    );

    CREATE UNIQUE INDEX UX_honai_user_session_session_id
        ON dbo.honai_user_session(session_id);
END;
GO

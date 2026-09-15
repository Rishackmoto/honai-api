IF OBJECT_ID('dbo.daily_sales_activity', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.daily_sales_activity (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userid VARCHAR(30) NOT NULL,
    tanggal DATE NOT NULL,
    jenis_aktivitas NVARCHAR(30) NOT NULL,
    nama_prospek NVARCHAR(150) NOT NULL,
    kontak NVARCHAR(50) NOT NULL,
    lokasi NVARCHAR(250) NOT NULL,
    produk NVARCHAR(100) NOT NULL,
    hasil NVARCHAR(2000) NOT NULL,
    tindak_lanjut NVARCHAR(2000) NOT NULL,
    tanggal_follow_up DATE NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
  );
  CREATE INDEX IX_daily_sales_user_date ON dbo.daily_sales_activity(userid, tanggal);
END;

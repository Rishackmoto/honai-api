const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const bcaParser = require('../parsers/bcaParser');
const mandiriParser = require('../parsers/mandiriParser');
const briParser = require('../parsers/briParser');
const bniParser = require('../parsers/bniParser');
const bpdPapuaParser = require('../parsers/bpdPapuaParser');
const { TYPE: UPLOAD_TYPE, validateUploadedFile, secureMemoryStorage, uploadErrorPayload } = require('../../../core/security/upload_security');

const router = express.Router();
const upload = multer({ storage: secureMemoryStorage({ maxTotalBytes: 12 * 1024 * 1024 }), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, parts: 12 } });

router.post('/parse-mutasi', (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (error) {
      const payload = uploadErrorPayload(error, 'Upload mutasi tidak valid.');
      return res.status(payload.statusCode).json(payload.body);
    }
    try {
      if (req.file) validateUploadedFile(req.file, { allowedTypes: [UPLOAD_TYPE.PDF], maxBytes: 10 * 1024 * 1024, label: 'File mutasi rekening' });
      return next();
    } catch (validationError) {
      const payload = uploadErrorPayload(validationError, 'File mutasi harus PDF yang valid.');
      return res.status(payload.statusCode).json(payload.body);
    }
  });
}, async (req, res) => {
  try {
    const { bank, periode, password } = req.body;
    if (!req.file) return res.status(400).json({ status: 'error', message: 'File PDF mutasi wajib dipilih' });
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    if (!bank || !periode) {
      return res.status(400).json({ status: 'error', message: 'Bank dan periode wajib diisi' });
    }

    // Ekstrak teks dari PDF (opsional dengan password)
    let pdfData;
    try {
      pdfData = await pdfParse(fileBuffer, { password: password || undefined });
    } catch (err) {
      return res.status(400).json({ status: 'error', message: 'Gagal membaca PDF. Periksa password atau file rusak.' });
    }

    const fullText = pdfData.text;

    let transaksi = [];
    switch (bank.toUpperCase()) {
      case 'BCA':
        transaksi = bcaParser(fullText);
        break;
      case 'MANDIRI':
        transaksi = mandiriParser(fullText);
        break;
      case 'BRI':
        transaksi = briParser(fullText);
        break;
      case 'BNI':
        transaksi = bniParser(fullText);
        break;
      case 'BPD PAPUA':
        transaksi = bpdPapuaParser(fullText);
        break;
      default:
        return res.status(400).json({ status: 'error', message: 'Bank tidak didukung' });
    }

    if (transaksi.length === 0) {
      return res.status(422).json({ status: 'error', message: 'Tidak ada transaksi yang berhasil diparsing. Format mungkin tidak dikenali.' });
    }

    res.json({
      status: 'success',
      data: {
        bank: bank.toUpperCase(),
        periode,
        fileName,
        transaksi,
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

module.exports = router;
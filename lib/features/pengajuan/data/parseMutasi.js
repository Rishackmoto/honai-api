const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const bcaParser = require('../parsers/bcaParser');
const mandiriParser = require('../parsers/mandiriParser');
const briParser = require('../parsers/briParser');
const bniParser = require('../parsers/bniParser');
const bpdPapuaParser = require('../parsers/bpdPapuaParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/parse-mutasi', upload.single('file'), async (req, res) => {
  try {
    const { bank, periode, password } = req.body;
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
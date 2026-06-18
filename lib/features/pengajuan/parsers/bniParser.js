const { parseIndonesianNumber, formatDateDMYtoISO } = require('../utils/numberHelper');

function bniParser(text) {
  const lines = text.split('\n');
  const transactions = [];

  // Pola umum  : "01/01/2024  KETERANGAN  1.000.000,00  500.000,00"
  // atau "01/01/2024  KETERANGAN  1.000.000,00  DB" (tergantung versi)
  const regex = /(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([\d\.]+,\d{2})\s+([\d\.]+,\d{2})/;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const [_, dateStr, desc, debitStr, creditStr] = match;
      const debit = parseIndonesianNumber(debitStr);
      const credit = parseIndonesianNumber(creditStr);
      const tanggalISO = formatDateDMYtoISO(dateStr);
      if (!tanggalISO) continue;

      transactions.push({
        tanggal: tanggalISO,
        keterangan: desc.trim(),
        debit: debit > 0 ? debit : null,
        kredit: credit > 0 ? credit : null,
        // Untuk BNI, saldo biasanya tidak langsung ada, bisa dihitung nanti di frontend
        saldo: 0,
      });
    }
  }

  // Hitung saldo kumulatif jika perlu (opsional)
  let runningBalance = 0;
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (t.debit) runningBalance += t.debit;
    else if (t.kredit) runningBalance -= t.kredit;
    t.saldo = runningBalance;
  }

  return transactions;
}

module.exports = bniParser;
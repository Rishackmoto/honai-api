const { parseIndonesianNumber, formatDateDMYtoISO } = require('../utils/numberHelper');

function mandiriParser(text) {
  const lines = text.split('\n');
  const transactions = [];

  // Format Mandiri sering: "01/01/2024  KETERANGAN  Rp1.000.000,00  Rp500.000,00"
  const regex = /(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+Rp([\d\.]+,\d{2})\s+Rp([\d\.]+,\d{2})/;

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
        saldo: 0,
      });
    }
  }

  let runningBalance = 0;
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (t.debit) runningBalance += t.debit;
    else if (t.kredit) runningBalance -= t.kredit;
    t.saldo = runningBalance;
  }

  return transactions;
}

module.exports = mandiriParser;
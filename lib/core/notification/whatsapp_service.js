async function sendWaText({ to, message }) {
  const token = process.env.WA_TOKEN;
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log('WA belum dikonfigurasi.');
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: message,
      },
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error('Gagal kirim WA:', result);
    return;
  }

  console.log('WA terkirim:', result);
}

module.exports = { sendWaText };
require("../../config/env");

function normalizePhone(value) {
  const digits = (value || "").toString().replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  return digits;
}

function whatsappConfig() {
  return {
    accessToken: process.env.WA_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: process.env.WA_API_VERSION || "v25.0",
    notificationTemplate: process.env.WA_NOTIFICATION_TEMPLATE || "hello_world",
    notificationTemplateLanguage: process.env.WA_NOTIFICATION_TEMPLATE_LANGUAGE || "en_US",
  };
}

function isWhatsAppEnabled() {
  const config = whatsappConfig();
  return Boolean(config.accessToken && config.phoneNumberId);
}

async function postWhatsAppMessage(payload) {
  const config = whatsappConfig();
  if (!config.accessToken || !config.phoneNumberId) {
    return { skipped: true, reason: "WA_ACCESS_TOKEN/WA_PHONE_NUMBER_ID belum diset" };
  }

  const response = await fetch(
    `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...payload,
      }),
    }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `WhatsApp API error ${response.status}`);
  }

  return body;
}

async function sendWhatsAppText(to, text) {
  const phone = normalizePhone(to);
  if (!phone) return { skipped: true, reason: "Nomor WhatsApp kosong/tidak valid" };

  return postWhatsAppMessage({
    to: phone,
    type: "text",
    text: {
      preview_url: false,
      body: text,
    },
  });
}

async function sendWhatsAppTemplate(to, templateName = "hello_world", languageCode = "en_US") {
  const phone = normalizePhone(to);
  if (!phone) return { skipped: true, reason: "Nomor WhatsApp kosong/tidak valid" };

  return postWhatsAppMessage({
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: languageCode,
      },
    },
  });
}

async function sendWhatsAppNotification(to, text) {
  const config = whatsappConfig();
  try {
    const result = await sendWhatsAppText(to, text);
    return { mode: "text", result };
  } catch (error) {
    const templateResult = await sendWhatsAppTemplate(
      to,
      config.notificationTemplate,
      config.notificationTemplateLanguage
    );
    return {
      mode: "template_fallback",
      text_error: error.message,
      result: templateResult,
    };
  }
}

module.exports = {
  isWhatsAppEnabled,
  normalizePhone,
  sendWhatsAppTemplate,
  sendWhatsAppNotification,
};

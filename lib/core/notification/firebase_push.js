const { GoogleAuth } = require('google-auth-library');

let authClient;
let cachedConfig;

function decodeJsonConfig() {
  const base64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (base64) {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  }

  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) return JSON.parse(raw);

  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();

  if (projectId && clientEmail && privateKey) {
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    };
  }

  return null;
}

function getFirebaseConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    const credentials = decodeJsonConfig();
    if (!credentials?.project_id) {
      cachedConfig = null;
      return cachedConfig;
    }
    cachedConfig = {
      credentials,
      projectId: credentials.project_id,
    };
    return cachedConfig;
  } catch (error) {
    console.error('FCM CONFIG ERROR:', error.message);
    cachedConfig = null;
    return cachedConfig;
  }
}

function isFirebasePushConfigured() {
  return Boolean(getFirebaseConfig());
}

async function accessToken() {
  const config = getFirebaseConfig();
  if (!config) throw new Error('Firebase service account belum dikonfigurasi.');

  authClient ??= new GoogleAuth({
    credentials: config.credentials,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });

  const client = await authClient.getClient();
  const token = await client.getAccessToken();
  const value = typeof token === 'string' ? token : token?.token;
  if (!value) throw new Error('Gagal memperoleh OAuth token Firebase.');
  return value;
}

function stringData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

async function sendFcmToToken({ token, title, body, data = {} }) {
  const config = getFirebaseConfig();
  if (!config) {
    return { success: false, disabled: true, code: 'FCM_NOT_CONFIGURED' };
  }

  const bearer = await accessToken();
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: String(title || 'HONAI'),
            body: String(body || ''),
          },
          data: stringData(data),
          android: {
            priority: 'high',
            notification: {
              channel_id: 'honai_default',
              sound: 'default',
            },
          },
          apns: {
            payload: {
              aps: { sound: 'default' },
            },
          },
          webpush: {
            notification: {
              icon: '/icons/Icon-192.png',
            },
          },
        },
      }),
    }
  );

  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {}

  if (!response.ok) {
    const code = payload?.error?.details?.[0]?.errorCode ||
      payload?.error?.status || `HTTP_${response.status}`;
    const message = payload?.error?.message || 'FCM request gagal.';
    return { success: false, code, message, status: response.status };
  }

  return { success: true, name: payload?.name || null };
}

module.exports = {
  isFirebasePushConfigured,
  sendFcmToToken,
};

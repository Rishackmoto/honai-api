const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const apiRoot = path.resolve(__dirname, '../..');

function normalizeEnvName(value) {
  if (!value) {
    return '';
  }

  return value.trim().toLowerCase();
}

function loadEnv() {
  const appEnv = normalizeEnvName(process.env.APP_ENV || process.env.NODE_ENV);
  const candidates = [];

  if (appEnv) {
    candidates.push(path.join(apiRoot, `.env.${appEnv}`));
  } else {
    candidates.push(path.join(apiRoot, '.env.local'));
  }

  candidates.push(path.join(apiRoot, '.env'));

  const envPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (envPath) {
    dotenv.config({ path: envPath });
    process.env.APP_ENV_FILE = envPath;
  } else {
    dotenv.config();
  }

  return process.env;
}

module.exports = loadEnv();

const sql = require('mssql');
require('dotenv').config();
const toBool = (value, defaultValue) => {
    if (value === undefined) {
        return defaultValue;
    }

    return value === 'true';
};

const toNumber = (value, defaultValue) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
};

const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: toNumber(process.env.DB_PORT, 1433),
    pool: {
        max: toNumber(process.env.DB_POOL_MAX, 10),
        min: toNumber(process.env.DB_POOL_MIN, 0),
        idleTimeoutMillis: toNumber(process.env.DB_POOL_IDLE_TIMEOUT, 30000),
    },
    options: {
        encrypt: toBool(process.env.DB_ENCRYPT, false),
        trustServerCertificate: toBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
        enableArithAbort: true,
    },
};

let poolPromise;

function getDbTarget() {
    return `${process.env.DB_USER || '(missing user)'}@${process.env.DB_SERVER || '(missing server)'}:${toNumber(process.env.DB_PORT, 1433)}/${process.env.DB_DATABASE || '(missing database)'}`;
}

function isDbLoginError(error) {
    return error?.code === 'ELOGIN' || error?.originalError?.code === 'ELOGIN';
}

function validateConfig() {
    const requiredKeys = ['DB_USER', 'DB_PASSWORD', 'DB_SERVER', 'DB_DATABASE'];
    const missingKeys = requiredKeys.filter((key) => !process.env[key]);

    if (missingKeys.length > 0) {
        throw new Error(`Missing SQL Server env: ${missingKeys.join(', ')}`);
    }
}

function getPool() {
    validateConfig();

    if (!poolPromise) {
        poolPromise = sql.connect(sqlConfig).catch((error) => {
            poolPromise = undefined;
            if (isDbLoginError(error)) {
                console.error(`SQL Server login rejected for ${getDbTarget()}`);
            }
            throw error;
        });
    }

    return poolPromise;
}

module.exports = {
    sql,
    getPool,
    getDbTarget,
    isDbLoginError,
};

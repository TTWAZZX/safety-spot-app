require('dotenv').config();
const mysql = require('mysql2/promise');

// -----------------------------
// Parse DATABASE_URL manually
// -----------------------------
const url = new URL(process.env.DATABASE_URL);

// Extract credentials
const DB_HOST = url.hostname;
const DB_USER = url.username;
const DB_PASS = url.password;
const DB_NAME = url.pathname.replace('/', '');  // remove "/"
const DB_PORT = url.port || 3306;

const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: {
        rejectUnauthorized: false   // AIVEN / RENDER required
    }
});

// Test connection one time
pool.getConnection()
    .then(conn => {
        console.log("✅ MySQL Connected:", DB_HOST);
        conn.release();
    })
    .catch(err => {
        console.error("❌ MySQL Connection Failed:", err);
    });

module.exports = {
    query: (...args) => pool.query(...args),
    getClient: () => pool.getConnection()
};

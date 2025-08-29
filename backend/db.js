const mysql = require('mysql2/promise');

// สร้าง Connection Pool เพื่อการเชื่อมต่อฐานข้อมูลที่มีประสิทธิภาพ
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'safety_spot_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true // บังคับให้ return วันที่เป็น String เพื่อป้องกันปัญหา Timezone
});

// ทดสอบการเชื่อมต่อ
pool.getConnection()
    .then(conn => {
        console.log('Successfully connected to the database.');
        conn.release(); // คืน connection กลับเข้า pool
    })
    .catch(err => {
        console.error('Failed to connect to the database:', err);
    });

module.exports = pool;


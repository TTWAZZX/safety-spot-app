require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  ssl: {
    // highlight-start
    // สำหรับ Aiven เราต้องตั้งค่านี้เป็น false
    // เพื่ออนุญาตการเชื่อมต่อที่ใช้ Self-Signed Certificate
    rejectUnauthorized: false
    // highlight-end
  }
});

// ทดสอบการเชื่อมต่อเมื่อเซิร์ฟเวอร์เริ่มทำงาน
pool.getConnection()
    .then(connection => {
        console.log('Successfully connected to the MySQL database.');
        connection.release(); // คืน connection กลับเข้า pool
    })
    .catch(err => console.error('Failed to connect to the database:', err));

module.exports = {
  // mysql2 ใช้ ? เป็น placeholder และส่ง params เป็น array ได้เลย
  query: (text, params) => pool.query(text, params),
  // สร้างฟังก์ชัน getClient ให้ทำงานคล้ายของเดิม
  getClient: () => pool.getConnection(),
};
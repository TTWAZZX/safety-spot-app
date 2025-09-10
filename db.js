require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  ssl: {
    // Aiven ใช้ Certificate ที่เชื่อถือได้โดยทั่วไป
    // การตั้งค่านี้จะบังคับให้ใช้ SSL/TLS ในการเชื่อมต่อ
    rejectUnauthorized: true 
  }
}); // <<< เพิ่มวงเล็บปิด }) ตรงนี้ครับ

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
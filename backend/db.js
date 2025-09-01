    require('dotenv').config();
    const { Pool } = require('pg');
    
    // สร้าง Connection Pool โดยใช้ DATABASE_URL จาก .env
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // ตั้งค่า SSL สำหรับการเชื่อมต่อบน Production (จำเป็นสำหรับ Render)
      ssl: {
        rejectUnauthorized: false
      }
    });
    
    // ทดสอบการเชื่อมต่อเมื่อเซิร์ฟเวอร์เริ่มทำงาน
    pool.connect()
        .then(() => console.log('Successfully connected to the PostgreSQL database.'))
        .catch(err => console.error('Failed to connect to the database:', err));
    
    module.exports = {
      query: (text, params) => pool.query(text, params),
      getClient: () => pool.connect(),
    };
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const parse = require('csv-parser');

// --- ⚠️ แก้ไขข้อมูลการเชื่อมต่อให้ตรงกับของคุณ ---
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '', // ใส่รหัสผ่าน MySQL ของคุณ (ถ้ามี)
    database: 'safety_spot_db'
};

const csvFolderPath = path.join(__dirname, 'csv');

// ======================= DEBUGGING STEP =======================
// ส่วนนี้จะช่วยเราตรวจสอบว่าสคริปต์มองเห็นไฟล์อะไรบ้าง
try {
    console.log(`\n--- DEBUG: กำลังตรวจสอบไฟล์ในโฟลเดอร์: ${csvFolderPath} ---`);
    const filesInDir = fs.readdirSync(csvFolderPath);
    console.log('ไฟล์ที่เจอ:', filesInDir);
    if (filesInDir.length === 0) {
        console.log('!!! คำเตือน: ไม่เจอไฟล์ใดๆ ในโฟลเดอร์ csv เลย !!!');
    }
    console.log('--- END DEBUG ---\n');
} catch (e) {
    console.error(`--- DEBUG ERROR: ไม่สามารถอ่านโฟลเดอร์ ${csvFolderPath} ได้. Error: ${e.message} ---`);
}
// =============================================================


const tablesToImport = [
    { file: 'Safety Spot DB - Users.csv', table: 'users', columns: ['lineUserId', 'displayName', 'pictureUrl', 'fullName', 'employeeId', 'totalScore'] },
    { file: 'Safety Spot DB - Activities.csv', table: 'activities', columns: ['activityId', 'title', 'description', 'imageUrl', 'status', 'createdAt'] },
    { file: 'Safety Spot DB - Submissions.csv', table: 'submissions', columns: ['submissionId', 'activityId', 'lineUserId', 'description', 'imageUrl', 'status', 'points', 'createdAt'] },
    { file: 'Safety Spot DB - Admins.csv', table: 'admins', columns: ['lineUserId'] },
    { file: 'Safety Spot DB - Badges.csv', table: 'badges', columns: ['badgeId', 'badgeName', 'description', 'imageUrl'] },
    { file: 'Safety Spot DB - UserBadges.csv', table: 'user_badges', columns: ['lineUserId', 'badgeId', 'earnedAt'] },
    { file: 'Safety Spot DB - Likes.csv', table: 'likes', columns: ['likeId', 'submissionId', 'lineUserId', 'createdAt'] },
    { file: 'Safety Spot DB - Comments.csv', table: 'comments', columns: ['commentId', 'submissionId', 'lineUserId', 'commentText', 'createdAt'] }
];

function formatDateTime(datetimeStr) {
    if (!datetimeStr || typeof datetimeStr !== 'string') return null;
    const parts = datetimeStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2})/);
    if (!parts) return null;
    return `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')} ${parts[4].padStart(2, '0')}:${parts[5]}:${parts[6]}`;
}


async function importData() {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        console.log('Connected to MySQL database.');

        await connection.query('SET FOREIGN_KEY_CHECKS = 0;');

        for (const { file, table, columns } of tablesToImport) {
            const filePath = path.join(csvFolderPath, file);
            if (!fs.existsSync(filePath)) {
                console.warn(`Skipping: File not found at ${filePath}`);
                continue;
            }

            console.log(`\nImporting data for table: ${table}`);
            
            await connection.query(`TRUNCATE TABLE ${table}`);
            
            const records = [];
            await new Promise((resolve, reject) => {
                fs.createReadStream(filePath)
                    .pipe(parse({
                        mapHeaders: ({ header }) => {
                            if (header === 'score') return 'points';
                            if (header === 'submittedAt') return 'createdAt';
                            return header;
                        }
                    }))
                    .on('data', (row) => {
                        const processedRow = {};
                        columns.forEach(col => {
                            let value = row[col];
                            if (value === undefined || value === null || value === '') {
                                processedRow[col] = null;
                            } else if (['createdAt', 'earnedAt'].includes(col)) {
                                processedRow[col] = formatDateTime(value);
                            }
                            else {
                                processedRow[col] = value;
                            }
                        });
                        // Fix for submissions table mapping
                        if(table === 'submissions' && row.submittedAt) {
                            processedRow.createdAt = formatDateTime(row.submittedAt);
                        }
                        if(table === 'submissions' && row.score) {
                           processedRow.points = row.score;
                        }

                        records.push(Object.values(processedRow));
                    })
                    .on('end', resolve)
                    .on('error', reject);
            });

            if (records.length > 0) {
                const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ?`;
                await connection.query(sql, [records]);
                console.log(`Successfully imported ${records.length} records into ${table}.`);
            } else {
                console.log(`No records to import for ${table}.`);
            }
        }
        
        await connection.query('SET FOREIGN_KEY_CHECKS = 1;');
        console.log('\nData import completed!');

    } catch (error) {
        console.error('An error occurred during data import:', error);
    } finally {
        if (connection) {
            await connection.end();
            console.log('MySQL connection closed.');
        }
    }
}

importData();

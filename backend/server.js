require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors'); // << 1. เรียกใช้ cors ที่ติดตั้งมา
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Cloudinary with environment variables
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ===== 👇 จุดที่แก้ไข 1: กำหนดค่า CORS Policy 👇 =====
const corsOptions = {
  origin: [
    'https://ttwazzx.github.io', 
    'https://ttwazzx.github.io/safety-spot-app'
  ],
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  preflightContinue: false,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // สำหรับจัดการกับ Preflight Request
// ===== 👆 สิ้นสุดจุดที่แก้ไข 1 👆 =====

app.use(express.json());

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
    console.log(`Created directory: ${uploadsDir}`);
}

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(uploadsDir));

// Multer setup for file uploads
const storage = multer.memoryStorage(); // Use memory storage as Render's filesystem is ephemeral
const upload = multer({ storage: storage });

// Helper for handling requests and errors
const handleRequest = (handler) => async (req, res) => {
    try {
        let data = await handler(req, res);

        // ===== 👇 เพิ่มโค้ดป้องกัน 👇 =====
        // ถ้า data ที่ได้จาก handler เป็น undefined ให้แปลงเป็น null
        // เพื่อป้องกันไม่ให้ Express ส่งสถานะ 204 No Content กลับไป
        if (data === undefined) {
            data = null;
        }
        // ===== 👆 สิ้นสุดส่วนที่เพิ่ม 👆 =====

        res.status(200).json({ status: 'success', data });
    } catch (error) {
        console.error(`API Error on ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
};

// Middleware to check for admin privileges
// Middleware to check for admin privileges
const isAdmin = async (req, res, next) => {
    // 1. อ่าน lineUserId จาก body หรือ query ของ request ที่ส่งมา
    //    เราจะใช้ค่านี้ในการตรวจสอบความเป็น Admin ที่แท้จริง
    const lineUserId = req.body.lineUserId || req.query.lineUserId;

    // 2. ตรวจสอบว่ามีการส่ง lineUserId มาเพื่อระบุตัวตนหรือไม่
    if (!lineUserId) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized: Missing User ID for verification' });
    }

    // 3. นำ lineUserId ที่ได้ไปค้นหาในตาราง admins
    try {
        const adminRes = await db.query('SELECT * FROM admins WHERE "lineUserId" = $1', [lineUserId]);
        
        // 4. ถ้าไม่พบผู้ใช้คนนี้ในตาราง admins ให้ปฏิเสธการเข้าถึง
        if (adminRes.rows.length === 0) {
            return res.status(403).json({ status: 'error', message: 'Forbidden: You do not have admin privileges.' });
        }
        
        // 5. ถ้าพบ แสดงว่าเป็น Admin จริง -> อนุญาตให้ทำรายการต่อไปได้
        next();
    } catch (error) {
        console.error('Error during admin check:', error);
        res.status(500).json({ status: 'error', message: 'An internal server error occurred during authentication.' });
    }
};

// Image Upload Route with Cloudinary
app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) {
        console.error('No file uploaded.');
        return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
    }

    try {
        const uploadStream = cloudinary.uploader.upload_stream({ folder: 'safety-spot' }, (error, result) => {
            if (result) {
                res.status(200).json({ status: 'success', data: { imageUrl: result.secure_url } });
            } else {
                console.error('Cloudinary upload error:', error);
                res.status(500).json({ status: 'error', message: 'Failed to upload image to Cloudinary.' });
            }
        });

        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
    } catch (error) {
        console.error('API Error on /api/upload:', error);
        res.status(500).json({ status: 'error', message: 'An internal server error occurred.' });
    }
});

// --- User & General Routes ---
app.get('/api/user/profile', handleRequest(async (req) => {
    const { lineUserId } = req.query;
    if (!lineUserId) {
        // ถ้าไม่มี lineUserId ส่งมา, ถือว่ายังไม่ลงทะเบียน
        return { registered: false, user: null };
    }

    // ค้นหาผู้ใช้ในฐานข้อมูล
    const userRes = await db.query('SELECT * FROM users WHERE "lineUserId" = $1', [lineUserId]);
    
    if (userRes.rows.length === 0) {
        // ถ้าไม่พบผู้ใช้, ถือว่ายังไม่ลงทะเบียน
        return { registered: false, user: null };
    }

    // ถ้าพบผู้ใช้, ให้ส่งข้อมูลผู้ใช้กลับไปเสมอ
    const user = userRes.rows[0];
    
    // ตรวจสอบสถานะแอดมิน
    const adminRes = await db.query('SELECT * FROM admins WHERE "lineUserId" = $1', [lineUserId]);
    user.isAdmin = adminRes.rows.length > 0;
    
    // ส่งข้อมูลกลับไปว่าลงทะเบียนแล้ว พร้อมข้อมูลผู้ใช้ที่ครบถ้วน
    return { registered: true, user: user };
}));
app.post('/api/user/register', handleRequest(async (req) => {
    const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;
    const existingUserRes = await db.query('SELECT * FROM users WHERE "lineUserId" = $1 OR "employeeId" = $2', [lineUserId, employeeId]);
    if (existingUserRes.rows.length > 0) throw new Error('LINE User ID หรือรหัสพนักงานนี้มีอยู่ในระบบแล้ว');
    const newUser = { lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore: 0 };
    await db.query('INSERT INTO users ("lineUserId", "displayName", "pictureUrl", "fullName", "employeeId", "totalScore") VALUES ($1, $2, $3, $4, $5, $6)', 
        [lineUserId, displayName, pictureUrl, fullName, employeeId, 0]);
    const adminRes = await db.query('SELECT * FROM admins WHERE "lineUserId" = $1', [lineUserId]);
    newUser.isAdmin = adminRes.rows.length > 0;
    return newUser;
}));
app.get('/api/activities', handleRequest(async () => (await db.query(`SELECT "activityId", title, description, "imageUrl", status, "createdAt" FROM activities WHERE status = 'active' ORDER BY "createdAt" DESC`)).rows));
app.get('/api/leaderboard', handleRequest(async () => (await db.query('SELECT "fullName", "pictureUrl", "totalScore" FROM users ORDER BY "totalScore" DESC, "fullName" ASC LIMIT 50')).rows));
app.get('/api/user/badges', handleRequest(async (req) => {
    const { lineUserId } = req.query;
    const allBadgesRes = await db.query('SELECT "badgeId" as id, "badgeName" as name, description as "desc", "imageUrl" as img FROM badges');
    const userBadgeRes = await db.query('SELECT "badgeId" FROM user_badges WHERE "lineUserId" = $1', [lineUserId]);
    const userEarnedIds = new Set(userBadgeRes.rows.map(b => b.badgeId));
    return allBadgesRes.rows.map(b => ({ ...b, isEarned: userEarnedIds.has(b.id) }));
}));
app.get('/api/submissions', handleRequest(async (req) => {
    const { activityId, lineUserId } = req.query;
    const sql = `SELECT s."submissionId", s.description, s."imageUrl", s."createdAt", s.points, u."fullName" as "submitterFullName", u."pictureUrl" as "submitterPictureUrl", (SELECT COUNT(*) FROM likes WHERE "submissionId" = s."submissionId")::int as likes FROM submissions s JOIN users u ON s."lineUserId" = u."lineUserId" WHERE s."activityId" = $1 AND s.status IN ('approved', 'pending') ORDER BY s."createdAt" DESC;`;
    const submissionsRes = await db.query(sql, [activityId]);
    const likesRes = await db.query('SELECT "submissionId" FROM likes WHERE "lineUserId" = $1', [lineUserId]);
    const userLikedIds = new Set(likesRes.rows.map(l => l.submissionId));
    const commentsSql = `SELECT c."submissionId", c."commentText", u."fullName" as "commenterFullName", u."pictureUrl" as "commenterPictureUrl" FROM comments c JOIN users u ON c."lineUserId" = u."lineUserId" WHERE c."submissionId" = ANY($1::text[]) ORDER BY c."createdAt" ASC;`;
    const submissionIds = submissionsRes.rows.map(s => s.submissionId);
    let commentsBySubmission = {};
    if (submissionIds.length > 0) {
        const commentsRes = await db.query(commentsSql, [submissionIds]);
        commentsRes.rows.forEach(c => {
            if (!commentsBySubmission[c.submissionId]) commentsBySubmission[c.submissionId] = [];
            commentsBySubmission[c.submissionId].push({ commentText: c.commentText, commenter: { fullName: c.commenterFullName, pictureUrl: c.commenterPictureUrl } });
        });
    }
    return submissionsRes.rows.map(sub => ({ submissionId: sub.submissionId, description: sub.description, imageUrl: sub.imageUrl, createdAt: sub.createdAt, points: sub.points, submitter: { fullName: sub.submitterFullName, pictureUrl: sub.submitterPictureUrl }, likes: sub.likes, didLike: userLikedIds.has(sub.submissionId), comments: commentsBySubmission[sub.submissionId] || [] }));
}));
app.post('/api/submissions', handleRequest(async (req) => {
    const { activityId, lineUserId, description, imageUrl } = req.body;
    await db.query('INSERT INTO submissions ("submissionId", "activityId", "lineUserId", description, "imageUrl", status, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)', ["SUB" + uuidv4(), activityId, lineUserId, description, imageUrl, 'pending', new Date()]);
    return { message: 'Report submitted for review.' };
}));
app.post('/api/submissions/like', handleRequest(async (req) => {
    const { submissionId, lineUserId } = req.body;
    const existingLikeRes = await db.query('SELECT "likeId" FROM likes WHERE "submissionId" = $1 AND "lineUserId" = $2', [submissionId, lineUserId]);
    if (existingLikeRes.rows.length > 0) {
        await db.query('DELETE FROM likes WHERE "likeId" = $1', [existingLikeRes.rows[0].likeId]);
    } else {
        await db.query('INSERT INTO likes ("likeId", "submissionId", "lineUserId", "createdAt") VALUES ($1, $2, $3, $4)', ["LIKE" + uuidv4(), submissionId, lineUserId, new Date()]);
    }
    const countRes = await db.query('SELECT COUNT(*) FROM likes WHERE "submissionId" = $1', [submissionId]);
    return { status: existingLikeRes.rows.length > 0 ? 'unliked' : 'liked', newLikeCount: parseInt(countRes.rows[0].count) };
}));
app.post('/api/submissions/comment', handleRequest(async (req) => {
    const { submissionId, lineUserId, commentText } = req.body;
    if (!commentText || commentText.trim() === '') throw new Error("Comment cannot be empty.");
    await db.query('INSERT INTO comments ("commentId", "submissionId", "lineUserId", "commentText", "createdAt") VALUES ($1, $2, $3, $4, $5)', ["CMT" + uuidv4(), submissionId, lineUserId, commentText.trim(), new Date()]);
    return { message: 'Comment added.' };
}));

// --- Admin Routes ---
app.get('/api/admin/stats', isAdmin, handleRequest(async () => {
    const [totalUsersRes, totalSubmissionsRes, submissionsTodayRes, mostReportedRes] = await Promise.all([
        db.query('SELECT COUNT(*) as "totalUsers" FROM users'),
        db.query('SELECT COUNT(*) as "totalSubmissions" FROM submissions'),
        db.query(`SELECT COUNT(*) as "submissionsToday" FROM submissions WHERE DATE("createdAt") = CURRENT_DATE`),
        db.query(`SELECT a.title, COUNT(s."submissionId") as "reportCount" FROM submissions s JOIN activities a ON s."activityId" = a."activityId" GROUP BY s."activityId", a.title ORDER BY "reportCount" DESC LIMIT 1;`)
    ]);
    return { totalUsers: parseInt(totalUsersRes.rows[0].totalUsers), totalSubmissions: parseInt(totalSubmissionsRes.rows[0].totalSubmissions), submissionsToday: parseInt(submissionsTodayRes.rows[0].submissionsToday), mostReportedActivity: mostReportedRes.rows.length > 0 ? mostReportedRes.rows[0].title : "N/A" };
}));
app.get('/api/admin/chart-data', isAdmin, handleRequest(async () => {
    const query = `SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS date, COUNT(s."submissionId")::int AS count FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d(day) LEFT JOIN submissions s ON DATE(s."createdAt") = d.day GROUP BY d.day ORDER BY d.day;`;
    const res = await db.query(query);
    return { labels: res.rows.map(r => new Date(r.date).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric' })), data: res.rows.map(r => r.count) };
}));
app.get('/api/admin/submissions/pending', isAdmin, handleRequest(async () => (await db.query(`SELECT s.*, u."fullName" FROM submissions s JOIN users u ON s."lineUserId" = u."lineUserId" WHERE s.status = 'pending' ORDER BY s."createdAt" ASC`)).rows.map(s => ({...s, submitter: { fullName: s.fullName }}))));
app.post('/api/admin/submissions/approve', isAdmin, handleRequest(async (req) => {
    const { submissionId, score } = req.body;
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const submissionRes = await client.query('SELECT "lineUserId" FROM submissions WHERE "submissionId" = $1', [submissionId]);
        if (submissionRes.rows.length === 0) throw new Error('Submission not found');
        const { lineUserId } = submissionRes.rows[0];
        await client.query('UPDATE submissions SET status = $1, points = $2 WHERE "submissionId" = $3', ['approved', score, submissionId]);
        await client.query('UPDATE users SET "totalScore" = "totalScore" + $1 WHERE "lineUserId" = $2', [score, lineUserId]);
        await client.query('COMMIT');
        return { message: 'Submission approved.' };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.post('/api/admin/submissions/reject', isAdmin, handleRequest(async (req) => {
    const { submissionId } = req.body;
    await db.query("UPDATE submissions SET status = 'rejected' WHERE \"submissionId\" = $1", [submissionId]);
    return { message: 'Submission rejected.' };
}));
app.delete('/api/admin/submissions/:submissionId', isAdmin, handleRequest(async (req) => {
    const { submissionId } = req.params;
    await db.query('DELETE FROM submissions WHERE "submissionId" = $1', [submissionId]);
    return { message: 'Submission deleted.' };
}));
app.get('/api/admin/activities', isAdmin, handleRequest(async () => (await db.query('SELECT * FROM activities ORDER BY "createdAt" DESC')).rows));
app.post('/api/admin/activities', isAdmin, handleRequest(async (req) => {
    const { title, description, imageUrl } = req.body;
    await db.query('INSERT INTO activities ("activityId", title, description, "imageUrl", status, "createdAt") VALUES ($1, $2, $3, $4, $5, $6)', ["ACT" + uuidv4(), title, description, imageUrl, 'active', new Date()]);
    return { message: 'Activity created' };
}));
app.put('/api/admin/activities', isAdmin, handleRequest(async (req) => {
    const { activityId, title, description, imageUrl } = req.body;
    await db.query('UPDATE activities SET title = $1, description = $2, "imageUrl" = $3 WHERE "activityId" = $4', [title, description, imageUrl, activityId]);
    return { message: 'Activity updated' };
}));
app.delete('/api/admin/activities/:activityId', isAdmin, handleRequest(async (req) => {
    const { activityId } = req.params;
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM submissions WHERE "activityId" = $1', [activityId]);
        await client.query('DELETE FROM activities WHERE "activityId" = $1', [activityId]);
        await client.query('COMMIT');
        return { message: 'Activity and its submissions deleted.' };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.post('/api/admin/activities/toggle', isAdmin, handleRequest(async (req) => {
    const { activityId } = req.body;
    const activityRes = await db.query('SELECT status FROM activities WHERE "activityId" = $1', [activityId]);
    if (activityRes.rows.length === 0) throw new Error('Activity not found');
    const newStatus = activityRes.rows[0].status === 'active' ? 'inactive' : 'active';
    await db.query('UPDATE activities SET status = $1 WHERE "activityId" = $2', [newStatus, activityId]);
    return { newStatus };
}));
// --- Admin User and Badge Management API Routes ---
app.get('/api/admin/users', isAdmin, handleRequest(async (req) => {
    const searchTerm = req.query.search || '';
    // ===== 👇 จุดที่แก้ไข 2: เพิ่ม "pictureUrl" ใน Query 👇 =====
    const query = 'SELECT "lineUserId", "fullName", "employeeId", "totalScore", "pictureUrl" FROM users WHERE "fullName" ILIKE $1 OR "employeeId" ILIKE $1 ORDER BY "fullName" LIMIT 50';
    // ===== 👆 สิ้นสุดจุดที่แก้ไข 2 👆 =====
    const res = await db.query(query, [`%${searchTerm}%`]);
    return res.rows;
}));
app.get('/api/admin/user-details/:lineUserId', isAdmin, handleRequest(async (req) => {
    const { lineUserId } = req.params;
    const userRes = await db.query('SELECT "lineUserId", "fullName", "employeeId" FROM users WHERE "lineUserId" = $1', [lineUserId]);
    if (userRes.rows.length === 0) throw new Error('User not found');
    const allBadgesRes = await db.query('SELECT "badgeId", "badgeName" FROM badges ORDER BY "badgeName"');
    const userBadgesRes = await db.query('SELECT "badgeId" FROM user_badges WHERE "lineUserId" = $1', [lineUserId]);
    const earnedBadgeIds = new Set(userBadgesRes.rows.map(b => b.badgeId));
    return {
        user: userRes.rows[0],
        allBadges: allBadgesRes.rows,
        earnedBadgeIds: Array.from(earnedBadgeIds)
    };
}));
app.get('/api/admin/badges', isAdmin, handleRequest(async () => (await db.query('SELECT * FROM badges ORDER BY "badgeName"')).rows));
app.post('/api/admin/badges', isAdmin, handleRequest(async (req) => {
    const { badgeName, description, imageUrl } = req.body;
    const badgeId = "BADGE" + uuidv4();
    await db.query('INSERT INTO badges ("badgeId", "badgeName", description, "imageUrl") VALUES ($1, $2, $3, $4)', [badgeId, badgeName, description, imageUrl]);
    return { message: 'Badge created successfully' };
}));
app.put('/api/admin/badges/:badgeId', isAdmin, handleRequest(async (req) => {
    const { badgeId } = req.params;
    const { badgeName, description, imageUrl } = req.body;
    await db.query('UPDATE badges SET "badgeName" = $1, description = $2, "imageUrl" = $3 WHERE "badgeId" = $4', [badgeName, description, imageUrl, badgeId]);
    return { message: 'Badge updated successfully.' };
}));
app.delete('/api/admin/badges/:badgeId', isAdmin, handleRequest(async (req) => {
    const { badgeId } = req.params;
    await db.query('DELETE FROM badges WHERE "badgeId" = $1', [badgeId]);
    return { message: 'Badge deleted successfully' };
}));
app.post('/api/admin/award-badge', isAdmin, handleRequest(async (req) => {
    const { lineUserId, badgeId } = req.body;
    await db.query('INSERT INTO user_badges ("lineUserId", "badgeId") VALUES ($1, $2) ON CONFLICT ("lineUserId", "badgeId") DO NOTHING', [lineUserId, badgeId]);
    return { message: 'Badge awarded successfully' };
}));
app.post('/api/admin/revoke-badge', isAdmin, handleRequest(async (req) => {
    const { lineUserId, badgeId } = req.body;
    await db.query('DELETE FROM user_badges WHERE "lineUserId" = $1 AND "badgeId" = $2', [lineUserId, badgeId]);
    return { message: 'Badge revoked successfully' };
}));

// ================================= SERVER START =================================
app.get('/', (req, res) => res.send('Backend server is running!'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
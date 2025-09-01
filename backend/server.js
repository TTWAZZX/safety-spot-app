require('dotenv').config(); // โหลดค่าจากไฟล์ .env
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer'); // เพิ่ม multer
const db = require('./db'); // Import connection pool ของ PostgreSQL

// สร้าง Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // อนุญาตการเชื่อมต่อจากโดเมนอื่น (สำคัญสำหรับ LIFF)
app.use(express.json()); // ทำให้ Express อ่าน JSON จาก request body ได้
app.use(express.static(path.join(__dirname, 'public'))); // ให้บริการไฟล์ static (index.html) จากโฟลเดอร์ public
// *** NEW: ทำให้เข้าถึงไฟล์ในโฟลเดอร์ uploads ได้ ***
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ================================= MULTER SETUP =================================
// ตั้งค่าการจัดเก็บไฟล์ด้วย multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); // ระบุโฟลเดอร์ที่จะเก็บไฟล์
    },
    filename: function (req, file, cb) {
        // ตั้งชื่อไฟล์ใหม่เพื่อป้องกันชื่อซ้ำกัน
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// ================================= API ROUTES =================================

// --- Helper Function ---
// ฟังก์ชันสำหรับจัดการ Error และส่ง Response กลับไป
const handleRequest = (handler) => async (req, res) => {
    try {
        const data = await handler(req, res);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        console.error(`API Error on ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
};

// *** NEW: Endpoint สำหรับอัปโหลดรูปภาพ ***
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
    }
    // สร้าง URL ที่จะใช้เข้าถึงไฟล์จาก frontend
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.status(200).json({ status: 'success', data: { imageUrl: imageUrl } });
});


// --- User & General Routes ---

// GET /api/user/profile
app.get('/api/user/profile', handleRequest(async (req) => {
    const { lineUserId } = req.query;
    if (!lineUserId) throw new Error('lineUserId is required');

    const userRes = await db.query('SELECT * FROM users WHERE "lineUserId" = $1', [lineUserId]);
    if (userRes.rows.length === 0) {
        return { registered: false, user: null };
    }
    
    const adminRes = await db.query('SELECT * FROM admins WHERE "lineUserId" = $1', [lineUserId]);
    const user = userRes.rows[0];
    user.isAdmin = adminRes.rows.length > 0;
    
    return { registered: true, user };
}));

// POST /api/user/register
app.post('/api/user/register', handleRequest(async (req) => {
    const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;
    
    const existingUserRes = await db.query('SELECT * FROM users WHERE "lineUserId" = $1', [lineUserId]);
    if (existingUserRes.rows.length > 0) {
        return existingUserRes.rows[0]; // ถ้ามีอยู่แล้วก็ return ข้อมูลเดิม
    }

    const newUser = { lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore: 0 };
    await db.query('INSERT INTO users ("lineUserId", "displayName", "pictureUrl", "fullName", "employeeId", "totalScore") VALUES ($1, $2, $3, $4, $5, $6)', 
        [lineUserId, displayName, pictureUrl, fullName, employeeId, 0]);
    
    const adminRes = await db.query('SELECT * FROM admins WHERE "lineUserId" = $1', [lineUserId]);
    newUser.isAdmin = adminRes.rows.length > 0;

    return newUser;
}));

// GET /api/activities
app.get('/api/activities', handleRequest(async () => {
    const res = await db.query(
        `SELECT "activityId", title, description, "imageUrl", status, "createdAt" FROM activities WHERE status = 'active' ORDER BY "createdAt" DESC`
    );
    return res.rows;
}));

// GET /api/leaderboard
app.get('/api/leaderboard', handleRequest(async () => {
    const res = await db.query(
        'SELECT "fullName", "pictureUrl", "totalScore" FROM users ORDER BY "totalScore" DESC, "fullName" ASC LIMIT 50'
    );
    return res.rows;
}));

// GET /api/user/badges
app.get('/api/user/badges', handleRequest(async (req) => {
    const { lineUserId } = req.query;
    const allBadgesRes = await db.query('SELECT "badgeId" as id, "badgeName" as name, description as "desc", "imageUrl" as img FROM badges');
    const userBadgeRes = await db.query('SELECT "badgeId" FROM user_badges WHERE "lineUserId" = $1', [lineUserId]);
    const userEarnedIds = new Set(userBadgeRes.rows.map(b => b.badgeId));

    return allBadgesRes.rows.map(b => ({
        ...b,
        isEarned: userEarnedIds.has(b.id)
    }));
}));

// --- Submissions & Social Features ---

// GET /api/submissions
app.get('/api/submissions', handleRequest(async (req) => {
    const { activityId, lineUserId } = req.query;

    const sql = `
        SELECT 
            s."submissionId", s.description, s."imageUrl", s."createdAt",
            u."fullName", u."pictureUrl",
            (SELECT COUNT(*) FROM likes WHERE "submissionId" = s."submissionId")::int as likes,
            (SELECT COUNT(*) FROM likes WHERE "submissionId" = s."submissionId" AND "lineUserId" = $1)::int as didLike
        FROM submissions s
        JOIN users u ON s."lineUserId" = u."lineUserId"
        WHERE s."activityId" = $2 AND s.status = 'approved'
        ORDER BY s."createdAt" DESC;
    `;
    const submissionsRes = await db.query(sql, [lineUserId, activityId]);

    const commentsSql = `
        SELECT c."commentText", u."fullName", u."pictureUrl"
        FROM comments c
        JOIN users u ON c."lineUserId" = u."lineUserId"
        WHERE c."submissionId" = $1
        ORDER BY c."createdAt" ASC;
    `;

    const results = await Promise.all(submissionsRes.rows.map(async sub => {
        const commentsRes = await db.query(commentsSql, [sub.submissionId]);
        return {
            submissionId: sub.submissionId,
            description: sub.description,
            imageUrl: sub.imageUrl,
            createdAt: sub.createdAt,
            submitter: {
                fullName: sub.fullName,
                pictureUrl: sub.pictureUrl
            },
            likes: sub.likes,
            didLike: sub.didLike > 0,
            comments: commentsRes.rows.map(c => ({
                commentText: c.commentText,
                commenter: {
                    fullName: c.fullName,
                    pictureUrl: c.pictureUrl
                }
            }))
        };
    }));

    return results;
}));

// POST /api/submissions
app.post('/api/submissions', handleRequest(async (req) => {
    // *** UPDATED: รับ imageUrl มาด้วย ***
    const { activityId, lineUserId, description, imageUrl } = req.body;
    const submissionId = "SUB" + Date.now();
    await db.query(
        'INSERT INTO submissions ("submissionId", "activityId", "lineUserId", description, "imageUrl", status, points, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [submissionId, activityId, lineUserId, description, imageUrl, 'pending', 0, new Date()]
    );
    return { message: 'Report submitted successfully!' };
}));

// POST /api/submissions/like
app.post('/api/submissions/like', handleRequest(async (req) => {
    const { submissionId, lineUserId } = req.body;
    
    const existingLikeRes = await db.query('SELECT "likeId" FROM likes WHERE "submissionId" = $1 AND "lineUserId" = $2', [submissionId, lineUserId]);

    if (existingLikeRes.rows.length > 0) {
        // Unlike
        await db.query('DELETE FROM likes WHERE "likeId" = $1', [existingLikeRes.rows[0].likeId]);
        return { status: 'unliked' };
    } else {
        // Like
        const likeId = "LIKE" + Date.now();
        await db.query('INSERT INTO likes ("likeId", "submissionId", "lineUserId", "createdAt") VALUES ($1, $2, $3, $4)', [likeId, submissionId, lineUserId, new Date()]);
        return { status: 'liked' };
    }
}));

// POST /api/submissions/comment
app.post('/api/submissions/comment', handleRequest(async (req) => {
    const { submissionId, lineUserId, commentText } = req.body;
    if (!commentText || commentText.trim() === '') {
        throw new Error("Comment cannot be empty.");
    }
    const commentId = "CMT" + Date.now();
    await db.query(
        'INSERT INTO comments ("commentId", "submissionId", "lineUserId", "commentText", "createdAt") VALUES ($1, $2, $3, $4, $5)',
        [commentId, submissionId, lineUserId, commentText.trim(), new Date()]
    );
    return { message: 'Comment added.' };
}));


// --- Admin Routes ---

// GET /api/admin/stats
app.get('/api/admin/stats', handleRequest(async () => {
    const totalUsersRes = await db.query('SELECT COUNT(*) as "totalUsers" FROM users');
    const totalSubmissionsRes = await db.query('SELECT COUNT(*) as "totalSubmissions" FROM submissions');
    const submissionsTodayRes = await db.query(`SELECT COUNT(*) as "submissionsToday" FROM submissions WHERE DATE("createdAt") = CURRENT_DATE`);

    const mostReportedRes = await db.query(`
        SELECT a.title, COUNT(s."submissionId") as "reportCount"
        FROM submissions s
        JOIN activities a ON s."activityId" = a."activityId"
        GROUP BY s."activityId", a.title
        ORDER BY "reportCount" DESC
        LIMIT 1;
    `);

    let mostReportedActivity = "N/A";
    if (mostReportedRes.rows.length > 0) {
        mostReportedActivity = `${mostReportedRes.rows[0].title} (${mostReportedRes.rows[0].reportCount} reports)`;
    }

    return { 
        totalUsers: parseInt(totalUsersRes.rows[0].totalUsers),
        totalSubmissions: parseInt(totalSubmissionsRes.rows[0].totalSubmissions),
        submissionsToday: parseInt(submissionsTodayRes.rows[0].submissionsToday),
        mostReportedActivity
    };
}));

// GET /api/admin/submissions/pending
app.get('/api/admin/submissions/pending', handleRequest(async () => {
    const res = await db.query(`
        SELECT s.*, u."fullName" 
        FROM submissions s
        JOIN users u ON s."lineUserId" = u."lineUserId"
        WHERE s.status = 'pending'
        ORDER BY s."createdAt" DESC
    `);
    return res.rows.map(s => ({...s, submitter: { fullName: s.fullName }}));
}));

// POST /api/admin/submissions/approve
app.post('/api/admin/submissions/approve', handleRequest(async (req) => {
    const { submissionId } = req.body;
    const POINTS_PER_APPROVAL = 10;
    
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const submissionRes = await client.query('SELECT "lineUserId" FROM submissions WHERE "submissionId" = $1', [submissionId]);
        if (submissionRes.rows.length === 0) throw new Error('Submission not found');
        const { lineUserId } = submissionRes.rows[0];

        await client.query('UPDATE submissions SET status = $1, points = $2 WHERE "submissionId" = $3', ['approved', POINTS_PER_APPROVAL, submissionId]);
        await client.query('UPDATE users SET "totalScore" = "totalScore" + $1 WHERE "lineUserId" = $2', [POINTS_PER_APPROVAL, lineUserId]);

        const submissionCountRes = await client.query(`SELECT COUNT(*) as "submissionCount" FROM submissions WHERE "lineUserId" = $1 AND status = 'approved'`, [lineUserId]);
        const submissionCount = parseInt(submissionCountRes.rows[0].submissionCount);

        const userBadgesRes = await client.query('SELECT "badgeId" FROM user_badges WHERE "lineUserId" = $1', [lineUserId]);
        const earnedBadgeIds = userBadgesRes.rows.map(b => b.badgeId);

        const award = async (badgeId) => {
            if (!earnedBadgeIds.includes(badgeId)) {
                await client.query('INSERT INTO user_badges ("lineUserId", "badgeId", "earnedAt") VALUES ($1, $2, $3)', [lineUserId, badgeId, new Date()]);
            }
        };

        if (submissionCount >= 1) await award('badge001');
        if (submissionCount >= 5) await award('badge002');

        await client.query('COMMIT');
        return { message: 'Submission approved.' };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}));

// POST /api/admin/submissions/reject
app.post('/api/admin/submissions/reject', handleRequest(async (req) => {
    const { submissionId } = req.body;
    await db.query("UPDATE submissions SET status = 'rejected' WHERE \"submissionId\" = $1", [submissionId]);
    return { message: 'Submission rejected.' };
}));

// GET /api/admin/activities
app.get('/api/admin/activities', handleRequest(async () => {
    const res = await db.query('SELECT * FROM activities ORDER BY "createdAt" DESC');
    return res.rows;
}));

// POST /api/admin/activities
app.post('/api/admin/activities', handleRequest(async (req) => {
    const { title, description, imageUrl } = req.body;
    const activityId = "ACT" + Date.now();
    await db.query(
        'INSERT INTO activities ("activityId", title, description, "imageUrl", status, "createdAt") VALUES ($1, $2, $3, $4, $5, $6)',
        [activityId, title, description, imageUrl, 'active', new Date()]
    );
    return { message: 'Activity created' };
}));

// PUT /api/admin/activities
app.put('/api/admin/activities', handleRequest(async (req) => {
    const { activityId, title, description, imageUrl } = req.body;
    await db.query(
        'UPDATE activities SET title = $1, description = $2, "imageUrl" = $3 WHERE "activityId" = $4',
        [title, description, imageUrl, activityId]
    );
    return { message: 'Activity updated' };
}));

// POST /api/admin/activities/toggle
app.post('/api/admin/activities/toggle', handleRequest(async (req) => {
    const { activityId } = req.body;
    const activityRes = await db.query('SELECT status FROM activities WHERE "activityId" = $1', [activityId]);
    if (activityRes.rows.length === 0) throw new Error('Activity not found');
    
    const newStatus = activityRes.rows[0].status === 'active' ? 'inactive' : 'active';
    await db.query('UPDATE activities SET status = $1 WHERE "activityId" = $2', [newStatus, activityId]);
    return { newStatus };
}));


// ================================= SERVER START =================================

// Route หลักสำหรับให้บริการหน้าเว็บ
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// เริ่มรันเซิร์ฟเวอร์
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

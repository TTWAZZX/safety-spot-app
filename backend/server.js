// Import ไลบรารีที่จำเป็น
require('dotenv').config(); // โหลดค่าจากไฟล์ .env
const express = require('express');
const path = require('path');
const cors = require('cors');
const db = require('./db'); // Import connection pool ของเรา

// สร้าง Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // อนุญาตการเชื่อมต่อจากโดเมนอื่น (สำคัญสำหรับ LIFF)
app.use(express.json()); // ทำให้ Express อ่าน JSON จาก request body ได้
app.use(express.static(path.join(__dirname, 'public'))); // ให้บริการไฟล์ static (index.html) จากโฟลเดอร์ public

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

// --- User & General Routes ---

// GET /api/user/profile
app.get('/api/user/profile', handleRequest(async (req) => {
    const { lineUserId } = req.query;
    if (!lineUserId) throw new Error('lineUserId is required');

    const [users] = await db.query('SELECT * FROM users WHERE lineUserId = ?', [lineUserId]);
    if (users.length === 0) {
        return { registered: false, user: null };
    }
    
    const [admins] = await db.query('SELECT * FROM admins WHERE lineUserId = ?', [lineUserId]);
    const user = users[0];
    user.isAdmin = admins.length > 0;
    
    return { registered: true, user };
}));

// POST /api/user/register
app.post('/api/user/register', handleRequest(async (req) => {
    const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;
    
    const [existingUsers] = await db.query('SELECT * FROM users WHERE lineUserId = ?', [lineUserId]);
    if (existingUsers.length > 0) {
        return existingUsers[0]; // ถ้ามีอยู่แล้วก็ return ข้อมูลเดิม
    }

    const newUser = { lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore: 0 };
    await db.query('INSERT INTO users SET ?', newUser);
    
    const [admins] = await db.query('SELECT * FROM admins WHERE lineUserId = ?', [lineUserId]);
    newUser.isAdmin = admins.length > 0;

    return newUser;
}));

// GET /api/activities
app.get('/api/activities', handleRequest(async () => {
    const [activities] = await db.query(
        "SELECT * FROM activities WHERE status = 'active' ORDER BY createdAt DESC"
    );
    return activities;
}));

// GET /api/leaderboard
app.get('/api/leaderboard', handleRequest(async () => {
    const [users] = await db.query(
        'SELECT fullName, pictureUrl, totalScore FROM users ORDER BY totalScore DESC, fullName ASC LIMIT 50'
    );
    return users;
}));

// GET /api/user/badges
app.get('/api/user/badges', handleRequest(async (req) => {
    const { lineUserId } = req.query;
    const [allBadges] = await db.query('SELECT badgeId as id, badgeName as name, description as `desc`, imageUrl as img FROM badges');
    const [userBadgeRows] = await db.query('SELECT badgeId FROM user_badges WHERE lineUserId = ?', [lineUserId]);
    const userEarnedIds = new Set(userBadgeRows.map(b => b.badgeId));

    return allBadges.map(b => ({
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
            s.submissionId, s.description, s.imageUrl, s.createdAt,
            u.fullName, u.pictureUrl,
            (SELECT COUNT(*) FROM likes WHERE submissionId = s.submissionId) as likes,
            (SELECT COUNT(*) FROM likes WHERE submissionId = s.submissionId AND lineUserId = ?) as didLike,
            (SELECT COUNT(*) FROM comments WHERE submissionId = s.submissionId) as commentCount
        FROM submissions s
        JOIN users u ON s.lineUserId = u.lineUserId
        WHERE s.activityId = ? AND s.status = 'approved'
        ORDER BY s.createdAt DESC;
    `;
    const [submissions] = await db.query(sql, [lineUserId, activityId]);

    const commentsSql = `
        SELECT c.commentText, u.fullName, u.pictureUrl
        FROM comments c
        JOIN users u ON c.lineUserId = u.lineUserId
        WHERE c.submissionId = ?
        ORDER BY c.createdAt ASC;
    `;

    const results = await Promise.all(submissions.map(async sub => {
        const [comments] = await db.query(commentsSql, [sub.submissionId]);
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
            comments: comments.map(c => ({
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
    const { activityId, lineUserId, description } = req.body;
    const submissionId = "SUB" + Date.now();
    const newSubmission = {
        submissionId,
        activityId,
        lineUserId,
        description,
        status: 'pending',
        points: 0,
        createdAt: new Date()
    };
    await db.query('INSERT INTO submissions SET ?', newSubmission);
    return { message: 'Report submitted successfully!' };
}));

// POST /api/submissions/like
app.post('/api/submissions/like', handleRequest(async (req) => {
    const { submissionId, lineUserId } = req.body;
    
    const [existingLikes] = await db.query('SELECT * FROM likes WHERE submissionId = ? AND lineUserId = ?', [submissionId, lineUserId]);

    if (existingLikes.length > 0) {
        // Unlike
        await db.query('DELETE FROM likes WHERE likeId = ?', [existingLikes[0].likeId]);
        return { status: 'unliked' };
    } else {
        // Like
        const likeId = "LIKE" + Date.now();
        await db.query('INSERT INTO likes SET ?', { likeId, submissionId, lineUserId, createdAt: new Date() });
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
    const newComment = {
        commentId,
        submissionId,
        lineUserId,
        commentText: commentText.trim(),
        createdAt: new Date()
    };
    await db.query('INSERT INTO comments SET ?', newComment);
    return { message: 'Comment added.' };
}));


// --- Admin Routes ---

// GET /api/admin/stats
app.get('/api/admin/stats', handleRequest(async () => {
    const [[{ totalUsers }]] = await db.query('SELECT COUNT(*) as totalUsers FROM users');
    const [[{ totalSubmissions }]] = await db.query('SELECT COUNT(*) as totalSubmissions FROM submissions');
    const [[{ submissionsToday }]] = await db.query("SELECT COUNT(*) as submissionsToday FROM submissions WHERE DATE(createdAt) = CURDATE()");

    const [mostReported] = await db.query(`
        SELECT a.title, COUNT(s.submissionId) as reportCount
        FROM submissions s
        JOIN activities a ON s.activityId = a.activityId
        GROUP BY s.activityId
        ORDER BY reportCount DESC
        LIMIT 1;
    `);

    let mostReportedActivity = "N/A";
    if (mostReported.length > 0) {
        mostReportedActivity = `${mostReported[0].title} (${mostReported[0].reportCount} reports)`;
    }

    return { totalUsers, totalSubmissions, submissionsToday, mostReportedActivity };
}));

// GET /api/admin/submissions/pending
app.get('/api/admin/submissions/pending', handleRequest(async () => {
    const [submissions] = await db.query(`
        SELECT s.*, u.fullName 
        FROM submissions s
        JOIN users u ON s.lineUserId = u.lineUserId
        WHERE s.status = 'pending'
        ORDER BY s.createdAt DESC
    `);
    // Map to include submitter object for frontend compatibility
    return submissions.map(s => ({...s, submitter: { fullName: s.fullName }}));
}));

// POST /api/admin/submissions/approve
app.post('/api/admin/submissions/approve', handleRequest(async (req) => {
    const { submissionId } = req.body;
    const POINTS_PER_APPROVAL = 10;
    
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [submissionRows] = await conn.query('SELECT lineUserId FROM submissions WHERE submissionId = ?', [submissionId]);
        if (submissionRows.length === 0) throw new Error('Submission not found');
        const { lineUserId } = submissionRows[0];

        // 1. Approve submission and award points
        await conn.query('UPDATE submissions SET status = ?, points = ? WHERE submissionId = ?', ['approved', POINTS_PER_APPROVAL, submissionId]);

        // 2. Update user's total score
        await conn.query('UPDATE users SET totalScore = totalScore + ? WHERE lineUserId = ?', [POINTS_PER_APPROVAL, lineUserId]);

        // 3. Check for badges
        const [[{ submissionCount }]] = await conn.query("SELECT COUNT(*) as submissionCount FROM submissions WHERE lineUserId = ? AND status = 'approved'", [lineUserId]);
        const [userBadges] = await conn.query('SELECT badgeId FROM user_badges WHERE lineUserId = ?', [lineUserId]);
        const earnedBadgeIds = userBadges.map(b => b.badgeId);

        const award = async (badgeId) => {
            if (!earnedBadgeIds.includes(badgeId)) {
                await conn.query('INSERT INTO user_badges SET ?', { lineUserId, badgeId, earnedAt: new Date() });
            }
        };

        if (submissionCount >= 1) await award('badge001');
        if (submissionCount >= 5) await award('badge002');
        // Add more badge logic here

        await conn.commit();
        return { message: 'Submission approved.' };
    } catch (error) {
        await conn.rollback();
        throw error; // Re-throw the error to be caught by handleRequest
    } finally {
        conn.release();
    }
}));

// POST /api/admin/submissions/reject
app.post('/api/admin/submissions/reject', handleRequest(async (req) => {
    const { submissionId } = req.body;
    await db.query("UPDATE submissions SET status = 'rejected' WHERE submissionId = ?", [submissionId]);
    return { message: 'Submission rejected.' };
}));

// GET /api/admin/activities
app.get('/api/admin/activities', handleRequest(async () => {
    const [activities] = await db.query('SELECT * FROM activities ORDER BY createdAt DESC');
    return activities;
}));

// POST /api/admin/activities
app.post('/api/admin/activities', handleRequest(async (req) => {
    const { title, description, imageUrl } = req.body;
    const newActivity = {
        activityId: "ACT" + Date.now(),
        title,
        description,
        imageUrl,
        status: 'active',
        createdAt: new Date()
    };
    await db.query('INSERT INTO activities SET ?', newActivity);
    return { message: 'Activity created' };
}));

// PUT /api/admin/activities
app.put('/api/admin/activities', handleRequest(async (req) => {
    const { activityId, title, description, imageUrl } = req.body;
    await db.query(
        'UPDATE activities SET title = ?, description = ?, imageUrl = ? WHERE activityId = ?',
        [title, description, imageUrl, activityId]
    );
    return { message: 'Activity updated' };
}));

// POST /api/admin/activities/toggle
app.post('/api/admin/activities/toggle', handleRequest(async (req) => {
    const { activityId } = req.body;
    const [[activity]] = await db.query('SELECT status FROM activities WHERE activityId = ?', [activityId]);
    if (!activity) throw new Error('Activity not found');
    
    const newStatus = activity.status === 'active' ? 'inactive' : 'active';
    await db.query('UPDATE activities SET status = ? WHERE activityId = ?', [newStatus, activityId]);
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


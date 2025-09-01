require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- สร้างโฟลเดอร์ uploads อัตโนมัติ ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
    console.log(`Created directory: ${uploadsDir}`);
}

// ทำให้เข้าถึงไฟล์ในโฟลเดอร์ uploads ได้
app.use('/uploads', express.static(uploadsDir));

// ================================= MULTER SETUP =================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ================================= API ROUTES =================================
const handleRequest = (handler) => async (req, res) => {
    try {
        const data = await handler(req, res);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        console.error(`API Error on ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
};

app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
    }
    const imageUrl = `/uploads/${req.file.filename}`;
    res.status(200).json({ status: 'success', data: { imageUrl: imageUrl } });
});

// --- User & General Routes ---
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

app.post('/api/user/register', handleRequest(async (req) => {
    const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;
    
    const existingUserRes = await db.query('SELECT * FROM users WHERE "lineUserId" = $1 OR "employeeId" = $2', [lineUserId, employeeId]);
    if (existingUserRes.rows.length > 0) {
        throw new Error('LINE User ID หรือรหัสพนักงานนี้มีอยู่ในระบบแล้ว');
    }

    const newUser = { lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore: 0 };
    await db.query('INSERT INTO users ("lineUserId", "displayName", "pictureUrl", "fullName", "employeeId", "totalScore") VALUES ($1, $2, $3, $4, $5, $6)', 
        [lineUserId, displayName, pictureUrl, fullName, employeeId, 0]);
    
    const adminRes = await db.query('SELECT * FROM admins WHERE "lineUserId" = $1', [lineUserId]);
    newUser.isAdmin = adminRes.rows.length > 0;

    return newUser;
}));

app.get('/api/activities', handleRequest(async () => {
    const res = await db.query(
        `SELECT "activityId", title, description, "imageUrl", status, "createdAt" FROM activities WHERE status = 'active' ORDER BY "createdAt" DESC`
    );
    return res.rows;
}));

app.get('/api/leaderboard', handleRequest(async () => {
    const res = await db.query(
        'SELECT "fullName", "pictureUrl", "totalScore" FROM users ORDER BY "totalScore" DESC, "fullName" ASC LIMIT 50'
    );
    return res.rows;
}));

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
app.get('/api/submissions', handleRequest(async (req) => {
    const { activityId, lineUserId } = req.query;

    const sql = `
        SELECT 
            s."submissionId", s.description, s."imageUrl", s."createdAt",
            u."fullName" as "submitterFullName", u."pictureUrl" as "submitterPictureUrl",
            (SELECT COUNT(*) FROM likes WHERE "submissionId" = s."submissionId")::int as likes
        FROM submissions s
        JOIN users u ON s."lineUserId" = u."lineUserId"
        WHERE s."activityId" = $1 AND s.status = 'approved'
        ORDER BY s."createdAt" DESC;
    `;
    const submissionsRes = await db.query(sql, [activityId]);

    const likesRes = await db.query('SELECT "submissionId" FROM likes WHERE "lineUserId" = $1', [lineUserId]);
    const userLikedIds = new Set(likesRes.rows.map(l => l.submissionId));

    const commentsSql = `
        SELECT c."submissionId", c."commentText", u."fullName" as "commenterFullName", u."pictureUrl" as "commenterPictureUrl"
        FROM comments c
        JOIN users u ON c."lineUserId" = u."lineUserId"
        WHERE c."submissionId" = ANY($1::text[])
        ORDER BY c."createdAt" ASC;
    `;
    
    const submissionIds = submissionsRes.rows.map(s => s.submissionId);
    let commentsBySubmission = {};
    if (submissionIds.length > 0) {
        const commentsRes = await db.query(commentsSql, [submissionIds]);
        commentsRes.rows.forEach(c => {
            if (!commentsBySubmission[c.submissionId]) {
                commentsBySubmission[c.submissionId] = [];
            }
            commentsBySubmission[c.submissionId].push({
                commentText: c.commentText,
                commenter: { fullName: c.commenterFullName, pictureUrl: c.commenterPictureUrl }
            });
        });
    }

    return submissionsRes.rows.map(sub => ({
        submissionId: sub.submissionId,
        description: sub.description,
        imageUrl: sub.imageUrl,
        createdAt: sub.createdAt,
        submitter: { fullName: sub.submitterFullName, pictureUrl: sub.submitterPictureUrl },
        likes: sub.likes,
        didLike: userLikedIds.has(sub.submissionId),
        comments: commentsBySubmission[sub.submissionId] || []
    }));
}));

app.post('/api/submissions', handleRequest(async (req) => {
    const { activityId, lineUserId, description, imageUrl } = req.body;
    const submissionId = "SUB" + Date.now();
    await db.query(
        'INSERT INTO submissions ("submissionId", "activityId", "lineUserId", description, "imageUrl", status, points, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [submissionId, activityId, lineUserId, description, imageUrl, 'pending', 0, new Date()]
    );
    return { message: 'Report submitted successfully!' };
}));

app.post('/api/submissions/like', handleRequest(async (req) => {
    const { submissionId, lineUserId } = req.body;
    
    const existingLikeRes = await db.query('SELECT "likeId" FROM likes WHERE "submissionId" = $1 AND "lineUserId" = $2', [submissionId, lineUserId]);

    if (existingLikeRes.rows.length > 0) {
        await db.query('DELETE FROM likes WHERE "likeId" = $1', [existingLikeRes.rows[0].likeId]);
        const countRes = await db.query('SELECT COUNT(*) FROM likes WHERE "submissionId" = $1', [submissionId]);
        return { status: 'unliked', newLikeCount: parseInt(countRes.rows[0].count) };
    } else {
        const likeId = "LIKE" + Date.now();
        await db.query('INSERT INTO likes ("likeId", "submissionId", "lineUserId", "createdAt") VALUES ($1, $2, $3, $4)', [likeId, submissionId, lineUserId, new Date()]);
        const countRes = await db.query('SELECT COUNT(*) FROM likes WHERE "submissionId" = $1', [submissionId]);
        return { status: 'liked', newLikeCount: parseInt(countRes.rows[0].count) };
    }
}));

app.post('/api/submissions/comment', handleRequest(async (req) => {
    const { submissionId, lineUserId, commentText } = req.body;
    if (!commentText || commentText.trim() === '') throw new Error("Comment cannot be empty.");
    const commentId = "CMT" + Date.now();
    await db.query(
        'INSERT INTO comments ("commentId", "submissionId", "lineUserId", "commentText", "createdAt") VALUES ($1, $2, $3, $4, $5)',
        [commentId, submissionId, lineUserId, commentText.trim(), new Date()]
    );
    return { message: 'Comment added.' };
}));


// --- Admin Routes ---

app.get('/api/admin/stats', handleRequest(async () => {
    const totalUsersRes = await db.query('SELECT COUNT(*) as "totalUsers" FROM users');
    const totalSubmissionsRes = await db.query('SELECT COUNT(*) as "totalSubmissions" FROM submissions');
    const submissionsTodayRes = await db.query(`SELECT COUNT(*) as "submissionsToday" FROM submissions WHERE DATE("createdAt") = CURRENT_DATE`);
    const mostReportedRes = await db.query(`
        SELECT a.title, COUNT(s."submissionId") as "reportCount"
        FROM submissions s JOIN activities a ON s."activityId" = a."activityId"
        GROUP BY s."activityId", a.title ORDER BY "reportCount" DESC LIMIT 1;
    `);
    
    return { 
        totalUsers: parseInt(totalUsersRes.rows[0].totalUsers),
        totalSubmissions: parseInt(totalSubmissionsRes.rows[0].totalSubmissions),
        submissionsToday: parseInt(submissionsTodayRes.rows[0].submissionsToday),
        mostReportedActivity: mostReportedRes.rows.length > 0 ? mostReportedRes.rows[0].title : "N/A"
    };
}));

app.get('/api/admin/chart-data', handleRequest(async () => {
    const query = `
        SELECT 
            TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
            COUNT(s."submissionId")::int AS count
        FROM 
            generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
        LEFT JOIN 
            submissions s ON DATE(s."createdAt") = d.day
        GROUP BY 
            d.day
        ORDER BY 
            d.day;
    `;
    const res = await db.query(query);
    return {
        labels: res.rows.map(r => new Date(r.date).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric' })),
        data: res.rows.map(r => r.count)
    };
}));

app.get('/api/admin/submissions/pending', handleRequest(async () => {
    const res = await db.query(`
        SELECT s.*, u."fullName" 
        FROM submissions s JOIN users u ON s."lineUserId" = u."lineUserId"
        WHERE s.status = 'pending' ORDER BY s."createdAt" ASC
    `);
    return res.rows.map(s => ({...s, submitter: { fullName: s.fullName }}));
}));

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
        await client.query('COMMIT');
        return { message: 'Submission approved.' };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}));

app.post('/api/admin/submissions/reject', handleRequest(async (req) => {
    const { submissionId } = req.body;
    await db.query("UPDATE submissions SET status = 'rejected' WHERE \"submissionId\" = $1", [submissionId]);
    return { message: 'Submission rejected.' };
}));

app.get('/api/admin/activities', handleRequest(async () => {
    const res = await db.query('SELECT * FROM activities ORDER BY "createdAt" DESC');
    return res.rows;
}));

app.post('/api/admin/activities', handleRequest(async (req) => {
    const { title, description, imageUrl } = req.body;
    const activityId = "ACT" + Date.now();
    await db.query(
        'INSERT INTO activities ("activityId", title, description, "imageUrl", status, "createdAt") VALUES ($1, $2, $3, $4, $5, $6)',
        [activityId, title, description, imageUrl, 'active', new Date()]
    );
    return { message: 'Activity created' };
}));

app.put('/api/admin/activities', handleRequest(async (req) => {
    const { activityId, title, description, imageUrl } = req.body;
    await db.query(
        'UPDATE activities SET title = $1, description = $2, "imageUrl" = $3 WHERE "activityId" = $4',
        [title, description, imageUrl, activityId]
    );
    return { message: 'Activity updated' };
}));

app.post('/api/admin/activities/toggle', handleRequest(async (req) => {
    const { activityId } = req.body;
    const activityRes = await db.query('SELECT status FROM activities WHERE "activityId" = $1', [activityId]);
    if (activityRes.rows.length === 0) throw new Error('Activity not found');
    
    const newStatus = activityRes.rows[0].status === 'active' ? 'inactive' : 'active';
    await db.query('UPDATE activities SET status = $1 WHERE "activityId" = $2', [newStatus, activityId]);
    return { newStatus };
}));


// ================================= SERVER START =================================
// Add a simple root route to check if the server is up
app.get('/', (req, res) => {
    res.send('Backend server is running!');
});


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


// server.js (Clean Version – No Cloudinary)
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const { distance } = require('fastest-levenshtein');

// AWS S3 Client (Cloudflare R2)
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
//   CORS
// -----------------------------
const allowedOrigins = [
    'https://ttwazzx.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.error('CORS Error: Origin not allowed:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.use(express.json());

// -----------------------------
//   LOCAL UPLOAD FOLDER
// -----------------------------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

app.use('/uploads', express.static(uploadsDir, {
    maxAge: '30d',
    immutable: true
}));

// Multer in-memory
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// -----------------------------
//   Cloudflare R2 UPLOADER
// -----------------------------
async function uploadToR2(buffer, mime = 'image/jpeg') {
    const {
        R2_ACCOUNT_ID,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        R2_BUCKET_NAME,
        R2_PUBLIC_BASE_URL,
    } = process.env;

    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
        throw new Error('R2 configuration missing.');
    }

    const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        }
    });

    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const objectKey = `safety-spot/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: buffer,
        ContentType: mime
    }));

    return `${R2_PUBLIC_BASE_URL}/${objectKey}`;
}

// -----------------------------
//   Universal request handler
// -----------------------------
const handleRequest = (handler) => async (req, res) => {
    try {
        const [data] = await handler(req, res);
        res.status(200).json({ status: 'success', data: data || null });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// -----------------------------
//   Admin Middleware
// -----------------------------
const isAdmin = async (req, res, next) => {
    const requesterId = req.body.requesterId || req.query.requesterId;
    if (!requesterId) return res.status(401).json({ status: 'error', message: 'Unauthorized: Missing Requester ID' });

    try {
        const [adminRows] = await db.query('SELECT * FROM admins WHERE lineUserId = ?', [requesterId]);
        if (adminRows.length === 0) return res.status(403).json({ status: 'error', message: 'Forbidden: Not an admin' });

        next();
    } catch (error) {
        console.error('Admin auth error:', error);
        res.status(500).json({ status: 'error', message: 'Server error during admin check' });
    }
};

// -----------------------------
//   UPLOAD API → uses R2 only
// -----------------------------
app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'Missing image file.' });
    }

    try {
        const mime = req.file.mimetype || 'image/jpeg';
        const finalUrl = await uploadToR2(req.file.buffer, mime);

        return res.status(200).json({
            status: 'success',
            data: { imageUrl: finalUrl }
        });
    } catch (error) {
        console.error('R2 Upload Error:', error);
        return res.status(500).json({ status: 'error', message: 'Image upload failed.' });
    }
});

// -----------------------------
//     USER APIs
// -----------------------------
app.get('/api/user/profile', async (req, res) => {
    try {
        const { lineUserId } = req.query;

        if (!lineUserId) {
            return res.status(200).json({ status: 'success', data: { registered: false, user: null } });
        }

        const [userRows] = await db.query('SELECT * FROM users WHERE lineUserId = ?', [lineUserId]);
        if (userRows.length === 0) {
            return res.status(200).json({ status: 'success', data: { registered: false, user: null } });
        }

        const user = userRows[0];
        const [adminRows] = await db.query('SELECT * FROM admins WHERE lineUserId = ?', [lineUserId]);
        user.isAdmin = adminRows.length > 0;

        res.status(200).json({ status: 'success', data: { registered: true, user } });
    } catch (error) {
        console.error("Error /api/user/profile:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/user/register', async (req, res) => {
    try {
        const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;

        const [existing] = await db.query(
            'SELECT * FROM users WHERE lineUserId = ? OR employeeId = ?',
            [lineUserId, employeeId]
        );

        if (existing.length > 0) {
            throw new Error('LINE User ID หรือรหัสพนักงานมีอยู่แล้ว');
        }

        await db.query(
            'INSERT INTO users (lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore) VALUES (?, ?, ?, ?, ?, ?)',
            [lineUserId, displayName, pictureUrl, fullName, employeeId, 0]
        );

        res.status(200).json({
            status: 'success',
            data: { lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore: 0, isAdmin: false }
        });
    } catch (error) {
        console.error("Error /api/user/register:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// -----------------------------
//     ACTIVITIES
// -----------------------------
app.get('/api/activities', async (req, res) => {
    try {
        const { lineUserId } = req.query;

        const [activities] = await db.query(
            "SELECT * FROM activities WHERE status = 'active' ORDER BY createdAt DESC"
        );

        if (!lineUserId) {
            return res.status(200).json({ status: 'success', data: activities });
        }

        const [submitted] = await db.query(
            "SELECT activityId FROM submissions WHERE lineUserId = ? AND status IN ('pending','approved')",
            [lineUserId]
        );

        const submittedIds = new Set(submitted.map(s => s.activityId));

        const withStatus = activities.map(a => ({
            ...a,
            userHasSubmitted: submittedIds.has(a.activityId)
        }));

        res.status(200).json({ status: 'success', data: withStatus });
    } catch (error) {
        console.error("Error /api/activities:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// -----------------------------
//     LEADERBOARD
// -----------------------------
app.get('/api/leaderboard', handleRequest(async (req) => {
    const limit = 30;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    return db.query(
        'SELECT fullName, pictureUrl, totalScore FROM users ORDER BY totalScore DESC, fullName ASC LIMIT ? OFFSET ?',
        [limit, offset]
    );
}));

// -----------------------------
//     BADGES
// -----------------------------
app.get('/api/user/badges', async (req, res) => {
    try {
        const { lineUserId } = req.query;

        const [allBadges] = await db.query(
            'SELECT badgeId AS id, badgeName AS name, description AS `desc`, imageUrl AS img FROM badges'
        );

        const [userBadges] = await db.query(
            'SELECT badgeId FROM user_badges WHERE lineUserId = ?',
            [lineUserId]
        );

        const earned = new Set(userBadges.map(b => b.badgeId));

        const result = allBadges.map(b => ({
            ...b,
            isEarned: earned.has(b.id)
        }));

        res.status(200).json({ status: 'success', data: result });
    } catch (error) {
        console.error("Error /api/user/badges:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// -----------------------------
//     SUBMISSIONS
// -----------------------------
app.get('/api/submissions', async (req, res) => {
    try {
        const { activityId, lineUserId } = req.query;

        const sql = `
        SELECT s.submissionId, s.description, s.imageUrl, s.createdAt, s.points,
               u.fullName as submitterFullName, u.pictureUrl as submitterPictureUrl,
               (SELECT COUNT(*) FROM likes WHERE submissionId = s.submissionId) as likes
        FROM submissions s
        JOIN users u ON s.lineUserId = u.lineUserId
        WHERE s.activityId = ? AND s.status IN ('approved','pending')
        ORDER BY s.createdAt DESC
        `;

        const [rows] = await db.query(sql, [activityId]);

        const [likesRows] = await db.query(
            'SELECT submissionId FROM likes WHERE lineUserId = ?',
            [lineUserId]
        );

        const liked = new Set(likesRows.map(l => l.submissionId));

        const ids = rows.map(r => r.submissionId);
        let commentsMap = {};

        if (ids.length > 0) {
            const [comments] = await db.query(
                `SELECT c.submissionId, c.commentText, u.fullName AS commenterFullName, u.pictureUrl AS commenterPictureUrl
                 FROM comments c
                 JOIN users u ON c.lineUserId = u.lineUserId
                 WHERE c.submissionId IN (?)
                 ORDER BY c.createdAt ASC`,
                [ids]
            );

            comments.forEach(c => {
                if (!commentsMap[c.submissionId]) commentsMap[c.submissionId] = [];
                commentsMap[c.submissionId].push({
                    commentText: c.commentText,
                    commenter: {
                        fullName: c.commenterFullName,
                        pictureUrl: c.commenterPictureUrl
                    }
                });
            });
        }

        const result = rows.map(sub => ({
            submissionId: sub.submissionId,
            description: sub.description,
            imageUrl: sub.imageUrl,
            createdAt: sub.createdAt,
            points: sub.points,
            submitter: {
                fullName: sub.submitterFullName,
                pictureUrl: sub.submitterPictureUrl
            },
            likes: sub.likes,
            didLike: liked.has(sub.submissionId),
            comments: commentsMap[sub.submissionId] || []
        }));

        res.status(200).json({ status: 'success', data: result });

    } catch (error) {
        console.error("Error /api/submissions:", error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.post('/api/submissions', async (req, res) => {
    const { activityId, lineUserId, description, imageUrl } = req.body;

    try {
        const normalized = description.trim();
        if (!normalized) {
            throw new Error('กรุณากรอกรายละเอียดของรายงาน');
        }

        const [recent] = await db.query(
            'SELECT description FROM submissions WHERE activityId = ? ORDER BY createdAt DESC LIMIT 20',
            [activityId]
        );

        const SIMILARITY_THRESHOLD = 5;

        for (const sub of recent) {
            if (distance(normalized, sub.description) < SIMILARITY_THRESHOLD) {
                throw new Error('เนื้อหารายงานคล้ายกับรายงานที่มีอยู่แล้ว');
            }
        }

        const [existing] = await db.query(
            "SELECT submissionId FROM submissions WHERE activityId = ? AND lineUserId = ? AND status IN ('pending','approved')",
            [activityId, lineUserId]
        );

        if (existing.length > 0) {
            throw new Error('คุณเข้าร่วมกิจกรรมนี้แล้ว และรายงานรอตรวจหรือได้รับอนุมัติแล้ว');
        }

        await db.query(
            'INSERT INTO submissions (submissionId, activityId, lineUserId, description, imageUrl, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [`SUB${uuidv4()}`, activityId, lineUserId, normalized, imageUrl, 'pending', new Date()]
        );

        res.status(200).json({ status: 'success', data: { message: 'Submission created.' } });

    } catch (error) {
        console.error("Error /api/submissions POST:", error);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// -----------------------------
//   LIKE / UNLIKE
// -----------------------------
app.post('/api/submissions/like', async (req, res) => {
    const { submissionId, lineUserId } = req.body;

    const client = await db.getClient();

    try {
        await client.beginTransaction();

        const [existing] = await client.query(
            'SELECT likeId FROM likes WHERE submissionId = ? AND lineUserId = ?',
            [submissionId, lineUserId]
        );

        if (existing.length > 0) {
            await client.query('DELETE FROM likes WHERE likeId = ?', [existing[0].likeId]);
        } else {
            await client.query(
                'INSERT INTO likes (likeId, submissionId, lineUserId, createdAt) VALUES (?, ?, ?, ?)',
                [`LIKE${uuidv4()}`, submissionId, lineUserId, new Date()]
            );
        }

        await client.commit();

        res.status(200).json({ status: 'success', data: { liked: existing.length === 0 } });
    } catch (error) {
        await client.rollback();
        console.error("Error /api/submissions/like:", error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        client.release();
    }
});

// -----------------------------
//   SERVER START
// -----------------------------
app.listen(PORT, () => {
    console.log(`Safety Spot Backend running on port ${PORT}`);
});

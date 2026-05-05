// =============================================
// server.js  (FULL VERSION โ€” R2 UPLOAD ONLY)
// =============================================
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const { distance } = require('fastest-levenshtein');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const cron = require('node-cron'); // เน€เธเธดเนเธกเธเธฃเธฃเธ—เธฑเธ”เธเธตเนเธ•เนเธญเธเธฒเธ require เธญเธทเนเธเน

// -----------------------------
//   CORS
// -----------------------------
const allowedOrigins = [
    'https://ttwazzx.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function(origin, callback){
        if(!origin || allowedOrigins.includes(origin)){
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    }
}));

app.use(express.json());

// -----------------------------
//   Rate Limiting
// -----------------------------

// เธ—เธฑเนเธงเนเธ: 100 req / 1 เธเธฒเธ—เธต เธ•เนเธญ IP
const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many requests, please try again later.' }
});

// Sensitive endpoints: login/register 10 req / 5 เธเธฒเธ—เธต
const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many attempts, please wait 5 minutes.' }
});

// Upload/Submit: 20 req / 5 เธเธฒเธ—เธต
const uploadLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many submissions, please slow down.' }
});

app.use('/api/', generalLimiter);
app.use('/api/user/register', authLimiter);
app.use('/api/submissions', uploadLimiter);
app.use('/api/upload', uploadLimiter);

// -----------------------------
//   Helper for MySQL style API
// -----------------------------
const handleRequest = (handler) => async (req, res) => {
    try {
        const [data] = await handler(req, res);
        res.json({ status: "success", data: data || null });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
};

// -----------------------------
//   Startup DB migrations
// -----------------------------
db.query("ALTER TABLE users ADD COLUMN department VARCHAR(100) NOT NULL DEFAULT ''")
  .catch(() => {}); // ignore if column already exists
db.query("ALTER TABLE submissions ADD COLUMN reviewedAt DATETIME DEFAULT NULL")
  .catch(() => {});
db.query(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    logId       INT AUTO_INCREMENT PRIMARY KEY,
    adminId     VARCHAR(100) NOT NULL,
    adminName   VARCHAR(200) DEFAULT '',
    action      VARCHAR(100) NOT NULL,
    targetType  VARCHAR(50)  DEFAULT '',
    targetId    VARCHAR(100) DEFAULT '',
    targetName  VARCHAR(200) DEFAULT '',
    detail      JSON,
    createdAt   DATETIME DEFAULT NOW()
  )
`).catch(() => {});

db.query(`
  CREATE TABLE IF NOT EXISTS submission_reactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submissionId VARCHAR(100) NOT NULL,
    lineUserId VARCHAR(100) NOT NULL,
    emoji VARCHAR(10) NOT NULL,
    createdAt DATETIME DEFAULT NOW(),
    UNIQUE KEY uq_react (submissionId, lineUserId, emoji)
  )
`).catch(() => {});

// -------------------------
//   Admin Audit Log Helper
// -------------------------
async function logAdminAction(adminId, action, targetType, targetId, targetName, detail) {
    try {
        const [[admin]] = await db.query("SELECT fullName FROM users WHERE lineUserId = ?", [adminId]);
        const adminName = admin ? admin.fullName : adminId;
        await db.query(
            `INSERT INTO audit_logs (adminId, adminName, action, targetType, targetId, targetName, detail, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [adminId, adminName, action, targetType || '', targetId || '', targetName || '', JSON.stringify(detail || {})]
        );
    } catch (_) { /* never block main flow */ }
}

// -----------------------------
//   Auto award badges by score (ADD + REMOVE)
// -----------------------------
async function autoAwardBadgesForUser(lineUserId, connOptional) {
    // เธ–เนเธฒเธกเธตเธชเนเธ connection เธเธฒเธ transaction เน€เธเนเธฒเธกเธฒเนเธซเนเนเธเนเธ•เธฑเธงเธเธฑเนเธ
    // เธ–เนเธฒเนเธกเนเธชเนเธเธกเธฒ เนเธเน db เธเธเธ•เธด (pool)
    const conn = connOptional || db;

    // 1) เธฅเธเธเนเธฒเธข auto เธ—เธตเนเธเธฐเนเธเธ "เนเธกเนเธ–เธถเธเน€เธเธ“เธ‘เนเนเธฅเนเธง"
    //    - เธเนเธฒเธข auto: badges.minScore IS NOT NULL
    //    - เธเธนเนเนเธเนเธเธฐเนเธเธเธเธฑเธเธเธธเธเธฑเธ < minScore  โ’ เธ•เนเธญเธเธ–เธนเธเธฅเธเธญเธญเธ
    await conn.query(
        `
        DELETE ub
        FROM user_badges ub
        JOIN badges b ON ub.badgeId = b.badgeId
        JOIN users u  ON ub.lineUserId = u.lineUserId
        WHERE ub.lineUserId = ?
          AND b.minScore IS NOT NULL
          AND u.totalScore < b.minScore
        `,
        [lineUserId]
    );

    // 2) เน€เธเธดเนเธกเธเนเธฒเธข auto เธ—เธตเนเธเธฐเนเธเธเธ–เธถเธเน€เธเธ“เธ‘เน เนเธ•เนเธขเธฑเธเนเธกเนเธกเธตเนเธ user_badges
    await conn.query(
        `
        INSERT INTO user_badges (lineUserId, badgeId, earnedAt)
        SELECT 
            u.lineUserId,
            b.badgeId,
            NOW()
        FROM users u
        JOIN badges b
          ON b.minScore IS NOT NULL          -- เน€เธเธเธฒเธฐเธเนเธฒเธข auto
         AND u.totalScore >= b.minScore      -- เธเธฐเนเธเธเธ–เธถเธเน€เธเธ“เธ‘เน
        LEFT JOIN user_badges ub
          ON ub.lineUserId = u.lineUserId
         AND ub.badgeId   = b.badgeId        -- เธ–เนเธฒเธกเธตเธเนเธฒเธขเธเธตเนเธญเธขเธนเนเนเธฅเนเธงเธเธฐเน€เธเธญเนเธ ub
        WHERE u.lineUserId = ?
          AND ub.badgeId IS NULL;            -- เนเธ—เธฃเธเน€เธเธเธฒเธฐเธเนเธฒเธขเธ—เธตเนเธขเธฑเธเนเธกเนเธกเธต
        `,
        [lineUserId]
    );
}


// -----------------------------
//   LOCAL STATIC FOLDER
// -----------------------------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use('/uploads', express.static(uploadsDir));

// -----------------------------
//   Multer Memory Storage
// -----------------------------
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB limit
});

// -----------------------------
//   Cloudflare R2 Upload
// -----------------------------
const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_BASE_URL,
} = process.env;

// เธชเธฃเนเธฒเธ S3Client เธเธฃเธฑเนเธเน€เธ”เธตเธขเธงเนเธฅเนเธง reuse (เนเธกเนเธ•เนเธญเธเธชเธฃเนเธฒเธเนเธซเธกเนเธ—เธธเธ request)
const s3Client = (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)
    ? new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    })
    : null;

async function uploadToR2(buffer, mime = "image/jpeg") {
    if (!s3Client || !R2_BUCKET_NAME) {
        throw new Error("R2 config missing");
    }

    const ext = mime === "image/png" ? "png" : "jpg";
    const key = `safety-spot/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    await s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mime,
    }));

    return `${R2_PUBLIC_BASE_URL}/${key}`;
}

// -----------------------------
//   Admin Checker
// -----------------------------
const isAdmin = async (req, res, next) => {
    const requesterId = req.body.requesterId || req.query.requesterId;
    if (!requesterId) return res.status(401).json({ status: 'error', message: 'Missing requester' });

    try {
        const [rows] = await db.query(
            "SELECT lineUserId FROM admins WHERE lineUserId = ?",
            [requesterId]
        );

        if (rows.length === 0)
            return res.status(403).json({ status: "error", message: "Not admin" });

        next();
    } catch (err) {
        res.status(500).json({ status: "error", message: "Auth check failed" });
    }
};

// -----------------------------
//   R2 Upload API
// -----------------------------
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ status: 'error', message: "Missing file" });

        // MIME validation โ€” accept images only
        if (!req.file.mimetype.startsWith('image/')) {
            return res.status(400).json({ status: 'error', message: "เนเธเธฅเนเธ•เนเธญเธเน€เธเนเธเธฃเธนเธเธ เธฒเธเน€เธ—เนเธฒเธเธฑเนเธ" });
        }

        const { lineUserId } = req.body;
        if (!lineUserId) return res.status(400).json({ status: 'error', message: "เธ•เนเธญเธเธฃเธฐเธเธธ lineUserId" });

        const url = await uploadToR2(req.file.buffer, req.file.mimetype);

        res.json({ status: "success", data: { imageUrl: url } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// PART 2 โ€” USER / ACTIVITIES / LEADERBOARD
// ======================================================

// --- API: USER PROFILE (เธเธเธฑเธเนเธเน: เนเธเธงเน Streak 0 เธ–เนเธฒเธเธฒเธ”เธเนเธงเธ) ---
app.get('/api/user/profile', async (req, res) => {
    try {
        const { lineUserId } = req.query;
        if (!lineUserId) return res.json({ status: "success", data: { registered: false, user: null } });

        const [rows] = await db.query(`
            SELECT u.*, 
                   us.currentStreak,
                   us.lastPlayedDate,
                   us.recoverableStreak
            FROM users u
            LEFT JOIN user_streaks us ON u.lineUserId = us.lineUserId
            WHERE u.lineUserId = ?
        `, [lineUserId]);

        if (rows.length === 0) return res.json({ status: "success", data: { registered: false, user: null } });

        const user = rows[0];
        
        // โญ LOGIC: เธ–เนเธฒเนเธกเนเนเธ”เนเน€เธฅเนเธเธกเธฒเน€เธเธดเธ 1 เธงเธฑเธ เนเธซเนเนเธชเธ”เธเน€เธเนเธ 0 (Visual Reset)
        let displayStreak = 0;
        if (user.currentStreak && user.lastPlayedDate) {
            const todayStr = new Date().toISOString().split('T')[0];
            const lastStr = new Date(user.lastPlayedDate).toISOString().split('T')[0];
            const diffTime = new Date(todayStr) - new Date(lastStr);
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

            // เธ–เนเธฒเน€เธฅเนเธเธงเธฑเธเธเธตเน (0) เธซเธฃเธทเธญเน€เธกเธทเนเธญเธงเธฒเธ (1) -> เนเธเธงเนเน€เธฅเธเน€เธ”เธดเธก
            if (diffDays <= 1) {
                displayStreak = user.currentStreak;
            }
        }
        user.currentStreak = displayStreak;

        // เน€เธเนเธ Admin
        const [adminRows] = await db.query("SELECT * FROM admins WHERE lineUserId = ?", [lineUserId]);
        user.isAdmin = adminRows.length > 0;

        // Rank & Percentile
        const [[rankRow]] = await db.query(
            "SELECT COUNT(*) AS betterCount FROM users WHERE totalScore > ?",
            [user.totalScore]
        );
        const [[totalRow]] = await db.query("SELECT COUNT(*) AS total FROM users");
        user.userRank = rankRow.betterCount + 1;
        user.totalUsers = totalRow.total;
        user.percentile = totalRow.total > 1
            ? Math.round(100 - (rankRow.betterCount / totalRow.total) * 100)
            : 100;

        res.json({ status: "success", data: { registered: true, user } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// -----------------------------
//   USER REGISTER
// -----------------------------
app.post('/api/user/register', async (req, res) => {
    try {
        const { lineUserId, displayName, pictureUrl, fullName, employeeId, department } = req.body;

        const [exists] = await db.query(
            "SELECT * FROM users WHERE lineUserId = ? OR employeeId = ?",
            [lineUserId, employeeId]
        );

        if (exists.length > 0) {
            return res.status(400).json({
                status: "error",
                message: "LINE User ID เธซเธฃเธทเธญ Employee ID เธกเธตเธญเธขเธนเนเนเธฅเนเธง"
            });
        }

        await db.query(
            "INSERT INTO users (lineUserId, displayName, pictureUrl, fullName, employeeId, department, totalScore, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
            [lineUserId, displayName, pictureUrl, fullName, employeeId, department || '', 0]
        );

        // Welcome notification
        db.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'system_alert', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เธขเธดเธเธ”เธตเธ•เนเธญเธเธฃเธฑเธเธชเธนเน Safety Spot, ${fullName}! ๐ เน€เธฃเธดเนเธกเน€เธฅเนเธ Daily Quiz เธงเธฑเธเธเธตเนเน€เธเธทเนเธญเธชเธฐเธชเธกเน€เธซเธฃเธตเธขเธเนเธฅเธฐเธเธฐเนเธเธเนเธ”เนเน€เธฅเธข`, null, lineUserId]
        ).catch(() => {});

        res.json({
            status: "success",
            data: {
                lineUserId,
                displayName,
                pictureUrl,
                fullName,
                employeeId,
                department: department || '',
                totalScore: 0,
                isAdmin: false
            }
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// -----------------------------
//   REFRESH PROFILE
// -----------------------------
app.post('/api/user/refresh-profile', async (req, res) => {
    try {
        const { lineUserId, displayName, pictureUrl } = req.body;

        await db.query(
            "UPDATE users SET displayName = ?, pictureUrl = ? WHERE lineUserId = ?",
            [displayName, pictureUrl, lineUserId]
        );

        res.json({ status: "success", data: { updated: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// -----------------------------
//   UPDATE DEPARTMENT (user self-service)
// -----------------------------
app.post('/api/user/update-department', async (req, res) => {
    const { lineUserId, department } = req.body;
    if (!lineUserId || !department) {
        return res.status(400).json({ status: 'error', message: 'เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ' });
    }
    try {
        await db.query("UPDATE users SET department = ? WHERE lineUserId = ?", [department, lineUserId]);
        res.json({ status: 'success', data: { department } });
    } catch(e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// -----------------------------
//   ACTIVITIES LIST
// -----------------------------
// Public: Social Feed โ€” recent approved submissions
app.get('/api/social-feed', async (_req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT s.submissionId, s.createdAt,
                   u.fullName, u.pictureUrl, u.department,
                   a.title AS activityTitle
            FROM submissions s
            JOIN users u ON s.lineUserId = u.lineUserId
            JOIN activities a ON s.activityId = a.activityId
            WHERE s.status = 'approved'
            ORDER BY s.createdAt DESC
            LIMIT 10
        `);
        res.json({ status: "success", data: rows });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// Public: Department Leaderboard (top 10 by avg score)
app.get('/api/department-leaderboard', async (_req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT department,
                   COUNT(*) AS memberCount,
                   ROUND(AVG(totalScore), 1) AS avgScore,
                   SUM(totalScore) AS totalScore
            FROM users
            WHERE department != ''
            GROUP BY department
            ORDER BY avgScore DESC
            LIMIT 10
        `);
        res.json({ status: "success", data: rows });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

app.get('/api/activities', async (req, res) => {
    try {
        const { lineUserId } = req.query;

        const [activities] = await db.query(
            "SELECT * FROM activities WHERE status = 'active' ORDER BY createdAt DESC"
        );

        if (!lineUserId) {
            return res.json({ status: "success", data: activities });
        }

        const [submitted] = await db.query(
            "SELECT activityId FROM submissions WHERE lineUserId = ? AND status IN ('pending','approved')",
            [lineUserId]
        );

        // เธเธณเธเธงเธเธเธเธชเนเธเธฃเธฒเธขเธเธฒเธเนเธ•เนเธฅเธฐเธเธดเธเธเธฃเธฃเธก
        const [counts] = await db.query(
            "SELECT activityId, COUNT(*) AS submissionCount FROM submissions WHERE status IN ('pending','approved') GROUP BY activityId"
        );
        const countMap = Object.fromEntries(counts.map(c => [c.activityId, c.submissionCount]));

        const submittedIds = new Set(submitted.map(a => a.activityId));

        const result = activities.map(a => ({
            ...a,
            userHasSubmitted: submittedIds.has(a.activityId),
            submissionCount: countMap[a.activityId] || 0
        }));

        res.json({ status: "success", data: result });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// -----------------------------
//   LEADERBOARD
// -----------------------------
app.get('/api/leaderboard', async (req, res) => {
    try {
        const limit = 30;
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;

        const [rows] = await db.query(
            "SELECT lineUserId, fullName, pictureUrl, totalScore FROM users ORDER BY totalScore DESC, fullName ASC LIMIT ? OFFSET ?",
            [limit, offset]
        );

        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// USER BADGES (frontend เธ•เนเธญเธเนเธเน endpoint เธเธตเน)
// ======================================================
app.get('/api/user/badges', async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [allBadges] = await db.query(
            "SELECT badgeId, badgeName, description, imageUrl FROM badges"
        );

        const [earned] = await db.query(
            "SELECT badgeId FROM user_badges WHERE lineUserId = ?",
            [lineUserId]
        );

        const earnedSet = new Set(earned.map(x => x.badgeId));

        const result = allBadges.map(b => ({
            id: b.badgeId,
            name: b.badgeName,
            desc: b.description,
            img: b.imageUrl || "https://placehold.co/200x200?text=Badge",
            isEarned: earnedSet.has(b.badgeId)
        }));

        res.json({ status: "success", data: result });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});


// ======================================================
// PART 3 โ€” SUBMISSIONS / LIKE / COMMENT
// ======================================================

// -----------------------------
//   GET SUBMISSIONS (with likes + comments)
// -----------------------------
app.get('/api/submissions', async (req, res) => {
    try {
        const { activityId, lineUserId } = req.query;

        const sql = `
        SELECT 
            s.submissionId, s.description, s.imageUrl, s.createdAt, s.points,
            u.fullName AS submitterFullName, u.pictureUrl AS submitterPictureUrl,
            (SELECT COUNT(*) FROM likes WHERE submissionId = s.submissionId) AS likes
        FROM submissions s
        JOIN users u ON s.lineUserId = u.lineUserId
        WHERE s.activityId = ?
          AND s.status IN ('approved','pending')
        ORDER BY s.createdAt DESC
        `;

        const [rows] = await db.query(sql, [activityId]);

        // เน€เธเนเธเธงเนเธฒ user เธเธ”เนเธฅเธเนเนเธเธชเธ•เนเนเธซเธเธเนเธฒเธ
        const [likedRows] = await db.query(
            "SELECT submissionId FROM likes WHERE lineUserId = ?",
            [lineUserId]
        );

        const likedSet = new Set(likedRows.map(l => l.submissionId));

        // เธเธญเธกเน€เธกเธเธ•เนเธ—เธฑเนเธเธซเธกเธ”เธเธญเธ submission เน€เธซเธฅเนเธฒเธเธตเน
        const ids = rows.map(r => r.submissionId);
        let commentsMap = {};

        if (ids.length > 0) {
            const [comments] = await db.query(`
                SELECT 
                    c.submissionId, c.commentText,
                    u.fullName AS commenterFullName,
                    u.pictureUrl AS commenterPictureUrl
                FROM comments c
                JOIN users u ON c.lineUserId = u.lineUserId
                WHERE c.submissionId IN (?)
                ORDER BY c.createdAt ASC
            `, [ids]);

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

        // Fetch reactions
        let reactionsMap = {};
        let userReactionsSet = new Set();
        if (ids.length > 0) {
            const [reactions] = await db.query(
                `SELECT submissionId, emoji, COUNT(*) AS cnt FROM submission_reactions WHERE submissionId IN (?) GROUP BY submissionId, emoji`,
                [ids]
            );
            reactions.forEach(r => {
                if (!reactionsMap[r.submissionId]) reactionsMap[r.submissionId] = {};
                reactionsMap[r.submissionId][r.emoji] = Number(r.cnt);
            });
            const [userReacts] = await db.query(
                `SELECT submissionId, emoji FROM submission_reactions WHERE lineUserId = ? AND submissionId IN (?)`,
                [lineUserId, ids]
            );
            userReacts.forEach(r => userReactionsSet.add(`${r.submissionId}:${r.emoji}`));
        }

        // เธฃเธงเธกเธเธฅเธฅเธฑเธเธเน
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
            didLike: likedSet.has(sub.submissionId),
            comments: commentsMap[sub.submissionId] || [],
            reactions: reactionsMap[sub.submissionId] || {},
            myReactions: ['๐‘','๐”ฅ','๐’ช'].filter(e => userReactionsSet.has(`${sub.submissionId}:${e}`))
        }));

        res.json({ status: "success", data: result });
    } catch (err) {
        console.error("/api/submissions error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
});

// -----------------------------
//   CREATE SUBMISSION
// -----------------------------
app.post('/api/submissions', async (req, res) => {
    const { activityId, lineUserId, description, imageUrl } = req.body;

    try {
        const normalized = description.trim();
        if (!normalized)
            return res.status(400).json({
                status: "error",
                message: "เธเธฃเธธเธ“เธฒเธเธฃเธญเธเธฃเธฒเธขเธฅเธฐเน€เธญเธตเธขเธ”เธเธญเธเธฃเธฒเธขเธเธฒเธ"
            });

        // Prevent similar spam
        const [recent] = await db.query(
            "SELECT description FROM submissions WHERE activityId = ? ORDER BY createdAt DESC LIMIT 20",
            [activityId]
        );

        for (const r of recent) {
            if (distance(normalized, r.description) < 5) {
                return res.status(400).json({
                    status: "error",
                    message: "เน€เธเธทเนเธญเธซเธฒเธฃเธฒเธขเธเธฒเธเธเธฅเนเธฒเธขเธเธฑเธเธฃเธฒเธขเธเธฒเธเธ—เธตเนเธกเธตเธญเธขเธนเนเนเธฅเนเธง"
                });
            }
        }

        // Prevent duplicate submission
        const [exists] = await db.query(
            "SELECT submissionId FROM submissions WHERE activityId = ? AND lineUserId = ? AND status IN ('pending','approved')",
            [activityId, lineUserId]
        );

        if (exists.length > 0) {
            return res.status(400).json({
                status: "error",
                message: "เธเธธเธ“เน€เธเธขเธชเนเธเธฃเธฒเธขเธเธฒเธเธเธดเธเธเธฃเธฃเธกเธเธตเนเนเธเนเธฅเนเธง"
            });
        }

        // Insert submission
        const [[activity]] = await db.query("SELECT title FROM activities WHERE activityId = ?", [activityId]);
        const activityTitle = activity ? activity.title : 'เธเธดเธเธเธฃเธฃเธก';

        await db.query(
            `INSERT INTO submissions
             (submissionId, activityId, lineUserId, description, imageUrl, status, createdAt)
             VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
            ["SUB" + uuidv4(), activityId, lineUserId, normalized, imageUrl]
        );

        // เนเธเนเธเน€เธ•เธทเธญเธเธ•เธฑเธงเน€เธญเธ โ€” เธฃเธฒเธขเธเธฒเธเธฃเธญเธญเธเธธเธกเธฑเธ•เธด
        db.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'submission', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เธฃเธฒเธขเธเธฒเธ "${activityTitle}" เธเธญเธเธเธธเธ“เธญเธขเธนเนเธฃเธฐเธซเธงเนเธฒเธเธฃเธญเธเธฒเธฃเธเธดเธเธฒเธฃเธ“เธฒเธเธฒเธเนเธญเธ”เธกเธดเธ`, activityId, lineUserId]
        ).catch(() => {});

        res.json({ status: "success", data: { message: "Submission created." } });
    } catch (err) {
        console.error("POST /api/submissions:", err);
        res.status(500).json({ status: "error", message: err.message });
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

        const [exists] = await client.query(
            "SELECT likeId FROM likes WHERE submissionId = ? AND lineUserId = ?",
            [submissionId, lineUserId]
        );

        if (exists.length > 0) {
            // Unlike
            await client.query(
                "DELETE FROM likes WHERE likeId = ?",
                [exists[0].likeId]
            );
        } else {
            // Like
            await client.query(
                "INSERT INTO likes (likeId, submissionId, lineUserId, createdAt) VALUES (?, ?, ?, NOW())",
                ["LIKE" + uuidv4(), submissionId, lineUserId]
            );

            // Owner
            const [sub] = await client.query(
                "SELECT lineUserId FROM submissions WHERE submissionId = ?",
                [submissionId]
            );

            if (sub.length > 0) {
                const ownerId = sub[0].lineUserId;

                if (ownerId !== lineUserId) {
                    // Check if already notified
                    const [notif] = await client.query(
                        `SELECT notificationId 
                         FROM notifications 
                         WHERE type = 'like'
                           AND relatedItemId = ?
                           AND triggeringUserId = ?`,
                        [submissionId, lineUserId]
                    );

                    if (notif.length === 0) {
                        // Add +1 score
                        await client.query(
                            "UPDATE users SET totalScore = totalScore + 1 WHERE lineUserId = ?",
                            [ownerId]
                        );

                        const [u] = await client.query(
                            "SELECT fullName FROM users WHERE lineUserId = ?",
                            [lineUserId]
                        );

                        await client.query(
                            `INSERT INTO notifications 
                            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
                             VALUES (?, ?, ?, 'like', ?, ?, NOW())`,
                            [
                                "NOTIF" + uuidv4(),
                                ownerId,
                                `${u[0].fullName} เนเธ”เนเธเธ”เนเธฅเธเนเธฃเธฒเธขเธเธฒเธเธเธญเธเธเธธเธ“`,
                                submissionId,
                                lineUserId
                            ]
                        );
                    }
                }
            }
        }

        const [count] = await client.query(
            "SELECT COUNT(*) AS count FROM likes WHERE submissionId = ?",
            [submissionId]
        );

        await client.commit();

        res.json({
            status: "success",
            data: {
                liked: exists.length === 0,
                newLikeCount: count[0].count
            }
        });
    } catch (err) {
        await client.rollback();
        console.error("/api/submissions/like error:", err);
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        client.release();
    }
});

// --- REACT ---
app.post('/api/submissions/react', async (req, res) => {
    const { submissionId, lineUserId, emoji } = req.body;
    const ALLOWED = ['๐‘', '๐”ฅ', '๐’ช'];
    if (!submissionId || !lineUserId || !ALLOWED.includes(emoji)) {
        return res.status(400).json({ status: 'error', message: 'เธเนเธญเธกเธนเธฅเนเธกเนเธ–เธนเธเธ•เนเธญเธ' });
    }
    try {
        // Toggle: try insert, if dup then delete
        const [existing] = await db.query(
            'SELECT id FROM submission_reactions WHERE submissionId = ? AND lineUserId = ? AND emoji = ?',
            [submissionId, lineUserId, emoji]
        );
        let reacted;
        if (existing.length > 0) {
            await db.query('DELETE FROM submission_reactions WHERE submissionId = ? AND lineUserId = ? AND emoji = ?', [submissionId, lineUserId, emoji]);
            reacted = false;
        } else {
            await db.query('INSERT INTO submission_reactions (submissionId, lineUserId, emoji) VALUES (?, ?, ?)', [submissionId, lineUserId, emoji]);
            reacted = true;
        }
        const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM submission_reactions WHERE submissionId = ? AND emoji = ?', [submissionId, emoji]);
        res.json({ status: 'success', data: { reacted, newCount: Number(cnt), emoji } });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// -----------------------------
//   COMMENT
// -----------------------------
app.post('/api/submissions/comment', async (req, res) => {
    const { submissionId, lineUserId, commentText } = req.body;

    if (!commentText || !commentText.trim()) {
        return res.status(400).json({
            status: "error",
            message: "Comment cannot be empty."
        });
    }

    const client = await db.getClient();
    try {
        await client.beginTransaction();

        const commentId = "CMT" + uuidv4();
        await client.query(
            `INSERT INTO comments (commentId, submissionId, lineUserId, commentText, createdAt)
             VALUES (?, ?, ?, ?, NOW())`,
            [commentId, submissionId, lineUserId, commentText.trim()]
        );

        const [sub] = await client.query(
            "SELECT lineUserId FROM submissions WHERE submissionId = ?",
            [submissionId]
        );

        if (sub.length > 0) {
            const ownerId = sub[0].lineUserId;

            if (ownerId !== lineUserId) {
                // Count comments
                const [count] = await client.query(
                    `SELECT COUNT(*) AS count
                     FROM comments
                     WHERE submissionId = ?
                       AND lineUserId = ?`,
                    [submissionId, lineUserId]
                );

                // First comment = reward
                if (count[0].count === 1) {
                    await client.query(
                        "UPDATE users SET totalScore = totalScore + 1 WHERE lineUserId = ?",
                        [ownerId]
                    );

                    const [u] = await client.query(
                        "SELECT fullName FROM users WHERE lineUserId = ?",
                        [lineUserId]
                    );

                    await client.query(
                        `INSERT INTO notifications 
                        (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
                         VALUES (?, ?, ?, 'comment', ?, ?, NOW())`,
                        [
                            "NOTIF" + uuidv4(),
                            ownerId,
                            `${u[0].fullName} เนเธ”เนเนเธชเธ”เธเธเธงเธฒเธกเธเธดเธ”เน€เธซเนเธเธเธเธฃเธฒเธขเธเธฒเธเธเธญเธเธเธธเธ“`,
                            submissionId,
                            lineUserId
                        ]
                    );
                }
            }
        }

        const [newComment] = await client.query(
            `SELECT c.commentText, u.fullName, u.pictureUrl
             FROM comments c
             JOIN users u ON c.lineUserId = u.lineUserId
             WHERE c.commentId = ?`,
            [commentId]
        );

        await client.commit();

        res.json({
            status: "success",
            data: {
                commentText: newComment[0].commentText,
                commenter: {
                    fullName: newComment[0].fullName,
                    pictureUrl: newComment[0].pictureUrl
                }
            }
        });
    } catch (err) {
        await client.rollback();
        console.error("/api/submissions/comment error:", err);
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        client.release();
    }
});

// ======================================================
// PART 3.5 โ€” GAME API (Safety Card Gacha)
// ======================================================

// 1. เธ”เธถเธเธเธณเธ–เธฒเธกเธเธฃเธฐเธเธณเธงเธฑเธ (เธชเธธเนเธกเธกเธฒ 1 เธเนเธญ เธ—เธตเนเธขเธฑเธเนเธกเนเน€เธเธขเธ•เธญเธเนเธเธงเธฑเธเธเธตเน)
app.get('/api/game/daily-question', async (req, res) => {
    const { lineUserId } = req.query;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    try {
        // เน€เธเนเธเธงเนเธฒเธงเธฑเธเธเธตเนเน€เธฅเนเธเนเธเธซเธฃเธทเธญเธขเธฑเธ
        const [history] = await db.query(
            "SELECT historyId FROM user_game_history WHERE lineUserId = ? AND playedAt = ?",
            [lineUserId, today]
        );

        if (history.length > 0) {
            return res.json({ status: "success", data: { played: true } });
        }

        // เธชเธธเนเธกเธเธณเธ–เธฒเธกเธกเธฒ 1 เธเนเธญ
        const [questions] = await db.query(
            "SELECT * FROM kyt_questions WHERE isActive = TRUE ORDER BY RAND() LIMIT 1"
        );

        if (questions.length === 0) {
            return res.json({ status: "error", message: "เนเธกเนเธเธเธเธณเธ–เธฒเธกเนเธเธฃเธฐเธเธ" });
        }

        const q = questions[0];
        res.json({
            status: "success",
            data: {
                played: false,
                question: {
                    questionId: q.questionId,
                    text: q.questionText,
                    image: q.imageUrl,
                    options: {
                        A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD,
                        E: q.optionE, F: q.optionF, G: q.optionG, H: q.optionH
                    }
                }
            }
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// --- API: เธชเนเธเธเธณเธ•เธญเธ (v1) ---
app.post('/api/game/submit-answer', async (req, res) => {
    const { lineUserId, questionId, selectedOption } = req.body;

    // Input validation
    if (!lineUserId || !questionId || !selectedOption) {
        return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ (lineUserId, questionId, selectedOption)" });
    }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เธ•เธฃเธงเธเธเธณเธ•เธญเธ
        const [qs] = await conn.query("SELECT * FROM kyt_questions WHERE questionId = ?", [questionId]);
        if (qs.length === 0) throw new Error("เธเธณเธ–เธฒเธกเนเธกเนเธ–เธนเธเธ•เนเธญเธ");

        const question = qs[0];
        const isCorrect = (selectedOption === question.correctOption);

        // 2. เธเธณเธซเธเธ”เธฃเธฒเธเธงเธฑเธฅ
        let earnedCoins = isCorrect ? 50 : 10;
        let earnedScore = isCorrect ? question.scoreReward : 2;

        // 3. เธฃเธฐเธเธ Streak
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        let currentStreak = 1;

        if (streakRow.length > 0) {
            const lastDate = new Date(streakRow[0].lastPlayedDate);
            const diffTime = Math.abs(new Date(today) - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 1) currentStreak = streakRow[0].currentStreak + 1;
            else if (diffDays > 1) currentStreak = 1;
            else currentStreak = streakRow[0].currentStreak;

            await conn.query("UPDATE user_streaks SET currentStreak = ?, lastPlayedDate = ? WHERE lineUserId = ?", [currentStreak, today, lineUserId]);
        } else {
            await conn.query("INSERT INTO user_streaks VALUES (?, 1, ?, 1)", [lineUserId, today]);
        }

        // 4. เธเธฑเธเธ—เธถเธเธเธฃเธฐเธงเธฑเธ•เธด โ€” UNIQUE(lineUserId, playedAt) เธเนเธญเธเธเธฑเธ race condition
        try {
            await conn.query(
                "INSERT INTO user_game_history (lineUserId, questionId, isCorrect, earnedPoints, playedAt) VALUES (?, ?, ?, ?, ?)",
                [lineUserId, questionId, isCorrect, earnedCoins, today]
            );
        } catch (insertErr) {
            if (insertErr.code === 'ER_DUP_ENTRY') {
                throw new Error("เธเธธเธ“เน€เธฅเนเธเน€เธเธกเธเธญเธเธงเธฑเธเธเธตเนเนเธเนเธฅเนเธง");
            }
            throw insertErr;
        }

        // 5. เธญเธฑเธเน€เธ”เธ• User
        await conn.query(
            "UPDATE users SET totalScore = totalScore + ?, coinBalance = coinBalance + ? WHERE lineUserId = ?",
            [earnedScore, earnedCoins, lineUserId]
        );

        // 6. เธ”เธถเธเธขเธญเธ”เธฅเนเธฒเธชเธธเธ”
        const [[updatedUser]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);

        // 7. เนเธเนเธเน€เธ•เธทเธญเธ
        const notifMsg = isCorrect
            ? `เธ เธฒเธฃเธเธดเธเธชเธณเน€เธฃเนเธ! เธเธธเธ“เนเธ”เนเธฃเธฑเธ ${earnedCoins} เน€เธซเธฃเธตเธขเธเธเธฒเธเธเธฒเธฃเธ•เธญเธเธเธณเธ–เธฒเธกเธเธฃเธฐเธเธณเธงเธฑเธ`
            : `เธ•เธญเธเธเธดเธ”เธฃเธฑเธเธฃเธฒเธเธงเธฑเธฅเธเธฅเธญเธเนเธ ${earnedCoins} เน€เธซเธฃเธตเธขเธ`;

        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'game_quiz', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, notifMsg, questionId, lineUserId]
        );

        await conn.commit();

        res.json({
            status: "success",
            data: {
                isCorrect,
                earnedCoins,
                currentStreak,
                correctOption: question.correctOption,
                newCoinBalance: updatedUser.coinBalance,
                newTotalScore: updatedUser.totalScore
            }
        });

    } catch (e) {
        await conn.rollback();
        res.status(e.message === "เธเธธเธ“เน€เธฅเนเธเน€เธเธกเธเธญเธเธงเธฑเธเธเธตเนเนเธเนเธฅเนเธง" ? 400 : 500).json({ status: "error", message: e.message });
    } finally {
        conn.release();
    }
});

// ======================================================
// PART 3.6 โ€” ADMIN: Manage Game Questions
// ======================================================

// 1. เธ”เธถเธเธเธณเธ–เธฒเธกเธ—เธฑเนเธเธซเธกเธ” (Admin View)
app.get('/api/admin/questions', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM kyt_questions ORDER BY questionId DESC");
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 2. เน€เธเธดเนเธก/เนเธเนเนเธ เธเธณเธ–เธฒเธก
app.post('/api/admin/questions', isAdmin, async (req, res) => {
    // เธฃเธฑเธ option A-H
    const { questionId, questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, imageUrl, scoreReward } = req.body;

    try {
        if (questionId) {
            // Update
            await db.query(
                `UPDATE kyt_questions 
                 SET questionText=?, optionA=?, optionB=?, optionC=?, optionD=?, optionE=?, optionF=?, optionG=?, optionH=?, correctOption=?, imageUrl=?, scoreReward=? 
                 WHERE questionId=?`,
                [questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, imageUrl, scoreReward || 10, questionId]
            );
            res.json({ status: "success", data: { message: "Updated" } });
        } else {
            // Create
            await db.query(
                `INSERT INTO kyt_questions (questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, imageUrl, scoreReward, isActive)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
                [questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, imageUrl, scoreReward || 10]
            );
            res.json({ status: "success", data: { message: "Created" } });
        }
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 3. เธฅเธเธเธณเธ–เธฒเธก
app.delete('/api/admin/questions/:id', isAdmin, async (req, res) => {
    try {
        await db.query("DELETE FROM kyt_questions WHERE questionId = ?", [req.params.id]);
        res.json({ status: "success", data: { deleted: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 4. เน€เธเธดเธ”/เธเธดเธ” เธเธณเธ–เธฒเธก (Toggle Active)
app.post('/api/admin/questions/toggle', isAdmin, async (req, res) => {
    try {
        const { questionId } = req.body;
        // เน€เธเนเธเธชเธ–เธฒเธเธฐเธเธฑเธเธเธธเธเธฑเธเธเนเธญเธ
        const [rows] = await db.query("SELECT isActive FROM kyt_questions WHERE questionId = ?", [questionId]);
        if (rows.length === 0) return res.status(404).json({status:"error"});

        const newStatus = !rows[0].isActive;
        await db.query("UPDATE kyt_questions SET isActive = ? WHERE questionId = ?", [newStatus, questionId]);
        
        res.json({ status: "success", data: { isActive: newStatus } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// PART 3.7 โ€” ADMIN: Manage Safety Cards
// ======================================================

// 1. เธ”เธถเธเธเธฒเธฃเนเธ”เธ—เธฑเนเธเธซเธกเธ” (เธชเธณเธซเธฃเธฑเธ Admin)
app.get('/api/admin/cards', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM safety_cards ORDER BY createdAt DESC");
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 2. เน€เธเธดเนเธก/เนเธเนเนเธ เธเธฒเธฃเนเธ”
app.post('/api/admin/cards', isAdmin, async (req, res) => {
    const { cardId, cardName, description, imageUrl, rarity } = req.body;

    try {
        if (cardId) {
            // Update
            await db.query(
                "UPDATE safety_cards SET cardName=?, description=?, imageUrl=?, rarity=? WHERE cardId=?",
                [cardName, description, imageUrl, rarity, cardId]
            );
            res.json({ status: "success", data: { message: "Updated" } });
        } else {
            // Create
            // เธชเธฃเนเธฒเธ ID เนเธเธเธเนเธฒเธขเน (เธซเธฃเธทเธญเธเธฐเนเธเน UUID เธเนเนเธ”เน)
            const newId = "CARD_" + Date.now(); 
            await db.query(
                "INSERT INTO safety_cards (cardId, cardName, description, imageUrl, rarity) VALUES (?, ?, ?, ?, ?)",
                [newId, cardName, description, imageUrl, rarity]
            );
            res.json({ status: "success", data: { message: "Created" } });
        }
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 3. เธฅเธเธเธฒเธฃเนเธ”
app.delete('/api/admin/cards/:id', isAdmin, async (req, res) => {
    try {
        // เธฅเธเธเนเธญเธกเธนเธฅเธเธฒเธฃเธเธฃเธญเธเธเธฃเธญเธเธเธญเธเธเธนเนเน€เธฅเนเธเธเนเธญเธ (เน€เธเธทเนเธญเนเธกเนเนเธซเนเธ•เธดเธ” Foreign Key)
        await db.query("DELETE FROM user_cards WHERE cardId = ?", [req.params.id]);
        
        // เธฅเธเธ•เธฑเธงเธเธฒเธฃเนเธ”
        await db.query("DELETE FROM safety_cards WHERE cardId = ?", [req.params.id]);
        
        res.json({ status: "success", data: { deleted: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// PART 4 โ€” ADMIN PANEL / NOTIFICATIONS / SERVER START
// ======================================================

// ======================================================
// ADMIN: Overall Stats
// ======================================================
app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const [users] = await db.query("SELECT COUNT(*) AS count FROM users");
        const [subs] = await db.query("SELECT COUNT(*) AS count FROM submissions");
        const [today] = await db.query(
            "SELECT COUNT(*) AS count FROM submissions WHERE DATE(createdAt) = CURDATE()"
        );
        const [top] = await db.query(`
            SELECT a.title, COUNT(s.submissionId) AS total
            FROM submissions s
            JOIN activities a ON s.activityId = a.activityId
            GROUP BY s.activityId
            ORDER BY total DESC
            LIMIT 1
        `);

        res.json({
            status: "success",
            data: {
                totalUsers: users[0].count,
                totalSubmissions: subs[0].count,
                submissionsToday: today[0].count,
                mostReportedActivity: top.length > 0 ? top[0].title : "N/A"
            }
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Dashboard Overview
// ======================================================
app.get('/api/admin/dashboard-stats', isAdmin, async (req, res) => {
    try {
        const [pending]       = await db.query("SELECT COUNT(*) AS count FROM submissions WHERE status = 'pending'");
        const [users]         = await db.query("SELECT COUNT(*) AS count FROM users");
        const [acts]          = await db.query("SELECT COUNT(*) AS count FROM activities WHERE status = 'active'");
        const [approvedToday] = await db.query("SELECT COUNT(*) AS count FROM submissions WHERE status = 'approved' AND DATE(reviewedAt) = CURDATE()");
        const [quizToday]     = await db.query("SELECT COUNT(*) AS count FROM user_game_history WHERE DATE(playedAt) = CURDATE()");
        const [atRisk]        = await db.query("SELECT COUNT(*) AS count FROM user_streaks WHERE currentStreak > 0 AND DATE(lastPlayedDate) = CURDATE() - INTERVAL 1 DAY");

        res.json({
            status: "success",
            data: {
                pendingCount: pending[0].count,
                userCount: users[0].count,
                activeActivitiesCount: acts[0].count,
                approvedToday: approvedToday[0].count,
                quizTodayCount: quizToday[0].count,
                atRiskCount: atRisk[0].count
            }
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Chart Data (7 days)
// ======================================================
app.get('/api/admin/chart-data', isAdmin, async (req, res) => {
    try {
        const query = `
            WITH RECURSIVE days AS (
                SELECT CURDATE() - INTERVAL 6 DAY AS d
                UNION ALL
                SELECT d + INTERVAL 1 DAY FROM days WHERE d < CURDATE()
            )
            SELECT
                DATE_FORMAT(days.d, '%Y-%m-%d') AS day,
                COUNT(s.submissionId) AS count
            FROM days
            LEFT JOIN submissions s ON DATE(s.createdAt) = days.d
            GROUP BY days.d
            ORDER BY days.d
        `;
        const [rows] = await db.query(query);

        res.json({
            status: "success",
            data: {
                labels: rows.map(r => r.day),
                data: rows.map(r => r.count)
            }
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Submissions Pending
// ======================================================
app.get('/api/admin/submissions/pending', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT s.*, u.fullName, u.pictureUrl
            FROM submissions s
            JOIN users u ON s.lineUserId = u.lineUserId
            WHERE s.status = 'pending'
            ORDER BY s.createdAt ASC
        `);

        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Approve Submission
// ======================================================
app.post('/api/admin/submissions/approve', isAdmin, async (req, res) => {
    const { submissionId, score, requesterId } = req.body;

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // เธซเธฒเธงเนเธฒเธฃเธฒเธขเธเธฒเธเธเธตเนเน€เธเนเธเธเธญเธเนเธเธฃ + เน€เธเนเธเธชเธ–เธฒเธเธฐ (idempotency)
        const [sub] = await conn.query(
            "SELECT lineUserId, status FROM submissions WHERE submissionId = ?",
            [submissionId]
        );
        if (sub.length === 0) throw new Error("Submission not found");
        if (sub[0].status === 'approved') throw new Error("เธฃเธฒเธขเธเธฒเธเธเธตเนเธ–เธนเธ approve เนเธเนเธฅเนเธง");

        const ownerId = sub[0].lineUserId;

        // เธญเธฑเธเน€เธ”เธ•เธชเธ–เธฒเธเธฐ + เนเธซเนเธเธฐเนเธเธเนเธเธ•เธฒเธฃเธฒเธ submissions
        await conn.query(
            "UPDATE submissions SET status = 'approved', points = ? WHERE submissionId = ?",
            [score, submissionId]
        );

        // เน€เธเธดเนเธกเธเธฐเนเธเธเนเธซเน user
        await conn.query(
            "UPDATE users SET totalScore = totalScore + ? WHERE lineUserId = ?",
            [score, ownerId]
        );

        // เนเธเนเธเน€เธ•เธทเธญเธ
        await conn.query(`
            INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
            VALUES (?, ?, ?, 'approved', ?, ?, NOW())
        `, [
            "NOTIF" + uuidv4(),
            ownerId,
            `เธฃเธฒเธขเธเธฒเธเธเธญเธเธเธธเธ“เนเธ”เนเธฃเธฑเธเธเธฒเธฃเธญเธเธธเธกเธฑเธ•เธด (${score} เธเธฐเนเธเธ)`,
            submissionId,
            requesterId
        ]);

        // ๐”ฅ เน€เธฃเธตเธขเธ autoAwardBadgesForUser เธ เธฒเธขเนเธ•เน transaction เน€เธ”เธตเธขเธงเธเธฑเธ
        await autoAwardBadgesForUser(ownerId, conn);

        await conn.commit();
        logAdminAction(requesterId, 'APPROVE_SUBMISSION', 'submission', String(submissionId), `Submission #${submissionId}`, { score, ownerId });
        res.json({ status: "success", data: { message: "Approved." } });
    } catch (err) {
        await conn.rollback();
        console.error("/api/admin/submissions/approve error:", err);
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        conn.release();
    }
});


// ======================================================
// ADMIN: Reject Submission
// ======================================================
app.post('/api/admin/submissions/reject', isAdmin, async (req, res) => {
    const { submissionId, requesterId } = req.body;

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        const [sub] = await conn.query(
            "SELECT lineUserId FROM submissions WHERE submissionId = ?",
            [submissionId]
        );
        if (sub.length === 0) throw new Error("Submission not found");

        const ownerId = sub[0].lineUserId;

        await conn.query(
            "UPDATE submissions SET status = 'rejected' WHERE submissionId = ?",
            [submissionId]
        );

        await conn.query(`
            INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
            VALUES (?, ?, ?, 'rejected', ?, ?, NOW())
        `, [
            "NOTIF" + uuidv4(),
            ownerId,
            `เธเนเธฒเน€เธชเธตเธขเธ”เธฒเธข เธฃเธฒเธขเธเธฒเธเธเธญเธเธเธธเธ“เนเธกเนเธเนเธฒเธเธเธฒเธฃเธ•เธฃเธงเธเธชเธญเธ`,
            submissionId,
            requesterId
        ]);

        await conn.commit();
        logAdminAction(requesterId, 'REJECT_SUBMISSION', 'submission', String(submissionId), `Submission #${submissionId}`, { ownerId });
        res.json({ status: "success", data: { message: "Rejected." } });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        conn.release();
    }
});

// --- BULK APPROVE ---
app.post('/api/admin/submissions/bulk-approve', isAdmin, async (req, res) => {
    const { submissionIds, scores, requesterId } = req.body;
    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
        return res.status(400).json({ status: 'error', message: 'เนเธกเนเธกเธตเธฃเธฒเธขเธเธฒเธฃเธ—เธตเนเน€เธฅเธทเธญเธ' });
    }
    const conn = await db.getClient();
    let approved = 0;
    let skipped = 0;
    try {
        await conn.beginTransaction();
        for (const submissionId of submissionIds) {
            const [[sub]] = await conn.query(
                'SELECT lineUserId, status FROM submissions WHERE submissionId = ?', [submissionId]
            );
            if (!sub || sub.status !== 'pending') { skipped++; continue; }
            // เธฃเธญเธเธฃเธฑเธ scores map {submissionId: score} เธซเธฃเธทเธญ fallback เน€เธเนเธ 10
            const pts = Math.max(0, Number((scores && scores[submissionId]) ?? 10));
            await conn.query(
                "UPDATE submissions SET status = 'approved', points = ?, reviewedAt = NOW() WHERE submissionId = ?",
                [pts, submissionId]
            );
            await conn.query(
                "UPDATE users SET totalScore = totalScore + ? WHERE lineUserId = ?",
                [pts, sub.lineUserId]
            );
            await conn.query(
                `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
                 VALUES (?, ?, ?, 'approved', ?, ?, NOW())`,
                ["NOTIF" + uuidv4(), sub.lineUserId,
                 `เธฃเธฒเธขเธเธฒเธเธเธญเธเธเธธเธ“เนเธ”เนเธฃเธฑเธเธเธฒเธฃเธญเธเธธเธกเธฑเธ•เธด! เธเธธเธ“เนเธ”เนเธฃเธฑเธ ${pts} เธเธฐเนเธเธ ๐`, submissionId, requesterId]
            );
            logAdminAction(requesterId, 'APPROVE_SUBMISSION', 'submission', submissionId, `Submission #${submissionId}`, { score: pts, ownerId: sub.lineUserId });
            approved++;
        }
        await conn.commit();
        res.json({ status: 'success', data: { approved, skipped } });
    } catch (e) {
        await conn.rollback();
        res.status(500).json({ status: 'error', message: e.message });
    } finally { conn.release(); }
});

// ======================================================
// ADMIN: Delete Submission
// ======================================================
app.delete('/api/admin/submissions/:submissionId', isAdmin, async (req, res) => {
    const requesterId = req.query.requesterId;
    try {
        // เธ”เธถเธเธเนเธญเธกเธนเธฅเน€เธเนเธฒเธเธญเธเธเนเธญเธเธฅเธ
        const [[sub]] = await db.query(
            `SELECT s.lineUserId, a.title FROM submissions s
             LEFT JOIN activities a ON s.activityId = a.activityId
             WHERE s.submissionId = ?`, [req.params.submissionId]
        );
        await db.query("DELETE FROM likes WHERE submissionId = ?", [req.params.submissionId]);
        await db.query("DELETE FROM comments WHERE submissionId = ?", [req.params.submissionId]);
        await db.query("DELETE FROM submissions WHERE submissionId = ?", [req.params.submissionId]);
        logAdminAction(requesterId, 'DELETE_SUBMISSION', 'submission', req.params.submissionId, `Submission #${req.params.submissionId}`, {});
        // เนเธเนเธเน€เธเนเธฒเธเธญเธ
        if (sub) {
            db.query(
                `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
                 VALUES (?, ?, ?, 'system_alert', ?, ?, NOW())`,
                ["NOTIF" + uuidv4(), sub.lineUserId, `เธฃเธฒเธขเธเธฒเธ "${sub.title || 'เธเธดเธเธเธฃเธฃเธก'}" เธเธญเธเธเธธเธ“เธ–เธนเธเธฅเธเนเธ”เธขเนเธญเธ”เธกเธดเธ`, req.params.submissionId, requesterId]
            ).catch(() => {});
        }
        res.json({ status: "success", data: { removed: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Activities
// ======================================================
app.get('/api/admin/activities', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM activities ORDER BY createdAt DESC");
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.post('/api/admin/activities', isAdmin, async (req, res) => {
    const { title, description, imageUrl } = req.body;
    try {
        await db.query(
            `INSERT INTO activities (activityId, title, description, imageUrl, status, createdAt) VALUES (?, ?, ?, ?, 'active', NOW())`,
            ["ACT" + uuidv4(), title, description, imageUrl]
        );
        res.json({ status: "success", data: { created: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.put('/api/admin/activities', isAdmin, async (req, res) => {
    const { activityId, title, description, imageUrl } = req.body;

    await db.query(
        `
        UPDATE activities
        SET title = ?, description = ?, imageUrl = ?
        WHERE activityId = ?
        `,
        [title, description, imageUrl, activityId]
    );

    res.json({ status: "success", data: { updated: true } });
});

app.post('/api/admin/activities/toggle', isAdmin, async (req, res) => {
    const { activityId } = req.body;
    try {
        const [rows] = await db.query(
            "SELECT status FROM activities WHERE activityId = ?",
            [activityId]
        );

        if (rows.length === 0)
            return res.status(404).json({ status: "error", message: "Not found" });

        const newStatus = rows[0].status === "active" ? "inactive" : "active";

        await db.query(
            "UPDATE activities SET status = ? WHERE activityId = ?",
            [newStatus, activityId]
        );

        res.json({ status: "success", data: { newStatus } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Delete Activity
// ======================================================
app.delete('/api/admin/activities/:activityId', isAdmin, async (req, res) => {
    try {
        const { activityId } = req.params;

        // เธฅเธ likes เนเธฅเธฐ comments เธเธญเธ submissions เนเธเธเธดเธเธเธฃเธฃเธกเธเธตเนเธเนเธญเธ (เธเนเธญเธเธเธฑเธ FK constraint)
        await db.query(
            "DELETE FROM likes WHERE submissionId IN (SELECT submissionId FROM submissions WHERE activityId = ?)",
            [activityId]
        );
        await db.query(
            "DELETE FROM comments WHERE submissionId IN (SELECT submissionId FROM submissions WHERE activityId = ?)",
            [activityId]
        );

        // เธฅเธ submission เธ—เธฑเนเธเธซเธกเธ”เธเธญเธเธเธดเธเธเธฃเธฃเธกเธเธตเน
        await db.query(
            "DELETE FROM submissions WHERE activityId = ?",
            [activityId]
        );

        // เธฅเธเธเธดเธเธเธฃเธฃเธก
        await db.query(
            "DELETE FROM activities WHERE activityId = ?",
            [activityId]
        );

        res.json({ status: "success", data: { removed: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});


// ======================================================
// ADMIN: Badge Management
// ======================================================
app.get('/api/admin/badges', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM badges ORDER BY badgeName ASC");
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.post('/api/admin/badges', isAdmin, async (req, res) => {
    const { badgeName, description, imageUrl } = req.body;
    try {
        await db.query(
            `INSERT INTO badges (badgeId, badgeName, description, imageUrl) VALUES (?, ?, ?, ?)`,
            ["BADGE" + uuidv4(), badgeName, description, imageUrl]
        );
        res.json({ status: "success", data: { created: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.put('/api/admin/badges/:badgeId', isAdmin, async (req, res) => {
    const { badgeId } = req.params;
    const { badgeName, description, imageUrl } = req.body;

    await db.query(
        `
        UPDATE badges SET badgeName = ?, description = ?, imageUrl = ?
        WHERE badgeId = ?
        `,
        [badgeName, description, imageUrl, badgeId]
    );

    res.json({ status: "success", data: { updated: true } });
});

app.delete('/api/admin/badges/:badgeId', isAdmin, async (req, res) => {
    try {
        // เธฅเธ user_badges เธ—เธตเนเธญเนเธฒเธเธญเธดเธ badge เธเธตเนเธเนเธญเธ (เธเนเธญเธเธเธฑเธ FK constraint)
        await db.query(
            "DELETE FROM user_badges WHERE badgeId = ?",
            [req.params.badgeId]
        );
        await db.query(
            "DELETE FROM badges WHERE badgeId = ?",
            [req.params.badgeId]
        );
        res.json({ status: "success", data: { removed: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// Award/revoke badge
app.post('/api/admin/award-badge', isAdmin, async (req, res) => {
    const { lineUserId, badgeId, requesterId } = req.body;

    // เธซเธฒ badgeName เน€เธเธทเนเธญเนเธเนเนเธเธเนเธญเธเธงเธฒเธกเนเธเนเธเน€เธ•เธทเธญเธ
    const [[badge]] = await db.query(
        "SELECT badgeName FROM badges WHERE badgeId = ?",
        [badgeId]
    );

    await db.query(
        "INSERT IGNORE INTO user_badges (lineUserId, badgeId) VALUES (?, ?)",
        [lineUserId, badgeId]
    );

    // เนเธเนเธเน€เธ•เธทเธญเธเธงเนเธฒเธ–เธนเธเธกเธญเธเธเนเธฒเธขเนเธ”เธขเนเธญเธ”เธกเธดเธ
    const msg = badge
        ? `เธเธธเธ“เนเธ”เนเธฃเธฑเธเธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅเนเธซเธกเนเธเธฒเธเธเธนเนเธ”เธนเนเธฅเธฃเธฐเธเธ: ${badge.badgeName}`
        : "เธเธธเธ“เนเธ”เนเธฃเธฑเธเธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅเนเธซเธกเนเธเธฒเธเธเธนเนเธ”เธนเนเธฅเธฃเธฐเธเธ";

    await db.query(
        `
        INSERT INTO notifications
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
        VALUES (?, ?, ?, 'badge', ?, ?, NOW())
        `,
        [
            "NOTI" + uuidv4(),
            lineUserId,
            msg,
            badgeId,
            requesterId || null
        ]
    );

    logAdminAction(requesterId, 'AWARD_BADGE', 'user', lineUserId, lineUserId, { badgeId, badgeName: badge ? badge.badgeName : '' });
    res.json({ status: "success", data: { awarded: true } });
});

app.post('/api/admin/revoke-badge', isAdmin, async (req, res) => {
    const { lineUserId, badgeId, requesterId } = req.body;

    const [[badge]] = await db.query(
        "SELECT badgeName FROM badges WHERE badgeId = ?",
        [badgeId]
    );

    await db.query(
        "DELETE FROM user_badges WHERE lineUserId = ? AND badgeId = ?",
        [lineUserId, badgeId]
    );

    // เนเธเนเธเน€เธ•เธทเธญเธเธงเนเธฒเธเนเธฒเธขเธ–เธนเธเน€เธเธดเธเธ–เธญเธ
    const msg = badge
        ? `เธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅเธเธญเธเธเธธเธ“เธ–เธนเธเน€เธเธดเธเธ–เธญเธ: ${badge.badgeName}`
        : "เธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅเธเธฒเธเธฃเธฒเธขเธเธฒเธฃเธเธญเธเธเธธเธ“เธ–เธนเธเน€เธเธดเธเธ–เธญเธเนเธ”เธขเธเธนเนเธ”เธนเนเธฅเธฃเธฐเธเธ";

    await db.query(
        `
        INSERT INTO notifications
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
        VALUES (?, ?, ?, 'badge', ?, ?, NOW())
        `,
        [
            "NOTI" + uuidv4(),
            lineUserId,
            msg,
            badgeId,
            requesterId || null
        ]
    );

    logAdminAction(requesterId, 'REVOKE_BADGE', 'user', lineUserId, lineUserId, { badgeId, badgeName: badge ? badge.badgeName : '' });
    res.json({ status: "success", data: { revoked: true } });
});

// ======================================================
// ADMIN: Recalculate auto badges for all users
// ======================================================
app.post('/api/admin/recalculate-badges', isAdmin, async (req, res) => {
    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // เธ”เธถเธ user เธ—เธฑเนเธเธซเธกเธ”
        const [users] = await conn.query(
            "SELECT lineUserId FROM users"
        );

        // เธงเธเธ—เธธเธเธเธเนเธฅเนเธงเนเธซเน autoAwardBadgesForUser เธเธฑเธ”เธเธฒเธฃเนเธซเน
        for (const u of users) {
            await autoAwardBadgesForUser(u.lineUserId, conn);
        }

        await conn.commit();
        res.json({
            status: "success",
            data: { recalculated: true, userCount: users.length }
        });
    } catch (err) {
        await conn.rollback();
        console.error("/api/admin/recalculate-badges error:", err);
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        conn.release();
    }
});

// ======================================================
// ADMIN: Update user score (add / subtract) + recalc badges + notifications
// ======================================================
app.post('/api/admin/users/update-score', isAdmin, async (req, res) => {
    const { lineUserId, deltaScore, requesterId } = req.body;

    // เธ•เธฃเธงเธเธเนเธฒเธเธทเนเธเธเธฒเธ
    if (!lineUserId || typeof deltaScore !== 'number' || isNaN(deltaScore)) {
        return res.status(400).json({
            status: "error",
            message: "เธ•เนเธญเธเธฃเธฐเธเธธ lineUserId เนเธฅเธฐ deltaScore (เธ•เธฑเธงเน€เธฅเธ)"
        });
    }

    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1) เธญเธฑเธเน€เธ”เธ•เธเธฐเนเธเธ (เนเธกเนเนเธซเนเธ•เธดเธ”เธฅเธ)
        await conn.query(
            `
            UPDATE users
            SET totalScore = GREATEST(totalScore + ?, 0)
            WHERE lineUserId = ?
            `,
            [deltaScore, lineUserId]
        );

        // 2) เธ”เธถเธเธเธฐเนเธเธเธฃเธงเธกเธฅเนเธฒเธชเธธเธ”
        const [[userRow]] = await conn.query(
            "SELECT totalScore FROM users WHERE lineUserId = ?",
            [lineUserId]
        );
        const newTotalScore = userRow ? userRow.totalScore : 0;

        // 3) เธเธฑเธเธ—เธถเธ history เธเธฒเธฃเธเธฃเธฑเธเธเธฐเนเธเธ (เน€เธเธทเนเธญเธ”เธนเธขเนเธญเธเธซเธฅเธฑเธ)
        await conn.query(
            `
            INSERT INTO user_score_history
                (lineUserId, deltaScore, newTotalScore, reason, createdBy, createdAt)
            VALUES (?, ?, ?, ?, ?, NOW())
            `,
            [
                lineUserId,
                deltaScore,
                newTotalScore,
                'ADMIN_UPDATE',
                requesterId || 'ADMIN'
            ]
        );

        await conn.commit();
        conn.release();

        // 4) เธซเธฅเธฑเธ commit เนเธฅเนเธงเธเนเธญเธขเนเธซเนเธฃเธฐเธเธเน€เธเนเธเธเนเธฒเธข auto เธ•เธฒเธกเธเธฐเนเธเธเนเธซเธกเน
        await autoAwardBadgesForUser(lineUserId);

        // 5) เนเธเนเธเน€เธ•เธทเธญเธเน€เธฃเธทเนเธญเธเธเธฐเนเธเธ
        const messageScore =
            deltaScore > 0
                ? `เธเธฐเนเธเธเธเธญเธเธเธธเธ“เธ–เธนเธเน€เธเธดเนเธก ${Math.abs(deltaScore)} เธเธฐเนเธเธ (เธฃเธงเธกเน€เธเนเธ ${newTotalScore} เธเธฐเนเธเธ)`
                : `เธเธฐเนเธเธเธเธญเธเธเธธเธ“เธ–เธนเธเธฅเธ” ${Math.abs(deltaScore)} เธเธฐเนเธเธ (เน€เธซเธฅเธทเธญ ${newTotalScore} เธเธฐเนเธเธ)`;

        await db.query(
            `
            INSERT INTO notifications
                (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
            `,
            [
                "NOTI" + uuidv4(),
                lineUserId,
                messageScore,
                "score",
                null,
                requesterId || null
            ]
        );

        // 6) เนเธเนเธเน€เธ•เธทเธญเธเธงเนเธฒเธฃเธฐเธเธเธ•เธฃเธงเธเธชเธญเธ/เธญเธฑเธเน€เธ”เธ•เธเนเธฒเธขเนเธซเนเนเธฅเนเธง (auto badge)
        const messageBadgeAuto = "เธฃเธฐเธเธเนเธ”เนเธ•เธฃเธงเธเธชเธญเธเนเธฅเธฐเธญเธฑเธเน€เธ”เธ•เธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅเธเธญเธเธเธธเธ“เธ•เธฒเธกเธเธฐเนเธเธเธฅเนเธฒเธชเธธเธ”เนเธฅเนเธง";
        await db.query(
            `
            INSERT INTO notifications
                (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
            `,
            [
                "NOTI" + uuidv4(),
                lineUserId,
                messageBadgeAuto,
                "badge",
                null,
                null
            ]
        );

        logAdminAction(requesterId, deltaScore >= 0 ? 'ADD_SCORE' : 'DEDUCT_SCORE', 'user', lineUserId, lineUserId, { deltaScore, newTotalScore });
        res.json({
            status: "success",
            data: {
                updated: true,
                lineUserId,
                deltaScore,
                newTotalScore
            }
        });
    } catch (err) {
        try { await conn.rollback(); } catch {}
        conn.release();
        console.error("/api/admin/users/update-score error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
});

// --- API: เธเธเน€เธเธก V2 (เธเธนเนเธเธตเธ Streak + เน€เธเนเธเธเนเธญเธขเธชเน + เนเธเนเธเน€เธ•เธทเธญเธ) ---
app.post('/api/game/submit-answer-v2', async (req, res) => {
    const { lineUserId, questionId, selectedOption } = req.body;
    if (!lineUserId || !questionId || !selectedOption) {
        return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ" });
    }
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 2. เธ•เธฃเธงเธเธเธณเธ•เธญเธ
        const [qs] = await conn.query("SELECT * FROM kyt_questions WHERE questionId = ?", [questionId]);
        if (qs.length === 0) throw new Error("เนเธกเนเธเธเธเธณเธ–เธฒเธก");

        const question = qs[0];
        const isCorrect = (selectedOption === question.correctOption);

        let earnedCoins = isCorrect ? 50 : 10;
        let earnedScore = isCorrect ? question.scoreReward : 2;

        // 3. เธฃเธฐเธเธ Streak (Logic เนเธซเธกเน: เน€เธเนเธเธชเธ–เธดเธ•เธดเน€เธเนเธฒเนเธงเนเธเธนเนเธเธทเธ)
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        let currentStreak = 1;
        let recoverableStreak = 0;
        let isStreakBroken = false;
        
        if (streakRow.length > 0) {
            const lastDate = new Date(streakRow[0].lastPlayedDate);
            const diffTime = Math.abs(new Date(today) - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 1) { 
                // เธ•เนเธญเน€เธเธทเนเธญเธ
                currentStreak = streakRow[0].currentStreak + 1;
                recoverableStreak = 0; 
            } else if (diffDays === 0) {
                // เธเนเธณเธงเธฑเธเน€เธ”เธดเธก
                currentStreak = streakRow[0].currentStreak;
                recoverableStreak = streakRow[0].recoverableStreak; 
            } else {
                // โ๏ธ เธเธฒเธ”เธเนเธงเธ (เนเธเธ”เธฑเธ!): เน€เธเนเธเธเธญเธเน€เธเนเธฒเนเธงเนเธเธนเนเธเธทเธ
                isStreakBroken = true;
                if (streakRow[0].currentStreak >= 3) { 
                    recoverableStreak = streakRow[0].currentStreak;
                }
                currentStreak = 1;
            }
            
            await conn.query(
                "UPDATE user_streaks SET currentStreak = ?, lastPlayedDate = ?, recoverableStreak = ? WHERE lineUserId = ?",
                [currentStreak, today, recoverableStreak, lineUserId]
            );
        } else {
            // เน€เธฅเนเธเธเธฃเธฑเนเธเนเธฃเธ
            await conn.query(
                "INSERT INTO user_streaks (lineUserId, currentStreak, lastPlayedDate, recoverableStreak) VALUES (?, 1, ?, 0)", 
                [lineUserId, today]
            );
        }

        // Streak Bonus (เธ—เธธเธ 7 เธงเธฑเธ)
        if (!isStreakBroken && currentStreak > 0 && currentStreak % 7 === 0) {
            earnedCoins += 100; 
        }

        // 4. เธญเธฑเธเน€เธ”เธ• User
        await conn.query("UPDATE users SET totalScore = totalScore + ?, coinBalance = coinBalance + ? WHERE lineUserId = ?", [earnedScore, earnedCoins, lineUserId]);

        // โญ 5. เธเธฑเธเธ—เธถเธเธเธฃเธฐเธงเธฑเธ•เธด โ€” UNIQUE(lineUserId, playedAt) เธเนเธญเธเธเธฑเธ race condition
        try {
            await conn.query(
                "INSERT INTO user_game_history (lineUserId, questionId, isCorrect, earnedPoints, playedAt, selectedAnswer) VALUES (?, ?, ?, ?, ?, ?)",
                [lineUserId, questionId, isCorrect, earnedCoins, today, selectedOption]
            );
        } catch (insertErr) {
            if (insertErr.code === 'ER_DUP_ENTRY') throw new Error("เธเธธเธ“เน€เธฅเนเธเน€เธเธกเธเธญเธเธงเธฑเธเธเธตเนเนเธเนเธฅเนเธง");
            throw insertErr;
        }

        // โญ 6. เนเธเนเธเน€เธ•เธทเธญเธเธฅเธ App
        const notifMsg = isCorrect 
            ? `เธ เธฒเธฃเธเธดเธเธชเธณเน€เธฃเนเธ! เธเธธเธ“เนเธ”เนเธฃเธฑเธ ${earnedCoins} เน€เธซเธฃเธตเธขเธเธเธฒเธเธเธฒเธฃเธ•เธญเธเธเธณเธ–เธฒเธกเธเธฃเธฐเธเธณเธงเธฑเธ`
            : `เธ•เธญเธเธเธดเธ”เธฃเธฑเธเธฃเธฒเธเธงเธฑเธฅเธเธฅเธญเธเนเธ ${earnedCoins} เน€เธซเธฃเธตเธขเธ`;

        await conn.query(
            `INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'game_quiz', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, notifMsg, questionId, lineUserId]
        );

        const [[updatedUser]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);
        await conn.commit();
        
        res.json({
            status: "success",
            data: {
                isCorrect,
                earnedCoins,
                earnedScore,
                currentStreak,
                recoverableStreak,
                newCoinBalance: updatedUser.coinBalance,
                newTotalScore: updatedUser.totalScore,
                isStreakBroken
            }
        });

    } catch (e) {
        await conn.rollback();
        const status = e.message === "เธเธธเธ“เน€เธฅเนเธเน€เธเธกเธเธญเธเธงเธฑเธเธเธตเนเนเธเนเธฅเนเธง" ? 400 : 500;
        res.status(status).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// --- API: เนเธเนเนเธญเน€เธ—เธกเธเธนเนเธเธทเธ Streak (Restore) ---
app.post('/api/game/restore-streak', async (req, res) => {
    const { lineUserId } = req.body;
    const RESTORE_COST = 200; // เธฃเธฒเธเธฒเธเนเธฒเธเธนเนเธเธทเธ
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เน€เธเนเธเธงเนเธฒเธกเธตเธญเธฐเนเธฃเนเธซเนเธเธนเนเนเธซเธก
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        if (streakRow.length === 0 || streakRow[0].recoverableStreak <= 0) {
            throw new Error("เนเธกเนเธกเธตเธชเธ–เธดเธ•เธดเนเธซเนเธเธนเนเธเธทเธเธเธฃเธฑเธ");
        }
        const lostStreak = streakRow[0].recoverableStreak;

        // 2. เน€เธเนเธเน€เธเธดเธ
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        if (user.coinBalance < RESTORE_COST) {
            throw new Error(`เน€เธซเธฃเธตเธขเธเนเธกเนเธเธญเธเธฃเธฑเธ (เธ•เนเธญเธเธเธฒเธฃ ${RESTORE_COST} เน€เธซเธฃเธตเธขเธ)`);
        }

        // 3. เธซเธฑเธเน€เธเธดเธ + เธเธนเนเธเธทเธ
        // เธชเธนเธ•เธฃ: เน€เธญเธฒเธเธญเธเน€เธเนเธฒ (lost) + เธเธญเธเธเธฑเธเธเธธเธเธฑเธ (current) เธฃเธงเธกเธเธฑเธ
        const restoredStreak = lostStreak + streakRow[0].currentStreak;

        await conn.query("UPDATE users SET coinBalance = coinBalance - ? WHERE lineUserId = ?", [RESTORE_COST, lineUserId]);
        
        await conn.query(
            "UPDATE user_streaks SET currentStreak = ?, recoverableStreak = 0 WHERE lineUserId = ?",
            [restoredStreak, lineUserId]
        );

        // 4. เนเธเนเธเน€เธ•เธทเธญเธ
        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, 'system_alert', 'restore', ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เธเธนเนเธเธตเธเธชเธณเน€เธฃเนเธ! ๐”ฅ เนเธเธเธฅเธฑเธเธกเธฒเน€เธเนเธ ${restoredStreak} เธงเธฑเธเนเธฅเนเธง`, lineUserId]
        );

        const [[updatedUser]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        await conn.commit();

        res.json({ 
            status: "success", 
            data: { 
                success: true, 
                newStreak: restoredStreak,
                newCoinBalance: updatedUser.coinBalance,
                message: `เธเธนเนเธเธทเธเธชเธณเน€เธฃเนเธ! เนเธเธเธฅเธฑเธเธกเธฒเธฅเธธเธเนเธเธ ${restoredStreak} เธงเธฑเธ ๐”ฅ`
            } 
        });

    } catch (e) {
        await conn.rollback();
        res.status(400).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// --- API: เธซเธกเธธเธเธเธฒเธเธฒ (เธเธเธฑเธเธญเธฑเธเน€เธ”เธ•: เธกเธต Bonus Coin Cashback) ---
app.post('/api/game/gacha-pull', async (req, res) => {
    const { lineUserId } = req.body;
    const GACHA_COST = 100; // เธเนเธฒเธซเธกเธธเธ 100 เน€เธซเธฃเธตเธขเธ
    const conn = await db.getClient();

    // โญ เธเธณเธซเธเธ”เน€เธฃเธ—เน€เธเธดเธเธเธทเธเธ•เธฒเธกเธฃเธฐเธ”เธฑเธ (Cashback)
    const BONUS_RATES = {
        'C': 20,    // เธเธฅเธญเธเนเธ
        'R': 40,   // เธเธทเธเธ—เธธเธ 10%
        'SR': 80,  // เธเธทเธเธ—เธธเธ 50%
        'UR': 100  // เธเธณเนเธฃ! (เนเธ”เนเธเธฒเธฃเนเธ”เนเธ–เธกเนเธ”เนเน€เธเธดเธเน€เธเธดเนเธก)
    };

    try {
        await conn.beginTransaction();

        // 1. เน€เธเนเธเน€เธเธดเธ
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        if (user.coinBalance < GACHA_COST) throw new Error("เน€เธซเธฃเธตเธขเธเนเธกเนเธเธญเธเธฃเธฑเธ (เธ•เนเธญเธเธเธฒเธฃ 100 เน€เธซเธฃเธตเธขเธ)");

        // 2. เธชเธธเนเธกเธเธฒเธฃเนเธ” (เนเธขเธเธ•เธฒเธก Rarity)
        const rand = Math.random() * 100;
        let rarityPool = ['C']; 
        if (rand < 5) rarityPool = ['UR'];        // 5%
        else if (rand < 20) rarityPool = ['SR'];  // 15%
        else if (rand < 50) rarityPool = ['R'];   // 30%
        else rarityPool = ['C'];                  // 50%

        const [cards] = await conn.query("SELECT * FROM safety_cards WHERE rarity IN (?) ORDER BY RAND() LIMIT 1", [rarityPool]);
        
        let card;
        if (cards.length > 0) {
            card = cards[0];
        } else {
            const [backup] = await conn.query("SELECT * FROM safety_cards ORDER BY RAND() LIMIT 1");
            if (backup.length === 0) throw new Error("เธฃเธฐเธเธเธขเธฑเธเนเธกเนเธกเธตเธเนเธญเธกเธนเธฅเธเธฒเธฃเนเธ”");
            card = backup[0];
        }

        // โญ 3. เธเธณเธเธงเธ“เน€เธเธดเธเธชเธธเธ—เธเธด (เธฅเธเธเนเธฒเธชเธธเนเธก + เธเธงเธเนเธเธเธฑเธชเธ—เธตเนเธเนเธญเธเนเธเธเธฒเธฃเนเธ”)
        const bonusCoins = BONUS_RATES[card.rarity] || 5;
        const netChange = -GACHA_COST + bonusCoins;

        // เธญเธฑเธเน€เธ”เธ•เน€เธเธดเธ
        await conn.query("UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?", [netChange, lineUserId]);

        // 4. เธเธฑเธเธ—เธถเธเธเธฒเธฃเนเธ”เนเธเธฒเธฃเนเธ”
        await conn.query("INSERT INTO user_cards (lineUserId, cardId) VALUES (?, ?)", [lineUserId, card.cardId]);

        // 5. เนเธเนเธเน€เธ•เธทเธญเธ
        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, 'game_gacha', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เนเธ”เนเธฃเธฑเธเธเธฒเธฃเนเธ” ${card.rarity}: "${card.cardName}" เธเธฃเนเธญเธกเน€เธซเธฃเธตเธขเธเนเธเธเธฑเธช ${bonusCoins} เน€เธซเธฃเธตเธขเธ!`, card.cardId, lineUserId]
        );

        // เธ”เธถเธเธขเธญเธ”เน€เธเธดเธเธฅเนเธฒเธชเธธเธ”
        const [[updatedUser]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);

        await conn.commit();
        
        // เธชเนเธเธเนเธญเธกเธนเธฅเธเธฅเธฑเธ (เน€เธเธดเนเธก bonusCoins เนเธเธเธญเธเธซเธเนเธฒเธเนเธฒเธ)
        res.json({ 
            status: "success", 
            data: { 
                badge: { ...card, badgeName: card.cardName }, 
                remainingCoins: updatedUser.coinBalance,
                bonusCoins: bonusCoins // เธชเนเธเธเนเธฒเธเธตเนเนเธเนเธเธงเน
            } 
        });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({message: e.message});
    } finally { conn.release(); }
});

// --- API: เธ”เธถเธเธเธฒเธฃเนเธ”เธชเธฐเธชเธกเธเธญเธเธเธนเนเนเธเน (เนเธขเธเธเธฒเธ Badges) ---
app.get('/api/user/cards', async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [allCards] = await db.query("SELECT * FROM safety_cards ORDER BY rarity DESC, cardName ASC");
        const [userCards] = await db.query("SELECT cardId, COUNT(*) as count FROM user_cards WHERE lineUserId = ? GROUP BY cardId", [lineUserId]);

        const ownedMap = {};
        userCards.forEach(c => ownedMap[c.cardId] = c.count);

        const result = allCards.map(c => ({
            ...c,
            isOwned: !!ownedMap[c.cardId],
            count: ownedMap[c.cardId] || 0
        }));

        res.json({ status: "success", data: result });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// ADMIN: Users list for admin panel
// ======================================================
// --- API: เธ”เธถเธเธฃเธฒเธขเธเธทเนเธญเธเธนเนเนเธเน (Admin) - เธฃเธญเธเธฃเธฑเธ Search & Sort ---
app.get('/api/admin/users', isAdmin, async (req, res) => {
    const { search, sortBy } = req.query;

    let sql = `
        SELECT u.lineUserId, u.fullName, u.pictureUrl, u.employeeId, u.totalScore, u.coinBalance,
               COUNT(ub.badgeId) AS badgeCount
        FROM users u
        LEFT JOIN user_badges ub ON u.lineUserId = ub.lineUserId
        WHERE 1=1
    `;

    let params = [];

    if (search) {
        sql += ` AND (u.fullName LIKE ? OR u.employeeId LIKE ?) `;
        params.push(`%${search}%`, `%${search}%`);
    }

    sql += ` GROUP BY u.lineUserId, u.fullName, u.pictureUrl, u.employeeId, u.totalScore, u.coinBalance`;

    const sortMap = {
        name:    `ORDER BY u.fullName ASC`,
        coins:   `ORDER BY u.coinBalance DESC`,
        newest:  `ORDER BY u.createdAt DESC`,
        score:   `ORDER BY u.totalScore DESC`,
    };
    sql += ` ${sortMap[sortBy] || sortMap.score}`;

    try {
        const [rows] = await db.query(sql, params);
        res.json({ status: "success", data: rows });
    } catch (e) {
        console.error("Get Users Error:", e);
        res.status(500).json({ message: e.message });
    }
});

app.get('/api/admin/user-details', isAdmin, async (req, res) => {
    const { lineUserId } = req.query;

    const [[user]] = await db.query(
        `SELECT lineUserId, fullName, employeeId, pictureUrl, totalScore, coinBalance, department
         FROM users
         WHERE lineUserId = ?`,
        [lineUserId]
    );

    if (!user) return res.status(404).json({ status: "error", message: "User not found" });

    const [badges] = await db.query(
        `SELECT b.badgeId, b.badgeName, b.imageUrl
         FROM user_badges ub
         JOIN badges b ON ub.badgeId = b.badgeId
         WHERE ub.lineUserId = ?`,
        [lineUserId]
    );

    // เธ”เธถเธ streak
    const [[streakRow]] = await db.query(
        `SELECT currentStreak, lastPlayedDate, recoverableStreak FROM user_streaks WHERE lineUserId = ?`,
        [lineUserId]
    );

    // เธ”เธถเธ card collection
    const [cards] = await db.query(
        `SELECT uc.cardId, sc.cardName, sc.imageUrl, sc.rarity, COUNT(*) AS qty
         FROM user_cards uc
         JOIN safety_cards sc ON uc.cardId = sc.cardId
         WHERE uc.lineUserId = ?
         GROUP BY uc.cardId, sc.cardName, sc.imageUrl, sc.rarity`,
        [lineUserId]
    );

    res.json({ status: "success", data: { user, badges, streak: streakRow || null, cards } });
});

// B-1: เธเธฃเธฑเธ Coins เนเธ”เธขเธ•เธฃเธ
app.post('/api/admin/user/update-coins', isAdmin, async (req, res) => {
    const { lineUserId, deltaCoins, requesterId } = req.body;
    if (!lineUserId || deltaCoins === undefined) {
        return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ" });
    }
    try {
        const [[user]] = await db.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        if (!user) return res.status(404).json({ status: "error", message: "เนเธกเนเธเธเธเธนเนเนเธเน" });
        const newBalance = Math.max(0, user.coinBalance + Number(deltaCoins));
        await db.query("UPDATE users SET coinBalance = ? WHERE lineUserId = ?", [newBalance, lineUserId]);
        logAdminAction(requesterId, Number(deltaCoins) >= 0 ? 'ADD_COINS' : 'DEDUCT_COINS', 'user', lineUserId, lineUserId, { deltaCoins, newBalance });
        const delta = Number(deltaCoins);
        const msg = delta >= 0
            ? `เนเธญเธ”เธกเธดเธเน€เธเธดเนเธก ${delta} เน€เธซเธฃเธตเธขเธเนเธซเนเธเธธเธ“ (เธเธเน€เธซเธฅเธทเธญ: ${newBalance} เน€เธซเธฃเธตเธขเธ)`
            : `เนเธญเธ”เธกเธดเธเธซเธฑเธ ${Math.abs(delta)} เน€เธซเธฃเธตเธขเธเธเธฒเธเธเธฑเธเธเธตเธเธธเธ“ (เธเธเน€เธซเธฅเธทเธญ: ${newBalance} เน€เธซเธฃเธตเธขเธ)`;
        db.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'system_alert', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, msg, null, requesterId]
        ).catch(() => {});
        res.json({ status: "success", data: { newBalance } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// B-4: เธเธฃเธฐเธงเธฑเธ•เธด KYT เธเธญเธ user
app.get('/api/admin/user/kyt-history', isAdmin, async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [rows] = await db.query(
            `SELECT h.historyId, h.playedAt, h.isCorrect, h.earnedPoints,
                    h.selectedAnswer AS selectedOption,
                    COALESCE(q.questionText, 'เธเธณเธ–เธฒเธกเธ–เธนเธเธฅเธเนเธเนเธฅเนเธง') AS questionText,
                    COALESCE(q.correctOption, '') AS correctOption
             FROM user_game_history h
             LEFT JOIN kyt_questions q ON h.questionId = q.questionId
             WHERE h.lineUserId = ?
             ORDER BY h.playedAt DESC
             LIMIT 60`,
            [lineUserId]
        );
        res.json({ status: "success", data: rows });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// B-5: เธเธฃเธฐเธงเธฑเธ•เธด Hunter เธเธญเธ user
app.get('/api/admin/user/hunter-history', isAdmin, async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [rows] = await db.query(
            `SELECT h.stars, h.clearedAt, l.title AS levelTitle, l.imageUrl
             FROM user_hunter_history h
             JOIN hunter_levels l ON h.levelId = l.levelId
             WHERE h.lineUserId = ?
             ORDER BY h.clearedAt DESC`,
            [lineUserId]
        );
        res.json({ status: "success", data: rows });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// B-6: เธเธฃเธฐเธงเธฑเธ•เธด Submissions เธเธญเธ user
app.get('/api/admin/user/submissions', isAdmin, async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [rows] = await db.query(
            `SELECT s.submissionId, s.status, s.createdAt, s.imageUrl, s.description,
                    s.points, a.title AS activityTitle
             FROM submissions s
             JOIN activities a ON s.activityId = a.activityId
             WHERE s.lineUserId = ?
             ORDER BY s.createdAt DESC`,
            [lineUserId]
        );
        res.json({ status: "success", data: rows });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// B-7: Reset / เนเธเนเนเธ Streak
app.post('/api/admin/user/update-streak', isAdmin, async (req, res) => {
    const { lineUserId, newStreak, requesterId } = req.body;
    if (!lineUserId || newStreak === undefined) {
        return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ" });
    }
    try {
        const streak = Math.max(0, Number(newStreak));
        const [[existing]] = await db.query("SELECT lineUserId FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        if (existing) {
            await db.query(
                "UPDATE user_streaks SET currentStreak = ?, lastPlayedDate = CURDATE() WHERE lineUserId = ?",
                [streak, lineUserId]
            );
        } else {
            await db.query(
                "INSERT INTO user_streaks (lineUserId, currentStreak, lastPlayedDate) VALUES (?, ?, CURDATE())",
                [lineUserId, streak]
            );
        }
        logAdminAction(requesterId, 'UPDATE_STREAK', 'user', lineUserId, lineUserId, { newStreak: streak });
        db.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'system_alert', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เนเธญเธ”เธกเธดเธเธเธฃเธฑเธ Streak เธเธญเธเธเธธเธ“เน€เธเนเธ ${streak} เธงเธฑเธ ๐”ฅ`, null, requesterId]
        ).catch(() => {});
        res.json({ status: "success", data: { newStreak: streak } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// B-8: เธกเธญเธเธเธฒเธฃเนเธ”เนเธซเน user เนเธ”เธขเธ•เธฃเธ
app.post('/api/admin/award-card', isAdmin, async (req, res) => {
    const { lineUserId, cardId, requesterId } = req.body;
    if (!lineUserId || !cardId) {
        return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ" });
    }
    try {
        const [[card]] = await db.query("SELECT cardName FROM safety_cards WHERE cardId = ?", [cardId]);
        await db.query("INSERT INTO user_cards (lineUserId, cardId) VALUES (?, ?)", [lineUserId, cardId]);
        logAdminAction(requesterId, 'AWARD_CARD', 'user', lineUserId, lineUserId, { cardId });
        const cardName = card ? card.cardName : cardId;
        db.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'game_gacha', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เนเธญเธ”เธกเธดเธเธกเธญเธเธเธฒเธฃเนเธ” "${cardName}" เนเธซเนเธเธธเธ“ ๐`, cardId, requesterId]
        ).catch(() => {});
        res.json({ status: "success", data: { message: "เธกเธญเธเธเธฒเธฃเนเธ”เธชเธณเน€เธฃเนเธ" } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// B-9: เนเธเนเนเธ Profile user (เธเธทเนเธญ, เธฃเธซเธฑเธชเธเธเธฑเธเธเธฒเธ)
app.post('/api/admin/user/update-profile', isAdmin, async (req, res) => {
    const { lineUserId, fullName, employeeId, department, requesterId } = req.body;
    if (!lineUserId || !fullName) {
        return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ" });
    }
    try {
        await db.query(
            "UPDATE users SET fullName = ?, employeeId = ?, department = ? WHERE lineUserId = ?",
            [fullName, employeeId || '', department || '', lineUserId]
        );
        logAdminAction(requesterId, 'UPDATE_PROFILE', 'user', lineUserId, fullName, { fullName, employeeId, department });
        res.json({ status: "success", message: "เนเธเนเนเธเธเนเธญเธกเธนเธฅเน€เธฃเธตเธขเธเธฃเนเธญเธข" });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// ==========================================
// ๐ ๏ธ ADMIN EDIT APIs (เนเธเนเนเธ”เนเธ—เธธเธเธ•เธฒเธฃเธฒเธ)
// ==========================================

// 1. เนเธเนเนเธเธเธณเธ–เธฒเธก (Quiz)
app.put('/api/admin/questions', isAdmin, async (req, res) => {
    const { questionId, questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, scoreReward, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE kyt_questions
            SET questionText=?, optionA=?, optionB=?, optionC=?, optionD=?, optionE=?, optionF=?, optionG=?, optionH=?, correctOption=?, scoreReward=?, imageUrl=?
            WHERE questionId=?
        `, [questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, scoreReward, imageUrl, questionId]);
        res.json({ status: "success", message: "เนเธเนเนเธเธเธณเธ–เธฒเธกเน€เธฃเธตเธขเธเธฃเนเธญเธข" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 2. เนเธเนเนเธเธเธฒเธฃเนเธ” (Cards)
app.put('/api/admin/cards', isAdmin, async (req, res) => {
    const { cardId, cardName, description, rarity, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE safety_cards
            SET cardName=?, description=?, rarity=?, imageUrl=?
            WHERE cardId=?
        `, [cardName, description, rarity, imageUrl, cardId]);
        res.json({ status: "success", message: "เนเธเนเนเธเธเธฒเธฃเนเธ”เน€เธฃเธตเธขเธเธฃเนเธญเธข" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 3. เนเธเนเนเธเธเธดเธเธเธฃเธฃเธก (Activities)
app.put('/api/admin/activities', isAdmin, async (req, res) => {
    const { activityId, title, description, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE activities 
            SET title=?, description=?, imageUrl=?
            WHERE activityId=?
        `, [title, description, imageUrl, activityId]);
        res.json({ status: "success", message: "เนเธเนเนเธเธเธดเธเธเธฃเธฃเธกเน€เธฃเธตเธขเธเธฃเนเธญเธข" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 4. เนเธเนเนเธเธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅ (Badges)
app.put('/api/admin/badges/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { badgeName, description, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE badges 
            SET badgeName=?, description=?, imageUrl=?
            WHERE badgeId=?
        `, [badgeName, description, imageUrl, id]);
        res.json({ status: "success", message: "เนเธเนเนเธเธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅเน€เธฃเธตเธขเธเธฃเนเธญเธข" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5. เนเธเนเนเธเธ”เนเธฒเธ Hunter (เธญเธฑเธเธเธตเนเน€เธ”เธดเธกเนเธเน POST path update เธญเธขเธนเนเนเธฅเนเธง เนเธ•เนเนเธชเนเน€เธเธทเนเธญเนเธงเน)
app.post('/api/admin/hunter/level/update', isAdmin, async (req, res) => {
    const { levelId, title, imageUrl, hazards } = req.body;
    const conn = await db.getClient();
    try {
        await conn.beginTransaction();
        // เธญเธฑเธเน€เธ”เธ•เธเนเธญเธกเธนเธฅเธ”เนเธฒเธ
        await conn.query('UPDATE hunter_levels SET title=?, imageUrl=? WHERE levelId=?', [title, imageUrl, levelId]);
        
        // เธฅเธเธเธธเธ”เน€เธ”เธดเธกเธ—เธดเนเธ เนเธฅเนเธงเธฅเธเนเธซเธกเน (เธเนเธฒเธขเธเธงเนเธฒเนเธฅเนเน€เธเนเธเธ—เธตเธฅเธฐเธเธธเธ”)
        await conn.query('DELETE FROM hunter_hazards WHERE levelId=?', [levelId]);
        
        // เธฅเธเธเธธเธ”เนเธซเธกเน
        for (const h of hazards) {
            await conn.query('INSERT INTO hunter_hazards (levelId, x, y, description, knowledge) VALUES (?, ?, ?, ?, ?)', 
                [levelId, h.x, h.y, h.description, h.knowledge]);
        }
        await conn.commit();
        res.json({ status: "success", message: "เนเธเนเนเธเธ”เนเธฒเธเน€เธฃเธตเธขเธเธฃเนเธญเธข" });
    } catch (e) {
        await conn.rollback();
        res.status(500).json({ message: e.message });
    } finally {
        conn.release();
    }
});

// --- API: เนเธเนเนเธเธเธฃเธฐเธงเธฑเธ•เธด KYT (Final Fix: เนเธเนเธเธทเนเธญเธเธญเธฅเธฑเธกเธเน recipientUserId เธ•เธฒเธกเธ เธฒเธ) ---
app.post('/api/admin/kyt/update-answer', isAdmin, async (req, res) => {
    console.log("๐€ Admin Update KYT Start:", req.body);

    const { historyId, lineUserId, isCorrect, newScore, requesterId } = req.body;
    
    if (!historyId || !lineUserId) {
        return res.status(400).json({ message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ (Missing historyId or lineUserId)" });
    }

    try {
        // 1. เธ”เธถเธเธเนเธญเธกเธนเธฅเน€เธเนเธฒ
        const [oldData] = await db.query('SELECT earnedPoints FROM user_game_history WHERE historyId = ?', [historyId]);
        if (oldData.length === 0) throw new Error("เนเธกเนเธเธเธเธฃเธฐเธงเธฑเธ•เธดเธเธฒเธฃเน€เธฅเนเธ");
        
        const oldScore = oldData[0].earnedPoints || 0;
        const diff = parseInt(newScore) - oldScore; 
        
        // 2. เธญเธฑเธเน€เธ”เธ•เธเธฃเธฐเธงเธฑเธ•เธด
        await db.query(`
            UPDATE user_game_history 
            SET isCorrect = ?, earnedPoints = ? 
            WHERE historyId = ?
        `, [isCorrect, newScore, historyId]);

        // 3. เธญเธฑเธเน€เธ”เธ•เธเธฐเนเธเธเธฃเธงเธก
        if (diff !== 0) {
            await db.query(`
                UPDATE users 
                SET coinBalance = coinBalance + ?, totalScore = totalScore + ?
                WHERE lineUserId = ?
            `, [diff, diff, lineUserId]);
        }

        // 4. เธชเธฃเนเธฒเธเธเธฒเธฃเนเธเนเธเน€เธ•เธทเธญเธ (โญโญ เนเธเนเธเธทเนเธญเธเธญเธฅเธฑเธกเธเนเธ•เธฒเธกเธ เธฒเธ image_bd7dee.png โญโญ)
        try {
            const msg = `เนเธญเธ”เธกเธดเธเนเธเนเนเธเธเธฅ KYT: ${isCorrect ? 'เธ–เธนเธเธ•เนเธญเธโ…' : 'เธเธดเธ”โ'} (${diff >= 0 ? '+' : ''}${diff} เน€เธซเธฃเธตเธขเธ)`;
            const notifId = 'NOTIF-' + Date.now();
            
            // ID เธเธนเนเธ—เธณเธฃเธฒเธขเธเธฒเธฃ (Admin)
            const triggerUser = requesterId || lineUserId; 

            // เนเธเน recipientUserId (เธเธนเนเธฃเธฑเธ) เนเธฅเธฐ triggeringUserId (เธเธนเนเธ—เธณ)
            await db.query(`
                INSERT INTO notifications 
                (notificationId, recipientUserId, message, type, isRead, createdAt, triggeringUserId, relatedItemId)
                VALUES (?, ?, ?, 'game_quiz', 0, NOW(), ?, ?)
            `, [
                notifId,
                lineUserId,           // recipientUserId
                msg,
                triggerUser,          // triggeringUserId
                historyId.toString()  // relatedItemId
            ]);
            
            console.log("โ… Notification Saved to DB:", notifId);
            
        } catch (notifyError) {
            console.error("โ เนเธเนเธเน€เธ•เธทเธญเธเธฅเธ DB เธฅเนเธกเน€เธซเธฅเธง:", notifyError.message);
        }

        console.log("โ… Update Successfully");
        res.json({ status: "success", message: "เนเธเนเนเธเนเธฅเธฐเธเธทเธเน€เธซเธฃเธตเธขเธเน€เธฃเธตเธขเธเธฃเนเธญเธข" });

    } catch (e) {
        console.error("โ Critical Error Update KYT:", e);
        res.status(500).json({ message: "Update Failed: " + e.message });
    }
});

// ======================================================
// NOTIFICATIONS
// ======================================================
app.get('/api/notifications', async (req, res) => {
    const { requesterId } = req.query;
    try {
        const [rows] = await db.query(
            "SELECT * FROM notifications WHERE recipientUserId = ? ORDER BY createdAt DESC",
            [requesterId]
        );
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.get('/api/notifications/unread-count', async (req, res) => {
    const { requesterId } = req.query;
    try {
        const [rows] = await db.query(
            "SELECT COUNT(*) AS count FROM notifications WHERE recipientUserId = ? AND isRead = FALSE",
            [requesterId]
        );
        res.json({ status: "success", data: { unreadCount: rows[0].count } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.post('/api/notifications/mark-read', async (req, res) => {
    const { requesterId } = req.body;
    try {
        await db.query(
            "UPDATE notifications SET isRead = TRUE WHERE recipientUserId = ?",
            [requesterId]
        );
        res.json({ status: "success", data: { updated: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// --- API: เนเธฅเธเน€เธซเธฃเธตเธขเธเน€เธเนเธเธเธฐเนเธเธ (Exchange Coins to Score) ---
app.post('/api/game/exchange-coins', async (req, res) => {
    const { lineUserId } = req.body;
    const COIN_COST = 10;  // เธเนเธฒเธข 10 เน€เธซเธฃเธตเธขเธ
    const POINT_GAIN = 2;  // เนเธ”เน 2 เธเธฐเนเธเธ
    
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เน€เธเนเธเธขเธญเธ”เน€เธเธดเธเธเธฑเธเธเธธเธเธฑเธ
        const [[user]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);
        if (!user || user.coinBalance < COIN_COST) {
            throw new Error(`เน€เธซเธฃเธตเธขเธเนเธกเนเธเธญเธเธฃเธฑเธ (เธกเธต ${user.coinBalance || 0} เน€เธซเธฃเธตเธขเธ, เธ•เนเธญเธเธเธฒเธฃ ${COIN_COST} เน€เธซเธฃเธตเธขเธ)`);
        }

        // 2. เธซเธฑเธเน€เธซเธฃเธตเธขเธ เนเธฅเธฐ เน€เธเธดเนเธกเธเธฐเนเธเธ
        await conn.query(
            "UPDATE users SET coinBalance = coinBalance - ?, totalScore = totalScore + ? WHERE lineUserId = ?", 
            [COIN_COST, POINT_GAIN, lineUserId]
        );

        // 3. เนเธเนเธเน€เธ•เธทเธญเธ (Notification)
        await conn.query(
            `INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'exchange', ?, ?, NOW())`,
            [
                "NOTIF" + uuidv4(),
                lineUserId,
                `เนเธฅเธเน€เธเธฅเธตเนเธขเธเธชเธณเน€เธฃเนเธ! เธเธธเธ“เนเธเน ${COIN_COST} เน€เธซเธฃเธตเธขเธ เนเธฅเธเธฃเธฑเธ ${POINT_GAIN} เธเธฐเนเธเธเน€เธฃเธตเธขเธเธฃเนเธญเธขเนเธฅเนเธง`,
                "exchange", // type เนเธซเธกเน
                null,
                lineUserId
            ]
        );

        // 4. เน€เธเนเธ Badge เธญเธฑเธ•เนเธเธกเธฑเธ•เธด (เน€เธเธทเนเธญเธเธฐเนเธเธเธ–เธถเธเน€เธเธ“เธ‘เนเนเธฅเนเธงเนเธ”เนเนเธฅเน)
        // (เธเธฑเธเธเนเธเธฑเธ autoAwardBadgesForUser เธ•เนเธญเธเธกเธตเธญเธขเธนเนเนเธฅเนเธงเนเธ server.js เธ•เธฒเธกเนเธเนเธ”เน€เธเนเธฒ)
        // await autoAwardBadgesForUser(lineUserId, conn); 

        // 5. เธ”เธถเธเธเนเธฒเธฅเนเธฒเธชเธธเธ”เธชเนเธเธเธฅเธฑเธ
        const [[updatedUser]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);

        await conn.commit();
        
        res.json({ 
            status: "success", 
            data: { 
                remainingCoins: updatedUser.coinBalance,
                newTotalScore: updatedUser.totalScore
            } 
        });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// --- API: เนเธฅเธเธเธฐเนเธเธ โ’ เน€เธซเธฃเธตเธขเธ ---
app.post('/api/game/exchange-score', async (req, res) => {
    const { lineUserId } = req.body;
    const SCORE_COST = 2;   // เธเนเธฒเธข 2 เธเธฐเนเธเธ
    const COIN_GAIN = 10;   // เนเธ”เน 10 เน€เธซเธฃเธตเธขเธ

    if (!lineUserId) return res.status(400).json({ status: "error", message: "เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ" });

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        const [[user]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);
        if (!user) throw new Error("เนเธกเนเธเธเธเธนเนเนเธเน");
        if (user.totalScore < SCORE_COST) {
            throw new Error(`เธเธฐเนเธเธเนเธกเนเธเธญเธเธฃเธฑเธ (เธกเธต ${user.totalScore} เธเธฐเนเธเธ, เธ•เนเธญเธเธเธฒเธฃ ${SCORE_COST} เธเธฐเนเธเธ)`);
        }

        await conn.query(
            "UPDATE users SET totalScore = totalScore - ?, coinBalance = coinBalance + ? WHERE lineUserId = ?",
            [SCORE_COST, COIN_GAIN, lineUserId]
        );

        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'exchange', ?, ?, NOW())`,
            [
                "NOTIF" + uuidv4(),
                lineUserId,
                `เนเธฅเธเน€เธเธฅเธตเนเธขเธเธชเธณเน€เธฃเนเธ! เธเธธเธ“เนเธเน ${SCORE_COST} เธเธฐเนเธเธ เนเธฅเธเธฃเธฑเธ ${COIN_GAIN} เน€เธซเธฃเธตเธขเธเน€เธฃเธตเธขเธเธฃเนเธญเธขเนเธฅเนเธง`,
                "exchange",
                null,
                lineUserId
            ]
        );

        const [[updatedUser]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);
        await conn.commit();

        res.json({
            status: "success",
            data: {
                newCoinBalance: updatedUser.coinBalance,
                newTotalScore: updatedUser.totalScore
            }
        });
    } catch (e) {
        await conn.rollback();
        res.status(e.message.includes("เนเธกเนเธเธญ") || e.message.includes("เนเธกเนเธเธ") ? 400 : 500).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// --- API: เธขเนเธญเธขเธเธฒเธฃเนเธ” (Recycle Cards) ---
app.post('/api/game/recycle-cards', async (req, res) => {
    const { lineUserId, cardsToRecycle } = req.body; 
    // cardsToRecycle = [{ cardId: 'CARD_001', count: 2 }, { cardId: 'CARD_002', count: 3 }] เธฃเธงเธกเธเธฑเธเธ•เนเธญเธเนเธ”เน 5 เนเธ
    
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เธ•เธฃเธงเธเธชเธญเธเธเธณเธเธงเธเธเธฒเธฃเนเธ”เธฃเธงเธก (เธ•เนเธญเธเธเธฃเธ 5 เนเธ)
        const totalCount = cardsToRecycle.reduce((sum, item) => sum + item.count, 0);
        if (totalCount !== 5) throw new Error("เธ•เนเธญเธเน€เธฅเธทเธญเธเธเธฒเธฃเนเธ”เธกเธฒเธขเนเธญเธขเนเธซเนเธเธฃเธ 5 เนเธเธเธญเธ”เธตเธเธฃเธฑเธ");

        // 2. เธฅเธเธเธฒเธฃเนเธ”เธญเธญเธเธเธฒเธเธ•เธฒเธฃเธฒเธ (เธงเธเธฅเธนเธเธขเนเธญเธขเธ—เธตเธฅเธฐเธเธเธดเธ”)
        for (const item of cardsToRecycle) {
            // เน€เธเนเธเธเนเธญเธเธงเนเธฒเธกเธตเธเธญเนเธซเนเธฅเธเนเธซเธก
            const [rows] = await conn.query(
                "SELECT count(*) as total FROM user_cards WHERE lineUserId = ? AND cardId = ?", 
                [lineUserId, item.cardId]
            );
            if (rows[0].total < item.count) {
                throw new Error(`เธเธฒเธฃเนเธ” ${item.cardId} เธกเธตเนเธกเนเธเธญเธชเธณเธซเธฃเธฑเธเธขเนเธญเธข (เธกเธต ${rows[0].total} เนเธ, เธ•เนเธญเธเธเธฒเธฃ ${item.count} เนเธ)`);
            }

            // เธเธณเธชเธฑเนเธเธฅเธเนเธเธเธเธณเธเธฑเธ”เธเธณเธเธงเธ (LIMIT)
            await conn.query(
                "DELETE FROM user_cards WHERE lineUserId = ? AND cardId = ? LIMIT ?",
                [lineUserId, item.cardId, item.count]
            );
        }

        // 3. เธชเธธเนเธกเธฃเธฒเธเธงเธฑเธฅ (Lucky Coin Box: 100 - 300 Coins)
        const rewardCoins = Math.floor(Math.random() * (300 - 100 + 1)) + 100;

        // 4. เนเธซเนเธฃเธฒเธเธงเธฑเธฅ
        await conn.query(
            "UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?",
            [rewardCoins, lineUserId]
        );

        // 5. เนเธเนเธเน€เธ•เธทเธญเธ
        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'recycle', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `เธฃเธตเนเธเน€เธเธดเธฅเธชเธณเน€เธฃเนเธ! เธเธธเธ“เนเธ”เนเธฃเธฑเธ ${rewardCoins} เน€เธซเธฃเธตเธขเธ`, "recycle", lineUserId]
        );

        // 6. เธชเนเธเธเนเธฒเธเธฅเธฑเธ
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);

        await conn.commit();
        res.json({ status: "success", data: { rewardCoins, newCoinBalance: user.coinBalance } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// ======================================================
// PART 5 โ€” SAFETY HUNTER API (MySQL/TiDB Compatible)
// ======================================================

// 1. ADMIN: เธชเธฃเนเธฒเธเธ”เนเธฒเธเนเธซเธกเน + เธเธฑเธเธ—เธถเธเธเธธเธ”เน€เธชเธตเนเธขเธ
app.post('/api/admin/hunter/level', isAdmin, async (req, res) => {
    const { title, imageUrl, hazards } = req.body; 
    const levelId = "LVL_" + Date.now();
    const conn = await db.getClient();
    
    try {
        await conn.beginTransaction();

        // 1. เธชเธฃเนเธฒเธ Level
        await conn.query(
            "INSERT INTO hunter_levels (levelId, title, imageUrl, totalHazards) VALUES (?, ?, ?, ?)",
            [levelId, title, imageUrl, hazards.length]
        );

        // 2. เธเธฑเธเธ—เธถเธเธเธธเธ”เน€เธชเธตเนเธขเธ (เธงเธเธฅเธนเธ Insert เธ—เธตเธฅเธฐเนเธ–เธง เน€เธเธทเนเธญเธเธงเธฒเธกเธเธฑเธงเธฃเนเนเธ MySQL)
        if (Array.isArray(hazards) && hazards.length > 0) {
            for (const h of hazards) {
                await conn.query(
                    "INSERT INTO hunter_hazards (hazardId, levelId, description, x, y, radius) VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        "HZD_" + uuidv4(), 
                        levelId, 
                        h.description || 'เธเธธเธ”เน€เธชเธตเนเธขเธ', 
                        h.x, 
                        h.y, 
                        5.0
                    ]
                );
            }
        }

        await conn.commit();
        res.json({ status: "success", data: { levelId } });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        conn.release();
    }
});

// 2. USER: เธ”เธถเธเธฃเธฒเธขเธเธทเนเธญเธ”เนเธฒเธเธ—เธฑเนเธเธซเธกเธ” (เธเธฃเนเธญเธกเธ”เธฒเธง + เธเธณเธเธงเธเธเธฃเธฑเนเธเธ—เธตเนเน€เธฅเนเธ)
app.get('/api/game/hunter/levels', async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [levels] = await db.query("SELECT * FROM hunter_levels ORDER BY createdAt DESC");

        const [history] = await db.query(`
            SELECT levelId, MAX(stars) as bestStars
            FROM user_hunter_history
            WHERE lineUserId = ?
            GROUP BY levelId
        `, [lineUserId]);

        const historyMap = {};
        history.forEach(h => { historyMap[h.levelId] = h.bestStars; });

        const [attempts] = await db.query(`
            SELECT levelId, attempt_count
            FROM hunter_attempts
            WHERE lineUserId = ?
        `, [lineUserId]);

        const attemptsMap = {};
        attempts.forEach(a => { attemptsMap[a.levelId] = a.attempt_count; });

        const result = levels.map(l => ({
            ...l,
            isCleared: historyMap.hasOwnProperty(l.levelId),
            bestStars: historyMap[l.levelId] || 0,
            playedCount: attemptsMap[l.levelId] || 0,
            maxPlays: 3
        }));

        res.json({ status: "success", data: result });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 3. USER: เธ•เธฃเธงเธเธชเธญเธเธเธดเธเธฑเธ” (Check Hit)
app.post('/api/game/hunter/check', async (req, res) => {
    const { levelId, x, y } = req.body; 

    const [hazards] = await db.query("SELECT * FROM hunter_hazards WHERE levelId = ?", [levelId]);
    
    let hit = null;
    for (const h of hazards) {
        // เธเธณเธเธงเธ“เธฃเธฐเธขเธฐเธซเนเธฒเธ
        const dx = parseFloat(x) - parseFloat(h.x);
        const dy = parseFloat(y) - parseFloat(h.y);
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (dist <= parseFloat(h.radius)) {
            hit = h;
            break; 
        }
    }

    if (hit) {
        res.json({ status: "success", data: { isHit: true, hazard: hit } });
    } else {
        res.json({ status: "success", data: { isHit: false } });
    }
});

// 4. USER: เธเธเน€เธเธก (เธฃเธฑเธเธฃเธฒเธเธงเธฑเธฅ + เธเธฑเธเธ—เธถเธเธ”เธฒเธง)
app.post('/api/game/hunter/complete', async (req, res) => {
    const { lineUserId, levelId, stars } = req.body; // โญ เธฃเธฑเธ stars เน€เธเธดเนเธก
    const REWARD = 150; 
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // เน€เธเนเธเธงเนเธฒเน€เธเธขเธเนเธฒเธเธ”เนเธฒเธเธเธตเนเธซเธฃเธทเธญเธขเธฑเธ (เน€เธเธทเนเธญเนเธเธเน€เธซเธฃเธตเธขเธเนเธเนเธเธฃเธฑเนเธเนเธฃเธ)
        const [hist] = await conn.query("SELECT * FROM user_hunter_history WHERE lineUserId = ? AND levelId = ?", [lineUserId, levelId]);
        
        let earnedCoins = 0;
        if (hist.length === 0) {
            earnedCoins = REWARD;
            await conn.query("UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?", [earnedCoins, lineUserId]);
            
            // เนเธเนเธเน€เธ•เธทเธญเธเน€เธซเธฃเธตเธขเธ (เน€เธเธเธฒเธฐเธเธฃเธฑเนเธเนเธฃเธ)
            await conn.query(
                "INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())",
                ["NOTIF" + uuidv4(), lineUserId, `เธชเธธเธ”เธขเธญเธ”! เธเธธเธ“เธเนเธเธซเธฒเธเธธเธ”เน€เธชเธตเนเธขเธเธเธฃเธ เธฃเธฑเธ ${earnedCoins} เน€เธซเธฃเธตเธขเธ`, 'game_hunter', levelId, lineUserId]
            );
        }

        // โญ เนเธเนเนเธ: เนเธเน ON DUPLICATE KEY UPDATE เธฃเธญเธเธฃเธฑเธเธเธฒเธฃเน€เธฅเนเธเธเนเธณ
        // (เธ–เนเธฒเธกเธตเธเนเธญเธกเธนเธฅเนเธฅเนเธง เธเธฐเธญเธฑเธเน€เธ”เธ•เธ”เธฒเธงเนเธซเนเน€เธเธเธฒเธฐเน€เธกเธทเนเธญเนเธ”เนเธ”เธฒเธงเธกเธฒเธเธเธงเนเธฒเน€เธ”เธดเธก)
        await conn.query(
            `INSERT INTO user_hunter_history (lineUserId, levelId, stars, clearedAt) 
             VALUES (?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE 
             stars = GREATEST(stars, VALUES(stars)), 
             clearedAt = NOW()`, 
            [lineUserId, levelId, stars || 1]
        );

        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        await conn.commit();

        res.json({ status: "success", data: { earnedCoins, newCoinBalance: user.coinBalance } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({ message: e.message });
    } finally {
        conn.release();
    }
});

// --- API: เน€เธฃเธดเนเธกเน€เธฅเนเธเธ”เนเธฒเธ (เธเธฑเธเธเธณเธเธงเธเธเธฃเธฑเนเธ) ---
app.post('/api/game/hunter/start-level', async (req, res) => {
    const { lineUserId, levelId } = req.body;
    const MAX_PLAYS = 3;

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // 1. เน€เธเนเธเธเธณเธเธงเธเธเธฃเธฑเนเธเธเธฑเธเธเธธเธเธฑเธ
        const [rows] = await conn.query(
            "SELECT attempt_count FROM hunter_attempts WHERE lineUserId = ? AND levelId = ?",
            [lineUserId, levelId]
        );

        let current = 0;
        if (rows.length > 0) {
            current = rows[0].attempt_count;
        }

        // 2. เธ–เนเธฒเธเธฃเธ 3 เธเธฃเธฑเนเธเนเธฅเนเธง -> เธซเนเธฒเธกเน€เธฅเนเธ
        if (current >= MAX_PLAYS) {
            throw new Error(`เธเธธเธ“เนเธเนเธชเธดเธ—เธเธดเนเน€เธฅเนเธเธ”เนเธฒเธเธเธตเนเธเธฃเธ ${MAX_PLAYS} เธเธฃเธฑเนเธเนเธฅเนเธง`);
        }

        // 3. เธเธงเธเน€เธเธดเนเธก 1 เธเธฃเธฑเนเธ
        if (rows.length === 0) {
            await conn.query(
                "INSERT INTO hunter_attempts (lineUserId, levelId, attempt_count) VALUES (?, ?, 1)",
                [lineUserId, levelId]
            );
        } else {
            await conn.query(
                "UPDATE hunter_attempts SET attempt_count = attempt_count + 1 WHERE lineUserId = ? AND levelId = ?",
                [lineUserId, levelId]
            );
        }

        await conn.commit();
        res.json({ status: "success", data: { canPlay: true, played: current + 1 } });

    } catch (e) {
        await conn.rollback();
        res.status(400).json({ status: "error", message: e.message });
    } finally {
        conn.release();
    }
});

// --- API: เธ”เธถเธเธฃเธฒเธขเธฅเธฐเน€เธญเธตเธขเธ”เธ”เนเธฒเธ (เธฃเธงเธกเธเธธเธ”เน€เธชเธตเนเธขเธ) เน€เธเธทเนเธญเธกเธฒเนเธเนเนเธ ---
app.get('/api/admin/hunter/level/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [levels] = await db.query("SELECT * FROM hunter_levels WHERE levelId = ?", [id]);
        if (levels.length === 0) throw new Error("เนเธกเนเธเธเธ”เนเธฒเธ");

        const [hazards] = await db.query("SELECT * FROM hunter_hazards WHERE levelId = ?", [id]);
        
        res.json({ status: "success", data: { ...levels[0], hazards } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// --- API: เธญเธฑเธเน€เธ”เธ•เธ”เนเธฒเธ (เนเธเนเธเธทเนเธญ + เนเธเนเธเธธเธ”เน€เธชเธตเนเธขเธ) ---
app.post('/api/admin/hunter/level/update', isAdmin, async (req, res) => {
    const { levelId, title, hazards } = req.body; // เน€เธฃเธฒเธเธฐเนเธกเนเนเธเนเธฃเธนเธเธ เธฒเธเน€เธเธทเนเธญเธเธงเธฒเธกเธเนเธฒเธข (เธ–เนเธฒเธเธฐเนเธเนเธฃเธนเธ เธฅเธเธชเธฃเนเธฒเธเนเธซเธกเนเธเนเธฒเธขเธเธงเนเธฒ)
    
    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // 1. เธญเธฑเธเน€เธ”เธ•เธเธทเนเธญเนเธฅเธฐเธเธณเธเธงเธเธเธธเธ”
        await conn.query(
            "UPDATE hunter_levels SET title = ?, totalHazards = ? WHERE levelId = ?",
            [title, hazards.length, levelId]
        );

        // 2. เธฅเธเธเธธเธ”เน€เธชเธตเนเธขเธเน€เธเนเธฒเธ—เธดเนเธเธ—เธฑเนเธเธซเธกเธ” (เนเธฅเนเธงเนเธชเนเนเธซเธกเน เธเนเธฒเธขเธเธงเนเธฒเธกเธฒเน€เธเนเธเธ—เธตเธฅเธฐเธเธธเธ”)
        await conn.query("DELETE FROM hunter_hazards WHERE levelId = ?", [levelId]);

        // 3. เนเธชเนเธเธธเธ”เน€เธชเธตเนเธขเธเนเธซเธกเน
        for (const h of hazards) {
            await conn.query(
                "INSERT INTO hunter_hazards (hazardId, levelId, description, knowledge, x, y, radius) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    "HZD_" + uuidv4(), 
                    levelId, 
                    h.description, 
                    h.knowledge || '', 
                    h.x, h.y, 
                    5.0
                ]
            );
        }

        await conn.commit();
        res.json({ status: "success", data: { updated: true } });
    } catch (e) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: e.message });
    } finally {
        conn.release();
    }
});

// --- API: เธฅเธเธ”เนเธฒเธ ---
app.delete('/api/admin/hunter/level/:id', isAdmin, async (req, res) => {
    try {
        // Cascade เธเธฐเธฅเธ hazards เนเธฅเธฐ attempts เนเธซเนเธญเธฑเธ•เนเธเธกเธฑเธ•เธด (เธ•เธฒเธกเธ—เธตเนเน€เธฃเธฒเนเธเน DB เนเธ)
        await db.query("DELETE FROM hunter_levels WHERE levelId = ?", [req.params.id]);
        res.json({ status: "success", data: { deleted: true } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// --- API: เธเธเน€เธเธกเนเธเธเนเธกเนเธเนเธฒเธ (เธฃเธฑเธเธฃเธฒเธเธงเธฑเธฅเธเธฅเธญเธเนเธ) ---
app.post('/api/game/hunter/fail', async (req, res) => {
    const { lineUserId, levelId } = req.body;
    const CONSOLATION_PRIZE = 10; // โญ เธเธณเธซเธเธ”เธเธณเธเธงเธเน€เธซเธฃเธตเธขเธเธเธฅเธญเธเนเธเธ•เธฃเธเธเธตเน

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // 1. เน€เธเธดเนเธกเน€เธซเธฃเธตเธขเธเนเธซเน User
        await conn.query(
            "UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?",
            [CONSOLATION_PRIZE, lineUserId]
        );

        // 2. เธเธฑเธเธ—เธถเธเนเธเนเธเน€เธ•เธทเธญเธ (Optional)
        await conn.query(
            "INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())",
            [
                "NOTIF" + uuidv4(), 
                lineUserId, 
                `เธเธขเธฒเธขเธฒเธกเนเธ”เนเธ”เธต! เธฃเธฑเธเธฃเธฒเธเธงเธฑเธฅเธเธฅเธญเธเนเธ ${CONSOLATION_PRIZE} เน€เธซเธฃเธตเธขเธ เธเธฒเธเธ เธฒเธฃเธเธดเธเธฅเนเธฒเธเธธเธ”เน€เธชเธตเนเธขเธ`, 
                'game_hunter_fail', 
                levelId, 
                lineUserId
            ]
        );

        // 3. เธ”เธถเธเธขเธญเธ”เธฅเนเธฒเธชเธธเธ”เธชเนเธเธเธฅเธฑเธ
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);

        await conn.commit();
        res.json({ status: "success", data: { earnedCoins: CONSOLATION_PRIZE, newCoinBalance: user.coinBalance } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({ message: e.message });
    } finally {
        conn.release();
    }
});

const axios = require('axios'); // เธ•เนเธญเธเธกเธตเธเธฃเธฃเธ—เธฑเธ”เธเธตเนเธ”เนเธฒเธเธเธเธชเธธเธ” เธ–เนเธฒเนเธกเนเธกเธตเนเธซเน npm install axios

// --- API: Admin เธเธ”เธเธธเนเธกเนเธเนเธเน€เธ•เธทเธญเธเน€เธญเธ (Manual) ---
app.post('/api/admin/remind-streaks', isAdmin, async (req, res) => {
    // เน€เธฃเธตเธขเธเนเธเนเธเธฑเธเธเนเธเธฑเธเน€เธ”เธตเธขเธงเธเธฑเธ Auto เน€เธฅเธข
    const result = await broadcastStreakReminders();
    
    if (result.success) {
        // โญโญโญ เนเธเนเธ•เธฃเธเธเธตเน: เธ•เนเธญเธเธซเนเธญ message เนเธงเนเนเธ data เน€เธเธทเนเธญเนเธซเน callApi เธฃเธฑเธเธเนเธฒเนเธ”เนเธ–เธนเธเธ•เนเธญเธ โญโญโญ
        res.json({ 
            status: "success", 
            data: { message: result.message } 
        });
    } else {
        res.status(500).json({ status: "error", message: result.message });
    }
});

// --- API: เธ—เธ”เธชเธญเธเธชเนเธเนเธเนเธเน€เธ•เธทเธญเธเธซเธฒเธ•เธฑเธงเน€เธญเธ (Admin Only) ---
app.post('/api/admin/test-remind-self', isAdmin, async (req, res) => {
    const { requesterId } = req.body; 
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

    try {
        if (!token) throw new Error("เนเธกเนเธเธ LINE Channel Access Token");

        const message = {
            to: requesterId,
            messages: [{
                type: "flex",
                altText: "[TEST] ๐”ฅ เธฃเธฐเธงเธฑเธเนเธเธ”เธฑเธ! เน€เธเนเธฒเธกเธฒเน€เธ•เธดเธกเธ”เนเธงเธ",
                contents: {
                    type: "bubble",
                    body: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            { type: "text", text: "๐”ฅ [TEST] เธฃเธฐเธงเธฑเธเนเธเธ”เธฑเธ!", weight: "bold", size: "xl", color: "#ff5500" },
                            { type: "text", text: `เธเธธเธ“เธฃเธฑเธเธฉเธฒเธชเธ–เธดเธ•เธดเธกเธฒ 5 เธงเธฑเธเนเธฅเนเธง (เธ•เธฑเธงเธญเธขเนเธฒเธ)`, size: "md", color: "#555555", margin: "md" },
                            { type: "text", text: "เธฃเธตเธเน€เธฅเนเธ Daily Quiz เธเนเธญเธเน€เธ—เธตเนเธขเธเธเธทเธเน€เธเธทเนเธญเธฃเธฑเธเธฉเธฒเธชเธ–เธดเธ•เธด!", size: "sm", color: "#aaaaaa", wrap: true, margin: "sm" }
                        ]
                    },
                    footer: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            {
                                type: "button",
                                // โญ เนเธเนเธ•เธฃเธเธเธตเน: เนเธเน process.env.LIFF_ID
                                action: { type: "uri", label: "เน€เธเนเธฒเน€เธเธกเธ—เธฑเธเธ—เธต ๐ฎ", uri: "https://liff.line.me/" + process.env.LIFF_ID },
                                style: "primary",
                                color: "#06C755"
                            }
                        ]
                    }
                }
            }]
        };

        await axios.post('https://api.line.me/v2/bot/message/push', message, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        });

        res.json({ status: "success", data: { message: "เธชเนเธเธเนเธญเธเธงเธฒเธกเธ—เธ”เธชเธญเธเธชเธณเน€เธฃเนเธ! เน€เธเนเธเนเธฅเธเนเธเธญเธเธเธธเธ“เนเธ”เนเน€เธฅเธข" } });

    } catch (e) {
        console.error(e);
        res.status(500).json({ status: "error", message: e.message });
    }
});

// ==========================================
// ๐•น๏ธ GAME MONITOR API (Fixed & Updated)
// ==========================================

// 1. เธ”เธถเธเธเธเน€เธฅเนเธ KYT เธงเธฑเธเธเธตเน (เนเธเน: เธฅเธ h.id เธญเธญเธ + เนเธเนเน€เธงเธฅเธฒเนเธ—เธข)
// --- API: เธ”เธถเธเธเนเธญเธกเธนเธฅ Monitor KYT (เธเธเธฑเธเนเธเนเนเธ: เธ•เธฃเธเธเธฑเธเธ•เธฒเธฃเธฒเธ kyt_questions เธเธญเธเธเธธเธ“) ---
app.get('/api/admin/monitor/kyt', isAdmin, async (req, res) => {
    try {
        const now = new Date();
        const thaiDate = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Bangkok"}));
        const todayStr = thaiDate.toISOString().split('T')[0];

        // เธ”เธถเธ questionText, selectedOption เนเธฅเธฐ correctOption เน€เธเธทเนเธญเนเธชเธ”เธเนเธ Monitor
        const [rows] = await db.query(`
            SELECT
                h.historyId AS id,
                u.lineUserId,
                u.fullName,
                u.employeeId,
                u.pictureUrl,
                h.isCorrect,
                h.earnedPoints,
                h.playedAt,
                h.selectedAnswer AS selectedOption,
                COALESCE(q.questionText, 'เธเธณเธ–เธฒเธกเธ–เธนเธเธฅเธเนเธเนเธฅเนเธง') AS questionText,
                COALESCE(q.correctOption, '') AS correctOption
            FROM user_game_history h
            JOIN users u ON h.lineUserId = u.lineUserId
            LEFT JOIN kyt_questions q ON h.questionId = q.questionId
            WHERE DATE(h.playedAt) = ? 
            ORDER BY h.playedAt DESC
        `, [todayStr]); 
        
        res.json({ status: "success", data: rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 2. เธ”เธถเธเธเธฃเธฐเธงเธฑเธ•เธด Hunter (เน€เธซเธกเธทเธญเธเน€เธ”เธดเธก)
app.get('/api/admin/monitor/hunter', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.fullName, u.pictureUrl, l.title, h.stars, h.clearedAt
            FROM user_hunter_history h
            JOIN users u ON h.lineUserId = u.lineUserId
            JOIN hunter_levels l ON h.levelId = l.levelId
            ORDER BY h.clearedAt DESC LIMIT 50
        `);
        res.json({ status: "success", data: rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 3. เธ”เธน Streak (เน€เธซเธกเธทเธญเธเน€เธ”เธดเธก)
app.get('/api/admin/monitor/streaks', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.fullName, u.pictureUrl, u.employeeId, s.currentStreak, s.lastPlayedDate
            FROM user_streaks s
            JOIN users u ON s.lineUserId = u.lineUserId
            ORDER BY s.currentStreak DESC LIMIT 100
        `);
        res.json({ status: "success", data: rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// โญ 4. (เนเธซเธกเน) เธเธฃเธฐเน€เธเนเธฒเน€เธซเธฃเธตเธขเธ (Coin Wallet)
app.get('/api/admin/monitor/coins', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT fullName, pictureUrl, employeeId, coinBalance 
            FROM users 
            ORDER BY coinBalance DESC LIMIT 100
        `);
        res.json({ status: "success", data: rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// --- เธเธฑเธเธเนเธเธฑเธเธเธฅเธฒเธ: เธชเนเธเนเธเนเธเน€เธ•เธทเธญเธ Streak (เนเธขเธ 2 เธเธฅเธธเนเธก: เน€เธ•เธทเธญเธ / เธ”เธฑเธ) ---
async function broadcastStreakReminders() {
    const conn = await db.getClient();
    console.log(`[${new Date().toLocaleString()}] เน€เธฃเธดเนเธกเธเธฃเธฐเธเธงเธเธเธฒเธฃเนเธเนเธเน€เธ•เธทเธญเธ Streak เนเธเธเนเธขเธเธเธฅเธธเนเธก...`);

    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) return { success: false, message: "No Token" };

    try {
        // เธเธฅเธธเนเธก 1: Warning (เธซเธฒเธขเนเธ 1 เธงเธฑเธ)
        const [warningUsers] = await conn.query(`
            SELECT lineUserId, currentStreak FROM user_streaks 
            WHERE currentStreak > 0 AND DATEDIFF(CURDATE(), lastPlayedDate) = 1
        `);


        // Helper function เธขเธดเธเนเธฅเธเน
        const sendPush = async (users, title, text, color, btnText) => {
            let count = 0;
            for (const u of users) {
                try {
                    await axios.post('https://api.line.me/v2/bot/message/push', {
                        to: u.lineUserId,
                        messages: [{
                            type: "flex", altText: title,
                            contents: {
                                type: "bubble",
                                body: {
                                    type: "box", layout: "vertical",
                                    contents: [
                                        { type: "text", text: title, weight: "bold", size: "xl", color: color },
                                        { type: "text", text: text.replace('{streak}', u.currentStreak), size: "md", color: "#555555", margin: "md", wrap: true },
                                    ]
                                },
                                footer: {
                                    type: "box", layout: "vertical",
                                    contents: [{
                                        type: "button", style: "primary", color: color,
                                        // โญ เนเธเนเธ•เธฃเธเธเธตเน: เนเธเน process.env.LIFF_ID
                                        action: { type: "uri", label: btnText, uri: "https://liff.line.me/" + process.env.LIFF_ID }
                                    }]
                                }
                            }
                        }]
                    }, { headers: { 'Authorization': `Bearer ${token}` } });
                    count++;
                } catch (e) { console.error(`Failed to send to ${u.lineUserId}`); }
            }
            return count;
        };

        const sentWarning = await sendPush(warningUsers, "โ ๏ธ เน€เธ•เธทเธญเธเธ เธฑเธข! เนเธเธเธฐเธ”เธฑเธ", "เธเธธเธ“เธฃเธฑเธเธฉเธฒเธชเธ–เธดเธ•เธดเธกเธฒ {streak} เธงเธฑเธเนเธฅเนเธง เธฃเธตเธเน€เธเนเธฒเธกเธฒเน€เธฅเนเธเธเนเธญเธเน€เธ—เธตเนเธขเธเธเธทเธ!", "#ffaa00", "เน€เธเนเธฒเน€เธ•เธดเธกเนเธ ๐”ฅ");

        return { success: true, message: `Warning: ${sentWarning}` };

    } catch (e) {
        return { success: false, message: e.message };
    } finally { conn.release(); }
}

// --- เธ•เธฑเนเธเน€เธงเธฅเธฒ Auto (Cron Job) ---
// '0 12 * * *' เนเธเธฅเธงเนเธฒ: เธเธฒเธ—เธตเธ—เธตเน 0 เธเธญเธเธเธฑเนเธงเนเธกเธเธ—เธตเน 12 (เน€เธ—เธตเนเธขเธเธ•เธฃเธ)
cron.schedule('0 12 * * *', async () => {
    console.log(`[${new Date().toLocaleString()}] โฐ เธ–เธถเธเน€เธงเธฅเธฒเนเธเนเธเน€เธ•เธทเธญเธเธญเธฑเธ•เนเธเธกเธฑเธ•เธด (เธฃเธญเธ 12:00)...`);
    
    // เน€เธฃเธตเธขเธเธเธฑเธเธเนเธเธฑเธเนเธเนเธเน€เธ•เธทเธญเธ
    const result = await broadcastStreakReminders();
    console.log(`เธเธฅเธเธฒเธฃเธ—เธณเธเธฒเธ: ${result.message}`);
    
}, {
    scheduled: true,
    timezone: "Asia/Bangkok" // เธชเธณเธเธฑเธเธกเธฒเธ! เธ•เนเธญเธเธฃเธฐเธเธธเน€เธเธทเนเธญเนเธซเนเธ•เธฃเธเธเธฑเธเน€เธงเธฅเธฒเนเธ—เธข
});

// ======================================================
// ADMIN: Analytics
// ======================================================
app.get('/api/admin/analytics', isAdmin, async (_req, res) => {
    try {
        const [[totals]] = await db.query(`
            SELECT
                COUNT(*) AS total,
                SUM(status='approved') AS approved,
                SUM(status='pending') AS pending,
                SUM(status='rejected') AS rejected
            FROM submissions`);
        const [[userCount]] = await db.query("SELECT COUNT(*) AS cnt FROM users");

        // 8-week trend
        const [weeklyRows] = await db.query(`
            SELECT YEARWEEK(createdAt, 1) AS yw,
                   MIN(DATE(createdAt)) AS weekStart,
                   COUNT(*) AS cnt
            FROM submissions
            WHERE createdAt >= NOW() - INTERVAL 56 DAY
            GROUP BY yw ORDER BY yw`);
        const weeklyTrend = weeklyRows.map(r => ({
            label: new Date(r.weekStart).toLocaleDateString('th-TH', { day:'numeric', month:'short' }),
            count: r.cnt
        }));

        // Top 10 reporters
        const [topReporters] = await db.query(`
            SELECT u.fullName, u.pictureUrl, u.department, COUNT(s.submissionId) AS cnt
            FROM submissions s
            JOIN users u ON s.lineUserId = u.lineUserId
            WHERE s.status = 'approved'
            GROUP BY s.lineUserId ORDER BY cnt DESC LIMIT 10`);

        res.json({ status: 'success', data: {
            totalSubmissions: Number(totals.total),
            approvedCount: Number(totals.approved || 0),
            pendingCount: Number(totals.pending || 0),
            rejectedCount: Number(totals.rejected || 0),
            totalUsers: Number(userCount.cnt),
            weeklyTrend,
            topReporters: topReporters.map(r => ({ ...r, count: Number(r.cnt) }))
        }});
    } catch(e) { res.status(500).json({ status:'error', message: e.message }); }
});

// ======================================================
// ADMIN: Department Safety Scores
// ======================================================
app.get('/api/admin/department-scores', isAdmin, async (_req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                COALESCE(NULLIF(u.department,''), 'เนเธกเนเธฃเธฐเธเธธเนเธเธเธ') AS department,
                COUNT(DISTINCT u.lineUserId) AS memberCount,
                ROUND(AVG(u.totalScore), 1) AS avgScore,
                COUNT(s.submissionId) AS totalSubmissions
            FROM users u
            LEFT JOIN submissions s ON u.lineUserId = s.lineUserId AND s.status = 'approved'
            GROUP BY department
            ORDER BY avgScore DESC`);
        res.json({ status: 'success', data: rows.map(r => ({
            ...r,
            memberCount: Number(r.memberCount),
            avgScore: Number(r.avgScore),
            totalSubmissions: Number(r.totalSubmissions)
        }))});
    } catch(e) { res.status(500).json({ status:'error', message: e.message }); }
});

// ======================================================
// ADMIN: Export Submissions (CSV)
// ======================================================
app.get('/api/admin/export/submissions', isAdmin, async (req, res) => {
    const { status, from, to } = req.query;
    try {
        let whereClause = '1=1';
        const params = [];
        if (status && status !== 'all') { whereClause += ' AND s.status = ?'; params.push(status); }
        if (from) { whereClause += ' AND DATE(s.createdAt) >= ?'; params.push(from); }
        if (to)   { whereClause += ' AND DATE(s.createdAt) <= ?'; params.push(to); }

        const [rows] = await db.query(`
            SELECT s.submissionId, u.fullName, u.employeeId,
                   COALESCE(u.department,'') AS department,
                   a.title AS activityTitle,
                   s.description, s.status, s.points,
                   s.createdAt, s.reviewedAt
            FROM submissions s
            JOIN users u ON s.lineUserId = u.lineUserId
            JOIN activities a ON s.activityId = a.activityId
            WHERE ${whereClause}
            ORDER BY s.createdAt DESC`, params);

        const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const header = ['ID','เธเธทเนเธญ','เธฃเธซเธฑเธชเธเธเธฑเธเธเธฒเธ','เนเธเธเธ','เธเธดเธเธเธฃเธฃเธก','เธเธณเธญเธเธดเธเธฒเธข','เธชเธ–เธฒเธเธฐ','เธเธฐเนเธเธ','เธงเธฑเธเธ—เธตเนเธชเนเธ','เธงเธฑเธเธ—เธตเนเธ•เธฃเธงเธ'];
        const csvLines = [
            '\uFEFF' + header.join(','),
            ...rows.map(r => [
                r.submissionId, r.fullName, r.employeeId, r.department,
                r.activityTitle, r.description, r.status, r.points || 0,
                new Date(r.createdAt).toLocaleString('th-TH'),
                r.reviewedAt ? new Date(r.reviewedAt).toLocaleString('th-TH') : ''
            ].map(escape).join(','))
        ];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="safety-spot-reports-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(csvLines.join('\r\n'));
    } catch(e) { res.status(500).json({ status:'error', message: e.message }); }
});

// ======================================================
// ADMIN: Export Submissions โ€” Print/PDF view
// ======================================================
app.get('/api/admin/export/submissions/print', isAdmin, async (req, res) => {
    const { status, from, to } = req.query;
    try {
        let whereClause = '1=1';
        const params = [];
        if (status && status !== 'all') { whereClause += ' AND s.status = ?'; params.push(status); }
        if (from) { whereClause += ' AND DATE(s.createdAt) >= ?'; params.push(from); }
        if (to)   { whereClause += ' AND DATE(s.createdAt) <= ?'; params.push(to); }

        const [rows] = await db.query(`
            SELECT s.submissionId, u.fullName, u.employeeId, COALESCE(u.department,'') AS department,
                   a.title AS activityTitle, s.description, s.status, s.points, s.createdAt
            FROM submissions s
            JOIN users u ON s.lineUserId = u.lineUserId
            JOIN activities a ON s.activityId = a.activityId
            WHERE ${whereClause}
            ORDER BY s.createdAt DESC`, params);

        const statusLabel = { approved:'เธญเธเธธเธกเธฑเธ•เธด', pending:'เธฃเธญเธ•เธฃเธงเธ', rejected:'เธเธเธดเน€เธชเธ' };
        const rowsHtml = rows.map((r, i) => `
            <tr>
                <td>${i+1}</td>
                <td>${r.fullName}<br><small class="text-muted">${r.employeeId || ''} ${r.department ? '| '+r.department : ''}</small></td>
                <td>${r.activityTitle}</td>
                <td style="max-width:300px;font-size:0.8em;">${r.description || ''}</td>
                <td><span class="badge" style="background:${r.status==='approved'?'#06C755':r.status==='pending'?'#f59e0b':'#ef4444'};color:#fff">${statusLabel[r.status]||r.status}</span></td>
                <td>${r.points || 0}</td>
                <td>${new Date(r.createdAt).toLocaleDateString('th-TH')}</td>
            </tr>`).join('');

        res.send(`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">
            <title>Safety Spot Report Export</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>@media print{.no-print{display:none}body{font-size:0.85rem}}th{background:#1a1a2e!important;color:#fff!important}</style>
        </head><body class="p-3">
            <div class="d-flex justify-content-between align-items-center mb-3 no-print">
                <h5>Safety Spot โ€” เธฃเธฒเธขเธเธฒเธ Export (${rows.length} เธฃเธฒเธขเธเธฒเธฃ)</h5>
                <button onclick="window.print()" class="btn btn-danger btn-sm">Print / Save PDF</button>
            </div>
            <h6 class="text-muted mb-3">เธชเธฃเนเธฒเธเน€เธกเธทเนเธญ: ${new Date().toLocaleString('th-TH')}</h6>
            <table class="table table-bordered table-sm">
                <thead><tr><th>#</th><th>เธเธนเนเธชเนเธ</th><th>เธเธดเธเธเธฃเธฃเธก</th><th>เธเธณเธญเธเธดเธเธฒเธข</th><th>เธชเธ–เธฒเธเธฐ</th><th>เธเธฐเนเธเธ</th><th>เธงเธฑเธเธ—เธตเน</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </body></html>`);
    } catch(e) { res.status(500).send('Error: ' + e.message); }
});

// ======================================================
// ADMIN: Audit Logs
// ======================================================
app.get('/api/admin/audit-logs', isAdmin, async (req, res) => {
    const { page = 1, limit = 50, action, adminId, dateFrom, dateTo } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conditions = [];
    const params = [];

    if (action)   { conditions.push("action = ?");            params.push(action); }
    if (adminId)  { conditions.push("adminId = ?");           params.push(adminId); }
    if (dateFrom) { conditions.push("createdAt >= ?");        params.push(dateFrom); }
    if (dateTo)   { conditions.push("createdAt <= ?");        params.push(dateTo + ' 23:59:59'); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    try {
        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM audit_logs ${where}`, params);
        const [rows] = await db.query(
            `SELECT logId, adminId, adminName, action, targetType, targetId, targetName, detail, createdAt
             FROM audit_logs ${where}
             ORDER BY createdAt DESC
             LIMIT ? OFFSET ?`,
            [...params, Number(limit), offset]
        );
        res.json({ status: "success", data: { rows, total, page: Number(page), limit: Number(limit) } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// ======================================================
// STARTUP MIGRATIONS โ€” LOTTERY TABLES
// ======================================================
db.query("ALTER TABLE users ADD COLUMN lotteryWinCount INT DEFAULT 0").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN lotteryTotalWinnings INT DEFAULT 0").catch(() => {});
db.query("ALTER TABLE lottery_quiz_answers ADD COLUMN usedForTicketId INT DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE lottery_quiz_answers ADD INDEX idx_quiz_answers_used (usedForTicketId)").catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_rounds (
  roundId       VARCHAR(50) PRIMARY KEY,
  drawDate      DATE NOT NULL,
  last2         VARCHAR(2)  DEFAULT NULL,
  last3_front   VARCHAR(3)  DEFAULT NULL,
  last3_back    VARCHAR(3)  DEFAULT NULL,
  status        VARCHAR(20) DEFAULT 'open',
  source        VARCHAR(50) DEFAULT 'manual',
  confirmedBy   VARCHAR(50) DEFAULT NULL,
  createdAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lottery_rounds_status (status),
  INDEX idx_lottery_rounds_date (drawDate)
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_tickets (
  ticketId      INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  roundId       VARCHAR(50) NOT NULL,
  ticketType    VARCHAR(10) NOT NULL,
  number        VARCHAR(3)  NOT NULL,
  price         INT         NOT NULL DEFAULT 0,
  isGoldTicket  BOOLEAN     DEFAULT FALSE,
  isWinner      BOOLEAN     DEFAULT FALSE,
  prizeAmount   INT         DEFAULT 0,
  isPrizeClaimed BOOLEAN    DEFAULT FALSE,
  purchasedAt   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (roundId)    REFERENCES lottery_rounds(roundId),
  INDEX idx_tickets_user_round (lineUserId, roundId),
  INDEX idx_tickets_round_type (roundId, ticketType, number),
  INDEX idx_tickets_winner     (isWinner, isPrizeClaimed)
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_daily_purchases (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  purchaseDate  DATE        NOT NULL,
  count         INT         DEFAULT 0,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  UNIQUE KEY uq_daily_purchase (lineUserId, purchaseDate)
)`).catch(() => {});

db.query(`ALTER TABLE lottery_rounds MODIFY source VARCHAR(50) DEFAULT 'manual'`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_gold_ticket_claims (
  claimId       INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  roundId       VARCHAR(50) NOT NULL,
  ticketId      INT         DEFAULT NULL,
  department    VARCHAR(100) NOT NULL DEFAULT '',
  incidentFreeSince DATE    NOT NULL,
  claimedAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (roundId) REFERENCES lottery_rounds(roundId),
  FOREIGN KEY (ticketId) REFERENCES lottery_tickets(ticketId),
  UNIQUE KEY uq_gold_claim_user_round (lineUserId, roundId),
  INDEX idx_gold_claim_round (roundId)
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_quiz_questions (
  questionId    INT AUTO_INCREMENT PRIMARY KEY,
  questionText  TEXT        NOT NULL,
  optionA       TEXT        NOT NULL,
  optionB       TEXT        NOT NULL,
  optionC       TEXT        NOT NULL,
  optionD       TEXT        NOT NULL,
  correctOption VARCHAR(1)  NOT NULL,
  category      VARCHAR(50) DEFAULT 'เธ—เธฑเนเธงเนเธ',
  isActive      BOOLEAN     DEFAULT TRUE,
  generatedBy   VARCHAR(50) DEFAULT 'manual',
  createdAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_quiz_active_category (isActive, category)
)`).catch(() => {});

db.query(`ALTER TABLE lottery_quiz_questions MODIFY generatedBy VARCHAR(50) DEFAULT 'manual'`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_settings (
  settingKey   VARCHAR(50) PRIMARY KEY,
  settingValue VARCHAR(255) NOT NULL,
  updatedBy    VARCHAR(50) DEFAULT NULL,
  updatedAt    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).catch(() => {});

db.query(`INSERT IGNORE INTO lottery_settings (settingKey, settingValue) VALUES
  ('user_enabled', 'false'),
  ('disabled_message', 'Safety Lottery is being prepared by the admin team.')`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_quiz_answers (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId     VARCHAR(50) NOT NULL,
  questionId     INT         NOT NULL,
  selectedOption VARCHAR(1)  NOT NULL,
  isCorrect      BOOLEAN     NOT NULL,
  usedForTicketId INT        DEFAULT NULL,
  answeredAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (questionId) REFERENCES lottery_quiz_questions(questionId) ON DELETE CASCADE,
  INDEX idx_quiz_answers_used     (usedForTicketId),
  INDEX idx_quiz_answers_user     (lineUserId, answeredAt),
  INDEX idx_quiz_answers_question (questionId, isCorrect)
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS lottery_results_history (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  roundId          VARCHAR(50) NOT NULL,
  totalTicketsSold INT         DEFAULT 0,
  totalWinners     INT         DEFAULT 0,
  totalPrizesPaid  INT         DEFAULT 0,
  createdAt        TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roundId) REFERENCES lottery_rounds(roundId),
  UNIQUE KEY uq_results_round (roundId)
)`).catch(() => {});

// ======================================================
// LOTTERY HELPER โ€” LINE Push Flex Message
// ======================================================
const LOTTERY_GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite'
];

const DEFAULT_LOTTERY_DISABLED_MESSAGE = 'Safety Lottery is being prepared by the admin team.';

async function getLotterySettings(conn = db) {
    const [rows] = await conn.query(
        `SELECT settingKey, settingValue FROM lottery_settings
         WHERE settingKey IN ('user_enabled', 'disabled_message')`
    );
    const map = Object.fromEntries(rows.map(r => [r.settingKey, r.settingValue]));
    return {
        userEnabled: map.user_enabled === 'true',
        disabledMessage: map.disabled_message || DEFAULT_LOTTERY_DISABLED_MESSAGE
    };
}

async function ensureLotteryUserEnabled(conn = db) {
    const settings = await getLotterySettings(conn);
    if (!settings.userEnabled) {
        const err = new Error(settings.disabledMessage || DEFAULT_LOTTERY_DISABLED_MESSAGE);
        err.statusCode = 403;
        err.code = 'LOTTERY_DISABLED';
        throw err;
    }
    return settings;
}

async function sendLotteryWinNotification(lineUserId, ticketData) {
    const flexMessage = {
        type: 'flex',
        altText: '๐ เธขเธดเธเธ”เธตเธ”เนเธงเธข! เธเธธเธ“เธ–เธนเธ Safety Lottery!',
        contents: {
            type: 'bubble', size: 'mega',
            header: {
                type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '20px',
                contents: [
                    { type: 'text', text: '๐ เธขเธดเธเธ”เธตเธ”เนเธงเธข!', color: '#FFFFFF', size: 'xl', weight: 'bold', align: 'center' },
                    { type: 'text', text: 'เธเธธเธ“เธ–เธนเธ Safety Lottery!', color: '#FFFFFF', size: 'md', align: 'center', margin: 'sm' }
                ]
            },
            body: {
                type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px',
                contents: [
                    { type: 'box', layout: 'horizontal', contents: [
                        { type: 'text', text: 'เธเธงเธ”เธงเธฑเธเธ—เธตเน', size: 'sm', color: '#888888', flex: 1 },
                        { type: 'text', text: ticketData.drawDate, size: 'sm', weight: 'bold', flex: 2, align: 'end' }
                    ]},
                    { type: 'box', layout: 'horizontal', contents: [
                        { type: 'text', text: 'เธเธฃเธฐเน€เธ เธ—', size: 'sm', color: '#888888', flex: 1 },
                        { type: 'text', text: ticketData.ticketType === 'two' ? '๐ข 2 เธ•เธฑเธงเธ—เนเธฒเธข' : '๐”ด 3 เธ•เธฑเธงเธ—เนเธฒเธข', size: 'sm', weight: 'bold', flex: 2, align: 'end' }
                    ]},
                    { type: 'box', layout: 'horizontal', contents: [
                        { type: 'text', text: 'เน€เธฅเธเธเธญเธเธเธธเธ“', size: 'sm', color: '#888888', flex: 1 },
                        { type: 'text', text: ticketData.number, size: 'xl', weight: 'bold', color: '#06C755', flex: 2, align: 'end' }
                    ]},
                    { type: 'separator', margin: 'lg' },
                    { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
                        { type: 'text', text: '๐ เธฃเธฒเธเธงเธฑเธฅ', size: 'md', weight: 'bold', flex: 1 },
                        { type: 'text', text: `+${ticketData.prizeAmount.toLocaleString()} Points`, size: 'lg', weight: 'bold', color: '#FFB800', flex: 2, align: 'end' }
                    ]}
                ]
            },
            footer: {
                type: 'box', layout: 'vertical', paddingAll: '15px',
                contents: [{
                    type: 'button',
                    action: { type: 'uri', label: '๐ฐ เธ”เธนเธฃเธฒเธขเธฅเธฐเน€เธญเธตเธขเธ”', uri: `https://liff.line.me/${process.env.LIFF_ID}` },
                    style: 'primary', color: '#06C755', height: 'sm'
                }]
            }
        }
    };
    try {
        await axios.post('https://api.line.me/v2/bot/message/push',
            { to: lineUserId, messages: [flexMessage] },
            { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
        );
    } catch (err) {
        console.error(`โ Lottery LINE Push failed for ${lineUserId}:`, err.response?.data || err.message);
    }
}

// ======================================================
// LOTTERY CRON โ€” เธ”เธถเธเธเธฅเธซเธงเธขเธญเธฑเธ•เนเธเธกเธฑเธ•เธด 16:00 เนเธ—เธข (09:00 UTC) เธงเธฑเธเธ—เธตเน 1 & 16
// ======================================================
async function fetchAndSaveLotteryResults(retryCount = 0) {
    const dateStr = getBangkokDateString();
    console.log(`๐ฐ fetchLotteryResults: ${dateStr} (retry ${retryCount})`);

    try {
        const [[round]] = await db.query(
            "SELECT * FROM lottery_rounds WHERE roundId = ? AND status IN ('open','closed')", [dateStr]);
        if (!round) { console.log('โ ๏ธ No open round for today'); return; }

        const htmlRes = await axios.get('https://www.glo.or.th/check/getLotteryResult', {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const geminiPayload = {
            contents: [{ parts: [{ text:
                `เธเธฒเธเธเนเธญเธกเธนเธฅ HTML เธเธฅเธซเธงเธขเนเธ—เธขเธเธตเน เธ”เธถเธเน€เธเธเธฒเธฐเธเธฅเธฃเธฒเธเธงเธฑเธฅเน€เธฅเธเธ—เนเธฒเธข 2 เธ•เธฑเธง เนเธฅเธฐเน€เธฅเธเธ—เนเธฒเธข 3 เธ•เธฑเธง เธญเธญเธเธกเธฒเน€เธเนเธ JSON\n` +
                `เธ•เธญเธเน€เธเนเธ JSON เน€เธ—เนเธฒเธเธฑเนเธ เธซเนเธฒเธกเธกเธตเธเนเธญเธเธงเธฒเธกเธญเธทเนเธ:\n{"last2":"XX","last3_back":"XXX","last3_front":"XXX"}\n\nHTML:\n${String(htmlRes.data).slice(0, 8000)}`
            }]}]
        };

        let parsed = null;
        let sourceModel = null;
        let lastGeminiError = null;
        for (const model of LOTTERY_GEMINI_MODELS) {
            try {
                const geminiRes = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
                    geminiPayload, { timeout: 20000 }
                );

                let rawText = geminiRes.data.candidates[0].content.parts[0].text;
                rawText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                parsed = JSON.parse(rawText);
                sourceModel = model;
                break;
            } catch (geminiErr) {
                lastGeminiError = geminiErr;
                console.warn(`Lottery result Gemini model failed: ${model}`, geminiErr.response?.status || geminiErr.message);
            }
        }
        if (!parsed) throw lastGeminiError || new Error('Unable to parse lottery result with Gemini');

        if (!parsed.last2 || !/^\d{2}$/.test(parsed.last2)) throw new Error('Invalid last2: ' + parsed.last2);
        if (!parsed.last3_back || !/^\d{3}$/.test(parsed.last3_back)) throw new Error('Invalid last3_back: ' + parsed.last3_back);

        await db.query(
            `UPDATE lottery_rounds SET last2=?, last3_front=?, last3_back=?, status='pending_confirm', source=? WHERE roundId=?`,
            [parsed.last2, parsed.last3_front || null, parsed.last3_back, sourceModel || 'auto_gemini', dateStr]
        );
        console.log(`โ… Lottery result fetched: 2เธ•เธฑเธง=${parsed.last2} 3เธ•เธฑเธงเธ—เนเธฒเธข=${parsed.last3_back}`);
    } catch (err) {
        console.error(`โ fetchLotteryResults failed (retry ${retryCount}):`, err.message);
        if (retryCount < 3) {
            const delays = [30, 60, 90]; // เธเธฒเธ—เธต
            setTimeout(() => fetchAndSaveLotteryResults(retryCount + 1), delays[retryCount] * 60 * 1000);
        } else {
            await db.query("UPDATE lottery_rounds SET status='pending_manual' WHERE roundId=?", [dateStr]).catch(() => {});
            console.log('โ ๏ธ Lottery auto-fetch failed 3 times โ€” set to pending_manual');
        }
    }
}

// เธ—เธธเธเธงเธฑเธเธ—เธตเน 1 & 16 เน€เธงเธฅเธฒ 16:00 เนเธ—เธข = 09:00 UTC
cron.schedule('0 9 1,16 * *', () => fetchAndSaveLotteryResults(0), { timezone: 'UTC' });

function getBangkokDateString(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

function toLotteryDateString(value) {
    if (value instanceof Date) return getBangkokDateString(value);
    const text = String(value || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    return text;
}

function getLotteryCloseAt(drawDate) {
    const drawStart = new Date(`${toLotteryDateString(drawDate)}T00:00:00+07:00`);
    return new Date(drawStart.getTime() - 60 * 1000);
}

function isLotteryRoundClosed(round) {
    return !round || round.status !== 'open' || new Date() >= getLotteryCloseAt(round.drawDate);
}

const LOTTERY_INCIDENT_KEYWORDS = [
    'incident', 'accident', 'near miss',
    'เธญเธธเธเธฑเธ•เธดเน€เธซเธ•เธธ', 'เธเธฒเธ”เน€เธเนเธ', 'เน€เธเนเธ', 'เน€เธเธทเธญเธเน€เธเธดเธ”เธญเธธเธเธฑเธ•เธดเน€เธซเธ•เธธ'
];

function getLotteryIncidentWhere(aliasPrefix = '') {
    const activity = `${aliasPrefix}a`;
    const submission = `${aliasPrefix}s`;
    const textExpr = `LOWER(CONCAT(COALESCE(${activity}.title,''),' ',COALESCE(${activity}.description,''),' ',COALESCE(${submission}.description,'')))`;
    const where = LOTTERY_INCIDENT_KEYWORDS.map(() => `${textExpr} LIKE ?`).join(' OR ');
    const params = LOTTERY_INCIDENT_KEYWORDS.map(k => `%${k.toLowerCase()}%`);
    return { where: `(${where})`, params };
}

async function getLotteryGoldEligibility(lineUserId, conn = db) {
    const [[round]] = await conn.query(
        `SELECT roundId, DATE_FORMAT(drawDate, '%Y-%m-%d') AS drawDate, status
         FROM lottery_rounds
         WHERE status IN ('open','closed','pending_confirm','pending_manual')
         ORDER BY drawDate ASC LIMIT 1`
    );
    if (!round) return { eligible: false, reason: 'เนเธกเนเธกเธตเธเธงเธ”เธ—เธตเนเน€เธเธดเธ”เธญเธขเธนเน', currentRound: null };
    if (isLotteryRoundClosed(round)) return { eligible: false, reason: 'เธเธงเธ”เธเธตเนเธเธดเธ”เธฃเธฑเธเนเธฅเนเธง', currentRound: round };

    const [[user]] = await conn.query(
        'SELECT department FROM users WHERE lineUserId=?',
        [lineUserId]);
    const department = (user?.department || '').trim();
    if (!department) return { eligible: false, reason: 'เธเธฃเธธเธ“เธฒเธฃเธฐเธเธธเนเธเธเธเธเนเธญเธ', currentRound: round };

    const [[claimed]] = await conn.query(
        'SELECT ticketId FROM lottery_gold_ticket_claims WHERE lineUserId=? AND roundId=?',
        [lineUserId, round.roundId]);
    if (claimed) {
        return { eligible: false, reason: 'เธฃเธฑเธเธ•เธฑเนเธงเธ—เธญเธเธชเธณเธซเธฃเธฑเธเธเธงเธ”เธเธตเนเนเธฅเนเธง', alreadyClaimed: true, ticketId: claimed.ticketId, currentRound: round, department };
    }

    const { where, params } = getLotteryIncidentWhere();
    const [[incidentStats]] = await conn.query(
        `SELECT COUNT(*) AS incidentCount, MAX(s.createdAt) AS lastIncidentAt
         FROM submissions s
         JOIN users u ON s.lineUserId = u.lineUserId
         JOIN activities a ON s.activityId = a.activityId
         WHERE u.department = ?
           AND s.status IN ('pending','approved')
           AND s.createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           AND ${where}`,
        [department, ...params]);

    const incidentsLast30 = Number(incidentStats?.incidentCount || 0);
    if (incidentsLast30 > 0) {
        return {
            eligible: false,
            reason: 'เนเธเธเธเธกเธต Incident เนเธเธเนเธงเธ 30 เธงเธฑเธเธ—เธตเนเธเนเธฒเธเธกเธฒ',
            currentRound: round,
            department,
            incidentsLast30,
            lastIncidentAt: incidentStats.lastIncidentAt
        };
    }

    const since = getBangkokDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    return { eligible: true, reason: 'เนเธเธเธเนเธกเนเธกเธต Incident เธเธฃเธ 30 เธงเธฑเธ', currentRound: round, department, incidentsLast30, incidentFreeSince: since };
}

// ======================================================
// LOTTERY USER APIs
// ======================================================

// GET /api/lottery/current-round โ€” เธเธงเธ”เธเธฑเธเธเธธเธเธฑเธ + countdown
app.get('/api/lottery/current-round', async (req, res) => {
    try {
        const settings = await getLotterySettings();
        if (!settings.userEnabled) {
            return res.json({
                status: 'success',
                data: {
                    featureEnabled: false,
                    disabled: true,
                    message: settings.disabledMessage
                }
            });
        }

        const [[round]] = await db.query(
            `SELECT roundId, DATE_FORMAT(drawDate, '%Y-%m-%d') AS drawDate, last2, last3_front, last3_back,
                    status, source, confirmedBy, createdAt
             FROM lottery_rounds WHERE status IN ('open','closed','pending_confirm','pending_manual')
             ORDER BY drawDate ASC LIMIT 1`
        );
        if (!round) return res.json({ status: 'success', data: null });

        const closeAt = getLotteryCloseAt(round.drawDate);
        const msLeft = Math.max(0, closeAt - new Date());
        const hoursLeft = Math.floor(msLeft / 3600000);
        const minutesLeft = Math.floor((msLeft % 3600000) / 60000);

        res.json({ status: 'success', data: { ...round, featureEnabled: true, closeAt, hoursLeft, minutesLeft, isClosed: isLotteryRoundClosed(round) } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// GET /api/lottery/quiz-question โ€” เธชเธธเนเธกเธเธณเธ–เธฒเธก Safety 1 เธเนเธญ
app.get('/api/lottery/quiz-question', async (req, res) => {
    try {
        await ensureLotteryUserEnabled();
        const [rows] = await db.query(
            `SELECT questionId, questionText, optionA, optionB, optionC, optionD, category
             FROM lottery_quiz_questions WHERE isActive = TRUE
             ORDER BY RAND() LIMIT 1`
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'เนเธกเนเธเธเธเธณเธ–เธฒเธก' });
        res.json({ status: 'success', data: rows[0] });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/lottery/answer-quiz โ€” เธ•เธญเธเธเธณเธ–เธฒเธก (เธ–เธนเธ = +2 coins)
app.post('/api/lottery/answer-quiz', async (req, res) => {
    const { lineUserId, questionId, selectedOption } = req.body;
    if (!lineUserId || !questionId || !selectedOption)
        return res.status(400).json({ status: 'error', message: 'เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ' });
    try {
        await ensureLotteryUserEnabled();
        const [[q]] = await db.query(
            'SELECT correctOption FROM lottery_quiz_questions WHERE questionId = ? AND isActive = TRUE', [questionId]);
        if (!q) return res.status(404).json({ status: 'error', message: 'เนเธกเนเธเธเธเธณเธ–เธฒเธก' });

        const isCorrect = selectedOption.toUpperCase() === q.correctOption.toUpperCase();

        const [answerResult] = await db.query(
            'INSERT INTO lottery_quiz_answers (lineUserId, questionId, selectedOption, isCorrect) VALUES (?,?,?,?)',
            [lineUserId, questionId, selectedOption.toUpperCase(), isCorrect]
        );

        res.json({
            status: 'success',
            data: {
                isCorrect,
                correctOption: q.correctOption,
                newCoinBalance: null,
                pendingBonusCoins: isCorrect ? 2 : 0,
                quizAnswerId: answerResult.insertId
            }
        });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/lottery/buy-ticket โ€” เธเธทเนเธญเธ•เธฑเนเธง (transaction)
app.post('/api/lottery/buy-ticket', async (req, res) => {
    const { lineUserId, roundId, ticketType, number, quizAnswerId } = req.body;
    if (!lineUserId || !roundId || !ticketType || number == null || !quizAnswerId)
        return res.status(400).json({ status: 'error', message: 'เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ' });

    if (!['two', 'three'].includes(ticketType))
        return res.status(400).json({ status: 'error', message: 'เธเธฃเธฐเน€เธ เธ—เธ•เธฑเนเธงเนเธกเนเธ–เธนเธเธ•เนเธญเธ' });

    const numberText = String(number);
    const requiredDigits = ticketType === 'two' ? 2 : 3;
    if (!new RegExp(`^\\d{${requiredDigits}}$`).test(numberText))
        return res.status(400).json({ status: 'error', message: `เน€เธฅเธเธ•เนเธญเธเน€เธเนเธเธ•เธฑเธงเน€เธฅเธ ${requiredDigits} เธซเธฅเธฑเธ` });

    const price = ticketType === 'two' ? 10 : 30;
    const quizBonus = 2;
    const todayTH = getBangkokDateString();

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();
        await ensureLotteryUserEnabled(conn);

        const [[user]] = await conn.query('SELECT coinBalance FROM users WHERE lineUserId = ? FOR UPDATE', [lineUserId]);
        if (!user || Number(user.coinBalance) + quizBonus < price)
            throw new Error(`เน€เธซเธฃเธตเธขเธเนเธกเนเธเธญ (เธ•เนเธญเธเธเธฒเธฃ ${price} เน€เธซเธฃเธตเธขเธ)`);

        const [[round]] = await conn.query(
            "SELECT roundId, DATE_FORMAT(drawDate, '%Y-%m-%d') AS drawDate, status FROM lottery_rounds WHERE roundId = ?",
            [roundId]);
        if (isLotteryRoundClosed(round))
            throw new Error('เธเธงเธ”เธเธตเนเธเธดเธ”เธฃเธฑเธเนเธฅเนเธง');

        const [[quizPass]] = await conn.query(
            `SELECT id FROM lottery_quiz_answers
             WHERE id=? AND lineUserId=? AND isCorrect=TRUE AND usedForTicketId IS NULL
               AND answeredAt >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
             FOR UPDATE`,
            [quizAnswerId, lineUserId]);
        if (!quizPass)
            throw new Error('เธเธฃเธธเธ“เธฒเธ•เธญเธเธเธณเธ–เธฒเธก Safety เนเธซเนเธ–เธนเธเธเนเธญเธเธเธทเนเธญเธ•เธฑเนเธง');

        await conn.query(
            `INSERT INTO lottery_daily_purchases (lineUserId, purchaseDate, count) VALUES (?,?,0)
             ON DUPLICATE KEY UPDATE count = count`,
            [lineUserId, todayTH]);
        const [[dp]] = await conn.query(
            'SELECT count FROM lottery_daily_purchases WHERE lineUserId=? AND purchaseDate=? FOR UPDATE',
            [lineUserId, todayTH]);
        if (dp && Number(dp.count) >= 5)
            throw new Error('เธเธทเนเธญเธเธฃเธ 5 เนเธเธ•เนเธญเธงเธฑเธเนเธฅเนเธง');

        await conn.query('UPDATE users SET coinBalance = coinBalance - ? + ? WHERE lineUserId = ?', [price, quizBonus, lineUserId]);
        const [ticketResult] = await conn.query(
            'INSERT INTO lottery_tickets (lineUserId, roundId, ticketType, number, price) VALUES (?,?,?,?,?)',
            [lineUserId, roundId, ticketType, numberText, price]);
        await conn.query(
            'UPDATE lottery_quiz_answers SET usedForTicketId=? WHERE id=?',
            [ticketResult.insertId, quizAnswerId]);
        await conn.query(
            'UPDATE lottery_daily_purchases SET count = count + 1 WHERE lineUserId=? AND purchaseDate=?',
            [lineUserId, todayTH]);

        await conn.commit();

        const [[u]] = await db.query('SELECT coinBalance FROM users WHERE lineUserId = ?', [lineUserId]);
        res.json({ status: 'success', data: { newCoinBalance: u.coinBalance, message: 'เธเธทเนเธญเธ•เธฑเนเธงเธชเธณเน€เธฃเนเธ' } });
    } catch (err) {
        await conn.rollback();
        res.status(err.statusCode || 400).json({ status: 'error', message: err.message, code: err.code });
    } finally {
        conn.release();
    }
});

// GET /api/lottery/my-tickets โ€” เธ•เธฑเนเธงเธเธญเธ user เนเธขเธเธ•เธฒเธกเธเธงเธ”
app.get('/api/lottery/my-tickets', async (req, res) => {
    const { lineUserId } = req.query;
    if (!lineUserId) return res.status(400).json({ status: 'error', message: 'เธ•เนเธญเธเธฃเธฐเธเธธ lineUserId' });
    try {
        const [tickets] = await db.query(
            `SELECT t.*, DATE_FORMAT(r.drawDate, '%Y-%m-%d') AS drawDate, r.status AS roundStatus, r.last2, r.last3_back
             FROM lottery_tickets t
             JOIN lottery_rounds r ON t.roundId = r.roundId
             WHERE t.lineUserId = ?
             ORDER BY t.purchasedAt DESC`,
            [lineUserId]);

        const todayTH = getBangkokDateString();
        const [[dp]] = await db.query(
            'SELECT count FROM lottery_daily_purchases WHERE lineUserId=? AND purchaseDate=?',
            [lineUserId, todayTH]);

        res.json({ status: 'success', data: { tickets, todayCount: dp ? dp.count : 0 } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// GET /api/lottery/results โ€” เธเธฅเธฃเธฒเธเธงเธฑเธฅเธขเนเธญเธเธซเธฅเธฑเธ
app.get('/api/lottery/results', async (req, res) => {
    try {
        const [rounds] = await db.query(
            `SELECT r.roundId, DATE_FORMAT(r.drawDate, '%Y-%m-%d') AS drawDate, r.last2, r.last3_front,
                    r.last3_back, r.status, r.source, r.confirmedBy, r.createdAt,
                    h.totalTicketsSold, h.totalWinners, h.totalPrizesPaid
             FROM lottery_rounds r
             LEFT JOIN lottery_results_history h ON r.roundId = h.roundId
             WHERE r.status = 'completed'
             ORDER BY r.drawDate DESC LIMIT 20`
        );
        res.json({ status: 'success', data: rounds });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// GET /api/lottery/stats โ€” เธชเธ–เธดเธ•เธด
app.get('/api/lottery/stats', async (req, res) => {
    const { lineUserId } = req.query;
    try {
        const [[totals]] = await db.query(
            `SELECT COUNT(*) AS totalRounds,
                    SUM(h.totalTicketsSold) AS allTickets,
                    SUM(h.totalWinners) AS allWinners,
                    SUM(h.totalPrizesPaid) AS allPrizes
             FROM lottery_results_history h`);

        let userStats = null;
        if (lineUserId) {
            const [[u]] = await db.query(
                'SELECT lotteryWinCount, lotteryTotalWinnings FROM users WHERE lineUserId=?', [lineUserId]);
            const [[uc]] = await db.query(
                'SELECT COUNT(*) AS myTickets FROM lottery_tickets WHERE lineUserId=?', [lineUserId]);
            userStats = { ...u, myTickets: uc.myTickets };
        }
        res.json({ status: 'success', data: { totals, userStats } });
    } catch (e) { res.status(e.statusCode || 500).json({ status: 'error', message: e.message, code: e.code }); }
});

// GET /api/lottery/gold-eligibility โ€” เน€เธเนเธเธชเธดเธ—เธเธดเนเธ•เธฑเนเธงเธ—เธญเธเธเธฃเธต
app.get('/api/lottery/gold-eligibility', async (req, res) => {
    const { lineUserId } = req.query;
    if (!lineUserId) return res.status(400).json({ status: 'error', message: 'เธ•เนเธญเธเธฃเธฐเธเธธ lineUserId' });
    try {
        await ensureLotteryUserEnabled();
        const eligibility = await getLotteryGoldEligibility(lineUserId);
        res.json({ status: 'success', data: eligibility });
    } catch (e) { res.status(e.statusCode || 500).json({ status: 'error', message: e.message, code: e.code }); }
});

// POST /api/lottery/claim-gold-ticket โ€” เธฃเธฑเธเธ•เธฑเนเธงเธ—เธญเธเธเธฃเธต 3 เธ•เธฑเธงเธ—เนเธฒเธข
app.post('/api/lottery/claim-gold-ticket', async (req, res) => {
    const { lineUserId } = req.body;
    if (!lineUserId) return res.status(400).json({ status: 'error', message: 'เธ•เนเธญเธเธฃเธฐเธเธธ lineUserId' });

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();
        await ensureLotteryUserEnabled(conn);
        const eligibility = await getLotteryGoldEligibility(lineUserId, conn);
        if (!eligibility.eligible) throw new Error(eligibility.reason || 'เธขเธฑเธเนเธกเนเธกเธตเธชเธดเธ—เธเธดเนเธฃเธฑเธเธ•เธฑเนเธงเธ—เธญเธ');

        const number = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
        const [ticketResult] = await conn.query(
            `INSERT INTO lottery_tickets (lineUserId, roundId, ticketType, number, price, isGoldTicket)
             VALUES (?, ?, 'three', ?, 0, TRUE)`,
            [lineUserId, eligibility.currentRound.roundId, number]);

        await conn.query(
            `INSERT INTO lottery_gold_ticket_claims
             (lineUserId, roundId, ticketId, department, incidentFreeSince)
             VALUES (?, ?, ?, ?, ?)`,
            [lineUserId, eligibility.currentRound.roundId, ticketResult.insertId, eligibility.department, eligibility.incidentFreeSince]);

        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'lottery_gold', ?, ?, NOW())`,
            [
                'NOTIF' + uuidv4(),
                lineUserId,
                `เธเธธเธ“เนเธ”เนเธฃเธฑเธ Gold Ticket เธเธฃเธต เธเธงเธ” ${eligibility.currentRound.drawDate} เน€เธฅเธ ${number}`,
                eligibility.currentRound.roundId,
                lineUserId
            ]);

        await conn.commit();
        res.json({
            status: 'success',
            data: {
                ticketId: ticketResult.insertId,
                roundId: eligibility.currentRound.roundId,
                drawDate: eligibility.currentRound.drawDate,
                ticketType: 'three',
                number,
                isGoldTicket: true,
                message: 'เธฃเธฑเธ Gold Ticket เธชเธณเน€เธฃเนเธ'
            }
        });
    } catch (e) {
        await conn.rollback();
        res.status(e.statusCode || 400).json({ status: 'error', message: e.message, code: e.code });
    } finally {
        conn.release();
    }
});

// ======================================================
// LOTTERY ADMIN APIs
// ======================================================

// POST /api/admin/lottery/set-result โ€” เธเธฃเธญเธเธเธฅเธฃเธฒเธเธงเธฑเธฅ manual
app.post('/api/admin/lottery/set-result', async (req, res) => {
    const { requesterId, roundId, last2, last3_front, last3_back } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        if (!roundId || !last2 || !last3_back)
            return res.status(400).json({ status: 'error', message: 'เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ' });
        if (!/^\d{2}$/.test(last2)) return res.status(400).json({ status: 'error', message: 'เธฃเธนเธเนเธเธ 2 เธ•เธฑเธงเธ—เนเธฒเธขเนเธกเนเธ–เธนเธเธ•เนเธญเธ' });
        if (!/^\d{3}$/.test(last3_back)) return res.status(400).json({ status: 'error', message: 'เธฃเธนเธเนเธเธ 3 เธ•เธฑเธงเธ—เนเธฒเธขเนเธกเนเธ–เธนเธเธ•เนเธญเธ' });

        await db.query(
            `UPDATE lottery_rounds SET last2=?, last3_front=?, last3_back=?, status='pending_confirm', source='manual', confirmedBy=? WHERE roundId=?`,
            [last2, last3_front || null, last3_back, requesterId, roundId]
        );
        await logAdminAction(requesterId, 'LOTTERY_SET_RESULT', 'round', roundId, roundId, { last2, last3_back });
        res.json({ status: 'success', data: { message: 'เธเธฑเธเธ—เธถเธเธเธฅเธฃเธฒเธเธงเธฑเธฅเนเธฅเนเธง เธฃเธญเธขเธทเธเธขเธฑเธ' } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/admin/lottery/confirm-result โ€” เธขเธทเธเธขเธฑเธเธเธฅเธเนเธญเธเธเนเธฒเธขเธฃเธฒเธเธงเธฑเธฅ
app.post('/api/admin/lottery/confirm-result', async (req, res) => {
    const { requesterId, roundId } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        const [[round]] = await db.query('SELECT * FROM lottery_rounds WHERE roundId=?', [roundId]);
        if (!round) throw new Error('Lottery round not found');
        if (!round.last2 || !round.last3_back)
            throw new Error('Lottery result is incomplete');

        await db.query(
            "UPDATE lottery_rounds SET status='confirmed', confirmedBy=? WHERE roundId=?",
            [requesterId, roundId]
        );
        await logAdminAction(requesterId, 'LOTTERY_CONFIRM_RESULT', 'round', roundId, roundId, { last2: round.last2, last3_back: round.last3_back });
        res.json({ status: 'success', data: { message: 'เธขเธทเธเธขเธฑเธเธเธฅเน€เธฃเธตเธขเธเธฃเนเธญเธข เธเธฃเนเธญเธกเธเธฃเธฐเธกเธงเธฅเธฃเธฒเธเธงเธฑเธฅ' } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/admin/lottery/process-prizes โ€” เธเธฃเธฐเธกเธงเธฅเธเธฅเธฃเธฒเธเธงเธฑเธฅ + เธเนเธฒเธข points + LINE Push
app.post('/api/admin/lottery/process-prizes', async (req, res) => {
    const { requesterId, roundId } = req.body;
    let conn;
    const pendingPushes = [];
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        conn = await db.getClient();
        await conn.beginTransaction();

        const [[round]] = await conn.query('SELECT * FROM lottery_rounds WHERE roundId=? FOR UPDATE', [roundId]);
        if (!round) throw new Error('Lottery round not found');
        if (round.status === 'completed')
            throw new Error('This lottery round has already been processed');
        if (round.status !== 'confirmed')
            throw new Error('Lottery result must be confirmed before processing prizes');
        if (!round.last2 || !round.last3_back)
            throw new Error('Lottery result is incomplete');

        // เธซเธฒเธเธนเนเธ–เธนเธเธฃเธฒเธเธงเธฑเธฅ 2 เธ•เธฑเธงเธ—เนเธฒเธข
        const [win2] = await conn.query(
            `SELECT * FROM lottery_tickets WHERE roundId=? AND ticketType='two' AND number=? AND isPrizeClaimed=FALSE FOR UPDATE`,
            [roundId, round.last2]);

        // เธซเธฒเธเธนเนเธ–เธนเธเธฃเธฒเธเธงเธฑเธฅ 3 เธ•เธฑเธงเธ—เนเธฒเธข
        const [win3] = await conn.query(
            `SELECT * FROM lottery_tickets WHERE roundId=? AND ticketType='three' AND number=? AND isPrizeClaimed=FALSE FOR UPDATE`,
            [roundId, round.last3_back]);

        const allWinners = [...win2, ...win3];
        let totalPrizes = 0;
        let paidWinners = 0;

        for (const ticket of allWinners) {
            const prize = ticket.ticketType === 'two' ? 500 : 3000;
            const [ticketUpdate] = await conn.query(
                `UPDATE lottery_tickets SET isWinner=TRUE, prizeAmount=?, isPrizeClaimed=TRUE WHERE ticketId=? AND isPrizeClaimed=FALSE`,
                [prize, ticket.ticketId]);
            if (ticketUpdate.affectedRows !== 1) continue;

            totalPrizes += prize;
            paidWinners += 1;
            await conn.query(
                `UPDATE users SET totalScore=totalScore+?, lotteryWinCount=lotteryWinCount+1,
                 lotteryTotalWinnings=lotteryTotalWinnings+? WHERE lineUserId=?`,
                [prize, prize, ticket.lineUserId]);

            const notifId = 'NOTIF' + uuidv4();
            await conn.query(
                `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId)
                 VALUES (?,?,?,?,?)`,
                [notifId, ticket.lineUserId,
                 `๐ เธเธธเธ“เธ–เธนเธ Safety Lottery เธเธงเธ” ${toLotteryDateString(round.drawDate)}! เนเธ”เนเธฃเธฑเธ ${prize.toLocaleString()} เธเธฐเนเธเธ`,
                 'lottery_win', roundId]
            );

            pendingPushes.push({ lineUserId: ticket.lineUserId, ticketData: {
                drawDate: toLotteryDateString(round.drawDate),
                ticketType: ticket.ticketType,
                number: ticket.number,
                prizeAmount: prize
            }});
        }

        // mark tickets เธ—เธตเนเนเธกเนเธ–เธนเธเธฃเธฒเธเธงเธฑเธฅ
        await conn.query(
            `UPDATE lottery_tickets SET isWinner=FALSE, isPrizeClaimed=TRUE
             WHERE roundId=? AND isPrizeClaimed=FALSE`,
            [roundId]);

        const [[sold]] = await conn.query(
            'SELECT COUNT(*) AS cnt FROM lottery_tickets WHERE roundId=?', [roundId]);
        await conn.query(
            `INSERT INTO lottery_results_history (roundId, totalTicketsSold, totalWinners, totalPrizesPaid)
             VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE totalTicketsSold=?, totalWinners=?, totalPrizesPaid=?`,
            [roundId, sold.cnt, paidWinners, totalPrizes, sold.cnt, paidWinners, totalPrizes]);

        await conn.query("UPDATE lottery_rounds SET status='completed' WHERE roundId=?", [roundId]);
        await conn.commit();

        await logAdminAction(requesterId, 'LOTTERY_PROCESS_PRIZES', 'round', roundId, roundId,
            { winners: paidWinners, totalPrizes });

        for (const push of pendingPushes) {
            sendLotteryWinNotification(push.lineUserId, push.ticketData).catch(() => {});
        }

        res.json({ status: 'success', data: { winners: paidWinners, totalPrizes, message: 'เธเธฃเธฐเธกเธงเธฅเธเธฅเธฃเธฒเธเธงเธฑเธฅเน€เธฃเธตเธขเธเธฃเนเธญเธข' } });
    } catch (e) {
        if (conn) {
            try { await conn.rollback(); } catch (_) {}
        }
        res.status(500).json({ status: 'error', message: e.message });
    } finally {
        if (conn) conn.release();
    }
});

// GET /api/admin/lottery/dashboard โ€” Dashboard เธชเธฃเธธเธ
app.get('/api/admin/lottery/dashboard', async (req, res) => {
    const { requesterId } = req.query;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        const [rounds] = await db.query(
            `SELECT r.roundId, DATE_FORMAT(r.drawDate, '%Y-%m-%d') AS drawDate, r.last2, r.last3_front,
                    r.last3_back, r.status, r.source, r.confirmedBy, r.createdAt,
                    h.totalTicketsSold, h.totalWinners, h.totalPrizesPaid
             FROM lottery_rounds r
             LEFT JOIN lottery_results_history h ON r.roundId=h.roundId
             ORDER BY r.drawDate DESC LIMIT 10`);

        const [[totals]] = await db.query(
            `SELECT COUNT(*) AS totalTickets,
                    SUM(CASE WHEN isWinner=TRUE THEN 1 ELSE 0 END) AS totalWinners,
                    SUM(prizeAmount) AS totalPrizesPaid
             FROM lottery_tickets`);

        const [[qCount]] = await db.query('SELECT COUNT(*) AS cnt FROM lottery_quiz_questions WHERE isActive=TRUE');
        const settings = await getLotterySettings();

        res.json({ status: 'success', data: { rounds, totals, activeQuestions: qCount.cnt, settings } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// GET /api/admin/lottery/settings — Feature access settings
app.get('/api/admin/lottery/settings', async (req, res) => {
    const { requesterId } = req.query;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์' });
        res.json({ status: 'success', data: await getLotterySettings() });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/admin/lottery/settings — Enable/disable user entry while admins develop
app.post('/api/admin/lottery/settings', async (req, res) => {
    const { requesterId, userEnabled, disabledMessage } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์' });

        const enabledValue = userEnabled ? 'true' : 'false';
        const message = String(disabledMessage || DEFAULT_LOTTERY_DISABLED_MESSAGE).slice(0, 255);

        await db.query(
            `INSERT INTO lottery_settings (settingKey, settingValue, updatedBy) VALUES
             ('user_enabled', ?, ?),
             ('disabled_message', ?, ?)
             ON DUPLICATE KEY UPDATE settingValue=VALUES(settingValue), updatedBy=VALUES(updatedBy)`,
            [enabledValue, requesterId, message, requesterId]
        );
        await logAdminAction(requesterId, 'LOTTERY_UPDATE_SETTINGS', 'settings', 'lottery', enabledValue, { disabledMessage: message });
        res.json({ status: 'success', data: await getLotterySettings() });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

function getNextLotteryDrawDates(count = 2, fromDate = new Date()) {
    const result = [];
    const cursor = new Date(fromDate);
    cursor.setHours(0, 0, 0, 0);

    while (result.length < count) {
        const y = cursor.getFullYear();
        const m = cursor.getMonth();
        for (const day of [1, 16]) {
            const d = new Date(y, m, day);
            d.setHours(0, 0, 0, 0);
            if (d >= cursor) result.push(getBangkokDateString(d));
            if (result.length >= count) break;
        }
        cursor.setMonth(cursor.getMonth() + 1, 1);
    }
    return result;
}

// GET /api/admin/lottery/monitor — Full monitoring surface for Safety Lottery
app.get('/api/admin/lottery/monitor', async (req, res) => {
    const { requesterId, roundId } = req.query;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์' });

        const [[currentRound]] = await db.query(
            `SELECT roundId FROM lottery_rounds
             WHERE status IN ('open','closed','pending_confirm','pending_manual','confirmed')
             ORDER BY drawDate ASC LIMIT 1`
        );
        const selectedRoundId = roundId || currentRound?.roundId || null;

        const [rounds] = await db.query(
            `SELECT roundId, DATE_FORMAT(drawDate, '%Y-%m-%d') AS drawDate, status, last2, last3_back
             FROM lottery_rounds ORDER BY drawDate DESC LIMIT 20`
        );

        const params = selectedRoundId ? [selectedRoundId] : [];
        const roundWhere = selectedRoundId ? 'WHERE t.roundId=?' : '';

        const [[summary]] = await db.query(
            `SELECT COUNT(*) AS tickets,
                    COUNT(DISTINCT t.lineUserId) AS players,
                    SUM(CASE WHEN t.isWinner=TRUE THEN 1 ELSE 0 END) AS winners,
                    SUM(CASE WHEN t.isGoldTicket=TRUE THEN 1 ELSE 0 END) AS goldTickets,
                    COALESCE(SUM(t.prizeAmount),0) AS prizesPaid
             FROM lottery_tickets t ${roundWhere}`,
            params
        );

        const [tickets] = await db.query(
            `SELECT t.ticketId, t.roundId, t.ticketType, t.number, t.price, t.isGoldTicket,
                    t.isWinner, t.prizeAmount, t.isPrizeClaimed, t.purchasedAt,
                    u.fullName, u.employeeId, u.department
             FROM lottery_tickets t
             JOIN users u ON u.lineUserId=t.lineUserId
             ${roundWhere}
             ORDER BY t.purchasedAt DESC LIMIT 80`,
            params
        );

        const [winners] = await db.query(
            `SELECT t.ticketId, t.roundId, t.ticketType, t.number, t.prizeAmount, t.isGoldTicket,
                    u.fullName, u.employeeId, u.department
             FROM lottery_tickets t
             JOIN users u ON u.lineUserId=t.lineUserId
             WHERE t.isWinner=TRUE ${selectedRoundId ? 'AND t.roundId=?' : ''}
             ORDER BY t.prizeAmount DESC, t.ticketId DESC LIMIT 80`,
            params
        );

        const [departments] = await db.query(
            `SELECT u.department,
                    COUNT(*) AS tickets,
                    COUNT(DISTINCT t.lineUserId) AS players,
                    SUM(CASE WHEN t.isWinner=TRUE THEN 1 ELSE 0 END) AS winners,
                    COALESCE(SUM(t.prizeAmount),0) AS prizesPaid
             FROM lottery_tickets t
             JOIN users u ON u.lineUserId=t.lineUserId
             ${roundWhere}
             GROUP BY u.department
             ORDER BY tickets DESC LIMIT 20`,
            params
        );

        res.json({
            status: 'success',
            data: { selectedRoundId, rounds, summary, tickets, winners, departments }
        });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// GET /api/admin/lottery/questions โ€” เธ”เธถเธเธเธณเธ–เธฒเธกเธ—เธฑเนเธเธซเธกเธ”
app.get('/api/admin/lottery/questions', async (req, res) => {
    const { requesterId, category } = req.query;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        let sql = 'SELECT * FROM lottery_quiz_questions WHERE 1=1';
        const params = [];
        if (category) { sql += ' AND category=?'; params.push(category); }
        sql += ' ORDER BY createdAt DESC';

        const [rows] = await db.query(sql, params);
        res.json({ status: 'success', data: rows });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/admin/lottery/questions โ€” เน€เธเธดเนเธกเธเธณเธ–เธฒเธก manual
app.post('/api/admin/lottery/questions', async (req, res) => {
    const { requesterId, questionText, optionA, optionB, optionC, optionD, correctOption, category } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });
        if (!questionText || !optionA || !optionB || !optionC || !optionD || !correctOption)
            return res.status(400).json({ status: 'error', message: 'เธเนเธญเธกเธนเธฅเนเธกเนเธเธฃเธ' });

        const [result] = await db.query(
            `INSERT INTO lottery_quiz_questions (questionText,optionA,optionB,optionC,optionD,correctOption,category,generatedBy)
             VALUES (?,?,?,?,?,?,?,?)`,
            [questionText, optionA, optionB, optionC, optionD, correctOption.toUpperCase(), category || 'เธ—เธฑเนเธงเนเธ', 'manual']);

        await logAdminAction(requesterId, 'LOTTERY_ADD_QUESTION', 'question', String(result.insertId), questionText.slice(0, 50), {});
        res.json({ status: 'success', data: { questionId: result.insertId } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// PUT /api/admin/lottery/questions โ€” เนเธเนเนเธเธเธณเธ–เธฒเธก
app.put('/api/admin/lottery/questions', async (req, res) => {
    const { requesterId, questionId, questionText, optionA, optionB, optionC, optionD, correctOption, category, isActive } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });
        if (!questionId) return res.status(400).json({ status: 'error', message: 'เธ•เนเธญเธเธฃเธฐเธเธธ questionId' });

        await db.query(
            `UPDATE lottery_quiz_questions SET questionText=?,optionA=?,optionB=?,optionC=?,optionD=?,
             correctOption=?,category=?,isActive=? WHERE questionId=?`,
            [questionText, optionA, optionB, optionC, optionD, correctOption.toUpperCase(),
             category || 'เธ—เธฑเนเธงเนเธ', isActive !== false, questionId]);

        await logAdminAction(requesterId, 'LOTTERY_EDIT_QUESTION', 'question', String(questionId), questionText.slice(0, 50), {});
        res.json({ status: 'success', data: { message: 'เนเธเนเนเธเนเธฅเนเธง' } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// DELETE /api/admin/lottery/questions/:id โ€” เธฅเธเธเธณเธ–เธฒเธก
app.delete('/api/admin/lottery/questions/:id', async (req, res) => {
    const requesterId = req.body?.requesterId || req.query?.requesterId;
    const { id } = req.params;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        const [[q]] = await db.query('SELECT questionText FROM lottery_quiz_questions WHERE questionId=?', [id]);
        await db.query('DELETE FROM lottery_quiz_questions WHERE questionId=?', [id]);
        await logAdminAction(requesterId, 'LOTTERY_DELETE_QUESTION', 'question', id, q ? q.questionText.slice(0, 50) : '', {});
        res.json({ status: 'success', data: { message: 'เธฅเธเนเธฅเนเธง' } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

function buildFallbackLotteryQuestions(category = 'ทั่วไป') {
    const cat = category || 'ทั่วไป';
    return [
        ['ก่อนเริ่มงานที่มีความเสี่ยงสูง ควรทำสิ่งใดก่อนเสมอ?', 'เริ่มงานทันทีถ้ามีประสบการณ์', 'ประเมินความเสี่ยงและทบทวนวิธีทำงานที่ปลอดภัย', 'รอให้หัวหน้ามาตรวจหลังทำเสร็จ', 'ทำเฉพาะเมื่อมีอุบัติเหตุเกิดขึ้น', 'B'],
        ['เมื่อพบ Near Miss ในพื้นที่ทำงาน ควรทำอย่างไร?', 'ปล่อยผ่านถ้าไม่มีใครบาดเจ็บ', 'รายงานและแก้ไขสภาพอันตรายก่อนเกิดเหตุจริง', 'ลบหลักฐานเพื่อไม่ให้เสียเวลา', 'รอประชุมประจำเดือนก่อนแจ้ง', 'B'],
        ['ข้อใดเป็นหลักการใช้ PPE ที่เหมาะสมที่สุด?', 'เลือกใช้ตามความสะดวก', 'ตรวจสภาพและเลือก PPE ให้ตรงกับความเสี่ยงของงาน', 'ใช้ร่วมกันได้ทุกคนถ้าประหยัด', 'ใส่เฉพาะตอนมีผู้ตรวจ', 'B'],
        ['หากพื้นเปียกลื่นในทางเดิน ควรทำสิ่งใดทันที?', 'เดินเลี่ยงแล้วไม่ต้องแจ้งใคร', 'ตั้งป้ายเตือนและประสานให้ทำความสะอาด', 'ถ่ายรูปเก็บไว้เท่านั้น', 'รอให้แห้งเอง', 'B'],
        ['ก่อนซ่อมบำรุงเครื่องจักร ควรควบคุมพลังงานอย่างไร?', 'ปิดสวิตช์เฉพาะหน้าเครื่อง', 'ทำ Lockout/Tagout ตามขั้นตอน', 'บอกเพื่อนร่วมงานด้วยวาจา', 'ซ่อมตอนเครื่องเดินช้า', 'B'],
        ['ถังดับเพลิงควรถูกดูแลอย่างไร?', 'ตรวจเมื่อจะใช้งานเท่านั้น', 'ตรวจสภาพตามรอบและให้เข้าถึงได้ง่าย', 'เก็บในห้องล็อกเพื่อกันหาย', 'วางหลังสิ่งของเพื่อประหยัดพื้นที่', 'B'],
        ['สารเคมีหกรั่วไหล ควรทำสิ่งใดก่อน?', 'รีบเช็ดด้วยผ้าทั่วไป', 'กั้นพื้นที่และปฏิบัติตาม SDS/แผนฉุกเฉิน', 'ใช้น้ำล้างทุกกรณี', 'เปิดพัดลมเป่าให้แห้ง', 'B'],
        ['การทำงานบนที่สูงต้องให้ความสำคัญกับอะไร?', 'ความเร็วในการทำงาน', 'อุปกรณ์กันตก จุดยึด และการตรวจพื้นที่ก่อนเริ่ม', 'จำนวนคนดูงาน', 'ทำเฉพาะวันที่อากาศดี', 'B'],
        ['การยกของหนักที่ถูกต้องควรทำอย่างไร?', 'ก้มหลังแล้วยกเร็ว', 'ให้หลังตรง ใช้แรงขา และขอความช่วยเหลือเมื่อจำเป็น', 'บิดตัวขณะยกเพื่อประหยัดเวลา', 'ยกคนเดียวเสมอ', 'B'],
        ['ทำไมต้องสื่อสารอันตรายก่อนเริ่มงาน?', 'เพื่อให้เอกสารครบเท่านั้น', 'เพื่อให้ทุกคนเข้าใจความเสี่ยงและมาตรการควบคุมเดียวกัน', 'เพื่อเพิ่มเวลาทำงาน', 'เพื่อใช้แทนการควบคุมจริง', 'B']
    ].map((q) => ({
        questionText: q[0],
        optionA: q[1],
        optionB: q[2],
        optionC: q[3],
        optionD: q[4],
        correctOption: q[5],
        category: cat
    }));
}

// POST /api/admin/lottery/generate-questions โ€” AI เธชเธฃเนเธฒเธเธเธณเธ–เธฒเธก 10 เธเนเธญ
app.post('/api/admin/lottery/generate-questions', async (req, res) => {
    const { requesterId, category } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });

        const prompt = `เธเธธเธ“เธเธทเธญเธเธนเนเน€เธเธตเนเธขเธงเธเธฒเธเธ”เนเธฒเธเธเธงเธฒเธกเธเธฅเธญเธ”เธ เธฑเธข เธญเธฒเธเธตเธงเธญเธเธฒเธกเธฑเธข เนเธฅเธฐเธชเธดเนเธเนเธงเธ”เธฅเนเธญเธก (เธเธ.เธงเธดเธเธฒเธเธตเธ) เนเธเนเธฃเธเธเธฒเธเธญเธธเธ•เธชเธฒเธซเธเธฃเธฃเธกเธเธฃเธฐเน€เธ—เธจเนเธ—เธข

เธชเธฃเนเธฒเธเธเธณเธ–เธฒเธกเนเธเธเธเธฃเธเธฑเธข 4 เธ•เธฑเธงเน€เธฅเธทเธญเธ เธเธณเธเธงเธ 10 เธเนเธญ เธซเธกเธงเธ”เธซเธกเธนเน: ${category || 'เธ—เธฑเนเธงเนเธ'}

เธเธเน€เธซเธฅเนเธ:
- เธเธณเธ–เธฒเธกเธ•เนเธญเธเน€เธเธตเนเธขเธงเธเธฑเธเธเธงเธฒเธกเธเธฅเธญเธ”เธ เธฑเธขเนเธเธเธฒเธฃเธ—เธณเธเธฒเธ เธญเธฒเธเธตเธงเธญเธเธฒเธกเธฑเธข เธซเธฃเธทเธญเธชเธดเนเธเนเธงเธ”เธฅเนเธญเธกเนเธเนเธฃเธเธเธฒเธ
- เธ เธฒเธฉเธฒเนเธ—เธข เน€เธเนเธฒเนเธเธเนเธฒเธข เน€เธซเธกเธฒเธฐเธเธฑเธเธเธเธฑเธเธเธฒเธเนเธฃเธเธเธฒเธเธ—เธธเธเธฃเธฐเธ”เธฑเธ
- เธ•เธฑเธงเน€เธฅเธทเธญเธเธ•เนเธญเธเธชเธกเธเธฃเธดเธ เนเธกเนเธ•เธฅเธ เนเธกเนเน€เธซเนเธเธเธฑเธ”เธงเนเธฒเธเนเธญเนเธซเธเธ–เธนเธ
- เธซเนเธฒเธกเธกเธตเธเธณเธ–เธฒเธกเธเนเธณเธเธฑเธ
- เธญเนเธฒเธเธญเธดเธเธเธเธซเธกเธฒเธขเนเธ—เธข เธกเธฒเธ•เธฃเธเธฒเธเธชเธฒเธเธฅ (ISO, OSHA) เธซเธฃเธทเธญเนเธเธงเธเธเธดเธเธฑเธ•เธดเธ—เธตเนเธ”เธตเนเธ”เน

เธ•เธญเธเน€เธเนเธ JSON array เน€เธ—เนเธฒเธเธฑเนเธ เธซเนเธฒเธกเธกเธตเธเนเธญเธเธงเธฒเธกเธญเธทเนเธเธเธญเธ JSON เธซเนเธฒเธกเธกเธต markdown backticks:
[{"questionText":"เธเธณเธ–เธฒเธก","optionA":"A","optionB":"B","optionC":"C","optionD":"D","correctOption":"A","category":"เธซเธกเธงเธ”"}]`;

        let questions;
        let source = 'system_fallback';
        let warning = null;
        let lastAiError = null;

        for (const model of LOTTERY_GEMINI_MODELS) {
            try {
                const geminiRes = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text: prompt }] }] },
                    { timeout: 30000 }
                );

                let rawText = geminiRes.data.candidates[0].content.parts[0].text;
                rawText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                questions = JSON.parse(rawText);
                source = model;
                break;
            } catch (aiErr) {
                lastAiError = aiErr;
                console.warn(`Lottery Gemini model failed: ${model}`, aiErr.response?.status || aiErr.message);
            }
        }

        if (!questions) {
            questions = buildFallbackLotteryQuestions(category || 'ทั่วไป');
            const status = lastAiError?.response?.status;
            warning = status === 429
                ? 'All Gemini models were rate limited. Created standard fallback questions instead.'
                : 'Gemini generation failed. Created standard fallback questions instead.';
        }

        if (!Array.isArray(questions) || questions.length === 0)
            throw new Error('Gemini เธชเนเธ JSON เนเธกเนเธ–เธนเธเธ•เนเธญเธ');

        const inserted = [];
        for (const q of questions) {
            if (!q.questionText || !q.optionA || !q.optionB || !q.optionC || !q.optionD || !q.correctOption) continue;
            const [r] = await db.query(
                `INSERT INTO lottery_quiz_questions (questionText,optionA,optionB,optionC,optionD,correctOption,category,generatedBy)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [q.questionText, q.optionA, q.optionB, q.optionC, q.optionD,
                 q.correctOption.toUpperCase(), q.category || category || 'เธ—เธฑเนเธงเนเธ', source]);
            inserted.push({ questionId: r.insertId, questionText: q.questionText });
        }

        await logAdminAction(requesterId, 'LOTTERY_AI_GENERATE_QUESTIONS', 'question', 'batch', category || 'เธ—เธฑเนเธงเนเธ',
            { count: inserted.length });

        res.json({ status: 'success', data: { inserted: inserted.length, preview: inserted.slice(0, 3), source, warning } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// POST /api/admin/lottery/rounds โ€” เธชเธฃเนเธฒเธเธเธงเธ”เนเธซเธกเน
app.post('/api/admin/lottery/rounds', async (req, res) => {
    const { requesterId, drawDate } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'เนเธกเนเธกเธตเธชเธดเธ—เธเธดเน' });
        if (!drawDate || !/^\d{4}-\d{2}-\d{2}$/.test(drawDate))
            return res.status(400).json({ status: 'error', message: 'เธงเธฑเธเธ—เธตเนเนเธกเนเธ–เธนเธเธ•เนเธญเธ' });

        await db.query(
            'INSERT INTO lottery_rounds (roundId, drawDate) VALUES (?,?)',
            [drawDate, drawDate]);
        await logAdminAction(requesterId, 'LOTTERY_CREATE_ROUND', 'round', drawDate, drawDate, {});
        res.json({ status: 'success', data: { roundId: drawDate, message: 'เธชเธฃเนเธฒเธเธเธงเธ”เนเธฅเนเธง' } });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ status: 'error', message: 'เธกเธตเธเธงเธ”เธเธตเนเนเธฅเนเธง' });
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// POST /api/admin/lottery/auto-rounds — Create upcoming 1st/16th draw rounds automatically
app.post('/api/admin/lottery/auto-rounds', async (req, res) => {
    const { requesterId, count = 2 } = req.body;
    try {
        const [[admin]] = await db.query('SELECT 1 FROM admins WHERE lineUserId=?', [requesterId]);
        if (!admin) return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์' });

        const dates = getNextLotteryDrawDates(Math.min(Math.max(Number(count) || 2, 1), 6));
        const created = [];
        const skipped = [];
        for (const drawDate of dates) {
            try {
                await db.query(
                    'INSERT INTO lottery_rounds (roundId, drawDate, status) VALUES (?, ?, "open")',
                    [drawDate, drawDate]
                );
                created.push(drawDate);
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') skipped.push(drawDate);
                else throw e;
            }
        }

        await logAdminAction(requesterId, 'LOTTERY_AUTO_CREATE_ROUNDS', 'round', 'batch', created.join(',') || 'none',
            { created, skipped });
        res.json({ status: 'success', data: { created, skipped } });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ======================================================
// SERVER START
// ======================================================
app.get('/', (req, res) => {
    res.send("Safety Spot Backend is running.");
});

app.listen(PORT, "0.0.0.0", () =>
    console.log(`Backend running on port ${PORT}`)
);

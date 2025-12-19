// =============================================
// server.js  (FULL VERSION — R2 UPLOAD ONLY)
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

const app = express();
const PORT = process.env.PORT || 3000;
const cron = require('node-cron'); // เพิ่มบรรทัดนี้ต่อจาก require อื่นๆ

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
//   Auto award badges by score (ADD + REMOVE)
// -----------------------------
async function autoAwardBadgesForUser(lineUserId, connOptional) {
    // ถ้ามีส่ง connection จาก transaction เข้ามาให้ใช้ตัวนั้น
    // ถ้าไม่ส่งมา ใช้ db ปกติ (pool)
    const conn = connOptional || db;

    // 1) ลบป้าย auto ที่คะแนน "ไม่ถึงเกณฑ์แล้ว"
    //    - ป้าย auto: badges.minScore IS NOT NULL
    //    - ผู้ใช้คะแนนปัจจุบัน < minScore  ⇒ ต้องถูกลบออก
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

    // 2) เพิ่มป้าย auto ที่คะแนนถึงเกณฑ์ แต่ยังไม่มีใน user_badges
    await conn.query(
        `
        INSERT INTO user_badges (lineUserId, badgeId, earnedAt)
        SELECT 
            u.lineUserId,
            b.badgeId,
            NOW()
        FROM users u
        JOIN badges b
          ON b.minScore IS NOT NULL          -- เฉพาะป้าย auto
         AND u.totalScore >= b.minScore      -- คะแนนถึงเกณฑ์
        LEFT JOIN user_badges ub
          ON ub.lineUserId = u.lineUserId
         AND ub.badgeId   = b.badgeId        -- ถ้ามีป้ายนี้อยู่แล้วจะเจอใน ub
        WHERE u.lineUserId = ?
          AND ub.badgeId IS NULL;            -- แทรกเฉพาะป้ายที่ยังไม่มี
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
const upload = multer({ storage });

// -----------------------------
//   Cloudflare R2 Upload
// -----------------------------
async function uploadToR2(buffer, mime = "image/jpeg") {
    const {
        R2_ACCOUNT_ID,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        R2_BUCKET_NAME,
        R2_PUBLIC_BASE_URL,
    } = process.env;

    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
        throw new Error("R2 config missing");
    }

    const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });

    const ext = mime === "image/png" ? "png" : "jpg";
    const key = `safety-spot/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    await s3.send(new PutObjectCommand({
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

    const [rows] = await db.query(
        "SELECT * FROM admins WHERE lineUserId = ?",
        [requesterId]
    );

    if (rows.length === 0)
        return res.status(403).json({ status: "error", message: "Not admin" });

    next();
};

// -----------------------------
//   R2 Upload API
// -----------------------------
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ status: 'error', message: "Missing file" });

        const url = await uploadToR2(req.file.buffer, req.file.mimetype);

        res.json({ status: "success", data: { imageUrl: url } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// PART 2 — USER / ACTIVITIES / LEADERBOARD
// ======================================================

// --- API: USER PROFILE (ฉบับแก้: โชว์ Streak 0 ถ้าขาดช่วง) ---
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
        
        // ⭐ LOGIC: ถ้าไม่ได้เล่นมาเกิน 1 วัน ให้แสดงเป็น 0 (Visual Reset)
        let displayStreak = 0;
        if (user.currentStreak && user.lastPlayedDate) {
            const now = new Date();
            const last = new Date(user.lastPlayedDate);
            const diffTime = Math.abs(now - last);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            
            // ถ้าเล่นวันนี้ (0) หรือเมื่อวาน (1) -> โชว์เลขเดิม
            if (diffDays <= 1) {
                displayStreak = user.currentStreak;
            }
        }
        user.currentStreak = displayStreak;

        // เช็ค Admin
        const [adminRows] = await db.query("SELECT * FROM admins WHERE lineUserId = ?", [lineUserId]);
        user.isAdmin = adminRows.length > 0;

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
        const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;

        const [exists] = await db.query(
            "SELECT * FROM users WHERE lineUserId = ? OR employeeId = ?",
            [lineUserId, employeeId]
        );

        if (exists.length > 0) {
            return res.status(400).json({
                status: "error",
                message: "LINE User ID หรือ Employee ID มีอยู่แล้ว"
            });
        }

        await db.query(
            "INSERT INTO users (lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())",
            [lineUserId, displayName, pictureUrl, fullName, employeeId, 0]
        );

        res.json({
            status: "success",
            data: {
                lineUserId,
                displayName,
                pictureUrl,
                fullName,
                employeeId,
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
//   ACTIVITIES LIST
// -----------------------------
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

        const submittedIds = new Set(submitted.map(a => a.activityId));

        const result = activities.map(a => ({
            ...a,
            userHasSubmitted: submittedIds.has(a.activityId)
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
            "SELECT fullName, pictureUrl, totalScore FROM users ORDER BY totalScore DESC, fullName ASC LIMIT ? OFFSET ?",
            [limit, offset]
        );

        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// USER BADGES (frontend ต้องใช้ endpoint นี้)
// ======================================================
app.get('/api/user/badges', async (req, res) => {
    const { lineUserId } = req.query;

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
});


// ======================================================
// PART 3 — SUBMISSIONS / LIKE / COMMENT
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

        // เช็คว่า user กดไลก์โพสต์ไหนบ้าง
        const [likedRows] = await db.query(
            "SELECT submissionId FROM likes WHERE lineUserId = ?",
            [lineUserId]
        );

        const likedSet = new Set(likedRows.map(l => l.submissionId));

        // คอมเมนต์ทั้งหมดของ submission เหล่านี้
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

        // รวมผลลัพธ์
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
            comments: commentsMap[sub.submissionId] || []
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
                message: "กรุณากรอกรายละเอียดของรายงาน"
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
                    message: "เนื้อหารายงานคล้ายกับรายงานที่มีอยู่แล้ว"
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
                message: "คุณเคยส่งรายงานกิจกรรมนี้ไปแล้ว"
            });
        }

        // Insert submission
        await db.query(
            `INSERT INTO submissions 
             (submissionId, activityId, lineUserId, description, imageUrl, status, createdAt)
             VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
            ["SUB" + uuidv4(), activityId, lineUserId, normalized, imageUrl]
        );

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
                                `${u[0].fullName} ได้กดไลค์รายงานของคุณ`,
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
                            `${u[0].fullName} ได้แสดงความคิดเห็นบนรายงานของคุณ`,
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
// PART 3.5 — GAME API (Safety Card Gacha)
// ======================================================

// 1. ดึงคำถามประจำวัน (สุ่มมา 1 ข้อ ที่ยังไม่เคยตอบในวันนี้)
app.get('/api/game/daily-question', async (req, res) => {
    const { lineUserId } = req.query;
    const today = new Date().toISOString().split('T')[0];

    // เช็คว่าวันนี้เล่นไปหรือยัง
    const [history] = await db.query(
        "SELECT * FROM user_game_history WHERE lineUserId = ? AND playedAt = ?",
        [lineUserId, today]
    );

    if (history.length > 0) {
        return res.json({ status: "success", data: { played: true } });
    }

    // สุ่มคำถามมา 1 ข้อ
    const [questions] = await db.query(
        "SELECT * FROM kyt_questions WHERE isActive = TRUE ORDER BY RAND() LIMIT 1"
    );

    if (questions.length === 0) {
        return res.json({ status: "error", message: "ไม่พบคำถามในระบบ" });
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
                // ส่ง options ครบ 8 ตัว
                options: { 
                    A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD,
                    E: q.optionE, F: q.optionF, G: q.optionG, H: q.optionH
                }
            }
        }
    });
});

// --- API: ส่งคำตอบ (แก้ใหม่: ส่งยอดเหรียญล่าสุดกลับไปด้วย) ---
app.post('/api/game/submit-answer', async (req, res) => {
    const { lineUserId, questionId, selectedOption } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เช็คว่าเล่นไปหรือยัง (ถ้าอยากให้เล่นซ้ำได้เพื่อเทส ให้คอมเมนต์บรรทัดเช็ค history ออกก่อนได้ครับ)
        /*
        const [history] = await conn.query(
            "SELECT * FROM user_game_history WHERE lineUserId = ? AND playedAt = ?",
            [lineUserId, today]
        );
        if (history.length > 0) throw new Error("คุณเล่นเกมของวันนี้ไปแล้ว");
        */

        // 2. ตรวจคำตอบ
        const [qs] = await conn.query("SELECT * FROM kyt_questions WHERE questionId = ?", [questionId]);
        if (qs.length === 0) throw new Error("คำถามไม่ถูกต้อง");
        
        const question = qs[0];
        const isCorrect = (selectedOption === question.correctOption);
        
        // 3. กำหนดรางวัล (Coins & Score)
        // ตอบถูก: 50 เหรียญ / ตอบผิด: 10 เหรียญ
        let earnedCoins = isCorrect ? 50 : 10; 
        let earnedScore = isCorrect ? question.scoreReward : 2; 

        // 4. ระบบ Streak (นับวันต่อเนื่อง)
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        let currentStreak = 1;
        
        if (streakRow.length > 0) {
            const lastDate = new Date(streakRow[0].lastPlayedDate);
            const diffTime = Math.abs(new Date(today) - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 1) currentStreak = streakRow[0].currentStreak + 1;
            else if (diffDays > 1) currentStreak = 1;
            else currentStreak = streakRow[0].currentStreak; // เล่นวันเดิม
            
            await conn.query("UPDATE user_streaks SET currentStreak = ?, lastPlayedDate = ? WHERE lineUserId = ?", [currentStreak, today, lineUserId]);
        } else {
            await conn.query("INSERT INTO user_streaks VALUES (?, 1, ?, 1)", [lineUserId, today]);
        }

        // 5. บันทึกประวัติ
        await conn.query(
            "INSERT INTO user_game_history (lineUserId, questionId, isCorrect, earnedPoints, playedAt) VALUES (?, ?, ?, ?, ?)",
            [lineUserId, questionId, isCorrect, earnedCoins, today]
        );

        // 6. อัปเดต User (บวกเหรียญและคะแนน)
        await conn.query(
            "UPDATE users SET totalScore = totalScore + ?, coinBalance = coinBalance + ? WHERE lineUserId = ?", 
            [earnedScore, earnedCoins, lineUserId]
        );

        // 7. ดึงยอดเหรียญล่าสุดมาส่งกลับ
        const [[updatedUser]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);

        // ==========================================
        // ✨ เพิ่มแจ้งเตือน: ผลการเล่นเกม ✨
        // ==========================================
        const notifMsg = isCorrect 
            ? `ภารกิจสำเร็จ! คุณได้รับ ${earnedCoins} เหรียญจากการตอบคำถามประจำวัน`
            : `ตอบผิดรับรางวัลปลอบใจ ${earnedCoins} เหรียญ`;

        await conn.query(
            `INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'game_quiz', ?, ?, NOW())`,
            [
                "NOTIF" + uuidv4(),
                lineUserId,
                notifMsg,
                questionId, // relatedItemId (ใช้เก็บ ID คำถามที่เล่น)
                lineUserId  // triggeringUserId (ตัวเองเป็นคนทำ)
            ]
        );

        await conn.commit();

        res.json({
            status: "success",
            data: {
                isCorrect,
                earnedCoins,       // เหรียญที่ได้รอบนี้
                currentStreak,
                correctOption: question.correctOption,
                newCoinBalance: updatedUser.coinBalance, // ยอดรวมล่าสุด
                newTotalScore: updatedUser.totalScore
            }
        });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: e.message });
    } finally {
        conn.release();
    }
});

// ======================================================
// PART 3.6 — ADMIN: Manage Game Questions
// ======================================================

// 1. ดึงคำถามทั้งหมด (Admin View)
app.get('/api/admin/questions', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM kyt_questions ORDER BY questionId DESC");
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 2. เพิ่ม/แก้ไข คำถาม
app.post('/api/admin/questions', isAdmin, async (req, res) => {
    // รับ option A-H
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

// 3. ลบคำถาม
app.delete('/api/admin/questions/:id', isAdmin, async (req, res) => {
    try {
        await db.query("DELETE FROM kyt_questions WHERE questionId = ?", [req.params.id]);
        res.json({ status: "success", data: { deleted: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 4. เปิด/ปิด คำถาม (Toggle Active)
app.post('/api/admin/questions/toggle', isAdmin, async (req, res) => {
    try {
        const { questionId } = req.body;
        // เช็คสถานะปัจจุบันก่อน
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
// PART 3.7 — ADMIN: Manage Safety Cards
// ======================================================

// 1. ดึงการ์ดทั้งหมด (สำหรับ Admin)
app.get('/api/admin/cards', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM safety_cards ORDER BY createdAt DESC");
        res.json({ status: "success", data: rows });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// 2. เพิ่ม/แก้ไข การ์ด
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
            // สร้าง ID แบบง่ายๆ (หรือจะใช้ UUID ก็ได้)
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

// 3. ลบการ์ด
app.delete('/api/admin/cards/:id', isAdmin, async (req, res) => {
    try {
        // ลบข้อมูลการครอบครองของผู้เล่นก่อน (เพื่อไม่ให้ติด Foreign Key)
        await db.query("DELETE FROM user_cards WHERE cardId = ?", [req.params.id]);
        
        // ลบตัวการ์ด
        await db.query("DELETE FROM safety_cards WHERE cardId = ?", [req.params.id]);
        
        res.json({ status: "success", data: { deleted: true } });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ======================================================
// PART 4 — ADMIN PANEL / NOTIFICATIONS / SERVER START
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
        const [pending] = await db.query("SELECT COUNT(*) AS count FROM submissions WHERE status = 'pending'");
        const [users] = await db.query("SELECT COUNT(*) AS count FROM users");
        const [acts] = await db.query("SELECT COUNT(*) AS count FROM activities WHERE status = 'active'");

        res.json({
            status: "success",
            data: {
                pendingCount: pending[0].count,
                userCount: users[0].count,
                activeActivitiesCount: acts[0].count
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

        // หาว่ารายงานนี้เป็นของใคร
        const [sub] = await conn.query(
            "SELECT lineUserId FROM submissions WHERE submissionId = ?",
            [submissionId]
        );
        if (sub.length === 0) throw new Error("Submission not found");

        const ownerId = sub[0].lineUserId;

        // อัปเดตสถานะ + ให้คะแนนในตาราง submissions
        await conn.query(
            "UPDATE submissions SET status = 'approved', points = ? WHERE submissionId = ?",
            [score, submissionId]
        );

        // เพิ่มคะแนนให้ user
        await conn.query(
            "UPDATE users SET totalScore = totalScore + ? WHERE lineUserId = ?",
            [score, ownerId]
        );

        // แจ้งเตือน
        await conn.query(`
            INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
            VALUES (?, ?, ?, 'approved', ?, ?, NOW())
        `, [
            "NOTIF" + uuidv4(),
            ownerId,
            `รายงานของคุณได้รับการอนุมัติ (${score} คะแนน)`,
            submissionId,
            requesterId
        ]);

        // 🔥 เรียก autoAwardBadgesForUser ภายใต้ transaction เดียวกัน
        await autoAwardBadgesForUser(ownerId, conn);

        await conn.commit();
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
            `น่าเสียดาย รายงานของคุณไม่ผ่านการตรวจสอบ`,
            submissionId,
            requesterId
        ]);

        await conn.commit();
        res.json({ status: "success", data: { message: "Rejected." } });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: err.message });
    } finally {
        conn.release();
    }
});

// ======================================================
// ADMIN: Delete Submission
// ======================================================
app.delete('/api/admin/submissions/:submissionId', isAdmin, async (req, res) => {
    await db.query(
        "DELETE FROM submissions WHERE submissionId = ?",
        [req.params.submissionId]
    );
    res.json({ status: "success", data: { removed: true } });
});

// ======================================================
// ADMIN: Activities
// ======================================================
app.get('/api/admin/activities', isAdmin, async (req, res) => {
    const [rows] = await db.query(
        "SELECT * FROM activities ORDER BY createdAt DESC"
    );
    res.json({ status: "success", data: rows });
});

app.post('/api/admin/activities', isAdmin, async (req, res) => {
    const { title, description, imageUrl } = req.body;

    await db.query(
        `INSERT INTO activities 
        (activityId, title, description, imageUrl, status, createdAt)
         VALUES (?, ?, ?, ?, 'active', NOW())`,
        ["ACT" + uuidv4(), title, description, imageUrl]
    );

    res.json({ status: "success", data: { created: true } });
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
});

// ======================================================
// ADMIN: Delete Activity
// ======================================================
app.delete('/api/admin/activities/:activityId', isAdmin, async (req, res) => {
    try {
        const { activityId } = req.params;

        // ลบ submission ทั้งหมดของกิจกรรมนี้ก่อน
        await db.query(
            "DELETE FROM submissions WHERE activityId = ?",
            [activityId]
        );

        // ลบกิจกรรม
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
    const [rows] = await db.query(
        "SELECT * FROM badges ORDER BY badgeName ASC"
    );
    res.json({ status: "success", data: rows });
});

app.post('/api/admin/badges', isAdmin, async (req, res) => {
    const { badgeName, description, imageUrl } = req.body;

    await db.query(
        `
        INSERT INTO badges (badgeId, badgeName, description, imageUrl)
        VALUES (?, ?, ?, ?)
        `,
        ["BADGE" + uuidv4(), badgeName, description, imageUrl]
    );

    res.json({ status: "success", data: { created: true } });
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
    await db.query(
        "DELETE FROM badges WHERE badgeId = ?",
        [req.params.badgeId]
    );
    res.json({ status: "success", data: { removed: true } });
});

// Award/revoke badge
app.post('/api/admin/award-badge', isAdmin, async (req, res) => {
    const { lineUserId, badgeId, requesterId } = req.body;

    // หา badgeName เพื่อใช้ในข้อความแจ้งเตือน
    const [[badge]] = await db.query(
        "SELECT badgeName FROM badges WHERE badgeId = ?",
        [badgeId]
    );

    await db.query(
        "INSERT IGNORE INTO user_badges (lineUserId, badgeId) VALUES (?, ?)",
        [lineUserId, badgeId]
    );

    // แจ้งเตือนว่าถูกมอบป้ายโดยแอดมิน
    const msg = badge
        ? `คุณได้รับป้ายรางวัลใหม่จากผู้ดูแลระบบ: ${badge.badgeName}`
        : "คุณได้รับป้ายรางวัลใหม่จากผู้ดูแลระบบ";

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

    // แจ้งเตือนว่าป้ายถูกเพิกถอน
    const msg = badge
        ? `ป้ายรางวัลของคุณถูกเพิกถอน: ${badge.badgeName}`
        : "ป้ายรางวัลบางรายการของคุณถูกเพิกถอนโดยผู้ดูแลระบบ";

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

    res.json({ status: "success", data: { revoked: true } });
});

app.post('/api/admin/revoke-badge', isAdmin, async (req, res) => {
    const { lineUserId, badgeId } = req.body;

    await db.query(
        "DELETE FROM user_badges WHERE lineUserId = ? AND badgeId = ?",
        [lineUserId, badgeId]
    );

    res.json({ status: "success", data: { revoked: true } });
});

// ======================================================
// ADMIN: Recalculate auto badges for all users
// ======================================================
app.post('/api/admin/recalculate-badges', isAdmin, async (req, res) => {
    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // ดึง user ทั้งหมด
        const [users] = await conn.query(
            "SELECT lineUserId FROM users"
        );

        // วนทุกคนแล้วให้ autoAwardBadgesForUser จัดการให้
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

    // ตรวจค่าพื้นฐาน
    if (!lineUserId || typeof deltaScore !== 'number' || isNaN(deltaScore)) {
        return res.status(400).json({
            status: "error",
            message: "ต้องระบุ lineUserId และ deltaScore (ตัวเลข)"
        });
    }

    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1) อัปเดตคะแนน (ไม่ให้ติดลบ)
        await conn.query(
            `
            UPDATE users
            SET totalScore = GREATEST(totalScore + ?, 0)
            WHERE lineUserId = ?
            `,
            [deltaScore, lineUserId]
        );

        // 2) ดึงคะแนนรวมล่าสุด
        const [[userRow]] = await conn.query(
            "SELECT totalScore FROM users WHERE lineUserId = ?",
            [lineUserId]
        );
        const newTotalScore = userRow ? userRow.totalScore : 0;

        // 3) บันทึก history การปรับคะแนน (เผื่อดูย้อนหลัง)
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

        // 4) หลัง commit แล้วค่อยให้ระบบเช็กป้าย auto ตามคะแนนใหม่
        await autoAwardBadgesForUser(lineUserId);

        // 5) แจ้งเตือนเรื่องคะแนน
        const messageScore =
            deltaScore > 0
                ? `คะแนนของคุณถูกเพิ่ม ${Math.abs(deltaScore)} คะแนน (รวมเป็น ${newTotalScore} คะแนน)`
                : `คะแนนของคุณถูกลด ${Math.abs(deltaScore)} คะแนน (เหลือ ${newTotalScore} คะแนน)`;

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

        // 6) แจ้งเตือนว่าระบบตรวจสอบ/อัปเดตป้ายให้แล้ว (auto badge)
        const messageBadgeAuto = "ระบบได้ตรวจสอบและอัปเดตป้ายรางวัลของคุณตามคะแนนล่าสุดแล้ว";
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

// --- API: จบเกม V2 (กู้ชีพ Streak + เก็บช้อยส์ + แจ้งเตือน) ---
app.post('/api/game/submit-answer-v2', async (req, res) => {
    const { lineUserId, questionId, selectedOption } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();
        
        // 1. ตรวจคำตอบ
        const [qs] = await conn.query("SELECT * FROM kyt_questions WHERE questionId = ?", [questionId]);
        if (qs.length === 0) throw new Error("ไม่พบคำถาม");
        
        const question = qs[0];
        const isCorrect = (selectedOption === question.correctOption);
        
        let earnedCoins = isCorrect ? 50 : 10;
        let earnedScore = isCorrect ? question.scoreReward : 2; 

        // 2. ระบบ Streak (Logic ใหม่: เก็บสถิติเก่าไว้กู้คืน)
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        let currentStreak = 1;
        let recoverableStreak = 0;
        let isStreakBroken = false;
        
        if (streakRow.length > 0) {
            const lastDate = new Date(streakRow[0].lastPlayedDate);
            const diffTime = Math.abs(new Date(today) - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 1) { 
                // ต่อเนื่อง
                currentStreak = streakRow[0].currentStreak + 1;
                recoverableStreak = 0; 
            } else if (diffDays === 0) {
                // ซ้ำวันเดิม
                currentStreak = streakRow[0].currentStreak;
                recoverableStreak = streakRow[0].recoverableStreak; 
            } else {
                // ❄️ ขาดช่วง (ไฟดับ!): เก็บของเก่าไว้กู้คืน
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
            // เล่นครั้งแรก
            await conn.query(
                "INSERT INTO user_streaks (lineUserId, currentStreak, lastPlayedDate, recoverableStreak) VALUES (?, 1, ?, 0)", 
                [lineUserId, today]
            );
        }

        // Streak Bonus (ทุก 7 วัน)
        if (!isStreakBroken && currentStreak > 0 && currentStreak % 7 === 0) {
            earnedCoins += 100; 
        }

        // 3. อัปเดต User
        await conn.query("UPDATE users SET totalScore = totalScore + ?, coinBalance = coinBalance + ? WHERE lineUserId = ?", [earnedScore, earnedCoins, lineUserId]);

        // ⭐ 4. บันทึกประวัติ (เพิ่ม selectedAnswer เพื่อเก็บ A-H)
        await conn.query(
            "INSERT INTO user_game_history (lineUserId, questionId, isCorrect, earnedPoints, playedAt, selectedAnswer) VALUES (?, ?, ?, ?, ?, ?)",
            [lineUserId, questionId, isCorrect, earnedCoins, today, selectedOption]
        );

        // ⭐ 5. แจ้งเตือนลง App
        const notifMsg = isCorrect 
            ? `ภารกิจสำเร็จ! คุณได้รับ ${earnedCoins} เหรียญจากการตอบคำถามประจำวัน`
            : `ตอบผิดรับรางวัลปลอบใจ ${earnedCoins} เหรียญ`;

        await conn.query(
            `INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'game_quiz', ?, ?, NOW())`,
            ["NOTIF" + Date.now(), lineUserId, notifMsg, questionId, lineUserId]
        );

        const [[updatedUser]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);
        await conn.commit();
        
        res.json({ 
            status: "success", 
            data: { 
                isCorrect, 
                earnedCoins, 
                currentStreak,
                recoverableStreak,
                newCoinBalance: updatedUser.coinBalance,
                isStreakBroken 
            } 
        });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({message: e.message});
    } finally { conn.release(); }
});

// --- API: ใช้ไอเทมกู้คืน Streak (Restore) ---
app.post('/api/game/restore-streak', async (req, res) => {
    const { lineUserId } = req.body;
    const RESTORE_COST = 200; // ราคาค่ากู้คืน
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เช็คว่ามีอะไรให้กู้ไหม
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        if (streakRow.length === 0 || streakRow[0].recoverableStreak <= 0) {
            throw new Error("ไม่มีสถิติให้กู้คืนครับ");
        }
        const lostStreak = streakRow[0].recoverableStreak;

        // 2. เช็คเงิน
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        if (user.coinBalance < RESTORE_COST) {
            throw new Error(`เหรียญไม่พอครับ (ต้องการ ${RESTORE_COST} เหรียญ)`);
        }

        // 3. หักเงิน + กู้คืน
        // สูตร: เอาของเก่า (lost) + ของปัจจุบัน (current) รวมกัน
        const restoredStreak = lostStreak + streakRow[0].currentStreak;

        await conn.query("UPDATE users SET coinBalance = coinBalance - ? WHERE lineUserId = ?", [RESTORE_COST, lineUserId]);
        
        await conn.query(
            "UPDATE user_streaks SET currentStreak = ?, recoverableStreak = 0 WHERE lineUserId = ?",
            [restoredStreak, lineUserId]
        );

        // 4. แจ้งเตือน
        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, 'system_alert', 'restore', ?, NOW())`,
            ["NOTIF" + Date.now(), lineUserId, `กู้ชีพสำเร็จ! 🔥 ไฟกลับมาเป็น ${restoredStreak} วันแล้ว`, lineUserId]
        );

        const [[updatedUser]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        await conn.commit();

        res.json({ 
            status: "success", 
            data: { 
                success: true, 
                newStreak: restoredStreak,
                newCoinBalance: updatedUser.coinBalance,
                message: `กู้คืนสำเร็จ! ไฟกลับมาลุกโชน ${restoredStreak} วัน 🔥`
            } 
        });

    } catch (e) {
        await conn.rollback();
        res.status(400).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// --- API: หมุนกาชา (ฉบับอัปเดต: มี Bonus Coin Cashback) ---
app.post('/api/game/gacha-pull', async (req, res) => {
    const { lineUserId } = req.body;
    const GACHA_COST = 100; // ค่าหมุน 100 เหรียญ
    const conn = await db.getClient();

    // ⭐ กำหนดเรทเงินคืนตามระดับ (Cashback)
    const BONUS_RATES = {
        'C': 20,    // ปลอบใจ
        'R': 40,   // คืนทุน 10%
        'SR': 80,  // คืนทุน 50%
        'UR': 100  // กำไร! (ได้การ์ดแถมได้เงินเพิ่ม)
    };

    try {
        await conn.beginTransaction();

        // 1. เช็คเงิน
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        if (user.coinBalance < GACHA_COST) throw new Error("เหรียญไม่พอครับ (ต้องการ 100 เหรียญ)");

        // 2. สุ่มการ์ด (แยกตาม Rarity)
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
            if (backup.length === 0) throw new Error("ระบบยังไม่มีข้อมูลการ์ด");
            card = backup[0];
        }

        // ⭐ 3. คำนวณเงินสุทธิ (ลบค่าสุ่ม + บวกโบนัสที่ซ่อนในการ์ด)
        const bonusCoins = BONUS_RATES[card.rarity] || 5;
        const netChange = -GACHA_COST + bonusCoins;

        // อัปเดตเงิน
        await conn.query("UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?", [netChange, lineUserId]);

        // 4. บันทึกการได้การ์ด
        await conn.query("INSERT INTO user_cards (lineUserId, cardId) VALUES (?, ?)", [lineUserId, card.cardId]);

        // 5. แจ้งเตือน
        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, 'game_gacha', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `ได้รับการ์ด ${card.rarity}: "${card.cardName}" พร้อมเหรียญโบนัส ${bonusCoins} เหรียญ!`, card.cardId, lineUserId]
        );

        // ดึงยอดเงินล่าสุด
        const [[updatedUser]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);

        await conn.commit();
        
        // ส่งข้อมูลกลับ (เพิ่ม bonusCoins ไปบอกหน้าบ้าน)
        res.json({ 
            status: "success", 
            data: { 
                badge: { ...card, badgeName: card.cardName }, 
                remainingCoins: updatedUser.coinBalance,
                bonusCoins: bonusCoins // ส่งค่านี้ไปโชว์
            } 
        });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({message: e.message});
    } finally { conn.release(); }
});

// --- API: ดึงการ์ดสะสมของผู้ใช้ (แยกจาก Badges) ---
app.get('/api/user/cards', async (req, res) => {
    const { lineUserId } = req.query;
    
    // ดึงการ์ดทั้งหมดที่มีในระบบ
    const [allCards] = await db.query("SELECT * FROM safety_cards ORDER BY rarity DESC, cardName ASC");
    
    // ดึงการ์ดที่ user มี
    const [userCards] = await db.query("SELECT cardId, COUNT(*) as count FROM user_cards WHERE lineUserId = ? GROUP BY cardId", [lineUserId]);
    
    // แปลงเป็น Map เพื่อเช็คว่ามีกี่ใบ
    const ownedMap = {};
    userCards.forEach(c => ownedMap[c.cardId] = c.count);

    const result = allCards.map(c => ({
        ...c,
        isOwned: !!ownedMap[c.cardId], // มีหรือไม่มี
        count: ownedMap[c.cardId] || 0 // จำนวนที่ซ้ำ
    }));

    res.json({ status: "success", data: result });
});

// ======================================================
// ADMIN: Users list for admin panel
// ======================================================
// --- API: ดึงรายชื่อผู้ใช้ (Admin) - รองรับ Search & Sort ---
app.get('/api/admin/users', isAdmin, async (req, res) => {
    const { search, sortBy } = req.query;

    // ⭐ เพิ่ม coinBalance เข้าไปตรงนี้ครับ
    let sql = `
        SELECT lineUserId, fullName, pictureUrl, employeeId, totalScore, coinBalance
        FROM users
        WHERE 1=1
    `;

    let params = [];

    if (search) {
        sql += ` AND (fullName LIKE ? OR employeeId LIKE ?) `;
        params.push(`%${search}%`, `%${search}%`);
    }

    if (sortBy === "name") {
        sql += ` ORDER BY fullName ASC`;
    } else {
        sql += ` ORDER BY totalScore DESC`;
    }

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
        `SELECT lineUserId, fullName, employeeId, pictureUrl, totalScore
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

    res.json({ status: "success", data: { user, badges } });
});

// ==========================================
// 🛠️ ADMIN EDIT APIs (แก้ได้ทุกตาราง)
// ==========================================

// 1. แก้ไขคำถาม (Quiz)
app.put('/api/admin/questions', isAdmin, async (req, res) => {
    const { questionId, questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, scoreReward, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE daily_questions 
            SET questionText=?, optionA=?, optionB=?, optionC=?, optionD=?, optionE=?, optionF=?, optionG=?, optionH=?, correctOption=?, scoreReward=?, imageUrl=?
            WHERE questionId=?
        `, [questionText, optionA, optionB, optionC, optionD, optionE, optionF, optionG, optionH, correctOption, scoreReward, imageUrl, questionId]);
        res.json({ status: "success", message: "แก้ไขคำถามเรียบร้อย" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 2. แก้ไขการ์ด (Cards)
app.put('/api/admin/cards', isAdmin, async (req, res) => {
    const { cardId, cardName, description, rarity, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE cards 
            SET cardName=?, description=?, rarity=?, imageUrl=?
            WHERE cardId=?
        `, [cardName, description, rarity, imageUrl, cardId]);
        res.json({ status: "success", message: "แก้ไขการ์ดเรียบร้อย" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 3. แก้ไขกิจกรรม (Activities)
app.put('/api/admin/activities', isAdmin, async (req, res) => {
    const { activityId, title, description, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE activities 
            SET title=?, description=?, imageUrl=?
            WHERE activityId=?
        `, [title, description, imageUrl, activityId]);
        res.json({ status: "success", message: "แก้ไขกิจกรรมเรียบร้อย" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 4. แก้ไขป้ายรางวัล (Badges)
app.put('/api/admin/badges/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { badgeName, description, imageUrl } = req.body;
    try {
        await db.query(`
            UPDATE badges 
            SET badgeName=?, description=?, imageUrl=?
            WHERE badgeId=?
        `, [badgeName, description, imageUrl, id]);
        res.json({ status: "success", message: "แก้ไขป้ายรางวัลเรียบร้อย" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5. แก้ไขด่าน Hunter (อันนี้เดิมใช้ POST path update อยู่แล้ว แต่ใส่เผื่อไว้)
app.post('/api/admin/hunter/level/update', isAdmin, async (req, res) => {
    const { levelId, title, imageUrl, hazards } = req.body;
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        // อัปเดตข้อมูลด่าน
        await conn.query('UPDATE hunter_levels SET title=?, imageUrl=? WHERE levelId=?', [title, imageUrl, levelId]);
        
        // ลบจุดเดิมทิ้ง แล้วลงใหม่ (ง่ายกว่าไล่เช็คทีละจุด)
        await conn.query('DELETE FROM hunter_hazards WHERE levelId=?', [levelId]);
        
        // ลงจุดใหม่
        for (const h of hazards) {
            await conn.query('INSERT INTO hunter_hazards (levelId, x, y, description, knowledge) VALUES (?, ?, ?, ?, ?)', 
                [levelId, h.x, h.y, h.description, h.knowledge]);
        }
        await conn.commit();
        res.json({ status: "success", message: "แก้ไขด่านเรียบร้อย" });
    } catch (e) {
        await conn.rollback();
        res.status(500).json({ message: e.message });
    } finally {
        conn.release();
    }
});

// --- API: แก้ไขประวัติ KYT (Final Fix: ใช้ชื่อคอลัมน์ recipientUserId ตามภาพ) ---
app.post('/api/admin/kyt/update-answer', isAdmin, async (req, res) => {
    console.log("🚀 Admin Update KYT Start:", req.body);

    const { historyId, lineUserId, isCorrect, newScore, requesterId } = req.body;
    
    if (!historyId || !lineUserId) {
        return res.status(400).json({ message: "ข้อมูลไม่ครบ (Missing historyId or lineUserId)" });
    }

    try {
        // 1. ดึงข้อมูลเก่า
        const [oldData] = await db.query('SELECT earnedPoints FROM user_game_history WHERE historyId = ?', [historyId]);
        if (oldData.length === 0) throw new Error("ไม่พบประวัติการเล่น");
        
        const oldScore = oldData[0].earnedPoints || 0;
        const diff = parseInt(newScore) - oldScore; 
        
        // 2. อัปเดตประวัติ
        await db.query(`
            UPDATE user_game_history 
            SET isCorrect = ?, earnedPoints = ? 
            WHERE historyId = ?
        `, [isCorrect, newScore, historyId]);

        // 3. อัปเดตคะแนนรวม
        if (diff !== 0) {
            await db.query(`
                UPDATE users 
                SET coinBalance = coinBalance + ?, totalScore = totalScore + ?
                WHERE lineUserId = ?
            `, [diff, diff, lineUserId]);
        }

        // 4. สร้างการแจ้งเตือน (⭐⭐ แก้ชื่อคอลัมน์ตามภาพ image_bd7dee.png ⭐⭐)
        try {
            const msg = `แอดมินแก้ไขผล KYT: ${isCorrect ? 'ถูกต้อง✅' : 'ผิด❌'} (${diff >= 0 ? '+' : ''}${diff} เหรียญ)`;
            const notifId = 'NOTIF-' + Date.now();
            
            // ID ผู้ทำรายการ (Admin)
            const triggerUser = requesterId || lineUserId; 

            // ใช้ recipientUserId (ผู้รับ) และ triggeringUserId (ผู้ทำ)
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
            
            console.log("✅ Notification Saved to DB:", notifId);
            
        } catch (notifyError) {
            console.error("❌ แจ้งเตือนลง DB ล้มเหลว:", notifyError.message);
        }

        console.log("✅ Update Successfully");
        res.json({ status: "success", message: "แก้ไขและคืนเหรียญเรียบร้อย" });

    } catch (e) {
        console.error("❌ Critical Error Update KYT:", e);
        res.status(500).json({ message: "Update Failed: " + e.message });
    }
});

// ======================================================
// NOTIFICATIONS
// ======================================================
app.get('/api/notifications', async (req, res) => {
    const { requesterId } = req.query;

    const [rows] = await db.query(
        "SELECT * FROM notifications WHERE recipientUserId = ? ORDER BY createdAt DESC",
        [requesterId]
    );

    res.json({ status: "success", data: rows });
});

app.get('/api/notifications/unread-count', async (req, res) => {
    const { requesterId } = req.query;

    const [rows] = await db.query(
        "SELECT COUNT(*) AS count FROM notifications WHERE recipientUserId = ? AND isRead = FALSE",
        [requesterId]
    );
    res.json({
      status: "success",
      data: { unreadCount: rows[0].count }
    });
});

app.post('/api/notifications/mark-read', async (req, res) => {
    const { requesterId } = req.body;

    await db.query(
        "UPDATE notifications SET isRead = TRUE WHERE recipientUserId = ?",
        [requesterId]
    );

    res.json({ status: "success", data: { updated: true } });
});

// --- API: แลกเหรียญเป็นคะแนน (Exchange Coins to Score) ---
app.post('/api/game/exchange-coins', async (req, res) => {
    const { lineUserId } = req.body;
    const COIN_COST = 10;  // จ่าย 10 เหรียญ
    const POINT_GAIN = 2;  // ได้ 2 คะแนน
    
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เช็คยอดเงินปัจจุบัน
        const [[user]] = await conn.query("SELECT coinBalance, totalScore FROM users WHERE lineUserId = ?", [lineUserId]);
        if (!user || user.coinBalance < COIN_COST) {
            throw new Error(`เหรียญไม่พอครับ (มี ${user.coinBalance || 0} เหรียญ, ต้องการ ${COIN_COST} เหรียญ)`);
        }

        // 2. หักเหรียญ และ เพิ่มคะแนน
        await conn.query(
            "UPDATE users SET coinBalance = coinBalance - ?, totalScore = totalScore + ? WHERE lineUserId = ?", 
            [COIN_COST, POINT_GAIN, lineUserId]
        );

        // 3. แจ้งเตือน (Notification)
        await conn.query(
            `INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'exchange', ?, ?, NOW())`,
            [
                "NOTIF" + uuidv4(),
                lineUserId,
                `แลกเปลี่ยนสำเร็จ! คุณใช้ ${COIN_COST} เหรียญ แลกรับ ${POINT_GAIN} คะแนนเรียบร้อยแล้ว`,
                "exchange", // type ใหม่
                null,
                lineUserId
            ]
        );

        // 4. เช็ค Badge อัตโนมัติ (เผื่อคะแนนถึงเกณฑ์แล้วได้โล่)
        // (ฟังก์ชัน autoAwardBadgesForUser ต้องมีอยู่แล้วใน server.js ตามโค้ดเก่า)
        // await autoAwardBadgesForUser(lineUserId, conn); 

        // 5. ดึงค่าล่าสุดส่งกลับ
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

// --- API: ย่อยการ์ด (Recycle Cards) ---
app.post('/api/game/recycle-cards', async (req, res) => {
    const { lineUserId, cardsToRecycle } = req.body; 
    // cardsToRecycle = [{ cardId: 'CARD_001', count: 2 }, { cardId: 'CARD_002', count: 3 }] รวมกันต้องได้ 5 ใบ
    
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. ตรวจสอบจำนวนการ์ดรวม (ต้องครบ 5 ใบ)
        const totalCount = cardsToRecycle.reduce((sum, item) => sum + item.count, 0);
        if (totalCount !== 5) throw new Error("ต้องเลือกการ์ดมาย่อยให้ครบ 5 ใบพอดีครับ");

        // 2. ลบการ์ดออกจากตาราง (วนลูปย่อยทีละชนิด)
        for (const item of cardsToRecycle) {
            // เช็คก่อนว่ามีพอให้ลบไหม
            const [rows] = await conn.query(
                "SELECT count(*) as total FROM user_cards WHERE lineUserId = ? AND cardId = ?", 
                [lineUserId, item.cardId]
            );
            if (rows[0].total <= item.count) { 
                // ต้องเหลือไว้อย่างน้อย 1 ใบ (ห้ามย่อยหมดเกลี้ยง) 
                // หรือถ้าอนุญาตให้ย่อยหมดก็ได้ แต่ตามหลักเกมมักจะเก็บใบหลักไว้
                // ในที่นี้สมมติยอมให้ย่อยเฉพาะตัวซ้ำ (Frontend ต้องกรองมา)
                // แต่ Backend เช็คแค่ว่ามีของให้ลบไหมพอ
            }

            // คำสั่งลบแบบจำกัดจำนวน (LIMIT)
            await conn.query(
                "DELETE FROM user_cards WHERE lineUserId = ? AND cardId = ? LIMIT ?",
                [lineUserId, item.cardId, item.count]
            );
        }

        // 3. สุ่มรางวัล (Lucky Coin Box: 100 - 300 Coins)
        const rewardCoins = Math.floor(Math.random() * (300 - 100 + 1)) + 100;

        // 4. ให้รางวัล
        await conn.query(
            "UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?",
            [rewardCoins, lineUserId]
        );

        // 5. แจ้งเตือน
        await conn.query(
            `INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'recycle', ?, ?, NOW())`,
            ["NOTIF" + uuidv4(), lineUserId, `รีไซเคิลสำเร็จ! คุณได้รับ ${rewardCoins} เหรียญ`, "recycle", lineUserId]
        );

        // 6. ส่งค่ากลับ
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);

        await conn.commit();
        res.json({ status: "success", data: { rewardCoins, newCoinBalance: user.coinBalance } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({ status: "error", message: e.message });
    } finally { conn.release(); }
});

// ======================================================
// PART 5 — SAFETY HUNTER API (MySQL/TiDB Compatible)
// ======================================================

// 1. ADMIN: สร้างด่านใหม่ + บันทึกจุดเสี่ยง
app.post('/api/admin/hunter/level', isAdmin, async (req, res) => {
    const { title, imageUrl, hazards } = req.body; 
    const levelId = "LVL_" + Date.now();
    const conn = await db.getClient();
    
    try {
        await conn.beginTransaction();

        // 1. สร้าง Level
        await conn.query(
            "INSERT INTO hunter_levels (levelId, title, imageUrl, totalHazards) VALUES (?, ?, ?, ?)",
            [levelId, title, imageUrl, hazards.length]
        );

        // 2. บันทึกจุดเสี่ยง (วนลูป Insert ทีละแถว เพื่อความชัวร์ใน MySQL)
        if (Array.isArray(hazards) && hazards.length > 0) {
            for (const h of hazards) {
                await conn.query(
                    "INSERT INTO hunter_hazards (hazardId, levelId, description, x, y, radius) VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        "HZD_" + uuidv4(), 
                        levelId, 
                        h.description || 'จุดเสี่ยง', 
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

// 2. USER: ดึงรายชื่อด่านทั้งหมด (พร้อมดาว + จำนวนครั้งที่เล่น)
app.get('/api/game/hunter/levels', async (req, res) => {
    const { lineUserId } = req.query;
    
    // ดึงด่านทั้งหมด
    const [levels] = await db.query("SELECT * FROM hunter_levels ORDER BY createdAt DESC");
    
    // ดึงดาวสูงสุด (Best Stars)
    const [history] = await db.query(`
        SELECT levelId, MAX(stars) as bestStars 
        FROM user_hunter_history 
        WHERE lineUserId = ? 
        GROUP BY levelId
    `, [lineUserId]);
    
    const historyMap = {};
    history.forEach(h => { historyMap[h.levelId] = h.bestStars; });

    // ⭐ ดึงจำนวนครั้งที่เล่น (Attempts)
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
        // เพิ่มฟิลด์นี้ส่งกลับไป
        playedCount: attemptsMap[l.levelId] || 0,
        maxPlays: 3 // กำหนดค่า Max ไว้ตรงนี้เลย
    }));

    res.json({ status: "success", data: result });
});

// 3. USER: ตรวจสอบพิกัด (Check Hit)
app.post('/api/game/hunter/check', async (req, res) => {
    const { levelId, x, y } = req.body; 

    const [hazards] = await db.query("SELECT * FROM hunter_hazards WHERE levelId = ?", [levelId]);
    
    let hit = null;
    for (const h of hazards) {
        // คำนวณระยะห่าง
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

// 4. USER: จบเกม (รับรางวัล + บันทึกดาว)
app.post('/api/game/hunter/complete', async (req, res) => {
    const { lineUserId, levelId, stars } = req.body; // ⭐ รับ stars เพิ่ม
    const REWARD = 150; 
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // เช็คว่าเคยผ่านด่านนี้หรือยัง (เพื่อแจกเหรียญแค่ครั้งแรก)
        const [hist] = await conn.query("SELECT * FROM user_hunter_history WHERE lineUserId = ? AND levelId = ?", [lineUserId, levelId]);
        
        let earnedCoins = 0;
        if (hist.length === 0) {
            earnedCoins = REWARD;
            await conn.query("UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?", [earnedCoins, lineUserId]);
            
            // แจ้งเตือนเหรียญ (เฉพาะครั้งแรก)
            await conn.query(
                "INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())",
                ["NOTIF" + uuidv4(), lineUserId, `สุดยอด! คุณค้นหาจุดเสี่ยงครบ รับ ${earnedCoins} เหรียญ`, 'game_hunter', levelId, lineUserId]
            );
        }

        // ⭐ แก้ไข: ใช้ ON DUPLICATE KEY UPDATE รองรับการเล่นซ้ำ
        // (ถ้ามีข้อมูลแล้ว จะอัปเดตดาวให้เฉพาะเมื่อได้ดาวมากกว่าเดิม)
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

// --- API: เริ่มเล่นด่าน (นับจำนวนครั้ง) ---
app.post('/api/game/hunter/start-level', async (req, res) => {
    const { lineUserId, levelId } = req.body;
    const MAX_PLAYS = 3;

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // 1. เช็คจำนวนครั้งปัจจุบัน
        const [rows] = await conn.query(
            "SELECT attempt_count FROM hunter_attempts WHERE lineUserId = ? AND levelId = ?",
            [lineUserId, levelId]
        );

        let current = 0;
        if (rows.length > 0) {
            current = rows[0].attempt_count;
        }

        // 2. ถ้าครบ 3 ครั้งแล้ว -> ห้ามเล่น
        if (current >= MAX_PLAYS) {
            throw new Error(`คุณใช้สิทธิ์เล่นด่านนี้ครบ ${MAX_PLAYS} ครั้งแล้ว`);
        }

        // 3. บวกเพิ่ม 1 ครั้ง
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

// --- API: ดึงรายละเอียดด่าน (รวมจุดเสี่ยง) เพื่อมาแก้ไข ---
app.get('/api/admin/hunter/level/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [levels] = await db.query("SELECT * FROM hunter_levels WHERE levelId = ?", [id]);
        if (levels.length === 0) throw new Error("ไม่พบด่าน");

        const [hazards] = await db.query("SELECT * FROM hunter_hazards WHERE levelId = ?", [id]);
        
        res.json({ status: "success", data: { ...levels[0], hazards } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// --- API: อัปเดตด่าน (แก้ชื่อ + แก้จุดเสี่ยง) ---
app.post('/api/admin/hunter/level/update', isAdmin, async (req, res) => {
    const { levelId, title, hazards } = req.body; // เราจะไม่แก้รูปภาพเพื่อความง่าย (ถ้าจะแก้รูป ลบสร้างใหม่ง่ายกว่า)
    
    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // 1. อัปเดตชื่อและจำนวนจุด
        await conn.query(
            "UPDATE hunter_levels SET title = ?, totalHazards = ? WHERE levelId = ?",
            [title, hazards.length, levelId]
        );

        // 2. ลบจุดเสี่ยงเก่าทิ้งทั้งหมด (แล้วใส่ใหม่ ง่ายกว่ามาเช็คทีละจุด)
        await conn.query("DELETE FROM hunter_hazards WHERE levelId = ?", [levelId]);

        // 3. ใส่จุดเสี่ยงใหม่
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

// --- API: ลบด่าน ---
app.delete('/api/admin/hunter/level/:id', isAdmin, async (req, res) => {
    try {
        // Cascade จะลบ hazards และ attempts ให้อัตโนมัติ (ตามที่เราแก้ DB ไป)
        await db.query("DELETE FROM hunter_levels WHERE levelId = ?", [req.params.id]);
        res.json({ status: "success", data: { deleted: true } });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// --- API: จบเกมแบบไม่ผ่าน (รับรางวัลปลอบใจ) ---
app.post('/api/game/hunter/fail', async (req, res) => {
    const { lineUserId, levelId } = req.body;
    const CONSOLATION_PRIZE = 10; // ⭐ กำหนดจำนวนเหรียญปลอบใจตรงนี้

    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // 1. เพิ่มเหรียญให้ User
        await conn.query(
            "UPDATE users SET coinBalance = coinBalance + ? WHERE lineUserId = ?",
            [CONSOLATION_PRIZE, lineUserId]
        );

        // 2. บันทึกแจ้งเตือน (Optional)
        await conn.query(
            "INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())",
            [
                "NOTIF" + uuidv4(), 
                lineUserId, 
                `พยายามได้ดี! รับรางวัลปลอบใจ ${CONSOLATION_PRIZE} เหรียญ จากภารกิจล่าจุดเสี่ยง`, 
                'game_hunter_fail', 
                levelId, 
                lineUserId
            ]
        );

        // 3. ดึงยอดล่าสุดส่งกลับ
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

const axios = require('axios'); // ต้องมีบรรทัดนี้ด้านบนสุด ถ้าไม่มีให้ npm install axios

// --- API: Admin กดปุ่มแจ้งเตือนเอง (Manual) ---
app.post('/api/admin/remind-streaks', isAdmin, async (req, res) => {
    // เรียกใช้ฟังก์ชันเดียวกับ Auto เลย
    const result = await broadcastStreakReminders();
    
    if (result.success) {
        // ⭐⭐⭐ แก้ตรงนี้: ต้องห่อ message ไว้ใน data เพื่อให้ callApi รับค่าได้ถูกต้อง ⭐⭐⭐
        res.json({ 
            status: "success", 
            data: { message: result.message } 
        });
    } else {
        res.status(500).json({ status: "error", message: result.message });
    }
});

// --- API: ทดสอบส่งแจ้งเตือนหาตัวเอง (Admin Only) ---
app.post('/api/admin/test-remind-self', isAdmin, async (req, res) => {
    const { requesterId } = req.body; // ไอดีของแอดมินที่กดปุ่ม
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

    try {
        if (!token) throw new Error("ไม่พบ LINE Channel Access Token");

        // สร้างข้อความ (Mock Data: สมมติว่ามี Streak 5 วัน เพื่อดูตัวอย่าง)
        const message = {
            to: requesterId,
            messages: [{
                type: "flex",
                altText: "[TEST] 🔥 ระวังไฟดับ! เข้ามาเติมด่วน",
                contents: {
                    type: "bubble",
                    body: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            { type: "text", text: "🔥 [TEST] ระวังไฟดับ!", weight: "bold", size: "xl", color: "#ff5500" },
                            { type: "text", text: `คุณรักษาสถิติมา 5 วันแล้ว (ตัวอย่าง)`, size: "md", color: "#555555", margin: "md" },
                            { type: "text", text: "รีบเล่น Daily Quiz ก่อนเที่ยงคืนเพื่อรักษาสถิติ!", size: "sm", color: "#aaaaaa", wrap: true, margin: "sm" }
                        ]
                    },
                    footer: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            {
                                type: "button",
                                action: { type: "uri", label: "เข้าเกมทันที 🎮", uri: "https://liff.line.me/2007053300-9xLKdwZp" },
                                style: "primary",
                                color: "#06C755"
                            }
                        ]
                    }
                }
            }]
        };

        // ยิงเข้าไลน์แอดมินคนเดียว
        await axios.post('https://api.line.me/v2/bot/message/push', message, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        });

        res.json({ status: "success", data: { message: "ส่งข้อความทดสอบสำเร็จ! เช็คไลน์ของคุณได้เลย" } });

    } catch (e) {
        console.error(e);
        res.status(500).json({ status: "error", message: e.message });
    }
});

// ==========================================
// 🕹️ GAME MONITOR API (Fixed & Updated)
// ==========================================

// 1. ดึงคนเล่น KYT วันนี้ (แก้: ลบ h.id ออก + ใช้เวลาไทย)
// --- API: ดึงข้อมูล Monitor KYT (ฉบับแก้ไข: ตรงกับตาราง kyt_questions ของคุณ) ---
app.get('/api/admin/monitor/kyt', isAdmin, async (req, res) => {
    try {
        const now = new Date();
        const thaiDate = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Bangkok"}));
        const todayStr = thaiDate.toISOString().split('T')[0];

        // ⭐ แก้ไข SQL: Join ด้วย questionId และดึง questionText
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
                COALESCE(q.questionText, 'คำถามถูกลบไปแล้ว') AS questionText
            FROM user_game_history h
            JOIN users u ON h.lineUserId = u.lineUserId
            LEFT JOIN kyt_questions q ON h.questionId = q.questionId
            WHERE DATE(h.playedAt) = ? 
            ORDER BY h.playedAt DESC
        `, [todayStr]); 
        
        res.json({ status: "success", data: rows });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 2. ดึงประวัติ Hunter (เหมือนเดิม)
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

// 3. ดู Streak (เหมือนเดิม)
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

// ⭐ 4. (ใหม่) กระเป๋าเหรียญ (Coin Wallet)
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

// --- ฟังก์ชันกลาง: ส่งแจ้งเตือน Streak (แยก 2 กลุ่ม: เตือน / ดับ) ---
async function broadcastStreakReminders() {
    const conn = await db.getClient();
    console.log(`[${new Date().toLocaleString()}] เริ่มกระบวนการแจ้งเตือน Streak แบบแยกกลุ่ม...`);

    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) return { success: false, message: "No Token" };

    try {
        // กลุ่ม 1: Warning (หายไป 1 วัน)
        const [warningUsers] = await conn.query(`
            SELECT lineUserId, currentStreak FROM user_streaks 
            WHERE currentStreak > 0 AND DATEDIFF(CURDATE(), lastPlayedDate) = 1
        `);

        // กลุ่ม 2: Lost (หายไป 2 วัน - แจ้งแค่ครั้งเดียว)
        const [lostUsers] = await conn.query(`
            SELECT lineUserId, currentStreak FROM user_streaks 
            WHERE currentStreak > 0 AND DATEDIFF(CURDATE(), lastPlayedDate) = 2
        `);

        // Helper function ยิงไลน์
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

        const sentWarning = await sendPush(warningUsers, "⚠️ เตือนภัย! ไฟจะดับ", "คุณรักษาสถิติมา {streak} วันแล้ว รีบเข้ามาเล่นก่อนเที่ยงคืน!", "#ffaa00", "เข้าเติมไฟ 🔥");
        
        const sentLost = await sendPush(lostUsers, "😭 ไฟดับแล้วเหลือ 0...", "เสียดายจัง! สถิติ {streak} วันสิ้นสุดลงแล้ว แต่เริ่มใหม่ได้เสมอนะ!", "#ff0000", "เริ่มจุดไฟใหม่ 🕯️");

        return { success: true, message: `Warning: ${sentWarning}, Lost: ${sentLost}` };

    } catch (e) {
        return { success: false, message: e.message };
    } finally { conn.release(); }
}

// --- ตั้งเวลา Auto (Cron Job) ---
// รูปแบบเวลา: 'นาที ชั่วโมง * * *'
// '0 12,15 * * *' แปลว่า: นาทีที่ 0 ของชั่วโมงที่ 12 และ 15 (เที่ยงตรง และ บ่ายสามโมงตรง)
cron.schedule('0 12,15 * * *', async () => {
    console.log(`[${new Date().toLocaleString()}] ⏰ ถึงเวลาแจ้งเตือนอัตโนมัติ (รอบ 12:00 / 15:00)...`);
    
    // เรียกฟังก์ชันแจ้งเตือน
    const result = await broadcastStreakReminders();
    console.log(`ผลการทำงาน: ${result.message}`);
    
}, {
    scheduled: true,
    timezone: "Asia/Bangkok" // สำคัญมาก! ต้องระบุเพื่อให้ตรงกับเวลาไทย
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

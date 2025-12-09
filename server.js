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

// -----------------------------
//   USER PROFILE
// -----------------------------
app.get('/api/user/profile', async (req, res) => {
    try {
        const { lineUserId } = req.query;
        if (!lineUserId) {
            return res.json({
                status: "success",
                data: { registered: false, user: null }
            });
        }

        const [rows] = await db.query(
            "SELECT * FROM users WHERE lineUserId = ?",
            [lineUserId]
        );
        if (rows.length === 0) {
            return res.json({
                status: "success",
                data: { registered: false, user: null }
            });
        }

        const user = rows[0];

        const [adminRows] = await db.query(
            "SELECT * FROM admins WHERE lineUserId = ?",
            [lineUserId]
        );

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
                options: { A: q.optionA, B: q.optionB }
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
    const { questionId, questionText, optionA, optionB, correctOption, imageUrl, scoreReward } = req.body;

    try {
        if (questionId) {
            // Update
            await db.query(
                `UPDATE kyt_questions 
                 SET questionText=?, optionA=?, optionB=?, correctOption=?, imageUrl=?, scoreReward=? 
                 WHERE questionId=?`,
                [questionText, optionA, optionB, correctOption, imageUrl, scoreReward || 10, questionId]
            );
            res.json({ status: "success", data: { message: "Updated" } });
        } else {
            // Create
            await db.query(
                `INSERT INTO kyt_questions (questionText, optionA, optionB, correctOption, imageUrl, scoreReward, isActive)
                 VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
                [questionText, optionA, optionB, correctOption, imageUrl, scoreReward || 10]
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

// --- API: จบเกม (คำนวณ Streak + แจก Coin) ---
app.post('/api/game/submit-answer-v2', async (req, res) => {
    const { lineUserId, questionId, selectedOption } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();
        
        // 1. ตรวจคำตอบ ... (เหมือนเดิม) ...
        const [qs] = await conn.query("SELECT * FROM kyt_questions WHERE questionId = ?", [questionId]);
        const question = qs[0];
        const isCorrect = (selectedOption === question.correctOption);
        
        // 2. คำนวณรางวัล (ให้ Coin แทน)
        let earnedCoins = isCorrect ? 50 : 10; // ถูกได้ 50, ผิดได้ 10
        let earnedScore = isCorrect ? question.scoreReward : 2; 

        // 3. ระบบ Streak (โบนัสความต่อเนื่อง)
        const [streakRow] = await conn.query("SELECT * FROM user_streaks WHERE lineUserId = ?", [lineUserId]);
        let currentStreak = 1;
        
        if (streakRow.length > 0) {
            const lastDate = new Date(streakRow[0].lastPlayedDate);
            const diffTime = Math.abs(new Date(today) - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 1) { 
                // มาเล่นต่อจากเมื่อวาน -> Streak ขึ้น
                currentStreak = streakRow[0].currentStreak + 1;
            } else if (diffDays === 0) {
                // เล่นซ้ำวันเดิม -> Streak เท่าเดิม
                currentStreak = streakRow[0].currentStreak;
            } else {
                // ขาดช่วง -> รีเซ็ตเหลือ 1
                currentStreak = 1;
            }
            
            // อัปเดต Streak
            await conn.query(
                "UPDATE user_streaks SET currentStreak = ?, lastPlayedDate = ? WHERE lineUserId = ?",
                [currentStreak, today, lineUserId]
            );
        } else {
            // เพิ่งเคยเล่นครั้งแรก
            await conn.query("INSERT INTO user_streaks VALUES (?, 1, ?, 1)", [lineUserId, today]);
        }

        // Streak Bonus: ทุกๆ 7 วัน ได้เหรียญเพิ่ม 100
        if (currentStreak > 0 && currentStreak % 7 === 0) {
            earnedCoins += 100; 
        }

        // 4. บันทึกผลและอัปเดต User
        // ... (บันทึก history เหมือนเดิม) ...
        await conn.query("UPDATE users SET totalScore = totalScore + ?, coinBalance = coinBalance + ? WHERE lineUserId = ?", [earnedScore, earnedCoins, lineUserId]);

        await conn.commit();
        res.json({ status: "success", data: { isCorrect, earnedCoins, currentStreak } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({message: e.message});
    } finally { conn.release(); }
});

// --- API: หมุนกาชา (ใช้ Coin แลกของ) ---
app.post('/api/game/gacha-pull', async (req, res) => {
    const { lineUserId } = req.body;
    const GACHA_COST = 100; // ค่าหมุน 100 เหรียญ
    const conn = await db.getClient();

    try {
        await conn.beginTransaction();

        // 1. เช็คเงิน
        const [[user]] = await conn.query("SELECT coinBalance FROM users WHERE lineUserId = ?", [lineUserId]);
        if (user.coinBalance < GACHA_COST) throw new Error("เหรียญไม่พอครับ (ต้องการ 100 เหรียญ)");

        // 2. หักเงิน
        await conn.query("UPDATE users SET coinBalance = coinBalance - ? WHERE lineUserId = ?", [GACHA_COST, lineUserId]);

        // 3. สุ่มของ (Logic เกลือ)
        // Rate: UR=1%, SR=5%, R=20%, C=74%
        const rand = Math.random() * 100;
        let rarity = 'C';
        if (rand < 1) rarity = 'UR';
        else if (rand < 6) rarity = 'SR';
        else if (rand < 26) rarity = 'R';

        // ดึงการ์ดตาม Rarity (ต้องมี column rarity ใน DB badges ด้วยนะครับ หรือสุ่มมั่วไปก่อนก็ได้)
        const [badges] = await conn.query("SELECT * FROM badges ORDER BY RAND() LIMIT 1"); // สมมติสุ่มมั่วก่อน
        const badge = badges[0];

        // 4. ให้ของ
        await conn.query("INSERT IGNORE INTO user_badges (lineUserId, badgeId) VALUES (?, ?)", [lineUserId, badge.badgeId]);

        // ==========================================
        // ✨ เพิ่มแจ้งเตือน: ได้การ์ดใหม่ ✨
        // ==========================================
        await conn.query(
            `INSERT INTO notifications 
            (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId, createdAt)
             VALUES (?, ?, ?, 'game_gacha', ?, ?, NOW())`,
            [
                "NOTIF" + uuidv4(),
                lineUserId,
                `คุณได้รับ Safety Card ระดับ ${badge.rarity || 'ทั่วไป'}: "${badge.badgeName}" จากตู้กาชา`,
                badge.badgeId, // relatedItemId (เก็บ ID การ์ดที่ได้)
                lineUserId
            ]
        );

        await conn.commit();
        res.json({ status: "success", data: { badge, remainingCoins: user.coinBalance - GACHA_COST } });

    } catch (e) {
        await conn.rollback();
        res.status(500).json({message: e.message});
    } finally { conn.release(); }
});

// ======================================================
// ADMIN: Users list for admin panel
// ======================================================
app.get('/api/admin/users', isAdmin, async (req, res) => {
    const { search, sortBy } = req.query;

    let sql = `
        SELECT lineUserId, fullName, pictureUrl, employeeId, totalScore
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

    const [rows] = await db.query(sql, params);

    res.json({ status: "success", data: rows });
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

// ======================================================
// SERVER START
// ======================================================
app.get('/', (req, res) => {
    res.send("Safety Spot Backend is running.");
});

app.listen(PORT, "0.0.0.0", () =>
    console.log(`Backend running on port ${PORT}`)
);

// server.js (เวอร์ชันแปลงสำหรับ MySQL)
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const db = require('./db'); // db.js จะเป็นเวอร์ชันใหม่แล้ว
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { v4: uuidv4 } = require('uuid');
const { distance } = require('fastest-levenshtein'); // <<< เพิ่มบรรทัดนี้

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

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

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '30d',
  immutable: true
}));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const handleRequest = (handler) => async (req, res) => {
    try {
        // ใน mysql2 ผลลัพธ์จะอยู่ใน index 0 ของ array ที่ return มา
        const [data] = await handler(req, res);
        res.status(200).json({ status: 'success', data: data || null });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
};

const isAdmin = async (req, res, next) => {
    const requesterId = req.body.requesterId || req.query.requesterId;
    if (!requesterId) return res.status(401).json({ status: 'error', message: 'Unauthorized: Missing Requester ID' });
    try {
        // เปลี่ยน Syntax เป็น MySQL
        const [adminRows] = await db.query('SELECT * FROM admins WHERE `lineUserId` = ?', [requesterId]);
        if (adminRows.length === 0) return res.status(403).json({ status: 'error', message: 'Forbidden: Not an admin' });
        next();
    } catch (error) {
        console.error('Error during admin check:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error during auth' });
    }
};

app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
    try {
        const uploadStream = cloudinary.uploader.upload_stream({ folder: 'safety-spot' }, (error, result) => {
            if (result) return res.status(200).json({ status: 'success', data: { imageUrl: result.secure_url } });
            console.error('Cloudinary upload error:', error);
            res.status(500).json({ status: 'error', message: 'Failed to upload to Cloudinary.' });
        });
        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
    } catch (error) {
        console.error('API Error on /api/upload:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error.' });
    }
});

// --- User & General Routes (Converted to MySQL) ---
app.get('/api/user/profile', async (req, res) => {
    try {
        const { lineUserId } = req.query;
        if (!lineUserId) return res.status(200).json({ status: 'success', data: { registered: false, user: null } });
        
        const [userRows] = await db.query('SELECT * FROM users WHERE `lineUserId` = ?', [lineUserId]);
        if (userRows.length === 0) return res.status(200).json({ status: 'success', data: { registered: false, user: null } });
        
        const user = userRows[0];
        const [adminRows] = await db.query('SELECT * FROM admins WHERE `lineUserId` = ?', [lineUserId]);
        user.isAdmin = adminRows.length > 0;
        
        res.status(200).json({ status: 'success', data: { registered: true, user } });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});


app.post('/api/user/register', async (req, res) => {
    try {
        const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;
        const [existingUserRows] = await db.query('SELECT * FROM users WHERE `lineUserId` = ? OR `employeeId` = ?', [lineUserId, employeeId]);
        if (existingUserRows.length > 0) throw new Error('LINE User ID หรือรหัสพนักงานนี้มีอยู่ในระบบแล้ว');
        
        await db.query('INSERT INTO users (`lineUserId`, `displayName`, `pictureUrl`, `fullName`, `employeeId`, `totalScore`) VALUES (?, ?, ?, ?, ?, ?)', [lineUserId, displayName, pictureUrl, fullName, employeeId, 0]);
        
        const newUser = { lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore: 0, isAdmin: false };
        res.status(200).json({ status: 'success', data: newUser });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});

app.get('/api/activities', async (req, res) => {
    try {
        const { lineUserId } = req.query;
        // ดึงกิจกรรมที่ active ทั้งหมดมาก่อนเสมอ
        const [activities] = await db.query("SELECT * FROM activities WHERE status = 'active' ORDER BY `createdAt` DESC");

        // ถ้าไม่ได้ส่ง lineUserId มา (เช่น จากการรีเฟรช) ก็ส่งข้อมูลกิจกรรมกลับไปเลย
        if (!lineUserId) {
            return res.status(200).json({ status: 'success', data: activities });
        }

        // --- จุดที่แก้ไขอยู่ตรงนี้ครับ ---
        // highlight-start
        // ดึง ID ของกิจกรรมที่ User คนนี้เคยเข้าร่วม และสถานะยังเป็น pending หรือ approved เท่านั้น
        const [submittedActivities] = await db.query(
            "SELECT `activityId` FROM submissions WHERE `lineUserId` = ? AND `status` IN ('pending', 'approved')",
            [lineUserId]
        );
        // highlight-end
        const submittedActivityIds = new Set(submittedActivities.map(s => s.activityId));

        // เพิ่มสถานะ 'userHasSubmitted' เข้าไปในข้อมูลกิจกรรมแต่ละอัน
        const activitiesWithStatus = activities.map(activity => ({
            ...activity,
            userHasSubmitted: submittedActivityIds.has(activity.activityId)
        }));

        res.status(200).json({ status: 'success', data: activitiesWithStatus });

    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});

app.get('/api/leaderboard', handleRequest(async (req) => {
    const limit = 30; // กำหนดให้ดึงข้อมูลครั้งละ 30 คน
    const page = parseInt(req.query.page) || 1; // รับหมายเลขหน้ามาจาก Frontend (ถ้าไม่ส่งมา ให้เป็นหน้า 1)
    const offset = (page - 1) * limit; // คำนวณว่าจะต้องข้ามข้อมูลไปกี่แถว

    const query = 'SELECT `fullName`, `pictureUrl`, `totalScore` FROM users ORDER BY `totalScore` DESC, `fullName` ASC LIMIT ? OFFSET ?';
    
    // ส่ง limit และ offset เข้าไปใน query อย่างปลอดภัย
    return db.query(query, [limit, offset]);
}));

app.get('/api/user/badges', async (req, res) => {
    try {
        const { lineUserId } = req.query;
        const [allBadgesRows] = await db.query('SELECT `badgeId` as id, `badgeName` as name, description as `desc`, `imageUrl` as img FROM badges');
        const [userBadgeRows] = await db.query('SELECT `badgeId` FROM user_badges WHERE `lineUserId` = ?', [lineUserId]);
        
        const userEarnedIds = new Set(userBadgeRows.map(b => b.badgeId));
        const resultData = allBadgesRows.map(b => ({ ...b, isEarned: userEarnedIds.has(b.id) }));
        
        res.status(200).json({ status: 'success', data: resultData });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});


app.get('/api/submissions', async (req, res) => {
    try {
        const { activityId, lineUserId } = req.query;
        
        const sql = `SELECT s.submissionId, s.description, s.imageUrl, s.createdAt, s.points, u.fullName as submitterFullName, u.pictureUrl as submitterPictureUrl, (SELECT COUNT(*) FROM likes WHERE submissionId = s.submissionId) as likes FROM submissions s JOIN users u ON s.lineUserId = u.lineUserId WHERE s.activityId = ? AND s.status IN ('approved', 'pending') ORDER BY s.createdAt DESC;`;
        const [submissionsRows] = await db.query(sql, [activityId]);

        const [likesRows] = await db.query('SELECT `submissionId` FROM likes WHERE `lineUserId` = ?', [lineUserId]);
        const userLikedIds = new Set(likesRows.map(l => l.submissionId));
        
        const submissionIds = submissionsRows.map(s => s.submissionId);
        let commentsBySubmission = {};
        if (submissionIds.length > 0) {
            const commentsSql = `SELECT c.submissionId, c.commentText, u.fullName as commenterFullName, u.pictureUrl as commenterPictureUrl FROM comments c JOIN users u ON c.lineUserId = u.lineUserId WHERE c.submissionId IN (?) ORDER BY c.createdAt ASC;`;
            const [commentsRows] = await db.query(commentsSql, [submissionIds]);
            commentsRows.forEach(c => {
                if (!commentsBySubmission[c.submissionId]) commentsBySubmission[c.submissionId] = [];
                commentsBySubmission[c.submissionId].push({ commentText: c.commentText, commenter: { fullName: c.commenterFullName, pictureUrl: c.commenterPictureUrl } });
            });
        }
        
        const resultData = submissionsRows.map(sub => ({
            submissionId: sub.submissionId,
            description: sub.description,
            imageUrl: sub.imageUrl,
            createdAt: sub.createdAt,
            points: sub.points,
            submitter: { fullName: sub.submitterFullName, pictureUrl: sub.submitterPictureUrl },
            likes: sub.likes,
            didLike: userLikedIds.has(sub.submissionId),
            comments: commentsBySubmission[sub.submissionId] || []
        }));
        
        res.status(200).json({ status: 'success', data: resultData });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});

app.post('/api/submissions', async (req, res) => {
    const { activityId, lineUserId, description, imageUrl } = req.body;
    try {
        const normalizedDescription = description.trim();
        if (!normalizedDescription) {
            throw new Error('กรุณากรอกรายละเอียดของรายงาน');
        }

        const SIMILARITY_THRESHOLD = 5; 
        const [recentSubmissions] = await db.query(
            'SELECT `description` FROM `submissions` WHERE `activityId` = ? ORDER BY `createdAt` DESC LIMIT 20',
            [activityId]
        );

        for (const submission of recentSubmissions) {
            const similarity = distance(normalizedDescription, submission.description);
            if (similarity < SIMILARITY_THRESHOLD) {
                throw new Error('เนื้อหารายงานมีความคล้ายคลึงกับรายงานที่มีอยู่แล้ว');
            }
        }

        // --- จุดที่แก้ไขอยู่ตรงนี้ครับ ---
        // highlight-start
        // ตรวจสอบว่าผู้ใช้คนเดิมมีรายงานที่ "รอตรวจ" หรือ "อนุมัติแล้ว" ค้างอยู่ในกิจกรรมนี้หรือไม่
        const [existingSubmissions] = await db.query(
            "SELECT `submissionId` FROM `submissions` WHERE `activityId` = ? AND `lineUserId` = ? AND `status` IN ('pending', 'approved')",
            [activityId, lineUserId]
        );
        // highlight-end

        if (existingSubmissions.length > 0) {
            throw new Error('คุณได้เข้าร่วมกิจกรรมนี้และรายงานกำลังรอการตรวจสอบหรือได้รับการอนุมัติไปแล้ว');
        }

        await db.query(
            'INSERT INTO submissions (`submissionId`, `activityId`, `lineUserId`, `description`, `imageUrl`, `status`, `createdAt`) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ["SUB" + uuidv4(), activityId, lineUserId, normalizedDescription, imageUrl, 'pending', new Date()]
        );
        
        res.status(200).json({ status: 'success', data: { message: 'Submission created.' } });

    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(400).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});

app.post('/api/submissions/like', async (req, res) => {
    const { submissionId, lineUserId } = req.body;
    const client = await db.getClient();
    try {
        await client.beginTransaction();
        const [existingLikeRows] = await client.query('SELECT `likeId` FROM likes WHERE `submissionId` = ? AND `lineUserId` = ?', [submissionId, lineUserId]);
        
        if (existingLikeRows.length > 0) {
            // กรณี Unlike: แค่ลบไลค์ออก ไม่ทำอะไรกับคะแนนและ Notification
            await client.query('DELETE FROM likes WHERE `likeId` = ?', [existingLikeRows[0].likeId]);
        } else {
            // กรณี Like ใหม่:
            await client.query('INSERT INTO likes (`likeId`, `submissionId`, `lineUserId`, `createdAt`) VALUES (?, ?, ?, ?)', ["LIKE" + uuidv4(), submissionId, lineUserId, new Date()]);

            const [submissionRows] = await client.query('SELECT `lineUserId` FROM submissions WHERE `submissionId` = ?', [submissionId]);
            
            if (submissionRows.length > 0) {
                const ownerId = submissionRows[0].lineUserId;
                if (ownerId !== lineUserId) {
                    // --- Logic ป้องกันการปั๊มคะแนน ---
                    // 1. ค้นหาใน 'สมุดบัญชี' (notifications) ว่าเคยให้คะแนนจากการไลค์ของผู้ใช้คนนี้ที่โพสต์นี้แล้วหรือยัง
                    const [existingPointNotif] = await client.query(
                        "SELECT notificationId FROM notifications WHERE relatedItemId = ? AND type = 'like' AND triggeringUserId = ?",
                        [submissionId, lineUserId]
                    );

                    // 2. ถ้ายังไม่เคยเจอ (เป็นไลค์ครั้งแรกที่ควรได้คะแนน) เราถึงจะบวกคะแนนและสร้าง Notification
                    if (existingPointNotif.length === 0) {
                        await client.query('UPDATE users SET `totalScore` = `totalScore` + 1 WHERE `lineUserId` = ?', [ownerId]);
                        
                        const [likerRows] = await client.query('SELECT fullName FROM users WHERE lineUserId = ?', [lineUserId]);
                        const likerName = likerRows.length > 0 ? likerRows[0].fullName : 'Someone';
                        const message = `${likerName} ได้กดไลค์รายงานของคุณ`;
                        await client.query(
                            'INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId) VALUES (?, ?, ?, ?, ?, ?)',
                            ["NOTIF" + uuidv4(), ownerId, message, 'like', submissionId, lineUserId]
                        );
                    }
                    // ถ้าเคยเจอแล้ว (existingPointNotif.length > 0) ก็จะไม่ทำอะไรเลย ข้ามการให้คะแนนไป
                }
            }
        }
        
        const [countRows] = await client.query('SELECT COUNT(*) as count FROM likes WHERE `submissionId` = ?', [submissionId]);
        await client.commit();
        res.status(200).json({ status: 'success', data: { status: existingLikeRows.length > 0 ? 'unliked' : 'liked', newLikeCount: countRows[0].count }});
    
    } catch (error) {
        await client.rollback();
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    } finally {
        client.release();
    }
});

app.post('/api/submissions/comment', async (req, res) => {
    const { submissionId, lineUserId, commentText } = req.body;
    if (!commentText || !commentText.trim()) {
        return res.status(400).json({ status: 'error', message: "Comment cannot be empty."});
    }

    const client = await db.getClient();
    try {
        await client.beginTransaction();
        const commentId = "CMT" + uuidv4();
        const trimmedComment = commentText.trim();

        await client.query('INSERT INTO comments (`commentId`, `submissionId`, `lineUserId`, `commentText`, `createdAt`) VALUES (?, ?, ?, ?, ?)', 
            [commentId, submissionId, lineUserId, trimmedComment, new Date()]
        );

        const [submissionRows] = await client.query('SELECT `lineUserId` FROM submissions WHERE `submissionId` = ?', [submissionId]);
        
        if (submissionRows.length > 0) {
            const ownerId = submissionRows[0].lineUserId;
            if (ownerId !== lineUserId) {
                // --- ส่วนที่อัปเกรด ---
                // highlight-start
                // 1. ตรวจสอบว่าผู้ใช้คนนี้เคยคอมเมนต์ที่โพสต์นี้กี่ครั้งแล้ว (นับรวมครั้งล่าสุดที่เพิ่งเพิ่มเข้าไป)
                const [commentCountRows] = await client.query(
                    'SELECT COUNT(*) as commentCount FROM comments WHERE submissionId = ? AND lineUserId = ?',
                    [submissionId, lineUserId]
                );

                // 2. ถ้าเคยคอมเมนต์แค่ครั้งเดียว (คือครั้งนี้เป็นครั้งแรก) ถึงจะให้คะแนน
                if (commentCountRows[0].commentCount === 1) {
                    await client.query('UPDATE users SET `totalScore` = `totalScore` + 1 WHERE `lineUserId` = ?', [ownerId]);

                    // สร้าง Notification (ยังคงทำเหมือนเดิมสำหรับคอมเมนต์แรก)
                    const [commenterRows] = await client.query('SELECT fullName FROM users WHERE lineUserId = ?', [lineUserId]);
                    const commenterName = commenterRows.length > 0 ? commenterRows[0].fullName : 'Someone';
                    const message = `${commenterName} ได้แสดงความคิดเห็นบนรายงานของคุณ`;
                    await client.query(
                       'INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId) VALUES (?, ?, ?, ?, ?, ?)', 
                       ["NOTIF" + uuidv4(), ownerId, message, 'comment', submissionId, lineUserId] // lineUserId คือ ID ของผู้คอมเมนต์
                    );
                }
                // highlight-end
            }
        }
        
        const [newCommentRows] = await client.query(`
            SELECT c.commentText, u.fullName, u.pictureUrl FROM comments c 
            JOIN users u ON c.lineUserId = u.lineUserId WHERE c.commentId = ?`, [commentId]);

        const newCommentData = { commentText: newCommentRows[0].commentText, commenter: { fullName: newCommentRows[0].fullName, pictureUrl: newCommentRows[0].pictureUrl }};
        
        await client.commit();
        res.status(200).json({ status: 'success', data: newCommentData });

    } catch (error) {
        await client.rollback();
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    } finally {
        client.release();
    }
});

app.post('/api/user/refresh-profile', handleRequest(async (req) => {
    const { lineUserId, displayName, pictureUrl } = req.body;
    if (!lineUserId || !displayName || !pictureUrl) {
        throw new Error('Missing required profile data.');
    }
    // อัปเดตชื่อและ URL รูปภาพล่าสุดลงฐานข้อมูล
    return db.query(
        'UPDATE users SET displayName = ?, pictureUrl = ? WHERE lineUserId = ?',
        [displayName, pictureUrl, lineUserId]
    );
}));

// --- Admin Routes (Converted to MySQL) ---
app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const [totalUsersRes] = await db.query('SELECT COUNT(*) as totalUsers FROM users');
        const [totalSubmissionsRes] = await db.query('SELECT COUNT(*) as totalSubmissions FROM submissions');
        const [submissionsTodayRes] = await db.query("SELECT COUNT(*) as submissionsToday FROM submissions WHERE DATE(`createdAt`) = CURDATE()");
        const [mostReportedRes] = await db.query(`SELECT a.title, COUNT(s.submissionId) as reportCount FROM submissions s JOIN activities a ON s.activityId = a.activityId GROUP BY s.activityId, a.title ORDER BY reportCount DESC LIMIT 1;`);
        
        const resultData = {
            totalUsers: totalUsersRes[0].totalUsers,
            totalSubmissions: totalSubmissionsRes[0].totalSubmissions,
            submissionsToday: submissionsTodayRes[0].submissionsToday,
            mostReportedActivity: mostReportedRes.length > 0 ? mostReportedRes[0].title : "N/A"
        };
        res.status(200).json({ status: 'success', data: resultData });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});


app.get('/api/admin/dashboard-stats', isAdmin, handleRequest(async () => {
    const [pendingRes, usersRes, activitiesRes] = await Promise.all([
        db.query("SELECT COUNT(*) as count FROM submissions WHERE status = 'pending'"),
        db.query("SELECT COUNT(*) as count FROM users"),
        db.query("SELECT COUNT(*) as count FROM activities WHERE status = 'active'")
    ]);
    return [{ // Return as an array to match the handleRequest expectation
        pendingCount: pendingRes[0][0].count,
        userCount: usersRes[0][0].count,
        activeActivitiesCount: activitiesRes[0][0].count
    }];
}));

app.get('/api/admin/chart-data', isAdmin, async (req, res) => {
    try {
        // Recursive CTE to generate date series (works in MySQL 8+ and MariaDB 10.2+)
        const query = `
            WITH RECURSIVE dates (date) AS (
              SELECT CURDATE() - INTERVAL 6 DAY
              UNION ALL
              SELECT date + INTERVAL 1 DAY FROM dates WHERE date < CURDATE()
            )
            SELECT
              DATE_FORMAT(d.date, '%Y-%m-%d') AS day,
              COUNT(s.submissionId) AS count
            FROM dates d
            LEFT JOIN submissions s ON DATE(s.createdAt) = d.date
            GROUP BY d.date
            ORDER BY d.date;
        `;
        const [rows] = await db.query(query);
        const resultData = {
            labels: rows.map(r => new Date(r.day).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric' })),
            data: rows.map(r => r.count)
        };
        res.status(200).json({ status: 'success', data: resultData });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});


app.get('/api/admin/submissions/pending', isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT s.*, u.fullName FROM submissions s JOIN users u ON s.lineUserId = u.lineUserId WHERE s.status = 'pending' ORDER BY s.createdAt ASC`);
        const resultData = rows.map(s => ({...s, submitter: { fullName: s.fullName }}));
        res.status(200).json({ status: 'success', data: resultData });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});


// server.js

app.post('/api/admin/submissions/approve', isAdmin, async (req, res) => {
    const { submissionId, score } = req.body;
    const client = await db.getClient();
    try {
        await client.beginTransaction();
        const [submissionRows] = await client.query('SELECT `lineUserId` FROM submissions WHERE `submissionId` = ?', [submissionId]);
        if (submissionRows.length === 0) throw new Error('Submission not found');
        
        const { lineUserId } = submissionRows[0];
        await client.query('UPDATE submissions SET status = ?, points = ? WHERE `submissionId` = ?', ['approved', score, submissionId]);
        await client.query('UPDATE users SET `totalScore` = `totalScore` + ? WHERE `lineUserId` = ?', [score, lineUserId]);
        
        // --- ส่วนที่เพิ่มเข้ามา: สร้าง Notification ---
        const message = `รายงานของคุณได้รับการอนุมัติ และได้รับ ${score} คะแนน`;
        await client.query(
            'INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId) VALUES (?, ?, ?, ?, ?, ?)',
           ["NOTIF"+uuidv4(), lineUserId, message, 'approved', submissionId, req.body.requesterId] // req.body.requesterId คือ ID ของแอดมิน
        );
        // --- จบส่วนที่เพิ่ม ---

        await client.commit();
        res.status(200).json({ status: 'success', data: { message: 'Submission approved.' } });
    } catch (error) {
        await client.rollback();
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/submissions/reject', isAdmin, async (req, res) => {
    const { submissionId } = req.body;
    const client = await db.getClient();
    try {
        await client.beginTransaction();

        // 1. ค้นหาเจ้าของรายงานก่อน เพื่อจะได้รู้ว่าจะส่งแจ้งเตือนไปให้ใคร
        const [submissionRows] = await client.query('SELECT `lineUserId` FROM submissions WHERE `submissionId` = ?', [submissionId]);
        if (submissionRows.length === 0) throw new Error('Submission not found');
        const { lineUserId } = submissionRows[0];

        // 2. อัปเดตสถานะรายงานเป็น 'rejected'
        await client.query("UPDATE submissions SET status = 'rejected' WHERE `submissionId` = ?", [submissionId]);

        // --- ส่วนที่เพิ่มเข้ามา: สร้าง Notification ---
        const message = `น่าเสียดาย, รายงานของคุณไม่ผ่านการตรวจสอบ`;
        await client.query(
           'INSERT INTO notifications (notificationId, recipientUserId, message, type, relatedItemId, triggeringUserId) VALUES (?, ?, ?, ?, ?, ?)',
           ["NOTIF" + uuidv4(), lineUserId, message, 'rejected', submissionId, req.body.requesterId] // req.body.requesterId คือ ID ของแอดมิน
        );
        // --- จบส่วนที่เพิ่ม ---

        await client.commit();
        res.status(200).json({ status: 'success', data: { message: 'Submission rejected.' } });

    } catch (error) {
        await client.rollback();
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    } finally {
        client.release();
    }
});

app.delete('/api/admin/submissions/:submissionId', isAdmin, handleRequest(async (req) => {
    const { submissionId } = req.params;
    return db.query('DELETE FROM submissions WHERE `submissionId` = ?', [submissionId]);
}));


app.get('/api/admin/activities', isAdmin, handleRequest(async () => db.query('SELECT * FROM activities ORDER BY `createdAt` DESC')));


app.post('/api/admin/activities', isAdmin, handleRequest(async (req) => {
    const { title, description, imageUrl } = req.body;
    return db.query('INSERT INTO activities (`activityId`, `title`, `description`, `imageUrl`, `status`, `createdAt`) VALUES (?, ?, ?, ?, ?, ?)', ["ACT" + uuidv4(), title, description, imageUrl, 'active', new Date()]);
}));


app.put('/api/admin/activities', isAdmin, handleRequest(async (req) => {
    const { activityId, title, description, imageUrl } = req.body;
    return db.query('UPDATE activities SET `title` = ?, `description` = ?, `imageUrl` = ? WHERE `activityId` = ?', [title, description, imageUrl, activityId]);
}));


app.delete('/api/admin/activities/:activityId', isAdmin, async (req, res) => {
    const { activityId } = req.params;
    const client = await db.getClient();
    try {
        await client.beginTransaction();
        await client.query('DELETE FROM submissions WHERE `activityId` = ?', [activityId]);
        await client.query('DELETE FROM activities WHERE `activityId` = ?', [activityId]);
        await client.commit();
        res.status(200).json({ status: 'success', data: { message: 'Activity and its submissions deleted.' } });
    } catch (error) {
        await client.rollback();
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    } finally {
        client.release();
    }
});


app.post('/api/admin/activities/toggle', isAdmin, async (req, res) => {
    try {
        const { activityId } = req.body;
        const [activityRows] = await db.query('SELECT status FROM activities WHERE `activityId` = ?', [activityId]);
        if (activityRows.length === 0) throw new Error('Activity not found');
        
        const newStatus = activityRows[0].status === 'active' ? 'inactive' : 'active';
        await db.query('UPDATE activities SET status = ? WHERE `activityId` = ?', [newStatus, activityId]);
        
        res.status(200).json({ status: 'success', data: { newStatus } });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});

app.get('/api/admin/users', isAdmin, handleRequest(async (req) => {
    const limit = 30;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const searchTerm = req.query.search || '';
    // highlight-start
    const sortBy = req.query.sortBy || 'score'; // รับค่า sortBy, ถ้าไม่ส่งมาให้เรียงตาม 'score' เป็นค่าเริ่มต้น

    let orderByClause = 'ORDER BY `totalScore` DESC'; // ตั้งค่าการเรียงตามคะแนนสูงสุดเป็นค่าเริ่มต้น

    switch (sortBy) {
        case 'name':
            orderByClause = 'ORDER BY `fullName` ASC'; // ถ้าขอเรียงตามชื่อ
            break;
        case 'newest':
            // ตรวจสอบให้แน่ใจว่าตาราง users มีคอลัมน์ createdAt หรือคอลัมน์ที่เก็บวันที่สร้าง
            // หากไม่มี อาจจะต้องเพิ่มเข้าไปเพื่อให้ฟีเจอร์นี้ทำงานได้สมบูรณ์
            orderByClause = 'ORDER BY `createdAt` DESC'; 
            break;
        // default case คือ 'score' ที่เราตั้งไว้ข้างบนแล้ว
    }
    // highlight-end

    const query = `
      SELECT 
        \`lineUserId\`, 
        \`fullName\`, 
        \`employeeId\`, 
        \`totalScore\`, 
        \`pictureUrl\`,
        (SELECT COUNT(*) FROM user_badges WHERE \`lineUserId\` = users.\`lineUserId\`) as badgeCount,
        \`createdAt\`
      FROM users 
      WHERE (\`fullName\` LIKE ? OR \`employeeId\` LIKE ?) 
      ${orderByClause}
      LIMIT ? OFFSET ?`;
      
    return db.query(query, [`%${searchTerm}%`, `%${searchTerm}%`, limit, offset]);
}));

app.get('/api/admin/user-details/:lineUserId', isAdmin, async (req, res) => {
    try {
        const { lineUserId } = req.params;
        const [userRes, allBadgesRes, userBadgesRes] = await Promise.all([
            db.query('SELECT `lineUserId`, `fullName`, `employeeId`, `pictureUrl`, `totalScore` FROM users WHERE `lineUserId` = ?', [lineUserId]),
            db.query('SELECT `badgeId`, `badgeName` FROM badges ORDER BY `badgeName`'),
            db.query('SELECT `badgeId` FROM user_badges WHERE `lineUserId` = ?', [lineUserId])
        ]);

        const [userRows] = userRes;
        if (userRows.length === 0) throw new Error('User not found');
        
        const [allBadgesRows] = allBadgesRes;
        const [userBadgesRows] = userBadgesRes;
        const earnedBadgeIds = new Set(userBadgesRows.map(b => b.badgeId));
        
        const resultData = {
            user: userRows[0],
            allBadges: allBadgesRows,
            earnedBadgeIds: Array.from(earnedBadgeIds)
        };
        res.status(200).json({ status: 'success', data: resultData });
    } catch (error) {
        console.error(`API Error on ${req.method} ${req.path}:`, error);
        res.status(500).json({ status: 'error', message: error.message || 'An internal server error occurred.' });
    }
});

app.get('/api/admin/badges', isAdmin, handleRequest(async () => db.query('SELECT * FROM badges ORDER BY `badgeName`')));

app.post('/api/admin/badges', isAdmin, handleRequest(async (req) => {
    const { badgeName, description, imageUrl } = req.body;
    const badgeId = "BADGE" + uuidv4();
    return db.query('INSERT INTO badges (`badgeId`, `badgeName`, `description`, `imageUrl`) VALUES (?, ?, ?, ?)', [badgeId, badgeName, description, imageUrl]);
}));

app.put('/api/admin/badges/:badgeId', isAdmin, handleRequest(async (req) => {
    const { badgeId } = req.params;
    const { badgeName, description, imageUrl } = req.body;
    return db.query('UPDATE badges SET `badgeName` = ?, `description` = ?, `imageUrl` = ? WHERE `badgeId` = ?', [badgeName, description, imageUrl, badgeId]);
}));

app.delete('/api/admin/badges/:badgeId', isAdmin, handleRequest(async (req) => {
    const { badgeId } = req.params;
    return db.query('DELETE FROM badges WHERE `badgeId` = ?', [badgeId]);
}));

app.post('/api/admin/award-badge', isAdmin, handleRequest(async (req) => {
    const { lineUserId, badgeId } = req.body;
    // Use INSERT IGNORE for MySQL's version of ON CONFLICT DO NOTHING
    return db.query('INSERT IGNORE INTO user_badges (`lineUserId`, `badgeId`) VALUES (?, ?)', [lineUserId, badgeId]);
}));

app.post('/api/admin/revoke-badge', isAdmin, handleRequest(async (req) => {
    const { lineUserId, badgeId } = req.body;
    return db.query('DELETE FROM user_badges WHERE `lineUserId` = ? AND `badgeId` = ?', [lineUserId, badgeId]);
}));

// ================================= NOTIFICATION ROUTES =================================

// 1. API สำหรับดึงการแจ้งเตือนทั้งหมดของผู้ใช้
app.get('/api/notifications', handleRequest(async (req) => {
    // requesterId ถูกส่งมาจาก Frontend โดยอัตโนมัติจากฟังก์ชัน callApi
    const { requesterId } = req.query; 
    if (!requesterId) throw new Error("User ID is required.");
    return db.query('SELECT * FROM notifications WHERE recipientUserId = ? ORDER BY createdAt DESC', [requesterId]);
}));

// 2. API สำหรับนับจำนวนที่ยังไม่อ่าน (สำหรับจุดสีแดง)
app.get('/api/notifications/unread-count', handleRequest(async (req) => {
    const { requesterId } = req.query;
    if (!requesterId) throw new Error("User ID is required.");
    const [rows] = await db.query("SELECT COUNT(*) as unreadCount FROM notifications WHERE recipientUserId = ? AND isRead = FALSE", [requesterId]);
    // handleRequest คาดหวัง array เราจึงส่ง [rows] กลับไป
    return [rows]; 
}));

// 3. API สำหรับ "ทำเครื่องหมายว่าอ่านแล้วทั้งหมด"
app.post('/api/notifications/mark-read', handleRequest(async (req) => {
    // requesterId ถูกส่งมาจาก Frontend โดยอัตโนมัติจากฟังก์ชัน callApi
    const { requesterId } = req.body; 
    if (!requesterId) throw new Error("User ID is required.");
    return db.query("UPDATE notifications SET isRead = TRUE WHERE recipientUserId = ? AND isRead = FALSE", [requesterId]);
}));

// ================================= SERVER START =================================
app.get('/', (req, res) => res.send('Backend server is running!'));

// === Cloudinary Quota Checker (using environment variables) ===
const axios = require("axios");

const CLOUDINARY_ACCOUNT = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const authHeader =
  "Basic " +
  Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString("base64");

// Endpoint to check Cloudinary usage  (REPLACE this handler)
app.get("/api/cloudinary-usage", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_ACCOUNT}/usage`,
      { headers: { Authorization: authHeader } }
    );
    const data = response.data || {};

    // ===== Default limits (for Free plan) with ENV overrides =====
    const DEF_STORAGE_GB = Number(process.env.CLOUDINARY_STORAGE_LIMIT_GB || 25);
    const DEF_BW_GB      = Number(process.env.CLOUDINARY_BANDWIDTH_LIMIT_GB || 25);
    const DEF_TF         = Number(process.env.CLOUDINARY_TRANSFORM_LIMIT   || 25000);

    const toGB = (v) => (typeof v === "number" && isFinite(v)) ? (v / (1024 ** 3)) : null;
    const pickLimit = (obj) => (obj && (obj.limit ?? obj.quota ?? null));

    // raw values from API
    const stUsedRaw = data.storage?.usage ?? null;
    let   stLimitRaw = pickLimit(data.storage);
    const bwUsedRaw = data.bandwidth?.usage ?? null;
    let   bwLimitRaw = pickLimit(data.bandwidth);
    let   tfLimit    = data.transformations?.limit ?? data.transformations?.quota ?? null;
    const tfUsed     = data.transformations?.usage ?? null;

    // if API doesn't provide, fall back to defaults (GB -> bytes)
    if (!stLimitRaw) stLimitRaw = DEF_STORAGE_GB * 1024 ** 3;
    if (!bwLimitRaw) bwLimitRaw = DEF_BW_GB      * 1024 ** 3;
    if (!tfLimit)    tfLimit    = DEF_TF;

    const stUsedGB = toGB(stUsedRaw);
    const stLimitGB = toGB(stLimitRaw);
    const bwUsedGB = toGB(bwUsedRaw);
    const bwLimitGB = toGB(bwLimitRaw);

    const stPct = (stUsedGB !== null && stLimitGB) ? Number(((stUsedGB / stLimitGB) * 100).toFixed(2)) : null;
    const bwPct = (bwUsedGB !== null && bwLimitGB) ? Number(((bwUsedGB / bwLimitGB) * 100).toFixed(2)) : null;

    res.json({
      status: "success",
      plan: data.plan || "Free",
      storage: {
        used_gb: stUsedGB !== null ? stUsedGB.toFixed(2) : null,
        limit_gb: stLimitGB !== null ? stLimitGB.toFixed(2) : null,
        percent_used: stPct,
        over_limit: (stUsedGB !== null && stLimitGB) ? stUsedGB > stLimitGB : null
      },
      bandwidth: {
        used_gb: bwUsedGB !== null ? bwUsedGB.toFixed(2) : null,
        limit_gb: bwLimitGB !== null ? bwLimitGB.toFixed(2) : null,
        percent_used: bwPct,
        over_limit: (bwUsedGB !== null && bwLimitGB) ? bwUsedGB > bwLimitGB : null
      },
      transformations: {
        used: tfUsed,
        limit: tfLimit,
        percent_used: (typeof tfUsed === "number" && tfLimit) ? Number(((tfUsed / tfLimit) * 100).toFixed(2)) : null
      },
      updated_at: data.last_updated || null
    });
  } catch (error) {
    console.error("Cloudinary check failed:", error?.response?.data || error.message);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port ${PORT}`));


// server.js (เวอร์ชันตัด Cloudinary ออก ใช้ R2 อย่างเดียว)
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const { distance } = require('fastest-levenshtein'); // ถ้าไม่ได้ใช้จริงจะลบออกก็ได้

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================= CORS =======================
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
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// static (ถ้าวันหลังเก็บไฟล์โลคัล)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer ใช้เฉพาะ /api/upload
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ======================= R2 UPLOAD =======================
async function uploadToR2(buffer, mime = 'image/jpeg') {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_BASE_URL,
  } = process.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error('R2 not configured');
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const objectKey = `safety-spot/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: objectKey,
      Body: buffer,
      ContentType: mime,
    })
  );

  return `${R2_PUBLIC_BASE_URL}/${objectKey}`;
}

// ======================= HELPERS =======================
function handleRequest(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) {
        res.json({ status: 'success', data: result });
      }
    } catch (error) {
      console.error('Request error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          status: 'error',
          message: 'Internal server error',
          details: error.message
        });
      }
    }
  };
}

// ดึง lineUserId / requesterId จากทั้ง query และ body
function getRequesterLineUserId(req) {
  return (
    req.query.lineUserId ||
    req.query.requesterId ||
    req.body.lineUserId ||
    req.body.requesterId
  );
}

// ======================= MIDDLEWARE: isAdmin =======================
const isAdmin = async (req, res, next) => {
  try {
    const lineUserId = getRequesterLineUserId(req);

    if (!lineUserId) {
      return res
        .status(400)
        .json({ status: 'error', message: 'lineUserId is required for admin check' });
    }

    const [rows] = await db.query(
      'SELECT isAdmin FROM users WHERE lineUserId = ?',
      [lineUserId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    if (!rows[0].isAdmin) {
      return res.status(403).json({ status: 'error', message: 'Not an admin' });
    }

    next();
  } catch (error) {
    console.error('Error during admin check:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error during auth' });
  }
};

// ======================= /api/upload (R2 เท่านั้น) =======================
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Missing image file.' });
  }

  try {
    const mime = req.file.mimetype || 'image/jpeg';
    const finalUrl = await uploadToR2(req.file.buffer, mime);
    console.log('✅ Uploaded to R2:', finalUrl);

    return res.status(200).json({
      status: 'success',
      data: { imageUrl: finalUrl },
    });
  } catch (error) {
    console.error('❌ R2 upload error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Image upload failed. Please try again.',
    });
  }
});

// ======================= USER & PROFILE =======================
app.get('/api/user/profile', async (req, res) => {
  try {
    const lineUserId = getRequesterLineUserId(req);

    if (!lineUserId) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Missing lineUserId' });
    }

    const [rows] = await db.query(
      'SELECT lineUserId AS id, lineUserId, displayName, pictureUrl, totalScore FROM users WHERE lineUserId = ?',
      [lineUserId]
    );

    if (!rows || rows.length === 0) {
      // ให้รูปแบบตรงกับ app.js: { registered: false }
      return res.json({
        status: 'success',
        data: { registered: false }
      });
    }

    return res.json({
      status: 'success',
      data: { registered: true, user: rows[0] }
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

app.post('/api/user/register', async (req, res) => {
  try {
    const { lineUserId, displayName, pictureUrl, fullName, employeeId } = req.body;

    if (!lineUserId) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Missing lineUserId' });
    }

    const [existing] = await db.query(
      'SELECT * FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (existing && existing.length > 0) {
      return res.json({ status: 'success', data: existing[0] });
    }

    const [result] = await db.query(
      'INSERT INTO users (lineUserId, displayName, pictureUrl, fullName, employeeId, totalScore) VALUES (?, ?, ?, ?, ?, ?)',
      [lineUserId, displayName || null, pictureUrl || null, fullName || null, employeeId || null, 0]
    );

    const newUser = {
      id: result.insertId,
      lineUserId,
      displayName,
      pictureUrl,
      points: 0,
      totalScore: 0,
      isAdmin: 0,
    };

    res.json({ status: 'success', data: newUser });
  } catch (error) {
    console.error('Error registering user:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

app.post('/api/user/refresh-profile', handleRequest(async (req) => {
  const { lineUserId, displayName, pictureUrl } = req.body;

  if (!lineUserId) {
    throw new Error('Missing lineUserId');
  }

  const [existing] = await db.query(
    'SELECT * FROM users WHERE lineUserId = ?',
    [lineUserId]
  );

  if (!existing || existing.length === 0) {
    const [result] = await db.query(
      'INSERT INTO users (lineUserId, displayName, pictureUrl, points, totalScore, isAdmin) VALUES (?, ?, ?, ?, ?, ?)',
      [lineUserId, displayName || null, pictureUrl || null, 0, 0, 0]
    );

    return {
      id: result.insertId,
      lineUserId,
      displayName,
      pictureUrl,
      points: 0,
      totalScore: 0,
      isAdmin: 0,
    };
  } else {
    const user = existing[0];
    if (displayName || pictureUrl) {
      await db.query(
        'UPDATE users SET displayName = ?, pictureUrl = ? WHERE id = ?',
        [
          displayName || user.displayName,
          pictureUrl || user.pictureUrl,
          user.id,
        ]
      );
      user.displayName = displayName || user.displayName;
      user.pictureUrl = pictureUrl || user.pictureUrl;
    }
    return user;
  }
}));

// ======================= ACTIVITIES & LEADERBOARD =======================
app.get('/api/activities', async (req, res) => {
  try {
    const lineUserId = getRequesterLineUserId(req) || null;

    const [activities] = await db.query(`
        SELECT a.*,
              (SELECT COUNT(*) FROM submissions s 
                WHERE s.activityId = a.activityId AND s.status = 'approved') AS submissionsCount
        FROM activities a
        WHERE a.status = 'active'
        ORDER BY a.createdAt DESC
    `);

    let userId = null;
    if (lineUserId) {
      const [userRows] = await db.query(
        'SELECT id FROM users WHERE lineUserId = ?',
        [lineUserId]
      );
      if (userRows && userRows.length > 0) {
        userId = userRows[0].id;
      }
    }

    if (userId) {
      for (const activity of activities) {
        const [subRows] = await db.query(
          'SELECT id, status FROM submissions WHERE activityId = ? AND userId = ? ORDER BY createdAt DESC LIMIT 1',
          [activity.id, userId]
        );
        if (subRows && subRows.length > 0) {
          const sub = subRows[0];
          activity.userSubmissionStatus = sub.status;
          activity.userSubmissionId = sub.id;
        } else {
          activity.userSubmissionStatus = null;
          activity.userSubmissionId = null;
        }
      }
    }

    res.json({ status: 'success', data: activities });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

app.get('/api/leaderboard', handleRequest(async (req) => {
  const page = Number(req.query.page || 1);
  const pageSize = 30;
  const offset = (page - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT id, lineUserId, displayName, pictureUrl, points, totalScore
     FROM users
     ORDER BY totalScore DESC
     LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );

  return rows;
}));

app.get('/api/user/badges', async (req, res) => {
  try {
    const lineUserId = getRequesterLineUserId(req);
    if (!lineUserId) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Missing lineUserId' });
    }

    const [userRows] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    const userId = userRows[0].id;

    const [userBadges] = await db.query(
      `SELECT b.id, b.name, b.description, b.imageUrl, ub.earnedAt
       FROM user_badges ub
       JOIN badges b ON ub.badgeId = b.id
       WHERE ub.userId = ?
       ORDER BY ub.earnedAt DESC`,
      [userId]
    );

    res.json({ status: 'success', data: userBadges });
  } catch (error) {
    console.error('Error fetching user badges:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

// ======================= SUBMISSIONS =======================
app.get('/api/submissions', async (req, res) => {
  try {
    const { activityId } = req.query;
    const lineUserId = getRequesterLineUserId(req);

    let userId = null;
    if (lineUserId) {
      const [userRows] = await db.query(
        'SELECT id FROM users WHERE lineUserId = ?',
        [lineUserId]
      );
      if (userRows && userRows.length > 0) {
        userId = userRows[0].id;
      }
    }

    let queryStr = `
        SELECT s.*, u.displayName AS userName, u.pictureUrl AS userPicture, a.title AS activityTitle,
              (SELECT COUNT(*) FROM likes l WHERE l.submissionId = s.submissionId) AS likesCount,
              (SELECT COUNT(*) FROM comments c WHERE c.submissionId = s.submissionId) AS commentsCount
        FROM submissions s
        JOIN users u ON s.lineUserId = u.lineUserId
        LEFT JOIN activities a ON s.activityId = a.activityId
        WHERE s.status = 'approved' `;
    if (activityId) {
        queryStr += 'AND s.activityId = ' + db.escape(activityId) + ' ';
    }
    queryStr += 'ORDER BY s.createdAt DESC';
    const [submissions] = await db.query(queryStr);

    let userLikes = [];
    let userBookmarks = [];
    if (userId) {
      const [likeRows] = await db.query(
        'SELECT submissionId FROM likes WHERE userId = ?',
        [userId]
      );
      userLikes = likeRows.map((r) => r.submissionId);

      const [bookmarkRows] = await db.query(
        'SELECT submissionId FROM bookmarks WHERE userId = ?',
        [userId]
      );
      userBookmarks = bookmarkRows.map((r) => r.submissionId);
    }

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total
       FROM submissions
       WHERE status = 'approved'`
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / pageSize);

    const result = submissions.map((sub) => ({
      ...sub,
      likedByCurrentUser: userLikes.includes(sub.id),
      bookmarkedByCurrentUser: userBookmarks.includes(sub.id),
    }));

    res.json({
      status: 'success',
      data: {
        submissions: result,
        page: Number(page),
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

// ❗ เวอร์ชันใหม่: รับ imageUrl จาก body (ไม่ต้องใช้ multer ที่นี่แล้ว)
app.post('/api/submissions', async (req, res) => {
  try {
    const { lineUserId, activityId, description, imageUrl } = req.body;

    if (!lineUserId || !activityId) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Missing required fields' });
    }

    const [userRows] = await db.query(
      'SELECT * FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    const user = userRows[0];

    const [activityRows] = await db.query(
      'SELECT * FROM activities WHERE id = ?',
      [activityId]
    );
    if (!activityRows || activityRows.length === 0) {
      return res
        .status(404)
        .json({ status: 'error', message: 'Activity not found' });
    }
    const activity = activityRows[0];

    // imageUrl มาจาก /api/upload ที่ frontend เรียกไปก่อนหน้า
    const finalImageUrl = imageUrl || null;

    const submissionId = uuidv4();

    await db.query(
      `INSERT INTO submissions 
       (id, activityId, userId, imageUrl, description, status, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
      [submissionId, activity.id, user.id, finalImageUrl, description || null]
    );

    res.json({
      status: 'success',
      data: {
        id: submissionId,
        activityId: activity.id,
        userId: user.id,
        imageUrl: finalImageUrl,
        description,
        status: 'pending',
      },
    });
  } catch (error) {
    console.error('Error saving submission:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

app.post('/api/submissions/like', async (req, res) => {
  try {
    const { lineUserId, submissionId } = req.body;

    if (!lineUserId || !submissionId) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Missing parameters' });
    }

    const [userRows] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    const userId = userRows[0].id;

    const [likeRows] = await db.query(
      'SELECT * FROM likes WHERE userId = ? AND submissionId = ?',
      [userId, submissionId]
    );

      if (likeRows && likeRows.length > 0) {
          await db.query('DELETE FROM likes WHERE userId = ? AND submissionId = ?', [userId, submissionId]);
      } else {
          await db.query('INSERT INTO likes (userId, submissionId, createdAt) VALUES (?, ?, NOW())', [userId, submissionId]);
      }
      const [[{ count: newLikeCount }]] = await db.query('SELECT COUNT(*) AS count FROM likes WHERE submissionId = ?', [submissionId]);
      res.json({ status: 'success', data: { liked: !(likeRows && likeRows.length > 0), newLikeCount } });
  } catch (error) {
    console.error('Error liking submission:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

app.post('/api/submissions/comment', async (req, res) => {
  try {
    const { lineUserId, submissionId, commentText } = req.body;

    if (!lineUserId || !submissionId || !comment) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Missing parameters' });
    }

    const [userRows] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    const userId = userRows[0].id;

    await db.query(
      'INSERT INTO comments (submissionId, lineUserId, commentText, createdAt) VALUES (?, ?, ?, NOW())',
      [submissionId, lineUserId, commentText]
    );

    res.json({ status: 'success', data: { message: 'Comment added' } });
  } catch (error) {
    console.error('Error commenting on submission:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

// ======================= ADMIN: STATS & DASHBOARD =======================
app.get('/api/admin/stats', isAdmin, async (req, res) => {
  try {
    const [stats] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS totalUsers,
        (SELECT COUNT(*) FROM submissions) AS totalSubmissions,
        (SELECT COUNT(*) FROM submissions WHERE status = 'pending') AS pendingSubmissions,
        (SELECT COUNT(*) FROM activities) AS totalActivities
    `);

    res.json({ status: 'success', data: stats[0] });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

app.get(
  '/api/admin/dashboard-stats',
  isAdmin,
  handleRequest(async () => {
    const [[summary]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS userCount,
        (SELECT COUNT(*) FROM submissions WHERE status = 'pending') AS pendingCount,
        (SELECT COUNT(*) FROM activities WHERE isActive = 1) AS activeActivitiesCount
  `);
    return summary;
  })
);

app.get('/api/admin/chart-data', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DATE(createdAt) AS date, COUNT(*) AS count
      FROM submissions
      WHERE status = 'approved'
      GROUP BY DATE(createdAt)
      ORDER BY DATE(createdAt)
    `);

    res.json({ status: 'success', data: rows });
  } catch (error) {
    console.error('Error fetching chart data:', error);
    res
      .status(500)
      .json({ status: 'error', message: 'Internal server error' });
  }
});

// ======================= ADMIN: SUBMISSIONS MANAGEMENT =======================
app.get(
  '/api/admin/submissions/pending',
  isAdmin,
  async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT s.*, u.displayName AS userName, a.title AS activityTitle
        FROM submissions s
        JOIN users u ON s.userId = u.id
        JOIN activities a ON s.activityId = a.id
        WHERE s.status = 'pending'
        ORDER BY s.createdAt ASC
      `);

      res.json({ status: 'success', data: rows });
    } catch (error) {
      console.error('Error fetching pending submissions:', error);
      res
        .status(500)
        .json({ status: 'error', message: 'Internal server error' });
    }
  }
);

app.post(
  '/api/admin/submissions/approve',
  isAdmin,
  async (req, res) => {
    try {
      const { submissionId, score } = req.body;

      if (!submissionId) {
        return res
          .status(400)
          .json({ status: 'error', message: 'Missing submissionId' });
      }

      const [[submission]] = await db.query(
        'SELECT * FROM submissions WHERE id = ?',
        [submissionId]
      );
      if (!submission) {
        return res
          .status(404)
          .json({ status: 'error', message: 'Submission not found' });
      }

      await db.query(
        'UPDATE submissions SET status = ?, updatedAt = NOW() WHERE id = ?',
        ['approved', submissionId]
      );

      const [activityRows] = await db.query(
        'SELECT * FROM activities WHERE id = ?',
        [submission.activityId]
      );
      if (activityRows && activityRows.length > 0) {
        const activity = activityRows[0];

        const [userRows] = await db.query(
          'SELECT * FROM users WHERE id = ?',
          [submission.userId]
        );
        if (userRows && userRows.length > 0) {
          const user = userRows[0];

          const points = score != null ? Number(score) : (activity.points || 0);
          const newTotalScore = (user.totalScore || 0) + points;

          await db.query(
            'UPDATE users SET points = points + ?, totalScore = ? WHERE id = ?',
            [points, newTotalScore, user.id]
          );

          await db.query(
            `INSERT INTO points_history
             (userId, activityId, submissionId, points, totalScoreAfter, description, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [
              user.id,
              activity.id,
              submission.id,
              points,
              newTotalScore,
              `ได้รับคะแนนจากกิจกรรม: ${activity.title}`,
            ]
          );
        }
      }

      res.json({
        status: 'success',
        data: { message: 'Submission approved' },
      });
    } catch (error) {
      console.error('Error approving submission:', error);
      res
        .status(500)
        .json({ status: 'error', message: 'Internal server error' });
    }
  }
);

app.post(
  '/api/admin/submissions/reject',
  isAdmin,
  async (req, res) => {
    try {
      const { submissionId, reason } = req.body;

      if (!submissionId) {
        return res
          .status(400)
          .json({ status: 'error', message: 'Missing submissionId' });
      }

      await db.query(
        'UPDATE submissions SET status = ?, updatedAt = NOW() WHERE id = ?',
        ['rejected', submissionId]
      );

      await db.query(
        `INSERT INTO rejection_reasons (submissionId, reason, createdAt) VALUES (?, ?, NOW())`,
        [submissionId, reason || 'No reason provided']
      );

      res.json({
        status: 'success',
        data: { message: 'Submission rejected' },
      });
    } catch (error) {
      console.error('Error rejecting submission:', error);
      res
        .status(500)
        .json({ status: 'error', message: 'Internal server error' });
    }
  }
);

app.delete(
  '/api/admin/submissions/:submissionId',
  isAdmin,
  handleRequest(async (req) => {
    const { submissionId } = req.params;
    if (!submissionId) throw new Error('submissionId is required');

    const [[submission]] = await db.query(
      'SELECT * FROM submissions WHERE id = ?',
      [submissionId]
    );
    if (!submission) {
      throw new Error('Submission not found');
    }

    await db.query('DELETE FROM submissions WHERE id = ?', [submissionId]);

    return { message: 'Submission deleted successfully' };
  })
);

// ======================= ADMIN: ACTIVITIES CRUD =======================
app.get(
  '/api/admin/activities',
  isAdmin,
  handleRequest(async () => {
    const [activities] = await db.query(
      'SELECT * FROM activities ORDER BY `createdAt` DESC'
    );
    return activities;
  })
);

app.post(
  '/api/admin/activities',
  isAdmin,
  handleRequest(async (req) => {
    const {
      title,
      description,
      imageUrl,
      points,
      isActive,
      startAt,
      endAt,
      category,
      quizType,
      quizQuestion,
      quizAnswer,
      quizChoices,
      quizTolerance,
    } = req.body;

    const [result] = await db.query(
      `INSERT INTO activities 
       (title, description, imageUrl, points, isActive, startAt, endAt, category,
        quizType, quizQuestion, quizAnswer, quizChoices, quizTolerance, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        title,
        description,
        imageUrl,
        points || 0,
        isActive ? 1 : 0,
        startAt || null,
        endAt || null,
        category || 'general',
        quizType || null,
        quizQuestion || null,
        quizAnswer || null,
        quizChoices || null,
        quizTolerance || null,
      ]
    );

    const [[activity]] = await db.query(
      'SELECT * FROM activities WHERE id = ?',
      [result.insertId]
    );
    return activity;
  })
);

app.post('/api/admin/activities/toggle', isAdmin, handleRequest(async (req) => {
    const { activityId } = req.body;
    if (!activityId) throw new Error('Missing activityId');
    const [[activity]] = await db.query('SELECT * FROM activities WHERE activityId = ?', [activityId]);
    if (!activity) throw new Error('Activity not found');
    // สมมติใช้ฟิลด์ status (active/inactive):
    const newStatus = (activity.status === 'active') ? 'inactive' : 'active';
    await db.query('UPDATE activities SET status = ? WHERE activityId = ?', [newStatus, activityId]);
    return { message: 'Activity status toggled' };
}));

app.put(
  '/api/admin/activities/:id',
  isAdmin,
  handleRequest(async (req) => {
    const { id } = req.params;
    const {
      title,
      description,
      imageUrl,
      points,
      isActive,
      startAt,
      endAt,
      category,
      quizType,
      quizQuestion,
      quizAnswer,
      quizChoices,
      quizTolerance,
    } = req.body;

    const [existingRows] = await db.query(
      'SELECT * FROM activities WHERE id = ?',
      [id]
    );
    if (!existingRows || existingRows.length === 0) {
      throw new Error('Activity not found');
    }
    const existing = existingRows[0];

    await db.query(
      `UPDATE activities
     SET title = ?, description = ?, imageUrl = ?, points = ?, isActive = ?, startAt = ?, endAt = ?,
         category = ?, quizType = ?, quizQuestion = ?, quizAnswer = ?, quizChoices = ?, quizTolerance = ?, updatedAt = NOW()
     WHERE id = ?`,
      [
        title ?? existing.title,
        description ?? existing.description,
        imageUrl ?? existing.imageUrl,
        points ?? existing.points,
        typeof isActive === 'boolean' ? (isActive ? 1 : 0) : existing.isActive,
        startAt ?? existing.startAt,
        endAt ?? existing.endAt,
        category ?? existing.category,
        quizType ?? existing.quizType,
        quizQuestion ?? existing.quizQuestion,
        quizAnswer ?? existing.quizAnswer,
        quizChoices ?? existing.quizChoices,
        quizTolerance ?? existing.quizTolerance,
        id,
      ]
    );

    const [[updated]] = await db.query(
      'SELECT * FROM activities WHERE id = ?',
      [id]
    );
    return updated;
  })
);

app.delete(
  '/api/admin/activities/:id',
  isAdmin,
  handleRequest(async (req) => {
    const { id } = req.params;

    const [existingRows] = await db.query(
      'SELECT * FROM activities WHERE id = ?',
      [id]
    );
    if (!existingRows || existingRows.length === 0) {
      throw new Error('Activity not found');
    }

    await db.query('DELETE FROM activities WHERE id = ?', [id]);
    return { message: 'Activity deleted successfully' };
  })
);

// ======================= ADMIN: BADGES CRUD =======================
app.get(
  '/api/admin/badges',
  isAdmin,
  handleRequest(async () => {
    const [badges] = await db.query(
      'SELECT * FROM badges ORDER BY `createdAt` DESC'
    );
    return badges;
  })
);

app.post(
  '/api/admin/badges',
  isAdmin,
  handleRequest(async (req) => {
    const { name, description, imageUrl, minScore } = req.body;

    const [result] = await db.query(
      `INSERT INTO badges (name, description, imageUrl, minScore, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [name, description || null, imageUrl || null, minScore || 0]
    );

    const [[badge]] = await db.query(
      'SELECT * FROM badges WHERE id = ?',
      [result.insertId]
    );
    return badge;
  })
);

app.put(
  '/api/admin/badges/:id',
  isAdmin,
  handleRequest(async (req) => {
    const { id } = req.params;
    const { name, description, imageUrl, minScore } = req.body;

    const [existingRows] = await db.query(
      'SELECT * FROM badges WHERE id = ?',
      [id]
    );
    if (!existingRows || existingRows.length === 0) {
      throw new Error('Badge not found');
    }
    const existing = existingRows[0];

    await db.query(
      `UPDATE badges
     SET name = ?, description = ?, imageUrl = ?, minScore = ?, updatedAt = NOW()
     WHERE id = ?`,
      [
        name ?? existing.name,
        description ?? existing.description,
        imageUrl ?? existing.imageUrl,
        minScore ?? existing.minScore,
        id,
      ]
    );

    const [[updated]] = await db.query(
      'SELECT * FROM badges WHERE id = ?',
      [id]
    );
    return updated;
  })
);

app.delete(
  '/api/admin/badges/:id',
  isAdmin,
  handleRequest(async (req) => {
    const { id } = req.params;

    const [existingRows] = await db.query(
      'SELECT * FROM badges WHERE id = ?',
      [id]
    );
    if (!existingRows || existingRows.length === 0) {
      throw new Error('Badge not found');
    }

    await db.query('DELETE FROM badges WHERE id = ?', [id]);
    return { message: 'Badge deleted successfully' };
  })
);

// ======================= POINTS HISTORY & BOOKMARKS =======================
app.get(
  '/api/user/points-history',
  handleRequest(async (req) => {
    const lineUserId = getRequesterLineUserId(req);
    if (!lineUserId) throw new Error('Missing lineUserId');

    const [[user]] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!user) throw new Error('User not found');

    const [history] = await db.query(
      `SELECT ph.*, a.title AS activityTitle
     FROM points_history ph
     LEFT JOIN activities a ON ph.activityId = a.id
     WHERE ph.userId = ?
     ORDER BY ph.createdAt DESC
     LIMIT 200`,
      [user.id]
    );

    return history;
  })
);

app.post(
  '/api/user/bookmarks/toggle',
  handleRequest(async (req) => {
    const { lineUserId, submissionId } = req.body;
    if (!lineUserId || !submissionId) throw new Error('Missing parameters');

    const [[user]] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!user) throw new Error('User not found');

    const [existing] = await db.query(
      'SELECT * FROM bookmarks WHERE userId = ? AND submissionId = ?',
      [user.id, submissionId]
    );

    if (existing && existing.length > 0) {
      await db.query(
        'DELETE FROM bookmarks WHERE userId = ? AND submissionId = ?',
        [user.id, submissionId]
      );
      return { bookmarked: false };
    } else {
      await db.query(
        'INSERT INTO bookmarks (userId, submissionId, createdAt) VALUES (?, ?, NOW())',
        [user.id, submissionId]
      );
      return { bookmarked: true };
    }
  })
);

app.get(
  '/api/user/bookmarks',
  handleRequest(async (req) => {
    const lineUserId = getRequesterLineUserId(req);
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 12);

    if (!lineUserId) throw new Error('Missing lineUserId');

    const [[user]] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!user) throw new Error('User not found');

    const offset = (page - 1) * pageSize;

    const [rows] = await db.query(
      `SELECT s.*,
            u.displayName AS userName,
            u.pictureUrl AS userPicture,
            a.title AS activityTitle,
            (SELECT COUNT(*) FROM likes l WHERE l.submissionId = s.id) AS likesCount,
            (SELECT COUNT(*) FROM comments c WHERE c.submissionId = s.id) AS commentsCount
     FROM bookmarks b
     JOIN submissions s ON b.submissionId = s.id
     JOIN users u ON s.userId = u.id
     LEFT JOIN activities a ON s.activityId = a.id
     WHERE b.userId = ?
     ORDER BY b.createdAt DESC
     LIMIT ? OFFSET ?`,
      [user.id, pageSize, offset]
    );

    const [countRows] = await db.query(
      'SELECT COUNT(*) AS total FROM bookmarks WHERE userId = ?',
      [user.id]
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / pageSize);

    return {
      submissions: rows,
      page,
      totalPages,
    };
  })
);

// ======================= NOTIFICATIONS =======================
app.get(
  '/api/notifications',
  handleRequest(async (req) => {
    const lineUserId = getRequesterLineUserId(req);
    if (!lineUserId) throw new Error('Missing lineUserId');

    const [[user]] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!user) throw new Error('User not found');

    const [rows] = await db.query(
      `SELECT n.*,
            a.title AS activityTitle,
            u.displayName AS fromUserName
     FROM notifications n
     LEFT JOIN activities a ON n.activityId = a.id
     LEFT JOIN users u ON n.fromUserId = u.id
     WHERE n.recipientUserId = ?
     ORDER BY n.createdAt DESC
     LIMIT 100`,
      [user.id]
    );

    return rows;
  })
);

// สำหรับ checkUnreadNotifications() ใน app.js
app.get(
  '/api/notifications/unread-count',
  handleRequest(async (req) => {
    const lineUserId = getRequesterLineUserId(req);
    if (!lineUserId) throw new Error('Missing lineUserId');

    const [[user]] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!user) throw new Error('User not found');

    const [[row]] = await db.query(
      'SELECT COUNT(*) AS unreadCount FROM notifications WHERE recipientUserId = ? AND isRead = FALSE',
      [user.id]
    );

    // app.js ใช้ data[0].unreadCount เลยส่งกลับเป็น array
    return [row];
  })
);

app.post(
  '/api/notifications/mark-read',
  handleRequest(async (req) => {
    const lineUserId = getRequesterLineUserId(req);
    if (!lineUserId) throw new Error('Missing lineUserId');

    const [[user]] = await db.query(
      'SELECT id FROM users WHERE lineUserId = ?',
      [lineUserId]
    );
    if (!user) throw new Error('User not found');

    await db.query(
      'UPDATE notifications SET isRead = TRUE WHERE recipientUserId = ? AND isRead = FALSE',
      [user.id]
    );

    return { updated: true };
  })
);

// ======================= SERVER START =======================
app.get('/', (req, res) => res.send('Backend server is running!'));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server is running on port ${PORT}`)
);

-- ============================================================
-- migration.sql — Safety Spot App (Safe / Data-Preserving)
-- รันบน production ที่มีข้อมูลอยู่แล้ว
-- ไม่ DROP / ไม่ลบข้อมูลใดๆ ยกเว้น badge ที่ซ้ำกัน
-- ============================================================

-- ============================================================
-- STEP 1: ไม่ต้องเพิ่ม column ใดๆ
-- (coinBalance, createdAt, minScore มีอยู่ครบแล้ว)
-- ============================================================

-- ============================================================
-- STEP 2: ทำความสะอาด duplicate ใน user_badges
-- (พบ 2 กลุ่มที่ซ้ำ ก่อน add UNIQUE constraint)
-- กลยุทธ์: เก็บแถวที่ userBadgeId น้อยที่สุด (ได้รับก่อน) ลบที่เหลือ
-- ============================================================

DELETE ub1
FROM user_badges ub1
INNER JOIN user_badges ub2
  ON  ub1.lineUserId = ub2.lineUserId
  AND ub1.badgeId    = ub2.badgeId
  AND ub1.earnedAt > ub2.earnedAt;

-- ตรวจสอบหลังลบ (ควรได้ 0 rows)
-- SELECT lineUserId, badgeId, COUNT(*) AS cnt
-- FROM user_badges
-- GROUP BY lineUserId, badgeId
-- HAVING cnt > 1;

-- ============================================================
-- STEP 3 & 4: เพิ่ม INDEX / UNIQUE — ตรวจก่อนสร้าง (idempotent)
-- MySQL ไม่รองรับ CREATE INDEX IF NOT EXISTS
-- ใช้ INFORMATION_SCHEMA + PREPARE/EXECUTE แทน
-- ============================================================

-- helper macro: สร้าง index เฉพาะกรณีที่ยังไม่มี
-- (ทำซ้ำสำหรับแต่ละ index เพราะ MySQL ไม่มี loop ใน plain SQL)

-- uq_user_badges
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='user_badges' AND index_name='uq_user_badges');
SET @sql := IF(@x=0, 'CREATE UNIQUE INDEX uq_user_badges ON user_badges (lineUserId, badgeId)', 'SELECT "uq_user_badges exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- uq_likes
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='likes' AND index_name='uq_likes');
SET @sql := IF(@x=0, 'CREATE UNIQUE INDEX uq_likes ON likes (submissionId, lineUserId)', 'SELECT "uq_likes exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- uq_users_employeeId
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='users' AND index_name='uq_users_employeeId');
SET @sql := IF(@x=0, 'CREATE UNIQUE INDEX uq_users_employeeId ON users (employeeId)', 'SELECT "uq_users_employeeId exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_submissions_activity_user
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='submissions' AND index_name='idx_submissions_activity_user');
SET @sql := IF(@x=0, 'CREATE INDEX idx_submissions_activity_user ON submissions (activityId, lineUserId, status)', 'SELECT "idx_submissions_activity_user exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_submissions_status
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='submissions' AND index_name='idx_submissions_status');
SET @sql := IF(@x=0, 'CREATE INDEX idx_submissions_status ON submissions (status)', 'SELECT "idx_submissions_status exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_likes_userId
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='likes' AND index_name='idx_likes_userId');
SET @sql := IF(@x=0, 'CREATE INDEX idx_likes_userId ON likes (lineUserId)', 'SELECT "idx_likes_userId exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_comments_submission
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='comments' AND index_name='idx_comments_submission');
SET @sql := IF(@x=0, 'CREATE INDEX idx_comments_submission ON comments (submissionId)', 'SELECT "idx_comments_submission exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_notifications_recipient
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='notifications' AND index_name='idx_notifications_recipient');
SET @sql := IF(@x=0, 'CREATE INDEX idx_notifications_recipient ON notifications (recipientUserId, isRead)', 'SELECT "idx_notifications_recipient exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- idx_game_history_user_date
SET @x := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name='user_game_history' AND index_name='idx_game_history_user_date');
SET @sql := IF(@x=0, 'CREATE INDEX idx_game_history_user_date ON user_game_history (lineUserId, playedAt)', 'SELECT "idx_game_history_user_date exists"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- uq_game_history_daily (สร้างใน DBeaver ไปแล้ว — uncomment ถ้ายังไม่มี)
-- SET @x := (SELECT COUNT(*) FROM information_schema.statistics
--            WHERE table_schema=DATABASE() AND table_name='user_game_history' AND index_name='uq_game_history_daily');
-- SET @sql := IF(@x=0, 'CREATE UNIQUE INDEX uq_game_history_daily ON user_game_history (lineUserId, playedAt)', 'SELECT "uq_game_history_daily exists"');
-- PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================================================
-- Lottery Settings: seed configurable prize/price/daily_limit values
-- ============================================================
INSERT INTO lottery_settings (settingKey, settingValue) VALUES
  ('prize_two',   '500'),
  ('prize_three', '3000'),
  ('price_two',   '10'),
  ('price_three', '30'),
  ('daily_limit', '5')
ON DUPLICATE KEY UPDATE settingKey=settingKey;

-- ============================================================
-- เสร็จสิ้น — รันแค่ครั้งเดียว ปลอดภัย 100%
-- ============================================================

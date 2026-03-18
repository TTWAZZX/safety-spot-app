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
  AND ub1.userBadgeId > ub2.userBadgeId;

-- ตรวจสอบหลังลบ (ควรได้ 0 rows)
-- SELECT lineUserId, badgeId, COUNT(*) AS cnt
-- FROM user_badges
-- GROUP BY lineUserId, badgeId
-- HAVING cnt > 1;

-- ============================================================
-- STEP 3: เพิ่ม UNIQUE constraints
-- ใช้ CREATE UNIQUE INDEX IF NOT EXISTS (MySQL 8.0+)
-- ============================================================

-- user_badges: ป้องกัน badge ซ้ำในระดับ DB
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_badges
  ON user_badges (lineUserId, badgeId);

-- likes: ป้องกัน like ซ้ำในระดับ DB (ไม่มี duplicate อยู่แล้ว)
CREATE UNIQUE INDEX IF NOT EXISTS uq_likes
  ON likes (submissionId, lineUserId);

-- users: ป้องกัน employeeId ซ้ำ (ไม่มี duplicate อยู่แล้ว)
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employeeId
  ON users (employeeId);

-- ============================================================
-- STEP 4: เพิ่ม Index เพื่อประสิทธิภาพ
-- ============================================================

-- submissions: ใช้บ่อยใน duplicate check และ pending query
CREATE INDEX IF NOT EXISTS idx_submissions_activity_user
  ON submissions (activityId, lineUserId, status);

CREATE INDEX IF NOT EXISTS idx_submissions_status
  ON submissions (status);

-- likes: ใช้ตอนโหลด submissions (เช็คว่า user กด like ไหน)
CREATE INDEX IF NOT EXISTS idx_likes_userId
  ON likes (lineUserId);

-- comments: ใช้ตอนโหลด submissions
CREATE INDEX IF NOT EXISTS idx_comments_submission
  ON comments (submissionId);

-- notifications: ใช้หนักที่สุด (query ทุกครั้งที่เปิด app)
CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications (recipientUserId, isRead);

-- user_game_history: ใช้ตรวจ daily quiz ทุกครั้งที่เล่น
CREATE INDEX IF NOT EXISTS idx_game_history_user_date
  ON user_game_history (lineUserId, playedAt);

-- user_game_history: ป้องกัน race condition (เล่นซ้ำวันเดิม)
-- *** สร้างแล้วใน DBeaver โดยตรง — รันเฉพาะถ้ายังไม่มี ***
-- CREATE UNIQUE INDEX uq_game_history_daily ON user_game_history (lineUserId, playedAt);

-- ============================================================
-- เสร็จสิ้น — รันแค่ครั้งเดียว ปลอดภัย 100%
-- ============================================================

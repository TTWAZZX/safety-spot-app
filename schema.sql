-- ============================================================
-- schema.sql — Safety Spot App (Full Schema)
-- ใช้สำหรับ fresh install เท่านั้น (DROP + CREATE ทั้งหมด)
-- สำหรับ production ที่มีข้อมูลอยู่แล้ว ให้ใช้ migration.sql
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ล้างตารางทั้งหมด (เรียงจาก child → parent)
DROP TABLE IF EXISTS user_hunter_history;
DROP TABLE IF EXISTS hunter_attempts;
DROP TABLE IF EXISTS hunter_hazards;
DROP TABLE IF EXISTS hunter_levels;
DROP TABLE IF EXISTS user_score_history;
DROP TABLE IF EXISTS user_cards;
DROP TABLE IF EXISTS safety_cards;
DROP TABLE IF EXISTS user_game_history;
DROP TABLE IF EXISTS kyt_questions;
DROP TABLE IF EXISTS user_streaks;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS likes;
DROP TABLE IF EXISTS user_badges;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS badges;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- CORE TABLES
-- ============================================================

-- ตารางผู้ใช้ (Users)
CREATE TABLE users (
  lineUserId    VARCHAR(50)   PRIMARY KEY,
  displayName   VARCHAR(255),
  pictureUrl    TEXT,
  fullName      VARCHAR(255)  NOT NULL,
  employeeId    VARCHAR(50)   NOT NULL,
  totalScore    INTEGER       DEFAULT 0,
  coinBalance   INTEGER       DEFAULT 0,
  createdAt     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_employeeId (employeeId)
);

-- ตารางกิจกรรม (Activities)
CREATE TABLE activities (
  activityId   VARCHAR(50)   PRIMARY KEY,
  title        VARCHAR(255)  NOT NULL,
  description  TEXT,
  imageUrl     TEXT,
  status       VARCHAR(20)   DEFAULT 'active',  -- active, inactive
  createdAt    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

-- ตารางป้ายรางวัล (Badges)
CREATE TABLE badges (
  badgeId      VARCHAR(50)   PRIMARY KEY,
  badgeName    VARCHAR(255)  NOT NULL,
  description  TEXT,
  imageUrl     TEXT,
  minScore     INTEGER       DEFAULT NULL  -- NULL = มอบโดย Admin เท่านั้น, ตัวเลข = auto-award เมื่อถึงเกณฑ์
);

-- ตารางการส่งรายงาน (Submissions)
CREATE TABLE submissions (
  submissionId  VARCHAR(50)   PRIMARY KEY,
  activityId    VARCHAR(50)   NOT NULL,
  lineUserId    VARCHAR(50)   NOT NULL,
  description   TEXT          NOT NULL,
  imageUrl      TEXT,
  status        VARCHAR(20)   DEFAULT 'pending',  -- pending, approved, rejected
  points        INTEGER       DEFAULT 0,
  createdAt     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (activityId) REFERENCES activities(activityId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  INDEX idx_submissions_activity_user (activityId, lineUserId, status),
  INDEX idx_submissions_status (status)
);

-- ตารางแอดมิน (Admins)
CREATE TABLE admins (
  lineUserId  VARCHAR(50)  PRIMARY KEY,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);

-- ตารางป้ายรางวัลที่ผู้ใช้ได้รับ (User Badges)
CREATE TABLE user_badges (
  userBadgeId  INT           AUTO_INCREMENT PRIMARY KEY,
  lineUserId   VARCHAR(50)   NOT NULL,
  badgeId      VARCHAR(50)   NOT NULL,
  earnedAt     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_badges (lineUserId, badgeId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (badgeId)    REFERENCES badges(badgeId)
);

-- ตารางไลค์ (Likes)
CREATE TABLE likes (
  likeId        VARCHAR(50)   PRIMARY KEY,
  submissionId  VARCHAR(50)   NOT NULL,
  lineUserId    VARCHAR(50)   NOT NULL,
  createdAt     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_likes (submissionId, lineUserId),
  FOREIGN KEY (submissionId) REFERENCES submissions(submissionId),
  FOREIGN KEY (lineUserId)   REFERENCES users(lineUserId),
  INDEX idx_likes_userId (lineUserId)
);

-- ตารางคอมเมนต์ (Comments)
CREATE TABLE comments (
  commentId     VARCHAR(50)   PRIMARY KEY,
  submissionId  VARCHAR(50)   NOT NULL,
  lineUserId    VARCHAR(50)   NOT NULL,
  commentText   TEXT          NOT NULL,
  createdAt     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submissionId) REFERENCES submissions(submissionId),
  FOREIGN KEY (lineUserId)   REFERENCES users(lineUserId),
  INDEX idx_comments_submission (submissionId)
);

-- ============================================================
-- NOTIFICATION & STREAK TABLES
-- ============================================================

-- ตารางแจ้งเตือน (Notifications)
CREATE TABLE notifications (
  notificationId   VARCHAR(50)   PRIMARY KEY,
  recipientUserId  VARCHAR(50)   NOT NULL,
  message          TEXT          NOT NULL,
  type             VARCHAR(50)   NOT NULL,  -- like, comment, approved, rejected, badge, game_quiz, score, exchange, recycle, system_alert
  relatedItemId    VARCHAR(100)  DEFAULT NULL,
  triggeringUserId VARCHAR(50)   DEFAULT NULL,
  isRead           BOOLEAN       DEFAULT FALSE,
  createdAt        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipientUserId) REFERENCES users(lineUserId),
  INDEX idx_notifications_recipient (recipientUserId, isRead)
);

-- ตาราง Streak รายวัน (User Streaks)
CREATE TABLE user_streaks (
  lineUserId         VARCHAR(50)  PRIMARY KEY,
  currentStreak      INT          DEFAULT 1,
  lastPlayedDate     DATE         NOT NULL,
  recoverableStreak  INT          DEFAULT 0,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);

-- ============================================================
-- GAME: KYT DAILY QUIZ
-- ============================================================

-- คำถาม KYT (KYT Questions)
CREATE TABLE kyt_questions (
  questionId     INT          AUTO_INCREMENT PRIMARY KEY,
  questionText   TEXT         NOT NULL,
  optionA        TEXT,
  optionB        TEXT,
  optionC        TEXT,
  optionD        TEXT,
  optionE        TEXT,
  optionF        TEXT,
  optionG        TEXT,
  optionH        TEXT,
  correctOption  VARCHAR(1)   NOT NULL,  -- A-H
  imageUrl       TEXT         DEFAULT NULL,
  scoreReward    INT          DEFAULT 10,
  isActive       BOOLEAN      DEFAULT TRUE
);

-- ประวัติการเล่น KYT (User Game History)
CREATE TABLE user_game_history (
  historyId      INT          AUTO_INCREMENT PRIMARY KEY,
  lineUserId     VARCHAR(50)  NOT NULL,
  questionId     INT          NOT NULL,
  isCorrect      BOOLEAN      NOT NULL,
  earnedPoints   INT          DEFAULT 0,
  playedAt       DATE         NOT NULL,
  selectedAnswer VARCHAR(1)   DEFAULT NULL,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  INDEX idx_game_history_user_date (lineUserId, playedAt)
);

-- ============================================================
-- GAME: SAFETY CARD GACHA
-- ============================================================

-- การ์ดสะสม (Safety Cards)
CREATE TABLE safety_cards (
  cardId       VARCHAR(50)   PRIMARY KEY,
  cardName     VARCHAR(255)  NOT NULL,
  description  TEXT,
  imageUrl     TEXT,
  rarity       VARCHAR(10)   NOT NULL DEFAULT 'C',  -- C, R, SR, UR
  createdAt    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

-- การ์ดที่ผู้ใช้มี — อนุญาตซ้ำ (User Cards)
CREATE TABLE user_cards (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  lineUserId  VARCHAR(50)   NOT NULL,
  cardId      VARCHAR(50)   NOT NULL,
  createdAt   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (cardId)     REFERENCES safety_cards(cardId)
);

-- ============================================================
-- GAME: SAFETY HUNTER
-- ============================================================

-- ด่านเกม (Hunter Levels)
CREATE TABLE hunter_levels (
  levelId       VARCHAR(50)   PRIMARY KEY,
  title         VARCHAR(255)  NOT NULL,
  imageUrl      TEXT,
  totalHazards  INT           DEFAULT 0,
  createdAt     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

-- จุดเสี่ยงในด่าน (Hunter Hazards)
CREATE TABLE hunter_hazards (
  hazardId     VARCHAR(50)    PRIMARY KEY,
  levelId      VARCHAR(50)    NOT NULL,
  description  TEXT,
  knowledge    TEXT,
  x            DECIMAL(8, 4)  NOT NULL,
  y            DECIMAL(8, 4)  NOT NULL,
  radius       DECIMAL(5, 2)  DEFAULT 5.0,
  FOREIGN KEY (levelId) REFERENCES hunter_levels(levelId) ON DELETE CASCADE
);

-- จำนวนครั้งที่เล่นแต่ละด่าน (Hunter Attempts)
CREATE TABLE hunter_attempts (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  lineUserId     VARCHAR(50)  NOT NULL,
  levelId        VARCHAR(50)  NOT NULL,
  attempt_count  INT          DEFAULT 0,
  UNIQUE KEY uq_hunter_attempts (lineUserId, levelId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (levelId)    REFERENCES hunter_levels(levelId) ON DELETE CASCADE
);

-- ผลการเล่นด่าน + ดาว (User Hunter History)
CREATE TABLE user_hunter_history (
  id          INT           AUTO_INCREMENT PRIMARY KEY,
  lineUserId  VARCHAR(50)   NOT NULL,
  levelId     VARCHAR(50)   NOT NULL,
  stars       INT           DEFAULT 1,
  clearedAt   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_hunter (lineUserId, levelId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (levelId)    REFERENCES hunter_levels(levelId) ON DELETE CASCADE
);

-- ============================================================
-- ADMIN: SCORE HISTORY
-- ============================================================

-- ประวัติการปรับคะแนนโดย Admin
CREATE TABLE user_score_history (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  lineUserId     VARCHAR(50)   NOT NULL,
  deltaScore     INT           NOT NULL,
  newTotalScore  INT           NOT NULL,
  reason         VARCHAR(100)  DEFAULT NULL,
  createdBy      VARCHAR(50)   DEFAULT NULL,
  createdAt      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);

-- ปิดการตรวจสอบ Foreign Key ชั่วคราวเพื่อให้ลบตารางได้โดยไม่ติด Error
SET FOREIGN_KEY_CHECKS = 0;

-- ล้างตารางเก่าทิ้ง
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS likes;
DROP TABLE IF EXISTS user_badges;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS badges;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS users;

-- เปิดการตรวจสอบ Foreign Key กลับคืนมา
SET FOREIGN_KEY_CHECKS = 1;

-- ตารางผู้ใช้ (Users)
CREATE TABLE users (
  lineUserId VARCHAR(50) PRIMARY KEY,
  displayName VARCHAR(255),
  pictureUrl TEXT,
  fullName VARCHAR(255) NOT NULL,
  employeeId VARCHAR(50) NOT NULL,
  totalScore INTEGER DEFAULT 0
);

-- ตารางกิจกรรม (Activities)
CREATE TABLE activities (
  activityId VARCHAR(50) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  imageUrl TEXT,
  status VARCHAR(20) DEFAULT 'active', -- active, inactive
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ตารางป้ายรางวัลทั้งหมด (Badges)
CREATE TABLE badges (
  badgeId VARCHAR(50) PRIMARY KEY,
  badgeName VARCHAR(255) NOT NULL,
  description TEXT,
  imageUrl TEXT
);

-- ตารางการส่งรายงาน (Submissions)
CREATE TABLE submissions (
  submissionId VARCHAR(50) PRIMARY KEY,
  activityId VARCHAR(50) NOT NULL,
  lineUserId VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  imageUrl TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
  points INTEGER DEFAULT 0,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (activityId) REFERENCES activities(activityId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);

-- ตารางแอดมิน (Admins)
CREATE TABLE admins (
  lineUserId VARCHAR(50) PRIMARY KEY,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);

-- ตารางป้ายรางวัลที่ผู้ใช้ได้รับ (UserBadges)
CREATE TABLE user_badges (
  userBadgeId INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId VARCHAR(50) NOT NULL,
  badgeId VARCHAR(50) NOT NULL,
  earnedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (badgeId) REFERENCES badges(badgeId)
);

-- ตารางไลค์ (Likes)
CREATE TABLE likes (
  likeId VARCHAR(50) PRIMARY KEY,
  submissionId VARCHAR(50) NOT NULL,
  lineUserId VARCHAR(50) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submissionId) REFERENCES submissions(submissionId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);

-- ตารางคอมเมนต์ (Comments)
CREATE TABLE comments (
  commentId VARCHAR(50) PRIMARY KEY,
  submissionId VARCHAR(50) NOT NULL,
  lineUserId VARCHAR(50) NOT NULL,
  commentText TEXT NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submissionId) REFERENCES submissions(submissionId),
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId)
);
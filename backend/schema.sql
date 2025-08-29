-- ลบตารางถ้ามีอยู่แล้วเพื่อป้องกัน Error
DROP TABLE IF EXISTS comments, likes, user_badges, badges, admins, submissions, activities, users CASCADE;

-- ตารางผู้ใช้
CREATE TABLE users (
  "lineUserId" VARCHAR(50) PRIMARY KEY,
  "displayName" VARCHAR(255),
  "pictureUrl" TEXT,
  "fullName" VARCHAR(255) NOT NULL,
  "employeeId" VARCHAR(50) NOT NULL,
  "totalScore" INT DEFAULT 0
);

-- ตารางกิจกรรม
CREATE TABLE activities (
  "activityId" VARCHAR(50) PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT,
  "status" VARCHAR(20) DEFAULT 'active', -- active, inactive
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางการส่งรายงาน
CREATE TABLE submissions (
  "submissionId" VARCHAR(50) PRIMARY KEY,
  "activityId" VARCHAR(50) REFERENCES activities("activityId"),
  "lineUserId" VARCHAR(50) REFERENCES users("lineUserId"),
  "description" TEXT NOT NULL,
  "imageUrl" TEXT,
  "status" VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
  "points" INT DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางแอดมิน
CREATE TABLE admins (
  "lineUserId" VARCHAR(50) PRIMARY KEY REFERENCES users("lineUserId")
);

-- ตารางป้ายรางวัลทั้งหมด
CREATE TABLE badges (
  "badgeId" VARCHAR(50) PRIMARY KEY,
  "badgeName" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT
);

-- ตารางป้ายรางวัลที่ผู้ใช้ได้รับ
CREATE TABLE user_badges (
  "userBadgeId" SERIAL PRIMARY KEY,
  "lineUserId" VARCHAR(50) REFERENCES users("lineUserId"),
  "badgeId" VARCHAR(50) REFERENCES badges("badgeId"),
  "earnedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางไลค์
CREATE TABLE likes (
  "likeId" VARCHAR(50) PRIMARY KEY,
  "submissionId" VARCHAR(50) REFERENCES submissions("submissionId"),
  "lineUserId" VARCHAR(50) REFERENCES users("lineUserId"),
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางคอมเมนต์
CREATE TABLE comments (
  "commentId" VARCHAR(50) PRIMARY KEY,
  "submissionId" VARCHAR(50) REFERENCES submissions("submissionId"),
  "lineUserId" VARCHAR(50) REFERENCES users("lineUserId"),
  "commentText" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
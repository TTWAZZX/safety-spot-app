-- ล้างตารางเก่าทิ้ง (ตามลำดับที่ถูกต้อง) เพื่อให้สคริปต์นี้รันซ้ำได้
-- CASCADE จะช่วยลบ Foreign Key ที่เกี่ยวข้องออกไปด้วยโดยอัตโนมัติ
DROP TABLE IF EXISTS "comments" CASCADE;
DROP TABLE IF EXISTS "likes" CASCADE;
DROP TABLE IF EXISTS "user_badges" CASCADE;
DROP TABLE IF EXISTS "admins" CASCADE;
DROP TABLE IF EXISTS "submissions" CASCADE;
DROP TABLE IF EXISTS "badges" CASCADE;
DROP TABLE IF EXISTS "activities" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;

-- ตารางผู้ใช้ (Users)
CREATE TABLE "users" (
  "lineUserId" VARCHAR(50) PRIMARY KEY,
  "displayName" VARCHAR(255),
  "pictureUrl" TEXT,
  "fullName" VARCHAR(255) NOT NULL,
  "employeeId" VARCHAR(50) NOT NULL,
  "totalScore" INTEGER DEFAULT 0
);

-- ตารางกิจกรรม (Activities)
CREATE TABLE "activities" (
  "activityId" VARCHAR(50) PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT,
  "status" VARCHAR(20) DEFAULT 'active', -- active, inactive
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางป้ายรางวัลทั้งหมด (Badges)
CREATE TABLE "badges" (
  "badgeId" VARCHAR(50) PRIMARY KEY,
  "badgeName" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT
);

-- ตารางการส่งรายงาน (Submissions)
CREATE TABLE "submissions" (
  "submissionId" VARCHAR(50) PRIMARY KEY,
  "activityId" VARCHAR(50) NOT NULL REFERENCES "activities"("activityId"),
  "lineUserId" VARCHAR(50) NOT NULL REFERENCES "users"("lineUserId"),
  "description" TEXT NOT NULL,
  "imageUrl" TEXT,
  "status" VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
  "points" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางแอดมิน (Admins)
CREATE TABLE "admins" (
  "lineUserId" VARCHAR(50) PRIMARY KEY REFERENCES "users"("lineUserId")
);


-- ตารางป้ายรางวัลที่ผู้ใช้ได้รับ (UserBadges)
CREATE TABLE "user_badges" (
  "userBadgeId" SERIAL PRIMARY KEY,
  "lineUserId" VARCHAR(50) NOT NULL REFERENCES "users"("lineUserId"),
  "badgeId" VARCHAR(50) NOT NULL REFERENCES "badges"("badgeId"),
  "earnedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางไลค์ (Likes)
CREATE TABLE "likes" (
  "likeId" VARCHAR(50) PRIMARY KEY,
  "submissionId" VARCHAR(50) NOT NULL REFERENCES "submissions"("submissionId"),
  "lineUserId" VARCHAR(50) NOT NULL REFERENCES "users"("lineUserId"),
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ตารางคอมเมนต์ (Comments)
CREATE TABLE "comments" (
  "commentId" VARCHAR(50) PRIMARY KEY,
  "submissionId" VARCHAR(50) NOT NULL REFERENCES "submissions"("submissionId"),
  "lineUserId" VARCHAR(50) NOT NULL REFERENCES "users"("lineUserId"),
  "commentText" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
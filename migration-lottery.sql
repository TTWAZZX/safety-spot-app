-- =============================================
-- migration-lottery.sql — Safety Lottery Feature
-- Run this ONCE on production (safe, no DROP)
-- =============================================

-- 1. lottery_rounds — งวดหวย
CREATE TABLE IF NOT EXISTS lottery_rounds (
  roundId       VARCHAR(50) PRIMARY KEY,
  drawDate      DATE NOT NULL,
  last2         VARCHAR(2)  DEFAULT NULL,
  last3_front   VARCHAR(3)  DEFAULT NULL,
  last3_back    VARCHAR(3)  DEFAULT NULL,
  status        VARCHAR(20) DEFAULT 'open',
  source        VARCHAR(20) DEFAULT 'manual',
  confirmedBy   VARCHAR(50) DEFAULT NULL,
  createdAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lottery_rounds_status (status),
  INDEX idx_lottery_rounds_date (drawDate)
);

-- 2. lottery_tickets — ตั๋วที่ซื้อ
CREATE TABLE IF NOT EXISTS lottery_tickets (
  ticketId      INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  roundId       VARCHAR(50) NOT NULL,
  ticketType    VARCHAR(10) NOT NULL,
  number        VARCHAR(3)  NOT NULL,
  price         INT         NOT NULL DEFAULT 0,
  isGoldTicket  BOOLEAN     DEFAULT FALSE,
  isWinner      BOOLEAN     DEFAULT FALSE,
  prizeAmount   INT         DEFAULT 0,
  isPrizeClaimed BOOLEAN    DEFAULT FALSE,
  purchasedAt   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (roundId) REFERENCES lottery_rounds(roundId),
  INDEX idx_tickets_user_round  (lineUserId, roundId),
  INDEX idx_tickets_round_type  (roundId, ticketType, number),
  INDEX idx_tickets_winner      (isWinner, isPrizeClaimed)
);

-- 3. lottery_daily_purchases — โควต้า 5 ใบ/วัน
CREATE TABLE IF NOT EXISTS lottery_daily_purchases (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  purchaseDate  DATE        NOT NULL,
  count         INT         DEFAULT 0,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  UNIQUE KEY uq_daily_purchase (lineUserId, purchaseDate)
);

-- 3.1 lottery_gold_ticket_claims — สิทธิ์ตั๋วทองฟรี 1 ใบ/คน/งวด
CREATE TABLE IF NOT EXISTS lottery_gold_ticket_claims (
  claimId       INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  roundId       VARCHAR(50) NOT NULL,
  ticketId      INT         DEFAULT NULL,
  department    VARCHAR(100) NOT NULL DEFAULT '',
  incidentFreeSince DATE    NOT NULL,
  claimedAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (roundId) REFERENCES lottery_rounds(roundId),
  FOREIGN KEY (ticketId) REFERENCES lottery_tickets(ticketId),
  UNIQUE KEY uq_gold_claim_user_round (lineUserId, roundId),
  INDEX idx_gold_claim_round (roundId)
);

-- 4. lottery_quiz_questions — คำถาม Safety
CREATE TABLE IF NOT EXISTS lottery_quiz_questions (
  questionId    INT AUTO_INCREMENT PRIMARY KEY,
  questionText  TEXT        NOT NULL,
  optionA       TEXT        NOT NULL,
  optionB       TEXT        NOT NULL,
  optionC       TEXT        NOT NULL,
  optionD       TEXT        NOT NULL,
  correctOption VARCHAR(1)  NOT NULL,
  category      VARCHAR(50) DEFAULT 'ทั่วไป',
  isActive      BOOLEAN     DEFAULT TRUE,
  generatedBy   VARCHAR(20) DEFAULT 'manual',
  createdAt     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_quiz_active_category (isActive, category)
);

-- 5. lottery_quiz_answers — สถิติตอบคำถาม
CREATE TABLE IF NOT EXISTS lottery_quiz_answers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  lineUserId    VARCHAR(50) NOT NULL,
  questionId    INT         NOT NULL,
  selectedOption VARCHAR(1) NOT NULL,
  isCorrect     BOOLEAN     NOT NULL,
  usedForTicketId INT       DEFAULT NULL,
  answeredAt    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lineUserId) REFERENCES users(lineUserId),
  FOREIGN KEY (questionId) REFERENCES lottery_quiz_questions(questionId) ON DELETE CASCADE,
  INDEX idx_quiz_answers_used     (usedForTicketId),
  INDEX idx_quiz_answers_user     (lineUserId, answeredAt),
  INDEX idx_quiz_answers_question (questionId, isCorrect)
);

-- 6. lottery_results_history — สรุปผลงวด
CREATE TABLE IF NOT EXISTS lottery_results_history (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  roundId         VARCHAR(50) NOT NULL,
  totalTicketsSold INT        DEFAULT 0,
  totalWinners    INT         DEFAULT 0,
  totalPrizesPaid INT         DEFAULT 0,
  createdAt       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roundId) REFERENCES lottery_rounds(roundId),
  UNIQUE KEY uq_results_round (roundId)
);

-- 7. เพิ่ม columns ในตาราง users
SET @add_lottery_win_count = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE users ADD COLUMN lotteryWinCount INT DEFAULT 0',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'lotteryWinCount'
);
PREPARE stmt FROM @add_lottery_win_count;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @add_lottery_total_winnings = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE users ADD COLUMN lotteryTotalWinnings INT DEFAULT 0',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'lotteryTotalWinnings'
);
PREPARE stmt FROM @add_lottery_total_winnings;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- =============================================
-- Seed: คำถาม Safety 20 ข้อ (8 หมวด)
-- =============================================
INSERT IGNORE INTO lottery_quiz_questions (questionText, optionA, optionB, optionC, optionD, correctOption, category, generatedBy) VALUES

-- หมวด PPE (3 ข้อ)
('ก่อนสวมอุปกรณ์ป้องกันส่วนบุคคล (PPE) ควรทำสิ่งใดก่อน?',
 'ใส่ PPE ทันทีเพื่อความรวดเร็ว',
 'ตรวจสอบสภาพ PPE ว่าอยู่ในสภาพดีและเหมาะสมกับงาน',
 'ถามหัวหน้าว่าจำเป็นต้องใส่หรือไม่',
 'ล้างมือก่อนใส่เสมอทุกครั้ง',
 'B', 'PPE', 'manual'),

('หน้ากากกันฝุ่น N95 มีประสิทธิภาพกรองอนุภาคฝุ่นได้กี่เปอร์เซ็นต์?',
 'ร้อยละ 85',
 'ร้อยละ 90',
 'ร้อยละ 95',
 'ร้อยละ 99',
 'C', 'PPE', 'manual'),

('ถุงมือป้องกันสารเคมีที่เหมาะสมสำหรับกรดกัดกร่อน ควรทำจากวัสดุใด?',
 'ถุงมือผ้าฝ้ายธรรมดา',
 'ถุงมือยางไนไตรล์หรือนีโอพรีน',
 'ถุงมือพลาสติก PE บางๆ',
 'ถุงมือหนังวัว',
 'B', 'PPE', 'manual'),

-- หมวด ดับเพลิง (3 ข้อ)
('ถังดับเพลิงชนิด CO2 เหมาะสำหรับดับไฟประเภทใดมากที่สุด?',
 'ไฟไหม้ไม้และกระดาษ',
 'ไฟไหม้น้ำมันและก๊าซ',
 'ไฟฟ้าและอุปกรณ์อิเล็กทรอนิกส์',
 'ไฟไหม้โลหะ',
 'C', 'ดับเพลิง', 'manual'),

('เมื่อพบเพลิงไหม้ขนาดเล็ก ลำดับขั้นตอนแรกที่ถูกต้องคือข้อใด?',
 'ดับไฟด้วยถังดับเพลิงทันที',
 'แจ้งเตือนคนอื่นและกดสัญญาณเตือนไฟไหม้',
 'วิ่งหนีออกจากอาคารให้เร็วที่สุด',
 'โทรแจ้งหัวหน้างานก่อน',
 'B', 'ดับเพลิง', 'manual'),

('การตรวจสอบถังดับเพลิงตามมาตรฐาน ควรทำบ่อยแค่ไหน?',
 'ทุก 5 ปี',
 'ทุก 3 ปี',
 'ทุกปี และตรวจสภาพทุกเดือน',
 'เฉพาะเมื่อมีการใช้งาน',
 'C', 'ดับเพลิง', 'manual'),

-- หมวด สารเคมี (2 ข้อ)
('SDS (Safety Data Sheet) ของสารเคมีต้องมีข้อมูลอะไรบ้าง?',
 'เฉพาะชื่อสารและราคา',
 'ชื่อสาร องค์ประกอบ อันตราย การปฐมพยาบาล และการจัดเก็บ',
 'เฉพาะวิธีใช้งานและปริมาณที่แนะนำ',
 'ชื่อผู้ผลิตและวันหมดอายุ',
 'B', 'สารเคมี', 'manual'),

('เมื่อสารเคมีถูกผิวหนัง ขั้นตอนแรกที่ถูกต้องคืออะไร?',
 'ทาครีมหรือยาทันที',
 'ปิดแผลด้วยผ้าพันแผล',
 'ล้างด้วยน้ำสะอาดปริมาณมากทันทีอย่างน้อย 15 นาที',
 'นำผู้ป่วยส่งโรงพยาบาลทันทีโดยไม่ต้องล้างแผลก่อน',
 'C', 'สารเคมี', 'manual'),

-- หมวด ไฟฟ้า (3 ข้อ)
('ก่อนซ่อมแซมหรือบำรุงรักษาอุปกรณ์ไฟฟ้า ต้องปฏิบัติตามขั้นตอนใด?',
 'ใส่ถุงมือยางแล้วดำเนินการได้เลย',
 'ตัดกระแสไฟและล็อก/ติดป้ายเตือน (LOTO) ก่อนทุกครั้ง',
 'แจ้งหัวหน้าเท่านั้นก็เพียงพอ',
 'ทำงานได้ถ้าแรงดันไฟฟ้าต่ำกว่า 220 โวลต์',
 'B', 'ไฟฟ้า', 'manual'),

('ข้อใดคืออันตรายหลักจากการใช้ปลั๊กไฟแบบ "ต่อพ่วงซ้อนกัน" หลายชั้น?',
 'ไฟฟ้ารั่วไหลออกมาที่พื้น',
 'วงจรโอเวอร์โหลดทำให้เกิดความร้อนและไฟไหม้',
 'ประหยัดไฟได้น้อยลง',
 'อุปกรณ์ทำงานช้าลง',
 'B', 'ไฟฟ้า', 'manual'),

('สายดิน (Grounding) ในระบบไฟฟ้ามีหน้าที่สำคัญอย่างไร?',
 'ทำให้กระแสไฟฟ้าไหลแรงขึ้น',
 'ป้องกันไฟฟ้าช็อตโดยนำกระแสไฟฟ้ารั่วลงดิน',
 'ลดการสิ้นเปลืองพลังงาน',
 'เพิ่มอายุการใช้งานของสายไฟ',
 'B', 'ไฟฟ้า', 'manual'),

-- หมวด การทำงานที่สูง (2 ข้อ)
('ตามกฎหมายความปลอดภัยไทย งานที่สูงเกินกี่เมตรต้องใช้สายรัดนิรภัย (Safety Harness)?',
 'สูงกว่า 1 เมตร',
 'สูงกว่า 2 เมตร',
 'สูงกว่า 3 เมตร',
 'สูงกว่า 5 เมตร',
 'B', 'การทำงานที่สูง', 'manual'),

('ก่อนเริ่มงานบนนั่งร้าน ควรตรวจสอบสิ่งใดเป็นลำดับแรก?',
 'น้ำหนักสูงสุดที่ระบุไว้และสภาพความมั่นคงของนั่งร้าน',
 'จำนวนคนที่จะขึ้นไปทำงาน',
 'สภาพอากาศในวันนั้น',
 'ความพร้อมของอุปกรณ์ดับเพลิง',
 'A', 'การทำงานที่สูง', 'manual'),

-- หมวด กฎหมาย (2 ข้อ)
('พระราชบัญญัติความปลอดภัย อาชีวอนามัย และสภาพแวดล้อมในการทำงาน พ.ศ. 2554 กำหนดให้นายจ้างที่มีลูกจ้างกี่คนขึ้นไปต้องมี จป.วิชาชีพ?',
 '10 คนขึ้นไป',
 '20 คนขึ้นไป',
 '50 คนขึ้นไป',
 '100 คนขึ้นไป',
 'C', 'กฎหมาย', 'manual'),

('โทษสูงสุดของนายจ้างที่ฝ่าฝืนกฎหมายความปลอดภัยและทำให้ลูกจ้างได้รับบาดเจ็บสาหัสคืออะไร?',
 'ปรับไม่เกิน 50,000 บาท',
 'จำคุกไม่เกิน 1 ปี หรือปรับไม่เกิน 200,000 บาท หรือทั้งจำทั้งปรับ',
 'ถูกสั่งปิดกิจการชั่วคราว',
 'ตักเตือนเป็นลายลักษณ์อักษรครั้งแรก',
 'B', 'กฎหมาย', 'manual'),

-- หมวด การยศาสตร์ (2 ข้อ)
('การยกของหนักที่ถูกต้องตามหลักการยศาสตร์ควรทำอย่างไร?',
 'ก้มตัวโค้งหลังและยกให้เร็วที่สุด',
 'นั่งยองๆ ให้หลังตรง ใช้แรงขา และยกของให้ชิดลำตัว',
 'ยืนตัวตรงและใช้แรงแขนดึงขึ้นมา',
 'ขอให้คนอื่นช่วยยกทุกครั้งโดยไม่คำนึงน้ำหนัก',
 'B', 'การยศาสตร์', 'manual'),

('อาการ RSI (Repetitive Strain Injury) เกิดจากสาเหตุใด?',
 'การยกของหนักครั้งเดียวเกินกำลัง',
 'การทำงานซ้ำๆ ในท่าเดิมนานเกินไปโดยไม่พักเปลี่ยนท่า',
 'การสัมผัสสารเคมีระเหยง่าย',
 'อุณหภูมิในสถานที่ทำงานต่ำเกินไป',
 'B', 'การยศาสตร์', 'manual'),

-- หมวด สิ่งแวดล้อม (2 ข้อ)
('ขยะอันตรายจากโรงงาน เช่น น้ำมันเครื่องเก่า ต้องจัดการอย่างไร?',
 'ทิ้งลงท่อระบายน้ำเพื่อเจือจาง',
 'เผาทำลายในพื้นที่โรงงาน',
 'รวบรวมในภาชนะปิดสนิทและส่งให้บริษัทรับกำจัดที่ได้รับอนุญาต',
 'ฝังดินในพื้นที่โรงงาน',
 'C', 'สิ่งแวดล้อม', 'manual'),

('ระดับเสียงดังในสถานที่ทำงานที่กฎหมายกำหนดให้พนักงานต้องสวมอุปกรณ์ป้องกันหูคือกี่เดซิเบล?',
 'มากกว่า 70 เดซิเบล',
 'มากกว่า 80 เดซิเบล',
 'มากกว่า 85 เดซิเบล',
 'มากกว่า 100 เดซิเบล',
 'C', 'สิ่งแวดล้อม', 'manual'),

-- หมวด ทั่วไป (3 ข้อ)
('เมื่อเกิดอุบัติเหตุในที่ทำงาน ขั้นตอนแรกที่ถูกต้องที่สุดคืออะไร?',
 'ถ่ายรูปเก็บหลักฐานก่อน',
 'ประเมินความปลอดภัยของพื้นที่ก่อนเข้าช่วยเหลือ',
 'โทรแจ้งประกันสังคมทันที',
 'นำผู้บาดเจ็บย้ายออกจากจุดเกิดเหตุทันที',
 'B', 'ทั่วไป', 'manual'),

('5ส (5S) ในการจัดการสถานที่ทำงานประกอบด้วยข้อใด?',
 'สะสาง สะดวก สะอาด สุขลักษณะ สร้างนิสัย',
 'สะอาด สวยงาม สว่าง สงบ สะดวก',
 'ปลอดภัย สะอาด สม่ำเสมอ สังเกต สรุป',
 'สะสาง สะอาด สมดุล สุขภาพ สุขนิสัย',
 'A', 'ทั่วไป', 'manual'),

('ทำไมการรายงานเหตุการณ์เกือบเกิดอุบัติเหตุ (Near Miss) จึงสำคัญ?',
 'เป็นข้อบังคับทางกฎหมายเท่านั้น',
 'เพื่อให้สามารถแก้ไขสภาพแวดล้อมที่เป็นอันตรายก่อนเกิดอุบัติเหตุจริง',
 'เพื่อนับสถิติและรายงานต่อผู้บริหาร',
 'เพื่อให้พนักงานระมัดระวังตัวมากขึ้นเท่านั้น',
 'B', 'ทั่วไป', 'manual');

-- =============================================
-- Seed: งวดเริ่มต้น 2 งวดถัดไป
-- (วันที่ 1 และ 16 ของเดือนถัดไป)
-- =============================================
INSERT IGNORE INTO lottery_rounds (roundId, drawDate, status) VALUES
  ('2026-05-16', '2026-05-16', 'open'),
  ('2026-06-01', '2026-06-01', 'open');

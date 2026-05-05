# Safety Lottery Dev Notes

คู่มือนี้สรุปวิธีรันและทดสอบฟีเจอร์ Safety Lottery บน localhost โดยไม่ต้อง push ขึ้น production

## Local Setup

ต้องมีไฟล์ `.env` ที่ root ของโปรเจกต์ก่อนรัน backend:

```env
DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DB_NAME
GEMINI_API_KEY=your_gemini_key
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LIFF_ID=2007053300-9xLKdwZp
PORT=3000
```

หมายเหตุ: ถ้า `DATABASE_URL` ชี้ production DB การทดสอบ local จะเขียนข้อมูลจริง เช่น lottery tickets, quiz answers, notifications ลงฐานจริง

## Run Locally

Terminal 1:

```powershell
npm start
```

Backend ควรขึ้นที่:

```text
http://localhost:3000
```

Terminal 2:

```powershell
npx http-server . -p 5500 -a 127.0.0.1
```

เปิด frontend:

```text
http://127.0.0.1:5500/index.html
```

`app.js` จะใช้ backend local อัตโนมัติเมื่อ hostname เป็น `localhost` หรือ `127.0.0.1`

## Local LIFF Bypass

LINE LIFF login จะ redirect กลับ endpoint ที่ตั้งใน LINE Console ซึ่ง production ตั้งเป็น GitHub Pages ดังนั้นการเปิด local ตรง ๆ อาจเด้งไป:

```text
https://ttwazzx.github.io/safety-spot-app/
```

สำหรับ local test ให้ bypass LIFF ด้วย `devLineUserId`:

```text
http://127.0.0.1:5500/index.html?devLineUserId=YOUR_LINE_USER_ID
```

ถ้าต้องการชื่อที่แสดงใน local profile mock:

```text
http://127.0.0.1:5500/index.html?devLineUserId=YOUR_LINE_USER_ID&devName=Local%20Tester
```

วิธีหา `lineUserId` ง่ายที่สุด:

1. เปิดหน้า production ที่ login อยู่
2. เปิด DevTools > Console
3. พิมพ์:

```js
AppState.lineProfile.userId
```

นำค่าที่ได้มาใส่ใน `devLineUserId`

## Required SQL

ถ้ารัน `migration-lottery.sql` ล่าสุดแล้ว ตารางหลักจะครบ รวมถึง:

- `lottery_rounds`
- `lottery_tickets`
- `lottery_daily_purchases`
- `lottery_gold_ticket_claims`
- `lottery_quiz_questions`
- `lottery_quiz_answers`
- `lottery_results_history`

ถ้า database เคยรัน migration เวอร์ชันเก่า ให้เช็กสองอย่างนี้:

```sql
ALTER TABLE lottery_quiz_answers
  ADD COLUMN usedForTicketId INT DEFAULT NULL;

ALTER TABLE lottery_quiz_answers
  ADD INDEX idx_quiz_answers_used (usedForTicketId);
```

ถ้า duplicate column/index ให้ข้ามได้ เพราะ `server.js` มี startup migration แบบ `.catch(() => {})` อยู่แล้ว

## Feature Checklist

User flow:

- เปิด Safety Lottery จาก Game Dashboard
- โหลด current round และ countdown
- เลือก 2 ตัวท้าย หรือ 3 ตัวท้าย
- กดสุ่มเลข หรือกรอกเลขเอง
- กดตอบ Safety Quiz
- ตอบถูกแล้วได้ bonus 2 coins และซื้อตั๋ว
- จำกัด 5 ใบต่อคนต่อวัน
- ดูตั๋วในแท็บ "ตั๋วของฉัน"
- ดูผลย้อนหลังในแท็บ "ผลรางวัล"

Gold Ticket:

- รับได้ 1 ใบต่อคนต่อรอบงวด
- เป็นตั๋ว 3 ตัวท้ายฟรี
- `price=0`
- `isGoldTicket=TRUE`
- ไม่กิน quota 5 ใบ
- ไม่ต้องตอบ Safety Quiz
- ระบบเช็กว่าแผนกไม่มี Incident 30 วัน

Admin flow:

- เปิด Admin > Safety Lottery
- ดู Dashboard
- สร้างงวดใหม่
- กรอกผล 2 ตัวท้าย และ 3 ตัวท้าย
- ยืนยันผล
- ประมวลผลรางวัล
- CRUD คำถาม Safety
- AI สร้างคำถาม 10 ข้อด้วย Gemini

## Incident Rule For Gold Ticket

ระบบเดิมไม่มีตาราง Incident แยก จึงตีความ Incident จาก `submissions` ของคนในแผนกเดียวกันในช่วง 30 วันที่ผ่านมา

นับเป็น Incident ถ้า:

- `submissions.status` เป็น `pending` หรือ `approved`
- อยู่ใน 30 วันที่ผ่านมา
- ข้อความใน activity title, activity description หรือ submission description มี keyword เช่น:
  - `incident`
  - `accident`
  - `near miss`
  - `อุบัติเหตุ`
  - `บาดเจ็บ`
  - `เจ็บ`
  - `เกือบเกิดอุบัติเหตุ`

ถ้าต้องการความแม่นยำสูงในอนาคต ควรเพิ่ม field หรือ activity type สำหรับ Incident โดยตรง

## Important Endpoints

User:

- `GET /api/lottery/current-round`
- `GET /api/lottery/quiz-question`
- `POST /api/lottery/answer-quiz`
- `POST /api/lottery/buy-ticket`
- `GET /api/lottery/my-tickets`
- `GET /api/lottery/results`
- `GET /api/lottery/stats`
- `GET /api/lottery/gold-eligibility`
- `POST /api/lottery/claim-gold-ticket`

Admin:

- `GET /api/admin/lottery/dashboard`
- `POST /api/admin/lottery/set-result`
- `POST /api/admin/lottery/confirm-result`
- `POST /api/admin/lottery/process-prizes`
- `GET /api/admin/lottery/questions`
- `POST /api/admin/lottery/questions`
- `PUT /api/admin/lottery/questions`
- `DELETE /api/admin/lottery/questions/:id`
- `POST /api/admin/lottery/generate-questions`
- `POST /api/admin/lottery/rounds`

## Smoke Test With Browser

1. เปิด DevTools > Network
2. เปิด Safety Lottery
3. ต้องเห็น request ไป `http://localhost:3000/api/lottery/current-round`
4. ลองซื้อ 2 ตัวท้าย
5. ตอบ quiz ถูก
6. เช็กว่า `POST /api/lottery/buy-ticket` มี `quizAnswerId`
7. เช็กแท็บ "ตั๋วของฉัน"
8. กดรับ Gold Ticket ถ้ามีสิทธิ์
9. เช็กว่า ticket แสดงเป็นสีทอง

## Known Limits

- Cron ดึงผลหวยจะทำงานตาม schedule จริง ไม่เหมาะกับ smoke test ทันที
- LINE Push ต้องมี `LINE_CHANNEL_ACCESS_TOKEN` จริง และผู้ใช้ต้องเป็น friend/follower ตามเงื่อนไข LINE
- AI generate ต้องมี `GEMINI_API_KEY`
- Local LIFF login อาจขึ้นกับ LIFF endpoint settings ใน LINE console

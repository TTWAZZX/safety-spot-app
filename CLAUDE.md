# Safety Spot App — CLAUDE.md

## Project Overview
LINE LIFF web application สำหรับระบบรายงานความปลอดภัยแบบ gamified
- Backend: Node.js + Express (`server.js`)
- Database: MySQL (Aiven Cloud) ผ่าน `db.js`
- Frontend: jQuery + Bootstrap 5 (`app.js`, `index.html`)
- Storage: Cloudflare R2 (S3-compatible)
- Deploy: Render.com (backend), GitHub Pages (frontend)

## Architecture
```
LINE LIFF (frontend) → callApi() → Express REST API → MySQL (Aiven)
                                 ↘ Cloudflare R2 (image upload)
                                 ↘ LINE Messaging API (push notifications)
```

## Key Files
| File | หน้าที่ |
|------|---------|
| `server.js` | Express backend ~6130 บรรทัด — API ทั้งหมด |
| `db.js` | MySQL connection pool — export `query()` และ `getClient()` |
| `schema.sql` | Full schema สำหรับ fresh install (DROP + CREATE) |
| `migration.sql` | ALTER statements สำหรับ patch production ที่มีข้อมูลแล้ว |
| `app.js` | Frontend SPA logic ~7970 บรรทัด |
| `index.html` | HTML template |
| `style.css` | Custom styles (Bootstrap 5 overrides, LINE green theme) ~3900 บรรทัด |

## Database
- **Host:** Aiven Cloud MySQL 8.0
- **Connection:** ผ่าน `DATABASE_URL` env variable
- **Pool:** `db.getClient()` สำหรับ transaction, `db.query()` สำหรับ query ธรรมดา
- **Tables:** 19 ตาราง + `audit_logs`, `lottery_dream_logs`, `safety_dream_items` (สร้างอัตโนมัติตอน server start)

## Environment Variables (.env)
```
DATABASE_URL          MySQL connection string (Aiven)
R2_ACCOUNT_ID         Cloudflare R2
R2_ACCESS_KEY_ID      Cloudflare R2
R2_SECRET_ACCESS_KEY  Cloudflare R2
R2_BUCKET_NAME        Cloudflare R2
R2_PUBLIC_BASE_URL    Cloudflare R2 public URL
LINE_CHANNEL_ACCESS_TOKEN  LINE Messaging API
LIFF_ID               LINE LIFF ID
PORT                  Server port (default 3000)
```

## Auth System
- ระบบใช้ `lineUserId` จาก LINE LIFF เป็น identity
- Admin check ผ่าน `isAdmin` middleware — ตรวจ `requesterId` จาก request body/query เทียบกับตาราง `admins`
- **ไม่มี session/token ฝั่ง server** — trust lineUserId จาก client

## Important Conventions

### Database Connections
```javascript
// Query ธรรมดา
const [rows] = await db.query("SELECT ...", [params]);

// Transaction
const conn = await db.getClient();  // ไม่ใช่ db.getConnection()
try {
    await conn.beginTransaction();
    // ...queries...
    await conn.commit();
} catch (err) {
    await conn.rollback();
} finally {
    conn.release();
}
```

### API Response Format
```javascript
// Success
res.json({ status: "success", data: { ... } });

// Error
res.status(500).json({ status: "error", message: err.message });
```

### ID Generation
```javascript
// ใช้ uuidv4() เสมอ — ห้ามใช้ Date.now() เป็น primary key
"SUB" + uuidv4()   // submissions
"LIKE" + uuidv4()  // likes
"CMT" + uuidv4()   // comments
"NOTIF" + uuidv4() // notifications
"BADGE" + uuidv4() // badges
"ACT" + uuidv4()   // activities
```

### Modal (Bootstrap 5)
```javascript
// เปิด modal
AppState.allModals['key'].show();           // modal ที่ init ใน initializeAllModals()
new bootstrap.Modal(document.getElementById('modal-id')).show(); // modal อื่นๆ

// ปิด modal — ต้องใช้ Bootstrap 5 API เสมอ (ห้ามใช้ $('...').modal('hide'))
bootstrap.Modal.getInstance(document.getElementById('modal-id'))?.hide();
AppState.allModals['key'].hide();
```

### Upload Image
```javascript
// ต้องส่ง lineUserId ใน FormData ด้วยเสมอ
formData.append('image', file);
formData.append('lineUserId', AppState.lineProfile.userId);
```

### callApi Helper
```javascript
// callApi อัตโนมัติ inject requesterId จาก AppState.lineProfile.userId ทุก request
await callApi('/api/endpoint', { param: value }, 'POST');
// GET requests → query string, POST requests → JSON body
```

## Game Tables
| Table | หน้าที่ |
|-------|---------|
| `kyt_questions` | คำถาม daily quiz |
| `user_game_history` | ประวัติการตอบ (UNIQUE lineUserId+playedAt ป้องกัน race condition) |
| `user_streaks` | streak รายวัน |
| `safety_cards` | การ์ดสะสม gacha |
| `user_cards` | การ์ดที่ user มี (ซ้ำได้) |
| `hunter_levels` | ด่าน Safety Hunter |
| `hunter_hazards` | จุดเสี่ยงในด่าน |
| `hunter_attempts` | จำนวนครั้งที่เล่นแต่ละด่าน (max 3) |
| `user_hunter_history` | ผลดาวและ UNIQUE per (lineUserId, levelId) |

## Features Implemented

### Rate Limiting (`express-rate-limit`)
- `generalLimiter`: 100 req/min — ครอบ `/api/`
- `authLimiter`: 10 req/5min — `/api/user/register` เท่านั้น
- `uploadLimiter`: 20 req/5min — `/api/submissions`, `/api/upload`
- ⚠️ `/api/user/profile` **ต้องไม่อยู่ใน authLimiter** — auto-refresh ทุก 5 วินาทีจะ 429

### Department System
- 34 แผนกคงที่ใน `DEPARTMENTS` constant (app.js)
- `promptSelectDepartment()` — บังคับ existing user เลือกแผนกก่อนใช้งาน
- Column `department VARCHAR(100)` ใน `users` table (migration อัตโนมัติ)

### Admin Analytics
- `GET /api/admin/analytics` — ยอดรวม, trend 8 สัปดาห์, top reporters
- `GET /api/admin/department-scores` — Safety Score ระดับแผนก (avg score, member count)
- `GET /api/admin/export/submissions` — CSV with UTF-8 BOM
- `GET /api/admin/export/submissions/print` — HTML page สำหรับ print PDF

### Admin Audit Log
- ตาราง `audit_logs` — สร้างอัตโนมัติด้วย `CREATE TABLE IF NOT EXISTS` ตอน server start
- `logAdminAction(adminId, action, targetType, targetId, targetName, detail)` — fire-and-forget ไม่บล็อก response
- บันทึกทุก action: APPROVE/REJECT/DELETE_SUBMISSION, ADD/DEDUCT_SCORE, ADD/DEDUCT_COINS, UPDATE_STREAK, AWARD/REVOKE_BADGE, AWARD_CARD, UPDATE_PROFILE
- `GET /api/admin/audit-logs` — paginated 50/page, filter ตาม action/adminId/dateFrom/dateTo
- UI: `#admin-audit-modal` fullscreen พร้อม filter bar + pagination

### Home Dashboard (Personal Dashboard)
หน้าหลักเป็น Personal Dashboard แยกออกจากหน้ากิจกรรม:
- **Profile card**: avatar, ชื่อ, รหัสพนักงาน, แผนก, คะแนน, percentile chip
- **Personal status strip**: เหรียญ, streak ต่อเนื่อง, คะแนน, สถานะ KYT วันนี้
- **Quick actions**: รายงานจุดเสี่ยง / ตอบ KYT / เล่นเกม / ดูรางวัล
- **Today's Safety Tasks**: action list ที่ดันงานวันนี้ขึ้นก่อน content อื่น เช่น KYT, activity pending, Safety Lottery, report shortcut
- **Department Leaderboard**: top 10 avg score, highlight แผนกตัวเอง, rank label
- **Department Leaderboard preview**: แสดง 5 แถวแรกบนหน้าแรกและมีปุ่มไปหน้าอันดับทั้งหมด
- **Recent activities**: compact card 3 อันดับแรก, กดเปิด submission modal ได้ พร้อมทางไปดูทั้งหมด
- **Safety Pulse**: ความเคลื่อนไหว cross-system ล่าสุดจาก `/api/home/activity-feed`, แสดงทีละ 5 พร้อม previous/next pager

### Activities Page (ภารกิจความปลอดภัย)
- **Filter tabs**: ทั้งหมด / ยังไม่ได้ร่วม / ร่วมแล้ว ✓
- **Done badges**: `activity-done-badge` (✅ overlay บนรูป), `activity-count-badge` (👥 overlay), green border
- `AppState._lastActivities` cache ไว้ filter tabs ใช้
- Filter reset เป็น "all" อัตโนมัติเมื่อโหลดกิจกรรมใหม่

### Leaderboard Page
- **Sticky "My Rank" bar**: `position: fixed; bottom: 66px` (เหนือ bottom nav)
- แสดงอัตโนมัติหลัง `loadLeaderboard` โหลดเสร็จ
- ซ่อนเมื่อออกจากหน้า leaderboard (nav click handler)
- Fallback: ถ้า user ไม่อยู่ใน page 1 ใช้ `AppState.currentUser.userRank` จาก profile

### Percentile System
- `/api/user/profile` คำนวณ `userRank`, `totalUsers`, `percentile`
- `updateUserInfoUI` populate `#home-percentile-label` พร้อม CSS class tier:
  - `.pct-top` (gold) — Top ≤10%
  - `.pct-mid` (green) — Top ≤50%
  - `.pct-low` (grey) — Top >50%

### Confetti Celebrations (`canvas-confetti`)
CDN: `https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js`
```javascript
fireConfetti('default')  // ส่งรายงาน, admin อนุมัติ
fireConfetti('streak')   // streak milestone (ยิงสองข้าง)
fireConfetti('big')      // 3 bursts
```

### Streak Milestone Celebration
- `checkStreakMilestone(streak)` เรียกใน `showMainApp` ทุก login
- Milestone: 7, 30, 60, 100 วัน
- Dedup ด้วย `localStorage.getItem('streak_milestone_N_shown')`
- แสดง Swal popup + confetti streak

### Social Feed
- `GET /api/home/activity-feed` (public) — cross-system activity feed เช่น reports, KYT, cards, hunter, lottery
- `loadSocialFeed()` — cache feed items and render 5 items per page in `#home-social-feed`
- `changeSocialFeedPage(delta)` — pager สำหรับ Safety Pulse
- `formatTimeAgo(dateStr)` — Thai time labels (เมื่อกี้ / X นาที / X ชั่วโมง / X วัน)

### Safety Lottery Current Notes
- User rules modal can be reopened from the Lottery modal header
- Lottery modal content uses rounded clipping to avoid square white corners on mobile
- User endpoints validate `requesterId`/`lineUserId` for Lottery user-owned data
- `/api/lottery/current-round` hides test rounds from normal users; admin (requesterId in admins table) sees test rounds via `includeTestRounds` flag
- `lottery_rounds.isTest` supports admin-only test rounds
- Admin result tab supports:
  - manual result entry
  - `POST /api/admin/lottery/fetch-result` for AI result fetch on real rounds
  - preview winners
  - confirm result
  - process prizes and LINE Push winner notifications
- If scheduled AI result fetch fails after retries, admins receive in-app notification and LINE Push alert, and the round becomes `pending_manual`
- Result confirmation is state-guarded: completed rounds cannot be edited/reconfirmed, and confirm only works from `pending_confirm`
- Confirmed rounds snapshot prize/price settings into `lottery_rounds` so later admin setting changes do not change an already confirmed payout
- Reset tickets is transaction-safe: it unlinks quiz answers, removes gold-ticket claims before tickets, and recalculates affected users' daily quota from remaining tickets today

### Safety Lottery — Round Management (Admin)
- **สร้างงวด**: Manual จาก admin panel หรือ auto-cron 08:00 BKK สร้างงวดล่วงหน้า 3 วันก่อน 1/16 ของเดือน
- **งวดทดสอบ** (`isTest=true`): มองเห็นเฉพาะ admin เท่านั้น ปุ่ม 🧪 เปิด lottery modal โดยตรง
- **แก้งวด**: ปุ่ม ✏️ แก้วันที่ได้เฉพาะ `status=open`
- **รีเซตตั๋ว**: ปุ่ม 🔄 ลบ tickets + คืน daily quota + คืน quiz answer links → ต้องพิมพ์ `RESET` ยืนยัน; บล็อก `confirmed`/`completed`
  - ⚠️ `lottery_daily_purchases` ไม่มีคอลัมน์ `roundId` — ลบด้วย `lineUserId IN (affected users)`
  - ⚠️ `lottery_quiz_answers` ไม่มีคอลัมน์ `roundId` — reset ด้วย `usedForTicketId IN (ticketIds)`
  - ⚠️ `lottery_gold_ticket_claims` มี FK → `lottery_tickets.ticketId` — ต้องลบก่อน delete tickets
- **ลบงวด**: ปุ่ม 🗑️ ลบได้เฉพาะงวด test หรืองวดที่ยังไม่มีตั๋ว

### Safety Dream Numbers — ท่านอาจารย์จอห์นนี่
- ปุ่ม 🔮 ในหน้าซื้อตั๋ว → เปิด dream modal (แสดงเสมอ แม้ไม่มีงวดเปิด)
- **3-step flow**: input (เลือกสัญลักษณ์ / พิมพ์ความฝัน) → loading → result (เลข 2/3 ตัว + คำแนะนำ Safety)
- **Rate limit**: 1 ครั้ง/วัน/user — วันเดิมกดได้ดูผลเดิม (cached); **Admin ไม่มี limit** — ทดสอบได้ไม่จำกัด
- **ปุ่ม "ใช้เลขนี้"**: ปิด dream modal → เปิด lottery modal → set เลขในช่อง + switch type อัตโนมัติ
- **AI**: Gemini `gemini-2.5-flash` → fallback models → static fallback ถ้า AI ล่ม
- **`LOTTERY_GEMINI_MODELS`** declared at line ~4169 — ใช้ร่วมกับ generate-questions และ fetch-result

#### Tables — safety_dream_items (schema จริง)
```sql
dreamId     VARCHAR(20)  PRIMARY KEY   -- เช่น PPE001, AI001 (AI-generated)
category    VARCHAR(20)                -- ppe|fire|electrical|chemical|height|machine|road
itemName    VARCHAR(100)
itemIcon    VARCHAR(10)                -- emoji
number2d    CHAR(2)
number3d    CHAR(3)
safetyFact  TEXT                       -- ข้อเท็จจริงด้านความปลอดภัย (ใช้ใน AI prompt)
promptHint  TEXT                       -- คำใบ้ให้ AI ทำนาย (ใช้ใน AI prompt)
```
⚠️ **อย่าใช้ `itemId` หรือ `luckyDigit`** — ไม่มีคอลัมน์นี้ ใช้ `dreamId`, `number2d`, `number3d`

Current production-safe schema additions:
- `category VARCHAR(50)`, `itemName VARCHAR(120)`, `itemIcon VARCHAR(20)`, `number2d VARCHAR(2)`, `number3d VARCHAR(3)`
- `isActive BOOLEAN DEFAULT TRUE`, `createdAt TIMESTAMP`, `updatedAt TIMESTAMP`
- `idx_dream_items_category (category, isActive)`
- Admin delete is a soft delete (`isActive=FALSE`), and user/admin lists only show active symbols

#### Table — lottery_dream_logs
```sql
logId        VARCHAR(50)  PRIMARY KEY
lineUserId   VARCHAR(60)
dreamText    TEXT
dreamItemId  VARCHAR(20)  -- FK ref safety_dream_items.dreamId (no hard FK constraint)
result       JSON         -- full AI response object
isFavorite   BOOLEAN      DEFAULT FALSE
sharedAt     TIMESTAMP    NULL DEFAULT NULL
createdAt    TIMESTAMP
```
- `result` is normalized on read/write; `number2d` must be 2 digits and `number3d` must be 3 digits
- `isFavorite` / `sharedAt` — added via idempotent ALTER TABLE at server start (already in production)
- Admin dream-logs endpoint extracts `number2d`/`number3d` via `JSON_EXTRACT` — ไม่ต้อง fetch full `result` JSON
- User dream endpoints enforce owner/admin access and use a per-user daily MySQL lock to prevent duplicate concurrent dream logs

#### Admin Dream Management (tab "ท่านอาจารย์" ใน admin lottery modal)
| Endpoint | วิธีใช้ |
|----------|---------|
| `GET /api/admin/lottery/dream-items` | รายการสัญลักษณ์ทั้งหมด (full schema) |
| `POST /api/admin/lottery/dream-items` | เพิ่มเอง — body: `{dreamId, category, itemName, itemIcon, number2d, number3d, safetyFact, promptHint}` |
| `PUT /api/admin/lottery/dream-items/:dreamId` | แก้ไข — body: fields ที่ต้องการแก้ |
| `DELETE /api/admin/lottery/dream-items/:dreamId` | ลบสัญลักษณ์ |
| `POST /api/admin/lottery/dream-items/generate` | AI สร้างใหม่ — body: `{count: 1-20}` ไม่ซ้ำของเดิม; dreamId auto = `AI001`, `AI002`... |
| `GET /api/admin/lottery/dream-logs` | ประวัติ 100 รายการล่าสุด พร้อม displayName, department, itemName |
| `DELETE /api/admin/lottery/dream-logs/user/:lineUserId` | รีเซต daily limit วันนี้ของ user คนนั้น |

**App.js functions**: `loadAdminDreamItems()`, `adminAddDreamItem()`, `adminEditDreamItem(dreamId)`, `adminDeleteDreamItem(dreamId, itemName)`, `adminGenerateDreamItems()`, `loadAdminDreamLogs()`, `adminResetDreamLimit(lineUserId, displayName)`

**⚠️ Swal preConfirm pattern**: admin form functions ต้อง capture `{ value: vals, isConfirmed }` จาก `Swal.fire()` — ห้ามเรียก `_dreamFormValues()` หลัง Swal ปิด เพราะ DOM elements ถูกทำลายแล้ว

**Module-level vars (dream)**: `_dreamItems`, `_dreamSelectedItemId`, `_dreamResult`, `_adminDreamItemsCache`

### Department Leaderboard (Public)
- `GET /api/department-leaderboard` (public) — top 10 แผนก by avgScore
- ไม่ต้อง auth, เรียกได้เลย

### Submission Count per Activity
- `/api/activities` คืน `submissionCount` ต่อ activity
- คำนวณจาก GROUP BY ใน query แยก + map เป็น object

### Empty States
- `.empty-state` — icon + heading + text (ใช้ใน activities list)
- `.empty-state-small` — compact version (ใช้ใน social feed, home cards)
- Filter-aware: ข้อความต่างกันสำหรับ done/pending filter ที่ว่าง

## Public API Endpoints (ไม่ต้องการ auth)
| Endpoint | Returns |
|----------|---------|
| `GET /api/social-feed` | 10 approved submissions ล่าสุด |
| `GET /api/department-leaderboard` | Top 10 แผนก by avgScore |
| `GET /api/activities?lineUserId=` | กิจกรรม + userHasSubmitted + submissionCount |
| `GET /api/leaderboard?page=` | ผู้ใช้ ranked by totalScore |

## KYT Monitor
- ⚠️ Column จริงคือ `h.selectedAnswer` — ต้อง `h.selectedAnswer AS selectedOption`
- อย่าใช้ `h.selectedOption` — ไม่มีคอลัมน์นี้ใน `user_game_history`

## Fixed Bugs Log

### รอบที่ 1 — Backend Audit (server.js)
| ID | ปัญหา | วิธีแก้ |
|----|-------|---------|
| BUG-1 | Quiz daily check ถูก comment ออก → farm coins ได้ | Uncomment + เพิ่มใน v2 |
| BUG-2 | `db.getConnection()` ไม่มี → crash | แก้เป็น `db.getClient()` |
| BUG-3 | PUT questions ใช้ตาราง `daily_questions` ผิด | แก้เป็น `kyt_questions` |
| BUG-4 | PUT cards ใช้ตาราง `cards` ผิด | แก้เป็น `safety_cards` |
| BUG-5 | Duplicate route `/api/admin/revoke-badge` | ลบ handler ซ้ำออก |
| BUG-6 | Delete activity ไม่ลบ likes/comments ก่อน → FK crash | เพิ่ม DELETE cascade ก่อน |
| BUG-7 | Delete badge ไม่ลบ user_badges ก่อน → FK crash | เพิ่ม DELETE user_badges ก่อน |
| BUG-8 | Approve submission ไม่เช็ค status → double score | เพิ่ม status check |
| BUG-9 | isAdmin middleware ไม่มี try/catch → unhandled crash | เพิ่ม try/catch |
| BUG-10 | Streak display Math.ceil timezone ผิด → streak แสดง 0 ผิด | แก้เป็น date string compare + Math.floor |
| BUG-11 | Notification ID ใช้ `Date.now()` → ซ้ำได้ | แก้เป็น `uuidv4()` |
| BUG-12 | recycle-cards validation block ว่าง → ไม่เช็คของ | เพิ่ม validation จริง |
| BUG-13 | หลาย endpoint ไม่มี error handling | เพิ่ม try/catch |

### รอบที่ 2 — Security & Race Condition
| ID | ปัญหา | วิธีแก้ |
|----|-------|---------|
| S-1 | Quiz submit v1/v2: SELECT→INSERT race condition | ลบ SELECT check, จับ ER_DUP_ENTRY บน INSERT แทน |
| S-2 | Upload ไม่จำกัดขนาด/ไม่เช็ค MIME | เพิ่ม 10MB limit + `mimetype.startsWith('image/')` + require lineUserId |
| DB-1 | UNIQUE constraint ขาดหาย | เพิ่มใน migration.sql และ schema.sql |

### รอบที่ 3 — UX/UI Fixes (app.js)
| ID | ปัญหา | วิธีแก้ |
|----|-------|---------|
| U-1 | uploadImage ไม่ส่ง lineUserId → backend 400 | เพิ่ม `formData.append('lineUserId', ...)` |
| U-2 | recycle modal ปิดไม่ได้ (jQuery syntax ผิด) | แก้เป็น `bootstrap.Modal.getInstance(...)?.hide()` |
| U-3 | coin/score ไม่อัปเดตหลัง exchange | เพิ่ม UI update หลัง callApi สำเร็จ |
| U-4 | Quiz options ว่างยังแสดง (กดพลาดได้) | loop show/hide `.col-6` ตาม option ที่มีค่า |
| U-5 | Streak recovery ปุ่มสีแดง = confusing | เปลี่ยนเป็น confirm=เขียว, cancel=เทา |
| U-6 | Admin user list: N+1 API calls | LEFT JOIN badge COUNT ใน SQL เดียว |
| U-7 | Submit form ไม่ disable button ระหว่าง upload | disable/enable ใน try/finally |
| U-8 | loadPendingSubmissions ไม่มี catch | เพิ่ม catch + error message |
| U-9 | KYT monitor 500: `h.selectedOption` ไม่มีคอลัมน์นี้ | แก้เป็น `h.selectedAnswer AS selectedOption` |
| U-10 | 429 Too Many Requests บน `/api/user/profile` | ลบออกจาก `authLimiter` |
| U-11 | Profile avatar ไม่ชิดขอบ (now-playing-bar) | Full-bleed: `margin: 0 -18px; border-radius: 0` |

### รอบที่ 4 — Lottery Reset Bugs
| ID | ปัญหา | วิธีแก้ |
|----|-------|---------|
| L-1 | Reset: `DELETE FROM lottery_daily_purchases WHERE roundId=?` — ไม่มีคอลัมน์ `roundId` → SQL crash | ดึง lineUserId จาก tickets ก่อน แล้ว DELETE by `lineUserId IN (...)` |
| L-2 | Reset: `DELETE FROM lottery_quiz_answers WHERE roundId=?` — ไม่มีคอลัมน์ `roundId` → SQL crash | UPDATE/DELETE by `usedForTicketId IN (SELECT ticketId FROM tickets WHERE roundId=?)` |
| L-3 | Reset: ลบ lottery_tickets โดยไม่ลบ lottery_gold_ticket_claims ก่อน → FK violation crash | DELETE claims WHERE roundId=? ก่อน delete tickets |
| L-4 | `loadAdminLotteryMonitor`: ternary ทั้งสองข้างเหมือนกัน → `keepSelection` ไม่มีผล | แก้เป็น `keepSelection ? $sel.val() : null` |
| L-5 | `useDreamNumber`: ไม่มี null check บน `lotteryModalEl` → crash ถ้า element ไม่อยู่ใน DOM | เพิ่ม `lotteryModalEl &&` ก่อน `.classList` |

### รอบที่ 5 — Dream Numbers Schema & Admin Bugs
| ID | ปัญหา | วิธีแก้ |
|----|-------|---------|
| D-1 | `safety_dream_items` schema ใน production ต่างจากที่ server คาดไว้ — ใช้ `dreamId VARCHAR(20)` ไม่ใช่ `itemId INT`, ใช้ `number2d`/`number3d` ไม่ใช่ `luckyDigit` → 500 ทุก endpoint | Rewrite ทุก query ให้ใช้ schema จริง |
| D-2 | `lottery_dream_logs` ขาดคอลัมน์ `result`, `dreamItemId` → `Unknown column` error | ALTER TABLE ADD COLUMN (idempotent patch ตอน server start) |
| D-3 | SQL patch ใช้ `'SELECT "ok"'` → DBeaver ตีความ `"ok"` เป็น column identifier → error | เปลี่ยนเป็น `'SELECT 1'` |
| D-4 | `renderDreamItems`: `onclick="selectDreamItem(${item.itemId})"` — dreamId เป็น string ไม่มีเครื่องหมาย quote → JS error | แก้เป็น `onclick="selectDreamItem('${item.itemId}', this)"` |
| D-5 | Dream shortcut button อยู่ใน `#lottery-form-content` → ซ่อนเมื่อไม่มีงวด | ย้ายออกมาอยู่นอก div เพื่อแสดงเสมอ |
| D-6 | **CRITICAL**: `adminEditDreamItem`/`adminAddDreamItem` เรียก `_dreamFormValues()` หลัง `Swal.fire()` resolve → DOM ถูกทำลายแล้ว → ส่งค่าว่างไป overwrite DB | เปลี่ยนเป็น `const { value: vals, isConfirmed } = await Swal.fire({..., preConfirm: () => _dreamFormValues()})` |
| D-7 | Admin mutation functions reset `_dreamItems` แต่ไม่ reset `_adminDreamItemsCache` → edit form อาจใช้ข้อมูลเก่า | เพิ่ม `_adminDreamItemsCache = null` ในทุก mutation |

## AppState (Global State)
```javascript
AppState = {
    lineProfile,       // LINE profile object
    currentUser,       // DB user object (includes userRank, percentile)
    allModals,         // Bootstrap modal instances
    reportsChart,      // Chart.js instance
    leaderboard,       // { currentPage, hasMore }
    adminUsers,        // { currentPage, hasMore, currentSearch, currentSort }
    _cachedQuestions,  // cached quiz questions
    _cachedCards,      // cached safety cards
    _cachedBadges,     // cached badges
    _cachedAdminUsers, // cached admin user list
    _lastCards,        // last loaded user cards
    _lastActivities,   // last loaded activities (used by filter tabs & home dashboard)
    _streakWarningShown,
    _filterActive,     // flag: filter tab is active (prevent cache overwrite)
    // Dream Numbers state (module-level vars, not AppState)
    // _dreamItems, _dreamSelectedItemId, _dreamResult
    // _adminDreamItemsCache  — admin dream items list cache (for edit lookup)
}
```

## CSS Architecture
- `style.css` — เรียงตามลำดับ: Variables → Reset → Layout → Components → Pages → Responsive
- ใช้ `var(--line-green)` (#06C755) เป็น primary color
- Bootstrap 5 เป็น base — override เฉพาะที่จำเป็น
- ไม่มี dark mode

## Database Migration
- **Fresh install:** รัน `schema.sql`
- **Production patch:** รัน `migration.sql` (safe, ไม่ลบข้อมูล)
- **สำคัญ:** Aiven MySQL บังคับ Primary Key ทุกตาราง (`sql_require_primary_key`)
- **UNIQUE Index ที่สร้างแล้วใน DB:** `uq_game_history_daily` บน `user_game_history(lineUserId, playedAt)`

## Cron Jobs
- ทุกวัน 12:00 และ 15:00 (Asia/Bangkok) → `broadcastStreakReminders()`
- แจ้งเตือน LINE push สำหรับ user ที่ streak กำลังจะหมด
- ทุกวัน 08:00 (Asia/Bangkok) → auto-create lottery rounds สำหรับงวดที่อีก ≤3 วันจะถึง 1st/16th
- วันที่ 1 และ 16 ตาม schedule ของ Lottery cron → AI fetch Thai lottery result; on repeated failure notify admins and require manual result handling

## Current Verification Commands
```bash
node --check app.js
node --check server.js
node --check db.js
node --check scripts/lottery-smoke-check.js
git diff --check
```

Lottery / Johnny API smoke before deploy:
```bash
# Requires a running server and an admin lineUserId in admins.
SMOKE_ADMIN_ID=<admin-line-user-id> npm run smoke:lottery

# Adds admin/user dream-item checks for Johnny.
SMOKE_ADMIN_ID=<admin-line-user-id> SMOKE_DREAM=1 npm run smoke:lottery

# Full side-effect smoke: buy/reset ticket, dream interpret, then cleanup test data.
SMOKE_ADMIN_ID=<admin-line-user-id> SMOKE_USER_ID=<test-user-line-id> SMOKE_BUY=1 SMOKE_DREAM=1 SMOKE_DREAM_INTERPRET=1 SMOKE_CLEANUP=1 npm run smoke:lottery
```
PowerShell equivalent: set `$env:SMOKE_ADMIN_ID`, `$env:SMOKE_USER_ID`, `$env:SMOKE_DREAM`, etc. before `npm run smoke:lottery`.

Recommended browser smoke after UI changes:
- Home loads profile/status strip/Quick Actions/Today's Safety Tasks
- Safety Pulse pages 5 items at a time
- Quick Actions navigate to activities, KYT, game, leaderboard
- Safety Lottery opens, rules button works, rounded modal has no square white corners
- User Lottery: open current/test round as admin, answer quiz, buy 2D and 3D tickets, verify quota and disabled/loading states
- Admin Lottery: dashboard/settings/monitor, create test round, preview/confirm/process result, reset tickets, delete empty test round
- Johnny user: open dream modal without an open round, select symbol, generate/view cached result, use number in lottery modal
- Johnny admin: list/add/edit/generate/soft-delete symbols, view logs, reset today's dream limit

## Running Locally
```bash
npm install
# สร้าง .env ก่อน
npm run dev   # nodemon
npm start     # production
```

## Known Limitations
- Auth ฝั่ง server ไม่มี token verification — trust lineUserId จาก client (LINE LIFF handles auth)
- Render.com free tier อาจ spin down → cold start ~30 วินาที (UptimeRobot ping ทุก 5 นาที keep alive)
- Notification ไม่มี pagination
- Admin user list ไม่มี server-side pagination
- `audit_logs.detail` เก็บเป็น JSON string
- Department Trend (↑↓ รายสัปดาห์) ยังไม่ implement — ต้องมี snapshot table ก่อน

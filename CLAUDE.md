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
| `server.js` | Express backend ~3400 บรรทัด — API ทั้งหมด |
| `db.js` | MySQL connection pool — export `query()` และ `getClient()` |
| `schema.sql` | Full schema สำหรับ fresh install (DROP + CREATE) |
| `migration.sql` | ALTER statements สำหรับ patch production ที่มีข้อมูลแล้ว |
| `app.js` | Frontend SPA logic ~5100 บรรทัด |
| `index.html` | HTML template |
| `style.css` | Custom styles (Bootstrap 5 overrides, LINE green theme) ~2460 บรรทัด |

## Database
- **Host:** Aiven Cloud MySQL 8.0
- **Connection:** ผ่าน `DATABASE_URL` env variable
- **Pool:** `db.getClient()` สำหรับ transaction, `db.query()` สำหรับ query ธรรมดา
- **Tables:** 19 ตาราง + `audit_logs` (สร้างอัตโนมัติตอน server start)

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
- **Stats row**: เหรียญ, streak ต่อเนื่อง
- **Quick actions**: เล่นเกม / ส่งรายงาน
- **Department Leaderboard**: top 10 avg score, highlight แผนกตัวเอง, rank label
- **Recent activities**: compact card 3 อันดับแรก, กดเปิด submission modal ได้
- **Social Feed**: ความเคลื่อนไหวล่าสุด (10 รายการ approved)

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
- `GET /api/social-feed` (public) — 10 approved submissions ล่าสุด พร้อม user + activity info
- `loadSocialFeed()` — render ใน `#home-social-feed` เรียกจาก `loadHomeDashboard`
- `formatTimeAgo(dateStr)` — Thai time labels (เมื่อกี้ / X นาที / X ชั่วโมง / X วัน)

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

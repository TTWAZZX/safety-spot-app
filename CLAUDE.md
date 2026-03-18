# Safety Spot App — CLAUDE.md

## Project Overview
LINE LIFF web application สำหรับระบบรายงานความปลอดภัยแบบ gamified
- Backend: Node.js + Express (`server.js`)
- Database: MySQL (Aiven Cloud) ผ่าน `db.js`
- Frontend: jQuery + Bootstrap 5 (`app.js`, `index.html`)
- Storage: Cloudflare R2 (S3-compatible)
- Deploy: Render.com (backend), GitHub Pages หรือ static hosting (frontend)

## Architecture
```
LINE LIFF (frontend) → callApi() → Express REST API → MySQL (Aiven)
                                 ↘ Cloudflare R2 (image upload)
                                 ↘ LINE Messaging API (push notifications)
```

## Key Files
| File | หน้าที่ |
|------|---------|
| `server.js` | Express backend ~3250 บรรทัด — API ทั้งหมด |
| `db.js` | MySQL connection pool — export `query()` และ `getClient()` |
| `schema.sql` | Full schema สำหรับ fresh install (DROP + CREATE) |
| `migration.sql` | ALTER statements สำหรับ patch production ที่มีข้อมูลแล้ว |
| `app.js` | Frontend SPA logic ~3300 บรรทัด |
| `index.html` | HTML template ~81KB |
| `style.css` | Custom styles (Bootstrap 5 overrides, LINE green theme) |

## Database
- **Host:** Aiven Cloud MySQL 8.0
- **Connection:** ผ่าน `DATABASE_URL` env variable
- **Pool:** `db.getClient()` สำหรับ transaction, `db.query()` สำหรับ query ธรรมดา
- **Tables:** 19 ตาราง (ดู `schema.sql` สำหรับ full schema) — รวม `audit_logs` ที่สร้างอัตโนมัติตอน server start

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

## Features Added

### Rate Limiting (`express-rate-limit`)
- `generalLimiter`: 100 req/min — ครอบ `/api/`
- `authLimiter`: 10 req/5min — `/api/user/register`, `/api/user/profile`
- `uploadLimiter`: 20 req/5min — `/api/submissions`, `/api/upload`

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
- ตาราง `audit_logs` — สร้างอัตโนมัติด้วย `CREATE TABLE IF NOT EXISTS`
- `logAdminAction(adminId, action, targetType, targetId, targetName, detail)` — helper fire-and-forget ไม่บล็อก response
- บันทึกทุก action สำคัญ: APPROVE/REJECT/DELETE_SUBMISSION, ADD/DEDUCT_SCORE, ADD/DEDUCT_COINS, UPDATE_STREAK, AWARD/REVOKE_BADGE, AWARD_CARD, UPDATE_PROFILE
- `GET /api/admin/audit-logs` — paginated 50/page, filter ตาม action/dateFrom/dateTo
- UI: modal fullscreen พร้อม filter bar + pagination ในหน้า Admin

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
| S-1 | Quiz submit v1/v2: SELECT→INSERT race condition → เล่นซ้ำวันเดิมได้ | ลบ SELECT check, จับ ER_DUP_ENTRY บน INSERT แทน |
| S-2 | Upload ไม่จำกัดขนาด/ไม่เช็ค MIME | เพิ่ม 10MB limit + `mimetype.startsWith('image/')` + require lineUserId |
| DB-1 | UNIQUE constraint ขาดหาย | เพิ่มใน migration.sql และ schema.sql |
| DB-2 | `uq_game_history_daily` สร้างใน DBeaver โดยตรง | บันทึกใน migration.sql (comment) |

### รอบที่ 3 — UX/UI Fixes (app.js)
| ID | ปัญหา | วิธีแก้ |
|----|-------|---------|
| U-1 | uploadImage ไม่ส่ง lineUserId → backend 400 | เพิ่ม `formData.append('lineUserId', ...)` |
| U-2 | recycle modal ปิดไม่ได้ (jQuery syntax ผิด) | แก้เป็น `bootstrap.Modal.getInstance(...)?.hide()` |
| U-3 | coin/score ไม่อัปเดตหลัง exchange | เพิ่ม UI update หลัง callApi สำเร็จ |
| U-4 | Quiz options ว่างยังแสดง (กดพลาดได้) | loop show/hide `.col-6` ตาม option ที่มีค่า |
| U-5 | Streak recovery ปุ่มสีแดง = confusing | เปลี่ยนเป็น confirm=เขียว, cancel=เทา |
| U-6 | Admin user list: N+1 API calls (31 requests) | LEFT JOIN badge COUNT ใน SQL เดียว |
| U-7 | Submit form ไม่ disable button ระหว่าง upload | disable/enable ใน try/finally |
| U-8 | loadPendingSubmissions ไม่มี catch → container ว่าง | เพิ่ม catch + error message |
| U-X | hunter/edit-user/edit-kyt modals ใช้ jQuery syntax ผิด | แก้เป็น `bootstrap.Modal.getInstance(...)?.hide()` |

## Database Migration
- **Fresh install:** รัน `schema.sql`
- **Production patch:** รัน `migration.sql` (safe, ไม่ลบข้อมูล)
- Schema จริงใน production อาจต่างจาก `schema.sql` ให้ใช้ `DESCRIBE <table>` ตรวจสอบก่อนแก้
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

## Known Limitations (ไม่ใช่ bug แต่ควรรู้)
- Auth ฝั่ง server ไม่มี token verification — trust lineUserId จาก client (LINE LIFF handles auth)
- Render.com free tier อาจ spin down → cold start ~30 วินาที (UptimeRobot ping ทุก 5 นาทีเพื่อ keep alive)
- Notification ไม่มี pagination (ถ้ามีมากจะ render ทีเดียว)
- Admin user list ไม่มี server-side pagination (คืนทุก row, sort/filter ใน SQL)
- `audit_logs.detail` เก็บเป็น JSON string — ถ้า MySQL ไม่รองรับ JSON type จะ fallback เป็น TEXT

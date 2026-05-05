# Safety Spot App Project Guide

เอกสารนี้เป็นภาพรวมทั้งโปรเจกต์สำหรับคนที่จะมาพัฒนาต่อ ดูรายละเอียดเฉพาะฟีเจอร์ Safety Lottery เพิ่มได้ที่ `SAFETY_LOTTERY_DEV.md`

## Overview

Safety Spot App เป็น LINE LIFF web app สำหรับระบบรายงานความปลอดภัยแบบ gamified

- ผู้ใช้ล็อกอินด้วย LINE LIFF
- ส่งรายงานกิจกรรม/ความปลอดภัยพร้อมรูปภาพ
- Admin ตรวจรายงานและให้คะแนน
- ระบบเกมช่วยเพิ่ม engagement เช่น Daily Quiz, Safety Cards, Recycle House, Safety Hunter, Safety Lottery
- Backend ส่ง notification ในระบบ และบาง flow ส่ง LINE Push Message

## Tech Stack

Frontend:

- HTML/CSS/JavaScript แบบไฟล์ตรง
- jQuery
- Bootstrap 5
- SweetAlert2
- Font Awesome
- LINE LIFF SDK

Backend:

- Node.js
- Express
- mysql2/promise
- multer
- Cloudflare R2 ผ่าน AWS S3 compatible SDK
- node-cron
- Gemini API ผ่าน axios
- LINE Messaging API

Database:

- MySQL, production ใช้ Aiven
- Connection ผ่าน `DATABASE_URL`

Deploy:

- Backend: Render
- Frontend: GitHub Pages

## Architecture

```text
LINE LIFF / Browser
  -> index.html + app.js + style.css
  -> callApi()
  -> Express API in server.js
  -> MySQL via db.js
  -> Cloudflare R2 for image upload
  -> LINE Messaging API for push messages
  -> Gemini API for AI features
```

## Important Files

| File | Purpose |
| --- | --- |
| `index.html` | Main frontend markup, pages, modals |
| `app.js` | Main frontend SPA logic and API calls |
| `style.css` | App styling and component themes |
| `server.js` | Express backend, API routes, cron jobs, startup migrations |
| `db.js` | MySQL connection pool |
| `schema.sql` | Full schema for fresh install |
| `migration.sql` | Existing production migration patches |
| `migration-lottery.sql` | Safety Lottery migration |
| `SAFETY_LOTTERY_DEV.md` | Safety Lottery development and testing notes |
| `.env` | Local environment variables, ignored by git |
| `CLAUDE.md` | Existing implementation notes and conventions |

## Local Environment

Create `.env` at project root:

```env
DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DB_NAME
R2_ACCOUNT_ID=your_r2_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret
R2_BUCKET_NAME=your_bucket
R2_PUBLIC_BASE_URL=https://your-public-r2-domain
GEMINI_API_KEY=your_gemini_key
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
LIFF_ID=2007053300-9xLKdwZp
PORT=3000
```

Minimum env needed to start backend:

```env
DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DB_NAME
PORT=3000
```

Some features need extra keys:

- Image upload needs R2 variables
- AI question generation needs `GEMINI_API_KEY`
- LINE Push needs `LINE_CHANNEL_ACCESS_TOKEN`
- LINE deep links use `LIFF_ID`

## Run Locally

Install dependencies:

```powershell
npm install
```

Run backend:

```powershell
npm start
```

Run frontend:

```powershell
npx http-server . -p 5500 -a 127.0.0.1
```

Open:

```text
http://127.0.0.1:5500/index.html
```

If local LIFF redirects back to GitHub Pages, use the local dev bypass:

```text
http://127.0.0.1:5500/index.html?devLineUserId=YOUR_LINE_USER_ID
```

You can get your real LINE user ID from the production app console:

```js
AppState.lineProfile.userId
```

Local frontend automatically uses:

```text
http://localhost:3000
```

Production frontend uses:

```text
https://shesafety-spot-appbackend.onrender.com
```

## Scripts

```json
{
  "start": "node server.js",
  "dev": "nodemon server.js"
}
```

Syntax checks:

```powershell
node --check server.js
node --check app.js
node --check db.js
```

## Auth And Admin Model

Identity:

- App uses LINE `lineUserId`
- `users.lineUserId` is primary identity

Admin:

- Admin users are stored in `admins`
- Most admin APIs check `requesterId`
- `callApi()` injects `requesterId` automatically from `AppState.lineProfile.userId`

Important limitation:

- There is no server-side session/token validation for most APIs
- The app currently trusts `lineUserId` from the client

## API Response Convention

Success:

```js
res.json({ status: 'success', data });
```

Error:

```js
res.status(400).json({ status: 'error', message: '...' });
```

Frontend `callApi()` unwraps `result.data` and throws when `status === 'error'`.

## Database Conventions

Normal query:

```js
const [rows] = await db.query('SELECT * FROM users WHERE lineUserId=?', [lineUserId]);
```

Transaction:

```js
const conn = await db.getClient();
try {
  await conn.beginTransaction();
  await conn.query('UPDATE users SET totalScore=totalScore+? WHERE lineUserId=?', [points, lineUserId]);
  await conn.commit();
} catch (err) {
  await conn.rollback();
  throw err;
} finally {
  conn.release();
}
```

Startup migrations:

```js
db.query('ALTER TABLE users ADD COLUMN example INT DEFAULT 0').catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS example_table (...)`).catch(() => {});
```

## Core Features

### User Registration And Profile

- LINE LIFF profile is read on app startup
- User registration stores full name, employee ID, department
- Department is used for leaderboard and Gold Ticket eligibility

### Activity Reports

- Users submit activity reports with description and image
- Duplicate/similar report prevention uses Levenshtein distance
- Admin approves/rejects reports
- Approved reports give score and notifications

### Dashboard

- Home dashboard shows profile, streak, score, department ranking, recent feed
- Admin dashboard shows pending reports, approved today, quiz stats, at-risk users, active activities

### Daily Quiz

- Safety quiz game with streak behavior
- Questions managed by admin
- Rewards coins/score depending on existing game rules

### Safety Cards And Gacha

- Users collect Safety Cards
- Cards have rarity and can be managed by admin
- Album modal displays owned cards

### Recycle House

- Converts duplicate/recyclable cards into coins
- Uses existing exchange/recycle endpoints and notifications

### Exchange

- Coins and points can be exchanged through game exchange endpoints
- Existing exchange rules are in server routes and frontend modal logic

### Safety Hunter

- Interactive hazard hunting game
- Admin can manage levels/hazards
- User history appears in admin user details

### Safety Lottery

- Users buy 2-digit or 3-digit lottery tickets with coins
- Safety Quiz gate required before paid ticket purchase
- 5 paid tickets per user per Thai day
- Gold Ticket gives free 3-digit ticket if department has no Incident for 30 days
- Admin sets/confirms/processes results
- Cron can fetch Thai lottery results and parse via Gemini
- Winners receive points, in-app notification, and LINE Push

See `SAFETY_LOTTERY_DEV.md` for deep details.

## Image Upload

Frontend:

- Client resizes images before upload
- Upload uses `FormData`
- Include `lineUserId`

Backend:

- `multer` receives image
- Uploads to Cloudflare R2
- Public URL is built from `R2_PUBLIC_BASE_URL`

## Notifications

Notifications are stored in `notifications`.

Common types include:

- `approved`
- `rejected`
- `like`
- `comment`
- `badge`
- `exchange`
- `game_quiz`
- `lottery_win`
- `lottery_gold`
- `system_alert`

LINE Push is used for selected flows and should not block the main transaction.

## Migrations

Fresh install:

```sql
schema.sql
```

Production patch:

```sql
migration.sql
```

Safety Lottery:

```sql
migration-lottery.sql
```

Important:

- Do not run `schema.sql` on production with data unless intentionally rebuilding
- Prefer additive migrations
- Several backend startup migrations intentionally ignore duplicate-column/table errors

## Deployment Notes

Backend Render:

- Set all env vars in Render dashboard
- Start command: `npm start`
- Make sure database allows Render access

Frontend GitHub Pages:

- Static files only
- `app.js` points production API to Render when hostname is not localhost/127.0.0.1

LINE LIFF:

- LIFF endpoint must match deployed frontend URL
- Localhost LIFF testing may require LINE console configuration

## Safety Lottery Smoke Test

1. Start backend with `.env`
2. Serve frontend on `127.0.0.1:5500`
3. Open browser DevTools Network tab
4. Open Safety Lottery
5. Confirm APIs hit `http://localhost:3000`
6. Buy a paid ticket after answering quiz
7. Confirm ticket appears in "ตั๋วของฉัน"
8. Claim Gold Ticket if eligible
9. Use Admin Safety Lottery modal to set, confirm, and process results

## Common Problems

`TypeError: Invalid URL` or missing `DATABASE_URL`:

- `.env` is missing or does not contain valid `DATABASE_URL`

CORS blocked locally:

- Serve frontend on `http://127.0.0.1:5500` or `http://localhost:5500`
- Those origins are allowed in `server.js`

Frontend still calls Render:

- Check browser URL. Local API is used only when hostname is `localhost` or `127.0.0.1`

Upload fails:

- Check R2 env vars
- Check bucket public URL

AI generation fails:

- Check `GEMINI_API_KEY`
- Check model/API quota

LINE Push fails:

- Check `LINE_CHANNEL_ACCESS_TOKEN`
- User must be reachable by the LINE bot
- Push failures are logged but should not block prize payout

## Coding Guidelines

- Keep changes scoped
- Use existing helpers: `callApi`, `syncCoins`, `showToast`, `Swal.fire`, `sanitizeHTML`, `logAdminAction`
- Use `db.getClient()` for transactions
- Use `uuidv4()` for generated IDs
- Do not use jQuery Bootstrap 4 modal syntax; use Bootstrap 5 modal API
- Keep admin actions audited with `logAdminAction`
- Prefer additive SQL changes for production data

## Current Working Notes

- `.env` is ignored by git and should never be committed
- `migration-lottery.sql` is intentionally separate from older migrations
- `SAFETY_LOTTERY_DEV.md` is the source of truth for Lottery-specific local testing and feature behavior

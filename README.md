# TeleDrive

> Lightweight browser-based cloud storage using Telegram Bot API as storage + Cloudflare Workers as backend.

---

## Architecture

```
Browser (SPA)
  ├── app.js        — state, API client, auth, events
  ├── ui.js         — all DOM rendering, modals, context menus, drag-drop
  ├── uploader.js   — client-side chunking, SHA-256, sequential upload
  └── downloader.js — parallel chunk download, integrity verify, Blob merge

Cloudflare Worker
  └── worker.js     — auth, metadata, Telegram forwarding, share links

Cloudflare D1
  └── schema.sql    — users, files, chunks, folders, shares, trash
```

---

## Setup

### 1. Telegram Bot + Channel

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → save your `BOT_TOKEN`
2. Create a **private channel** in Telegram
3. Add your bot as **admin** (with send messages permission)
4. Get the channel ID — forward any message from it to [@username_to_id_bot](https://t.me/username_to_id_bot)
   - It will be a negative number like `-100xxxxxxxxxx`

### 2. Cloudflare Setup

```bash
npm install -g wrangler
wrangler login
```

### 3. Create D1 database

```bash
wrangler d1 create teledrive
# Copy the database_id from the output
```

Apply schema:
```bash
wrangler d1 execute teledrive --file=./database/schema.sql
```

### 4. Configure `wrangler.toml`

Create `/wrangler.toml` in the project root:

```toml
name = "teledrive-worker"
main = "worker/worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "teledrive"
database_id = "<YOUR_D1_DATABASE_ID>"
```

### 5. Set secrets

```bash
wrangler secret put BOT_TOKEN
wrangler secret put CHANNEL_ID
wrangler secret put JWT_SECRET        # any random 32+ char string
wrangler secret put GOOGLE_CLIENT_ID  # optional, for Google Sign-In
```

Generate a good JWT secret:
```bash
openssl rand -base64 32
```

### 6. Deploy Worker

```bash
wrangler deploy
```

Your worker URL will look like: `https://teledrive-worker.YOUR_SUBDOMAIN.workers.dev`

### 7. Configure Frontend

Edit `frontend/index.html` and add before `</head>`:
```html
<script>
  window.TELEDRIVE_WORKER_URL = 'https://teledrive-worker.YOUR_SUBDOMAIN.workers.dev';
  window.GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com'; // optional
</script>
```

### 8. Deploy Frontend

**Option A — Cloudflare Pages (recommended):**
```bash
wrangler pages deploy frontend --project-name teledrive
```

**Option B — Any static host:**
Upload the `frontend/` folder to Netlify, Vercel, GitHub Pages, etc.

**Option C — Local dev:**
```bash
cd frontend
python3 -m http.server 8080
```

---

## File Structure

```
TeleDrive/
├── frontend/
│   ├── index.html      — app shell + all styles
│   ├── app.js          — state, API, auth, events
│   ├── ui.js           — all rendering + UI logic
│   ├── uploader.js     — chunked upload + resume
│   └── downloader.js   — parallel download + merge
├── worker/
│   └── worker.js       — Cloudflare Worker (all endpoints)
├── database/
│   └── schema.sql      — D1 tables
└── wrangler.toml       — (you create this)
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Email/password register |
| POST | `/auth/login` | — | Email/password login |
| POST | `/auth/google` | — | Google OAuth login |
| GET | `/auth/me` | ✓ | Get current user |
| GET | `/files` | ✓ | List files + folders |
| POST | `/upload-init` | ✓ | Start upload session |
| POST | `/upload-chunk` | ✓ | Upload single chunk |
| POST | `/upload-complete` | ✓ | Finalize upload |
| GET | `/download/:id` | ✓ | Get chunk download URLs |
| POST | `/rename` | ✓ | Rename file |
| POST | `/delete` | ✓ | Soft delete → trash |
| POST | `/move` | ✓ | Move file to folder |
| POST | `/restore` | ✓ | Restore from trash |
| POST | `/delete-permanent` | ✓ | Permanently delete |
| GET | `/folders` | ✓ | List all folders |
| POST | `/folder/create` | ✓ | Create folder |
| POST | `/folder/rename` | ✓ | Rename folder |
| POST | `/folder/delete` | ✓ | Delete folder |
| POST | `/share` | ✓ | Generate share link |
| DELETE | `/share/:id` | ✓ | Remove share link |
| GET | `/s/:id` | — | Resolve public share |
| GET | `/search` | ✓ | Search by name/mime |
| GET | `/trash` | ✓ | List trash |
| GET | `/storage` | ✓ | Storage usage |

---

## How It Works

### Upload Flow
1. Browser reads file → splits into **8 MB chunks**
2. Browser computes **SHA-256** checksum of each chunk + full file
3. Worker receives each chunk, **forwards to Telegram** via `sendDocument`
4. Telegram returns `message_id` + `file_id` — stored in D1
5. After all chunks, worker marks file as `upload_complete`

### Download Flow
1. Client requests `/download/:id`
2. Worker looks up all chunks → calls Telegram `getFile` to get fresh URLs
3. Client downloads **4 chunks in parallel**
4. Each chunk verified against stored SHA-256
5. All chunks merged with `Blob()` → triggered as browser download

### Resume
- Upload session stored in `localStorage` with chunk progress
- If upload fails, the same file can be re-queued → already-uploaded chunks are skipped

### Sharing
- Generates a random 12-char `share_id` stored in `files.share_id`
- Public URL: `https://yourdomain.com/s/<share_id>`
- No auth required, no expiry
- Share page is rendered by the same SPA when path matches `/s/:id`

### Security
- All file/folder endpoints verify ownership via JWT `sub` → `owner_id`
- Worker **never trusts** client metadata
- Chunks are only accessible via Telegram bot token (private channel)
- Rate limiting: 600 chunk uploads per hour per user

---

## Customization

### Change chunk size
In `frontend/app.js`:
```js
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB (Telegram max is ~50 MB)
```

### Change storage quota
Default is 10 GB per user. Change in `database/schema.sql`:
```sql
storage_quota INTEGER NOT NULL DEFAULT 10737418240, -- bytes
```

### Change trash retention
Default 30 days. Change in `database/schema.sql`:
```sql
purge_at INTEGER NOT NULL DEFAULT (unixepoch() + 2592000) -- seconds
```

Add a Cron trigger to auto-purge:
```toml
# wrangler.toml
[triggers]
crons = ["0 3 * * *"]
```
Then add a `scheduled` handler in `worker.js` to delete expired trash entries.

---

## Limitations

- **Telegram file size**: Individual chunks max ~50 MB. TeleDrive uses 8 MB for safety.
- **Telegram rate limits**: ~30 messages/second per bot. The 600/hour upload limit helps.
- **No server-side file processing**: All merging happens in the browser.
- **Share links don't expire** (by design per PRD). Add a `expires_at` field to `shares` table to change this.
- **Telegram files are permanent**: Deleting from TeleDrive doesn't delete Telegram messages (Telegram doesn't allow bots to delete old messages easily).

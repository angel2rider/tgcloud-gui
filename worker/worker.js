/**
 * TeleDrive — Cloudflare Worker
 *
 * Environment variables (set via wrangler.toml secrets):
 *   BOT_TOKEN      — Telegram bot token
 *   CHANNEL_ID     — Telegram private channel id (negative number, e.g. -100xxxxxxxxxx)
 *   JWT_SECRET     — Random 32+ char secret for signing JWTs
 *   GOOGLE_CLIENT_ID — Google OAuth client id
 *
 * Bindings:
 *   DB             — Cloudflare D1 database
 */

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS & CACHE
// ─────────────────────────────────────────────────────────────────────────────

const FILE_URL_CACHE = new Map(); // fileId -> { url, expiry }
const CACHE_TTL = 3000 * 1000;    // 50 minutes (Telegram URLs usually last 1hr)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });

const err = (msg, status = 400) => json({ error: msg }, status);

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-File-Id,X-Session-Id,X-Chunk-Index,X-Checksum',
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT  (HS256 using Web Crypto)
// ─────────────────────────────────────────────────────────────────────────────

async function importKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signJWT(payload, secret, expiresInSec = 86400 * 7) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '');
  const body = btoa(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec, iat: Math.floor(Date.now() / 1000) })).replace(/=+$/, '');
  const msg = `${header}.${body}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${msg}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [h, b, s] = token.split('.');
    if (!h || !b || !s) return null;
    const key = await importKey(secret);
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${h}.${b}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(b));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD  (PBKDF2 — no native bcrypt in Workers)
// ─────────────────────────────────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  const hashHex = [...new Uint8Array(derived)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  const candidate = [...new Uint8Array(derived)].map(b => b.toString(16).padStart(2, '0')).join('');
  return candidate === hashHex;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload?.sub) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
  return user || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER
// ─────────────────────────────────────────────────────────────────────────────

async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSec);
  const rk = `${key}:${window}`;
  try {
    const row = await env.DB.prepare(
      'INSERT INTO rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 RETURNING count'
    ).bind(rk, window).first();
    return (row?.count ?? 1) <= limit;
  } catch { return true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM
// ─────────────────────────────────────────────────────────────────────────────

async function tgSendDocument(env, formData) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: 'POST', body: formData,
  });
  if (!res.ok) throw new Error(`Telegram error: ${res.status}`);
  return res.json();
}

async function tgGetFileUrl(env, fileId) {
  const cached = FILE_URL_CACHE.get(fileId);
  if (cached && cached.expiry > Date.now()) return cached.url;

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error('getFile failed');
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${data.result.file_path}`;
  
  FILE_URL_CACHE.set(fileId, { url, expiry: Date.now() + CACHE_TTL });
  // Periodic cleanup
  if (FILE_URL_CACHE.size > 1000) {
    const now = Date.now();
    for (const [k, v] of FILE_URL_CACHE) if (v.expiry < now) FILE_URL_CACHE.delete(k);
  }
  
  return url;
}

async function tgDeleteMessage(env, messageId) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.CHANNEL_ID, message_id: messageId })
    });
  } catch (e) {
    console.error('Failed to delete message:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Auth ──────────────────────────────────────────────────────────────
      if (method === 'POST' && path === '/auth/register')  return handleRegister(request, env);
      if (method === 'POST' && path === '/auth/login')     return handleLogin(request, env);
      if (method === 'POST' && path === '/auth/google')    return handleGoogleLogin(request, env);
      if (method === 'GET'  && path === '/auth/me')        return handleMe(request, env);

      // ── Files ─────────────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/files')          return handleListFiles(request, env);
      if (method === 'GET'  && path.startsWith('/file/'))  return handleGetFile(request, env, path);
      if (method === 'POST' && path === '/upload-init')    return handleUploadInit(request, env);
      if (method === 'POST' && path === '/record-chunk')   return handleRecordChunk(request, env);
      if (method === 'POST' && path === '/upload-chunk')   return handleUploadChunk(request, env);
      if (method === 'POST' && path === '/upload-complete')return handleUploadComplete(request, env);
      if (method === 'GET'  && path.startsWith('/download/')) return handleDownload(request, env, path);
      if (method === 'POST' && path === '/rename')         return handleRename(request, env);
      if (method === 'POST' && path === '/delete')         return handleDelete(request, env);
      if (method === 'POST' && path === '/delete-bulk')    return handleBulkDelete(request, env);
      if (method === 'POST' && path === '/move')           return handleMove(request, env);
      if (method === 'POST' && path === '/restore')        return handleRestore(request, env);
      if (method === 'POST' && path === '/delete-permanent') return handleDeletePermanent(request, env);
      if (method === 'POST' && path === '/delete-permanent-bulk') return handleBulkDeletePermanent(request, env);

      // ── Folders ───────────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/folders')        return handleListFolders(request, env);
      if (method === 'POST' && path === '/folder/create')  return handleCreateFolder(request, env);
      if (method === 'POST' && path === '/folder/rename')  return handleRenameFolder(request, env);
      if (method === 'POST' && path === '/folder/delete')  return handleDeleteFolder(request, env);

      // ── Proxy ─────────────────────────────────────────────────────────────
      if (method === 'GET'  && path.startsWith('/proxy/')) return handleProxy(request, env, path);

      // ── Search ────────────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/search')         return handleSearch(request, env);

      // ── Trash ─────────────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/trash')          return handleListTrash(request, env);

      // ── Storage info ──────────────────────────────────────────────────────
      if (method === 'GET'  && path === '/storage')        return handleStorage(request, env);

      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err('Internal server error', 500);
    }
  },

  async scheduled(event, env, ctx) {
    const now = Math.floor(Date.now() / 1000);
    // Clean up expired trash
    const expiredTrash = await env.DB.prepare(
      'SELECT t.file_id, f.size, f.owner_id FROM trash t JOIN files f ON t.file_id = f.id WHERE t.purge_at <= ?'
    ).bind(now).all();
    for (const item of (expiredTrash.results || [])) {
      const chunks = await env.DB.prepare('SELECT telegram_message_id FROM chunks WHERE file_id=?').bind(item.file_id).all();
      for (const chunk of (chunks.results || [])) {
        if (chunk.telegram_message_id) await tgDeleteMessage(env, chunk.telegram_message_id);
      }
      await env.DB.prepare('DELETE FROM files WHERE id=?').bind(item.file_id).run();
      await env.DB.prepare('UPDATE users SET storage_used=MAX(0,storage_used-?) WHERE id=?').bind(item.size, item.owner_id).run();
    }

    // Clean up expired upload sessions
    const expiredSessions = await env.DB.prepare(
      'SELECT id, file_id FROM upload_sessions WHERE expires_at <= ?'
    ).bind(now).all();
    for (const session of (expiredSessions.results || [])) {
      const chunks = await env.DB.prepare('SELECT telegram_message_id FROM chunks WHERE file_id=?').bind(session.file_id).all();
      for (const chunk of (chunks.results || [])) {
        if (chunk.telegram_message_id) await tgDeleteMessage(env, chunk.telegram_message_id);
      }
      await env.DB.prepare('DELETE FROM files WHERE id=?').bind(session.file_id).run();
      await env.DB.prepare('DELETE FROM upload_sessions WHERE id=?').bind(session.id).run();
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleRegister(request, env) {
  const { email, password, display_name } = await request.json();
  if (!email || !password) return err('Email and password required');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return err('Email already registered', 409);

  const password_hash = await hashPassword(password);
  const user = await env.DB.prepare(
    'INSERT INTO users(email,password_hash,display_name) VALUES(?,?,?) RETURNING id,email,display_name,storage_used,storage_quota,created_at'
  ).bind(email, password_hash, display_name || email.split('@')[0]).first();

  const token = await signJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);
  return json({ token, user });
}

async function handleLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return err('Email and password required');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !user.password_hash) return err('Invalid credentials', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return err('Invalid credentials', 401);

  await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000), user.id).run();
  const token = await signJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);
  const { password_hash, ...safeUser } = user;
  return json({ token, user: safeUser });
}

async function handleGoogleLogin(request, env) {
  const { credential } = await request.json();
  if (!credential) return err('Google credential required');

  // Verify Google ID token
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
  if (!res.ok) return err('Invalid Google token', 401);
  const gData = await res.json();
  if (gData.aud !== env.GOOGLE_CLIENT_ID) return err('Token audience mismatch', 401);

  const { sub: google_id, email, name, picture } = gData;

  let user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ? OR email = ?').bind(google_id, email).first();
  if (user) {
    user = await env.DB.prepare('UPDATE users SET google_id=?, display_name=?, avatar_url=?, last_login=? WHERE id=? RETURNING id,email,display_name,avatar_url,storage_used,storage_quota,created_at')
      .bind(google_id, name || user.display_name, picture || user.avatar_url, Math.floor(Date.now() / 1000), user.id).first();
  } else {
    user = await env.DB.prepare(
      'INSERT INTO users(email,google_id,display_name,avatar_url) VALUES(?,?,?,?) RETURNING id,email,display_name,avatar_url,storage_used,storage_quota,created_at'
    ).bind(email, google_id, name, picture).first();
  }

  const token = await signJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);
  const { password_hash, ...safeUser } = user;
  return json({ token, user: safeUser });
}

async function handleMe(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { password_hash, ...safeUser } = user;
  return json({ user: safeUser });
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleListFiles(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const folder_id = url.searchParams.get('folder_id') || null;
  const sort = url.searchParams.get('sort') || 'created_at';
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const validSorts = { name: 'name', size: 'size', created_at: 'created_at' };
  const sortCol = validSorts[sort] || 'created_at';

  const files = await env.DB.prepare(
    `SELECT id,name,mime_type,size,folder_id,upload_complete,created_at,updated_at
     FROM files WHERE owner_id=? AND is_deleted=0 AND folder_id IS ? AND upload_complete=1
     ORDER BY ${sortCol} ${dir}`
  ).bind(user.id, folder_id).all();

  const folders = await env.DB.prepare(
    `SELECT id,name,parent_id,created_at FROM folders WHERE owner_id=? AND parent_id IS ?
     ORDER BY name ASC`
  ).bind(user.id, folder_id).all();

  return json({ files: files.results, folders: folders.results });
}

async function handleGetFile(request, env, path) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const fileId = path.split('/').pop();
  const file = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=? AND is_deleted=0').bind(fileId, user.id).first();
  if (!file) return err('File not found', 404);
  const chunks = await env.DB.prepare(
    'SELECT chunk_index,telegram_message_id,telegram_file_id,chunk_size,checksum FROM chunks WHERE file_id=? ORDER BY chunk_index ASC'
  ).bind(fileId).all();
  return json({ file, chunks: chunks.results });
}

async function handleUploadInit(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { name, mime_type, size, total_chunks, folder_id, checksum } = await request.json();
  if (!name || size == null || total_chunks == null) return err('name, size, total_chunks required');

  // Quota check
  if (user.storage_used + size > user.storage_quota) return err('Storage quota exceeded', 403);

  const file = await env.DB.prepare(
    'INSERT INTO files(owner_id,name,mime_type,size,folder_id,checksum) VALUES(?,?,?,?,?,?) RETURNING id'
  ).bind(user.id, name, mime_type || 'application/octet-stream', size, folder_id || null, checksum || null).first();

  const sessionId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2,'0')).join('');
  await env.DB.prepare(
    'INSERT INTO upload_sessions(id,file_id,owner_id,total_chunks) VALUES(?,?,?,?)'
  ).bind(sessionId, file.id, user.id, total_chunks).run();

  return json({ 
    file_id: file.id, 
    session_id: sessionId,
    config: {
      bot_token: env.BOT_TOKEN,
      channel_id: env.CHANNEL_ID
    }
  });
}

async function handleRecordChunk(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);

  const { file_id, session_id, chunk_index, tg_message_id, tg_file_id, chunk_size, checksum } = await request.json();

  if (!file_id || isNaN(chunk_index) || !tg_message_id) return err('Missing metadata');

  // Verify ownership
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=? AND file_id=? AND owner_id=?')
    .bind(session_id, file_id, user.id).first();
  if (!session) return err('Invalid session', 403);

  // Record chunk
  await env.DB.prepare(
    'INSERT OR REPLACE INTO chunks(file_id,chunk_index,telegram_message_id,telegram_file_id,chunk_size,checksum) VALUES(?,?,?,?,?,?)'
  ).bind(file_id, chunk_index, tg_message_id, tg_file_id || '', chunk_size, checksum || '').run();

  return json({ ok: true });
}

async function handleUploadChunk(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);

  if (!await rateLimit(env, `upload:${user.id}`, 2000, 3600)) return err('Rate limit exceeded', 429);

  // Read metadata from headers (more efficient for Workers than FormData parsing)
  const file_id = request.headers.get('X-File-Id');
  const session_id = request.headers.get('X-Session-Id');
  const chunk_index = parseInt(request.headers.get('X-Chunk-Index'), 10);
  const checksum = request.headers.get('X-Checksum');

  if (!file_id || isNaN(chunk_index)) return err('X-File-Id, X-Chunk-Index headers required');

  // Verify ownership
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=? AND file_id=? AND owner_id=?')
    .bind(session_id, file_id, user.id).first();
  if (!session) return err('Invalid session', 403);

  // Get raw chunk body
  const chunk = await request.blob();
  if (!chunk.size) return err('Empty chunk');

  // Forward chunk to Telegram (must use FormData for TG API)
  const tgForm = new FormData();
  tgForm.append('chat_id', env.CHANNEL_ID);
  tgForm.append('caption', `td:${file_id}:${chunk_index}`);
  tgForm.append('document', chunk, `chunk_${file_id}_${chunk_index}`);

  const tgResult = await tgSendDocument(env, tgForm);
  if (!tgResult.ok) return err('Telegram upload failed', 502);

  const msg = tgResult.result;
  const tgFileId = msg.document?.file_id || msg.video?.file_id || msg.audio?.file_id || '';

  // Record chunk
  await env.DB.prepare(
    'INSERT OR REPLACE INTO chunks(file_id,chunk_index,telegram_message_id,telegram_file_id,chunk_size,checksum) VALUES(?,?,?,?,?,?)'
  ).bind(file_id, chunk_index, msg.message_id, tgFileId, chunk.size, checksum || '').run();

  return json({ message_id: msg.message_id, file_id: tgFileId, chunk_index });
}

async function handleUploadComplete(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_id, session_id } = await request.json();
  if (!file_id || !session_id) return err('file_id and session_id required');

  const session = await env.DB.prepare('SELECT total_chunks FROM upload_sessions WHERE id=? AND file_id=? AND owner_id=?')
    .bind(session_id, file_id, user.id).first();
  if (!session) return err('Invalid session', 403);

  // Retry logic for D1 eventual consistency: check if all chunks are present, retry a few times if not.
  let uploadedCount = 0;
  for (let i = 0; i < 5; i++) {
    const row = await env.DB.prepare('SELECT COUNT(*) as count FROM chunks WHERE file_id=?').bind(file_id).first();
    uploadedCount = row?.count || 0;
    if (uploadedCount >= session.total_chunks) break;
    // Wait slightly longer each time (500ms, 1000ms, 1500ms...)
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }

  if (uploadedCount < session.total_chunks) {
    return err(`Incomplete: ${uploadedCount}/${session.total_chunks} chunks`);
  }

  const file = await env.DB.prepare('SELECT size FROM files WHERE id=?').bind(file_id).first();
  if (!file) return err('File metadata missing', 500);

  await env.DB.prepare('UPDATE files SET upload_complete=1,updated_at=? WHERE id=?')
    .bind(Math.floor(Date.now() / 1000), file_id).run();
  
  await env.DB.prepare('UPDATE users SET storage_used=storage_used + ? WHERE id=?').bind(file.size || 0, user.id).run();
  await env.DB.prepare('DELETE FROM upload_sessions WHERE id=?').bind(session_id).run();

  return json({ success: true, file_id });
}

async function handleDownload(request, env, path) {
  // Return chunk locations for client-side download assembly
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);

  const fileId = path.split('/').pop();
  const file = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=? AND is_deleted=0 AND upload_complete=1')
    .bind(fileId, user.id).first();
  if (!file) return err('File not found', 404);

  const chunks = await env.DB.prepare(
    'SELECT chunk_index, telegram_file_id, chunk_size, checksum FROM chunks WHERE file_id=? ORDER BY chunk_index ASC'
  ).bind(fileId).all();

  // Resolve Telegram download URLs for each chunk
  const chunkUrls = chunks.results.map(c => ({
    index: c.chunk_index,
    url: `/proxy/${c.telegram_file_id}`,
    size: c.chunk_size,
    checksum: c.checksum
  }));

  return json({ file, chunks: chunkUrls });
}

async function handleRename(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_id, name } = await request.json();
  if (!file_id || !name) return err('file_id and name required');
  const result = await env.DB.prepare('UPDATE files SET name=?,updated_at=? WHERE id=? AND owner_id=? AND is_deleted=0')
    .bind(name, Math.floor(Date.now() / 1000), file_id, user.id).run();
  if (!result.meta.changes) return err('File not found', 404);
  return json({ success: true });
}

async function handleDelete(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_id } = await request.json();
  const file = await env.DB.prepare('SELECT id FROM files WHERE id=? AND owner_id=? AND is_deleted=0').bind(file_id, user.id).first();
  if (!file) return err('File not found', 404);
  await env.DB.prepare('UPDATE files SET is_deleted=1,updated_at=? WHERE id=?').bind(Math.floor(Date.now() / 1000), file_id).run();
  await env.DB.prepare('INSERT OR IGNORE INTO trash(file_id) VALUES(?)').bind(file_id).run();
  return json({ success: true });
}

async function handleBulkDelete(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_ids } = await request.json();
  if (!Array.isArray(file_ids) || !file_ids.length) return err('file_ids required');

  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  for (const id of file_ids) {
    statements.push(env.DB.prepare('UPDATE files SET is_deleted=1,updated_at=? WHERE id=? AND owner_id=? AND is_deleted=0').bind(now, id, user.id));
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO trash(file_id) VALUES(?)').bind(id));
  }
  await env.DB.batch(statements);
  return json({ success: true });
}

async function handleMove(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_id, folder_id } = await request.json();
  // Verify target folder ownership
  if (folder_id) {
    const folder = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND owner_id=?').bind(folder_id, user.id).first();
    if (!folder) return err('Folder not found', 404);
  }
  await env.DB.prepare('UPDATE files SET folder_id=?,updated_at=? WHERE id=? AND owner_id=? AND is_deleted=0')
    .bind(folder_id || null, Math.floor(Date.now() / 1000), file_id, user.id).run();
  return json({ success: true });
}

async function handleRestore(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_id } = await request.json();
  const file = await env.DB.prepare('SELECT id FROM files WHERE id=? AND owner_id=? AND is_deleted=1').bind(file_id, user.id).first();
  if (!file) return err('File not found in trash', 404);
  await env.DB.prepare('UPDATE files SET is_deleted=0,updated_at=? WHERE id=?').bind(Math.floor(Date.now() / 1000), file_id).run();
  await env.DB.prepare('DELETE FROM trash WHERE file_id=?').bind(file_id).run();
  return json({ success: true });
}

async function handleDeletePermanent(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_id } = await request.json();
  const file = await env.DB.prepare('SELECT id,size FROM files WHERE id=? AND owner_id=?').bind(file_id, user.id).first();
  if (!file) return err('File not found', 404);
  
  // Telegram messages deletion
  const chunks = await env.DB.prepare('SELECT telegram_message_id FROM chunks WHERE file_id=?').bind(file_id).all();
  const deletePromises = (chunks.results || []).map(chunk => 
    chunk.telegram_message_id ? tgDeleteMessage(env, chunk.telegram_message_id) : Promise.resolve()
  );
  await Promise.all(deletePromises);

  await env.DB.prepare('DELETE FROM files WHERE id=?').bind(file_id).run();
  await env.DB.prepare('UPDATE users SET storage_used=MAX(0,storage_used-?) WHERE id=?').bind(file.size, user.id).run();
  return json({ success: true });
}

async function handleBulkDeletePermanent(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { file_ids } = await request.json();
  if (!Array.isArray(file_ids) || !file_ids.length) return err('file_ids required');

  const files = await env.DB.prepare(`SELECT id, size FROM files WHERE owner_id=? AND id IN (${file_ids.map(() => '?').join(',')})`)
    .bind(user.id, ...file_ids).all();
  
  if (!files.results || !files.results.length) return json({ success: true });

  const foundIds = files.results.map(f => f.id);
  const totalSize = files.results.reduce((acc, f) => acc + f.size, 0);

  // Get all chunks for all files
  const chunks = await env.DB.prepare(`SELECT telegram_message_id FROM chunks WHERE file_id IN (${foundIds.map(() => '?').join(',')})`)
    .bind(...foundIds).all();
  
  // Parallel deletion from Telegram
  const deletePromises = (chunks.results || []).map(chunk => 
    chunk.telegram_message_id ? tgDeleteMessage(env, chunk.telegram_message_id) : Promise.resolve()
  );
  await Promise.all(deletePromises);

  // Batch delete from database
  const statements = [
    env.DB.prepare(`DELETE FROM files WHERE id IN (${foundIds.map(() => '?').join(',')})`).bind(...foundIds),
    env.DB.prepare('UPDATE users SET storage_used=MAX(0,storage_used-?) WHERE id=?').bind(totalSize, user.id)
  ];
  await env.DB.batch(statements);

  return json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// FOLDER HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleListFolders(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const folders = await env.DB.prepare('SELECT * FROM folders WHERE owner_id=? ORDER BY name ASC').bind(user.id).all();
  return json({ folders: folders.results });
}

async function handleCreateFolder(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { name, parent_id } = await request.json();
  if (!name) return err('name required');
  if (parent_id) {
    const parent = await env.DB.prepare('SELECT id FROM folders WHERE id=? AND owner_id=?').bind(parent_id, user.id).first();
    if (!parent) return err('Parent folder not found', 404);
  }
  try {
    const folder = await env.DB.prepare(
      'INSERT INTO folders(owner_id,name,parent_id) VALUES(?,?,?) RETURNING *'
    ).bind(user.id, name, parent_id || null).first();
    return json({ folder });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return err('Folder already exists', 409);
    throw e;
  }
}

async function handleRenameFolder(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { folder_id, name } = await request.json();
  const result = await env.DB.prepare('UPDATE folders SET name=? WHERE id=? AND owner_id=?').bind(name, folder_id, user.id).run();
  if (!result.meta.changes) return err('Folder not found', 404);
  return json({ success: true });
}

async function handleDeleteFolder(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const { folder_id } = await request.json();
  // Move all files in folder to root before deleting folder
  await env.DB.prepare('UPDATE files SET folder_id=NULL WHERE folder_id=? AND owner_id=?').bind(folder_id, user.id).run();
  await env.DB.prepare('DELETE FROM folders WHERE id=? AND owner_id=?').bind(folder_id, user.id).run();
  return json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROXY
// ─────────────────────────────────────────────────────────────────────────────

async function handleProxy(request, env, path) {
  const tgFileId = path.split('/').pop();
  try {
    const url = await tgGetFileUrl(env, tgFileId);
    const res = await fetch(url);
    const newHeaders = new Headers(res.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return new Response(res.body, {
      status: res.status,
      headers: newHeaders
    });
  } catch (e) {
    return err('Proxy error: ' + e.message, 502);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────────────────────

async function handleSearch(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const mime = url.searchParams.get('mime') || '';
  if (!q && !mime) return json({ files: [] });

  let query = 'SELECT id,name,mime_type,size,folder_id,created_at FROM files WHERE owner_id=? AND is_deleted=0 AND upload_complete=1';
  const binds = [user.id];
  if (q) { query += ' AND name LIKE ?'; binds.push(`%${q}%`); }
  if (mime) { query += ' AND mime_type LIKE ?'; binds.push(`${mime}%`); }
  query += ' LIMIT 50';

  const files = await env.DB.prepare(query).bind(...binds).all();
  return json({ files: files.results });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRASH
// ─────────────────────────────────────────────────────────────────────────────

async function handleListTrash(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  const files = await env.DB.prepare(
    `SELECT f.id,f.name,f.mime_type,f.size,t.deleted_at,t.purge_at
     FROM files f JOIN trash t ON f.id=t.file_id WHERE f.owner_id=? ORDER BY t.deleted_at DESC`
  ).bind(user.id).all();
  return json({ files: files.results });
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE INFO
// ─────────────────────────────────────────────────────────────────────────────

async function handleStorage(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);
  return json({ used: user.storage_used, quota: user.storage_quota });
}

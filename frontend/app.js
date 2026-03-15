/**
 * TeleDrive — app.js
 * Core state, API client, router
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — change WORKER_URL to your deployed worker URL
// ─────────────────────────────────────────────────────────────────────────────
let WORKER_URL = localStorage.getItem('worker_url') || window.TELEDRIVE_WORKER_URL || 'https://your-worker.workers.dev';
const CHUNK_SIZE = 20 * 1024 * 1024; // 10 MB (Safer for Free Workers)

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
export const state = {
  user: null,
  token: localStorage.getItem('td_token'),
  currentFolder: null,   // null = root
  folderPath: [],        // [{id, name}] breadcrumb trail
  files: [],
  folders: [],
  trashFiles: [],
  view: 'files',         // 'files' | 'trash' | 'settings'
  sort: { by: 'created_at', dir: 'desc' },
  layout: localStorage.getItem('td_layout') || 'grid',
  concurrency: parseInt(localStorage.getItem('td_concurrency')) || 3,
  tgApiUrl: localStorage.getItem('td_tg_api_url') || 'https://api.telegram.org',
  uploads: [],           // active upload jobs
  selection: new Set(),
  searchResults: null,   // null = not searching
};

// ─────────────────────────────────────────────────────────────────────────────
// FETCH WITH RETRY (Exponential Backoff)
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchWithRetry(url, options = {}, retries = 5) {
  let delay = 1000;
  const fetchOptions = {
    mode: 'cors',
    ...options
  };
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, fetchOptions);
      // Retry on 5xx or rate limit 429
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`Server error ${res.status}`);
      }
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Fetch failed (retry ${i + 1}/${retries}): ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT BUS
// ─────────────────────────────────────────────────────────────────────────────
const listeners = {};
export function on(event, fn) {
  (listeners[event] = listeners[event] || []).push(fn);
}
export function emit(event, data) {
  (listeners[event] || []).forEach(fn => fn(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// API CLIENT
// ─────────────────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetchWithRetry(`${WORKER_URL}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiForm(path, formData) {
  const headers = {};
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetchWithRetry(`${WORKER_URL}${path}`, { method: 'POST', body: formData, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiRaw(path, body, customHeaders = {}) {
  const headers = { ...customHeaders };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetchWithRetry(`${WORKER_URL}${path}`, { method: 'POST', body, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  register: (email, password, display_name) => apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, display_name }) }),
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  googleLogin: (credential) => apiFetch('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }),
  me: () => apiFetch('/auth/me'),

  // Files
  listFiles: (folder_id, sort, dir) => apiFetch(`/files?folder_id=${folder_id || ''}&sort=${sort}&dir=${dir}`),
  getFile: (id) => apiFetch(`/file/${id}`),
  uploadInit: (data) => apiFetch('/upload-init', { method: 'POST', body: JSON.stringify(data) }),
  uploadComplete: (data) => apiFetch('/upload-complete', { method: 'POST', body: JSON.stringify(data) }),
  download: (id) => apiFetch(`/download/${id}`),
  rename: (file_id, name) => apiFetch('/rename', { method: 'POST', body: JSON.stringify({ file_id, name }) }),
  deleteFile: (file_id) => apiFetch('/delete', { method: 'POST', body: JSON.stringify({ file_id }) }),
  bulkDelete: (file_ids) => apiFetch('/delete-bulk', { method: 'POST', body: JSON.stringify({ file_ids }) }),
  moveFile: (file_id, folder_id) => apiFetch('/move', { method: 'POST', body: JSON.stringify({ file_id, folder_id }) }),
  restore: (file_id) => apiFetch('/restore', { method: 'POST', body: JSON.stringify({ file_id }) }),
  deletePermanent: (file_id) => apiFetch('/delete-permanent', { method: 'POST', body: JSON.stringify({ file_id }) }),
  bulkDeletePermanent: (file_ids) => apiFetch('/delete-permanent-bulk', { method: 'POST', body: JSON.stringify({ file_ids }) }),

  // Folders
  listFolders: () => apiFetch('/folders'),
  createFolder: (name, parent_id) => apiFetch('/folder/create', { method: 'POST', body: JSON.stringify({ name, parent_id }) }),
  renameFolder: (folder_id, name) => apiFetch('/folder/rename', { method: 'POST', body: JSON.stringify({ folder_id, name }) }),
  deleteFolder: (folder_id) => apiFetch('/folder/delete', { method: 'POST', body: JSON.stringify({ folder_id }) }),

  // Search
  search: (q, mime) => apiFetch(`/search?q=${encodeURIComponent(q)}&mime=${encodeURIComponent(mime || '')}`),

  // Trash
  trash: () => apiFetch('/trash'),

  // Storage
  storage: () => apiFetch('/storage'),

  // Raw chunk upload
  uploadChunk: (body, headers) => apiRaw('/upload-chunk', body, headers),
  recordChunk: (data) => apiFetch('/record-chunk', { method: 'POST', body: JSON.stringify(data) }),
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
export async function login(email, password) {
  const { token, user } = await api.login(email, password);
  setSession(token, user);
}

export async function register(email, password, display_name) {
  const { token, user } = await api.register(email, password, display_name);
  setSession(token, user);
}

export async function googleLogin(credential) {
  const { token, user } = await api.googleLogin(credential);
  setSession(token, user);
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('td_token', token);
  emit('auth:login', user);
}

export function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('td_token');
  emit('auth:logout');
}

export async function restoreSession() {
  if (!state.token) return false;
  try {
    const { user } = await api.me();
    state.user = user;
    emit('auth:login', user);
    return true;
  } catch {
    logout();
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE SYSTEM ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
export async function loadFiles() {
  const { files, folders } = await api.listFiles(state.currentFolder, state.sort.by, state.sort.dir);
  state.files = files;
  state.folders = folders;
  state.selection.clear();
  emit('files:loaded', { files, folders });
}

export async function loadTrash() {
  const { files } = await api.trash();
  state.trashFiles = files;
  emit('trash:loaded', files);
}

export async function navigateToFolder(folderId, folderName) {
  if (folderId === null) {
    state.currentFolder = null;
    state.folderPath = [];
  } else {
    const existingIdx = state.folderPath.findIndex(f => f.id === folderId);
    if (existingIdx >= 0) {
      state.folderPath = state.folderPath.slice(0, existingIdx + 1);
    } else {
      state.folderPath.push({ id: folderId, name: folderName });
    }
    state.currentFolder = folderId;
  }
  await loadFiles();
  emit('nav:folder', state.folderPath);
}

export async function createFolder(name) {
  const { folder } = await api.createFolder(name, state.currentFolder);
  state.folders.unshift(folder);
  emit('files:loaded', { files: state.files, folders: state.folders });
  return folder;
}

export async function deleteFile(fileId) {
  await api.deleteFile(fileId);
  state.files = state.files.filter(f => f.id !== fileId);
  emit('files:loaded', { files: state.files, folders: state.folders });
}

export async function bulkDeleteFiles(fileIds) {
  if (!fileIds.length) return;
  await api.bulkDelete(fileIds);
  state.files = state.files.filter(f => !fileIds.includes(f.id));
  state.selection.clear();
  emit('selection:change', state.selection);
  emit('files:loaded', { files: state.files, folders: state.folders });
}

export async function bulkDeletePermanentFiles(fileIds) {
  if (!fileIds.length) return;
  await api.bulkDeletePermanent(fileIds);
  state.trashFiles = state.trashFiles.filter(f => !fileIds.includes(f.id));
  state.selection.clear();
  emit('selection:change', state.selection);
  emit('trash:loaded', state.trashFiles);
}

export async function renameFile(fileId, name) {
  await api.rename(fileId, name);
  const f = state.files.find(f => f.id === fileId);
  if (f) f.name = name;
  emit('files:loaded', { files: state.files, folders: state.folders });
}

export async function search(query, mime) {
  if (!query.trim()) {
    state.searchResults = null;
    emit('search:results', null);
    return;
  }
  const { files } = await api.search(query, mime);
  state.searchResults = files;
  emit('search:results', files);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT / SORT
// ─────────────────────────────────────────────────────────────────────────────
export function setLayout(layout) {
  state.layout = layout;
  localStorage.setItem('td_layout', layout);
  emit('layout:change', layout);
}

export function setSort(by, dir) {
  state.sort = { by, dir };
  loadFiles();
}

export function setWorkerUrl(url) {
  WORKER_URL = url;
  localStorage.setItem('worker_url', url);
  emit('settings:worker_url', url);
}

export function setTheme(theme) {
  localStorage.setItem('td_theme', theme);
  document.documentElement.dataset.theme = theme;
  emit('theme:change', theme);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION
// ─────────────────────────────────────────────────────────────────────────────
export function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  emit('selection:change', state.selection);
}

export function clearSelection() {
  state.selection.clear();
  emit('selection:change', state.selection);
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function getMimeIcon(mimeType) {
  if (!mimeType) return '<i data-lucide="file"></i>';
  if (mimeType.startsWith('image/')) return '<i data-lucide="image"></i>';
  if (mimeType.startsWith('video/')) return '<i data-lucide="film"></i>';
  if (mimeType.startsWith('audio/')) return '<i data-lucide="music"></i>';
  if (mimeType === 'application/pdf') return '<i data-lucide="file-text"></i>';
  if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed')) return '<i data-lucide="archive"></i>';
  if (mimeType.includes('word') || mimeType.includes('document')) return '<i data-lucide="file-edit"></i>';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '<i data-lucide="bar-chart"></i>';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '<i data-lucide="play-square"></i>';
  if (mimeType.startsWith('text/')) return '<i data-lucide="file-text"></i>';
  return '<i data-lucide="file"></i>';
}

export function getMimeColor(mimeType) {
  if (!mimeType) return '#64748b';
  if (mimeType.startsWith('image/')) return '#22d3ee';
  if (mimeType.startsWith('video/')) return '#a78bfa';
  if (mimeType.startsWith('audio/')) return '#34d399';
  if (mimeType === 'application/pdf') return '#f87171';
  if (mimeType.startsWith('text/')) return '#94a3b8';
  return '#60a5fa';
}

export function isPreviewable(file) {
  if (!file) return false;
  const { mime_type, size } = file;
  const MAX = 20 * 1024 * 1024; // 20 MB
  if (size > MAX) return false;
  return (
    mime_type.startsWith('image/') ||
    mime_type.startsWith('video/') ||
    mime_type.startsWith('audio/') ||
    mime_type === 'application/pdf' ||
    mime_type.startsWith('text/')
  );
}

export { CHUNK_SIZE, WORKER_URL };

/**
 * TeleDrive — ui.js
 * All DOM rendering: file grid/list, modals, context menus, drag-drop, previews.
 */

import * as App from './app.js';
import { queueFiles } from './uploader.js';
import { downloadFile, getPreviewURL } from './downloader.js';

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export function init() {
  bindEvents();
  wireDropZone();
  wireContextMenu();
  wireKeyboard();
  // Initialize Google if available, or wait for it
  if (window.google) {
    initGoogle();
  } else {
    // Check if document is already loaded
    if (document.readyState === 'complete') {
      // Script might still be loading async, poll every 500ms for up to 5s
      let retries = 0;
      const poll = setInterval(() => {
        if (window.google) {
          clearInterval(poll);
          initGoogle();
        } else if (retries++ > 10) {
          clearInterval(poll);
          console.warn('Google Identity Services script failed to load.');
        }
      }, 500);
    } else {
      window.addEventListener('load', initGoogle);
    }
  }
  // Initialize Lucide icons
  if (window.lucide) lucide.createIcons();
}

export function initGoogle() {
  const clientId = window.GOOGLE_CLIENT_ID || '';
  if (!clientId || !window.google) return;

  google.accounts.id.initialize({
    client_id: clientId,
    callback: async ({ credential }) => {
      try {
        await App.googleLogin(credential);
      } catch (err) {
        showAuthError(err.message);
      }
    }
  });

  const btn = document.getElementById('btn-google');
  if (btn) {
    google.accounts.id.renderButton(btn, {
      theme: 'outline',
      size: 'large',
      width: btn.offsetWidth || 340,
      text: 'continue_with',
      shape: 'rectangular',
    });
  }
}

function bindEvents() {
  App.on('auth:login', user => {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    renderUserInfo(user);
    loadStorage();
    App.loadFiles();
  });

  App.on('auth:logout', () => {
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('file-grid').innerHTML = '';
  });

  App.on('files:loaded', ({ files, folders }) => renderFileArea(files, folders));
  App.on('files:refresh', () => App.loadFiles());
  App.on('trash:loaded', files => renderTrash(files));
  App.on('nav:folder', path => renderBreadcrumbs(path));
  App.on('layout:change', () => renderFileArea(App.state.files, App.state.folders));
  App.on('selection:change', sel => renderSelectionBar(sel));
  App.on('search:results', results => {
    if (results !== null) renderSearchResults(results);
    else renderFileArea(App.state.files, App.state.folders);
  });
  App.on('upload:queued', job => addUploadRow(job));
  App.on('upload:progress', job => updateUploadRow(job));
  App.on('upload:done', job => finishUploadRow(job));
  App.on('upload:error', job => errorUploadRow(job));

  // Sidebar nav
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const view = el.dataset.nav;
      setActiveNav(view);
      App.state.view = view;
      if (view === 'files') {
        App.state.searchResults = null;
        App.loadFiles();
      } else if (view === 'trash') {
        App.loadTrash();
      }
    });
  });

  // Layout toggles
  document.getElementById('btn-grid')?.addEventListener('click', () => App.setLayout('grid'));
  document.getElementById('btn-list')?.addEventListener('click', () => App.setLayout('list'));

  // Upload button
  document.getElementById('btn-upload')?.addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('file-input')?.addEventListener('change', e => {
    if (e.target.files.length) {
      queueFiles(e.target.files, App.state.currentFolder);
      e.target.value = '';
    }
  });

  // New folder
  document.getElementById('btn-new-folder')?.addEventListener('click', showNewFolderModal);

  // Search
  const searchInput = document.getElementById('search-input');
  let searchTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => App.search(searchInput.value), 350);
  });

  // Sort controls
  document.getElementById('sort-select')?.addEventListener('change', e => {
    const [by, dir] = e.target.value.split(':');
    App.setSort(by, dir);
  });

  // Auth form
  document.getElementById('form-login')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-password').value;
    showAuthError('');
    try {
      await App.login(email, pass);
    } catch (err) { showAuthError(err.message); }
  });

  document.getElementById('form-register')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('reg-email').value;
    const pass = document.getElementById('reg-password').value;
    const name = document.getElementById('reg-name').value;
    showAuthError('');
    try {
      await App.register(email, pass, name);
    } catch (err) { showAuthError(err.message); }
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => App.logout());
  document.getElementById('btn-top-logout')?.addEventListener('click', () => {
    document.getElementById('profile-dropdown')?.classList.remove('open');
    App.logout();
  });

  // Profile Dropdown
  document.getElementById('btn-profile')?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('profile-dropdown')?.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.profile-wrap')) {
      document.getElementById('profile-dropdown')?.classList.remove('open');
    }
  });

  // Settings Modal
  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    document.getElementById('profile-dropdown')?.classList.remove('open');
    const modal = document.getElementById('modal-settings');
    document.getElementById('setting-worker-url').value = App.WORKER_URL;
    document.getElementById('setting-concurrency').value = App.state.concurrency;
    document.getElementById('setting-tg-api').value = App.state.tgApiUrl;
    document.getElementById('theme-select').value = localStorage.getItem('td_theme') || 'blue';
    modal.classList.remove('hidden');
  });

  // Theme Select immediate preview
  document.getElementById('theme-select')?.addEventListener('change', e => {
    App.setTheme(e.target.value);
  });

  document.getElementById('btn-save-settings')?.addEventListener('click', () => {
    const workerUrl = document.getElementById('setting-worker-url').value.trim();
    if (workerUrl) App.setWorkerUrl(workerUrl);
    
    const concurrency = parseInt(document.getElementById('setting-concurrency').value);
    if (!isNaN(concurrency) && concurrency >= 1) {
      App.state.concurrency = concurrency;
      localStorage.setItem('td_concurrency', concurrency);
    }

    const tgApi = document.getElementById('setting-tg-api').value.trim();
    if (tgApi) {
      App.state.tgApiUrl = tgApi;
      localStorage.setItem('td_tg_api_url', tgApi);
    }
    
    App.setTheme(document.getElementById('theme-select').value);
    closeModal();
    showToast('Settings saved', 'success');
  });

  // Add theme on launch
  const savedTheme = localStorage.getItem('td_theme') || 'blue';
  document.documentElement.dataset.theme = savedTheme;

  document.getElementById('tab-login')?.addEventListener('click', () => switchAuthTab('login'));
  document.getElementById('tab-register')?.addEventListener('click', () => switchAuthTab('register'));
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE AREA RENDERING
// ─────────────────────────────────────────────────────────────────────────────
function renderFileArea(files, folders) {
  const grid = document.getElementById('file-grid');
  if (!grid) return;
  const isGrid = App.state.layout === 'grid';
  grid.className = isGrid
    ? 'file-grid grid gap-3'
    : 'file-list flex flex-col gap-1';
  grid.innerHTML = '';

  // Empty state
  if (!files.length && !folders.length) {
    grid.innerHTML = `
      <div class="empty-state col-span-full">
        <div class="empty-icon"><i data-lucide="folder-open" size="48"></i></div>
        <p class="empty-text">Drop files here or click Upload</p>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  // Folders first
  folders.forEach(folder => grid.appendChild(renderFolderCard(folder, isGrid)));
  files.forEach(file => grid.appendChild(renderFileCard(file, isGrid)));
  if (window.lucide) lucide.createIcons();
}

function renderFolderCard(folder, isGrid) {
  const el = document.createElement('div');
  el.className = `file-card folder-card ${isGrid ? 'card-grid' : 'card-list'}`;
  el.dataset.id = folder.id;
  el.dataset.type = 'folder';
  el.innerHTML = isGrid ? `
    <div class="card-icon folder-icon"><i data-lucide="folder"></i></div>
    <div class="card-info">
      <div class="card-name">${esc(folder.name)}</div>
    </div>` : `
    <span class="card-icon-sm"><i data-lucide="folder" size="14"></i></span>
    <span class="card-name-list">${esc(folder.name)}</span>
    <span class="card-meta">—</span>
    <span class="card-meta">${App.formatDate(folder.created_at)}</span>`;

  el.addEventListener('dblclick', () => App.navigateToFolder(folder.id, folder.name));
  el.addEventListener('contextmenu', e => showContextMenu(e, { type: 'folder', data: folder }));
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop-target'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async e => {
    e.preventDefault();
    el.classList.remove('drop-target');
    const fileId = e.dataTransfer.getData('td-file-id');
    if (fileId) { await App.api.moveFile(fileId, folder.id); App.loadFiles(); }
  });
  return el;
}

function renderFileCard(file, isGrid) {
  const color = App.getMimeColor(file.mime_type);
  const icon = App.getMimeIcon(file.mime_type);
  const selected = App.state.selection.has(file.id);
  const el = document.createElement('div');
  el.className = `file-card ${isGrid ? 'card-grid' : 'card-list'} ${selected ? 'selected' : ''}`;
  el.dataset.id = file.id;
  el.dataset.type = 'file';
  el.draggable = true;

  if (isGrid) {
    el.innerHTML = `
      <div class="card-icon" style="color:${color}">${icon}</div>
      <div class="card-info">
        <div class="card-name" title="${esc(file.name)}">${esc(file.name)}</div>
        <div class="card-size">${App.formatBytes(file.size)}</div>
      </div>`;
  } else {
    el.innerHTML = `
      <span class="card-icon-sm" style="color:${color}">${icon}</span>
      <span class="card-name-list" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="card-meta">${App.formatBytes(file.size)}</span>
      <span class="card-meta">${App.formatDate(file.created_at)}</span>`;
  }

  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('td-file-id', file.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey) App.toggleSelect(file.id);
    else { App.clearSelection(); App.toggleSelect(file.id); }
  });
  el.addEventListener('dblclick', () => openPreview(file));
  el.addEventListener('contextmenu', e => showContextMenu(e, { type: 'file', data: file }));
  return el;
}

function renderSearchResults(files) {
  const grid = document.getElementById('file-grid');
  if (!grid) return;
  grid.className = 'file-list flex flex-col gap-1';
  grid.innerHTML = '';
  if (!files.length) {
    grid.innerHTML = '<div class="empty-state col-span-full"><p class="empty-text">No results found</p></div>';
    return;
  }
  files.forEach(file => grid.appendChild(renderFileCard(file, false)));
}

// ─────────────────────────────────────────────────────────────────────────────
// TRASH
// ─────────────────────────────────────────────────────────────────────────────
function renderTrash(files) {
  const grid = document.getElementById('file-grid');
  if (!grid) return;
  grid.className = 'file-list flex flex-col gap-1';
  grid.innerHTML = '';
  if (!files.length) {
    grid.innerHTML = '<div class="empty-state col-span-full"><div class="empty-icon">🗑</div><p class="empty-text">Trash is empty</p></div>';
    return;
  }
  files.forEach(file => {
    const el = document.createElement('div');
    el.className = 'file-card card-list trash-card';
    el.innerHTML = `
      <span class="card-icon-sm" style="color:${App.getMimeColor(file.mime_type)}">${App.getMimeIcon(file.mime_type)}</span>
      <span class="card-name-list">${esc(file.name)}</span>
      <span class="card-meta">${App.formatBytes(file.size)}</span>
      <span class="card-meta">Deleted ${App.formatDate(file.deleted_at)}</span>
      <div class="trash-actions">
        <button class="btn-icon" title="Restore" onclick="restoreFile('${file.id}')">↩</button>
        <button class="btn-icon danger" title="Delete Forever" onclick="deleteForever('${file.id}')">✕</button>
      </div>`;
    grid.appendChild(el);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BREADCRUMBS
// ─────────────────────────────────────────────────────────────────────────────
function renderBreadcrumbs(path) {
  const bc = document.getElementById('breadcrumbs');
  if (!bc) return;
  let html = `<span class="bc-item" data-folder-id="">Home</span>`;
  path.forEach((seg, i) => {
    html += ` <span class="bc-sep">/</span> <span class="bc-item" data-folder-id="${seg.id}" data-folder-name="${esc(seg.name)}">${esc(seg.name)}</span>`;
  });
  bc.innerHTML = html;
  bc.querySelectorAll('.bc-item').forEach(el => {
    el.addEventListener('click', () => {
      const fid = el.dataset.folderId || null;
      const fname = el.dataset.folderName || '';
      App.navigateToFolder(fid, fname);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION BAR
// ─────────────────────────────────────────────────────────────────────────────
function renderSelectionBar(selection) {
  const bar = document.getElementById('selection-bar');
  if (!bar) return;
  if (selection.size === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.querySelector('[data-sel-count]').textContent = `${selection.size} selected`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT MENU
// ─────────────────────────────────────────────────────────────────────────────
let ctxTarget = null;

function wireContextMenu() {
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideContextMenu(); closeModal(); } });
}

function showContextMenu(e, target) {
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = target;
  const menu = document.getElementById('ctx-menu');
  const isFile = target.type === 'file';
  const isFolder = target.type === 'folder';
  const isTrash = App.state.view === 'trash';

  document.querySelectorAll('[data-ctx]').forEach(item => {
    const action = item.dataset.ctx;
    item.style.display = 'flex';
    if (action === 'download' && isFolder) item.style.display = 'none';
    if (action === 'preview' && (isFolder || isTrash || !App.isPreviewable(target.data))) item.style.display = 'none';
    if ((action === 'restore' || action === 'delete-forever') && !isTrash) item.style.display = 'none';
    if ((action === 'rename' || action === 'delete') && isTrash) item.style.display = 'none';
  });

  const rect = { x: e.clientX, y: e.clientY };
  menu.style.left = `${Math.min(rect.x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(rect.y, window.innerHeight - 220)}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('ctx-menu')?.classList.add('hidden');
}

export function wireContextActions() {
  document.querySelectorAll('[data-ctx]').forEach(item => {
    item.addEventListener('click', async () => {
      hideContextMenu();
      if (!ctxTarget) return;
      const { type, data } = ctxTarget;
      const action = item.dataset.ctx;

      // Handle multi-selection if target is part of it
      const selection = Array.from(App.state.selection);
      const isSelected = selection.includes(data.id);
      const targets = isSelected ? selection : [data.id];

      if (action === 'download') {
        if (isSelected && selection.length > 1) {
          bulkDownload();
        } else if (type === 'file') {
          downloadFile(data.id, p => showToast(`Downloading… ${p}%`));
        }
      } else if (action === 'rename') {
        if (type === 'file') showRenameModal(data);
        else if (type === 'folder') showRenameFolderModal(data);
      } else if (action === 'delete') {
        if (isSelected && selection.length > 1) {
          bulkDelete();
        } else if (type === 'file') {
          await App.deleteFile(data.id); showToast('Moved to trash', 'info');
        } else if (type === 'folder') {
          await App.api.deleteFolder(data.id); App.loadFiles();
        }
      } else if (action === 'preview') {
        openPreview(data);
      } else if (action === 'restore') {
        if (isSelected && selection.length > 1) {
          for (const id of selection) await App.api.restore(id);
          App.loadTrash(); showToast('Restored items', 'success');
        } else {
          await App.api.restore(data.id); App.loadTrash(); showToast('File restored', 'success');
        }
      } else if (action === 'delete-forever') {
        if (isSelected && selection.length > 1) {
          bulkDelete();
        } else {
          await App.api.deletePermanent(data.id); App.loadTrash(); showToast('Deleted permanently', 'error');
        }
      }
    });
  });
}

export function bulkDownload() {
  const selection = Array.from(App.state.selection);
  if (!selection.length) return;
  showToast(`Starting bulk download of ${selection.length} files...`, 'info');
  // We don't await here to allow concurrent downloads (or sequential browser prompts)
  selection.forEach(id => {
    downloadFile(id, p => {}); // Progress is tricky for bulk, so we leave it empty or handled by App events
  });
}

export async function bulkDelete() {
  const selection = Array.from(App.state.selection);
  if (!selection.length) return;
  const isTrash = App.state.view === 'trash';
  const msg = isTrash ? `Permanently delete ${selection.length} items?` : `Move ${selection.length} items to trash?`;
  if (!confirm(msg)) return;

  try {
    if (isTrash) {
      await App.bulkDeletePermanentFiles(selection);
      showToast('Deleted permanently', 'error');
    } else {
      await App.bulkDeleteFiles(selection);
      showToast('Moved to trash', 'info');
    }
  } catch (e) {
    showToast(`Bulk delete failed: ${e.message}`, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────────────────────
function closeModal() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function showNewFolderModal() {
  const modal = document.getElementById('modal-new-folder');
  modal.classList.remove('hidden');
  const input = document.getElementById('new-folder-name');
  input.value = '';
  input.focus();
  modal.querySelector('[data-action="confirm"]').onclick = async () => {
    const name = input.value.trim();
    if (!name) return;
    await App.createFolder(name);
    closeModal();
    showToast(`Folder "${name}" created`, 'success');
  };
}

function showRenameModal(file) {
  const modal = document.getElementById('modal-rename');
  modal.classList.remove('hidden');
  const input = document.getElementById('rename-input');
  input.value = file.name;
  input.focus(); input.select();
  modal.querySelector('[data-action="confirm"]').onclick = async () => {
    const name = input.value.trim();
    if (!name) return;
    await App.renameFile(file.id, name);
    closeModal();
    showToast(`File renamed to "${name}"`, 'success');
  };
}

function showRenameFolderModal(folder) {
  const modal = document.getElementById('modal-rename');
  modal.classList.remove('hidden');
  const input = document.getElementById('rename-input');
  input.value = folder.name;
  input.focus(); input.select();
  modal.querySelector('[data-action="confirm"]').onclick = async () => {
    const name = input.value.trim();
    if (!name) return;
    await App.api.renameFolder(folder.id, name);
    App.loadFiles();
    closeModal();
    showToast(`Folder renamed to "${name}"`, 'success');
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE PREVIEW
// ─────────────────────────────────────────────────────────────────────────────
async function openPreview(file) {
  if (!App.isPreviewable(file)) return;
  const modal = document.getElementById('modal-preview');
  const content = document.getElementById('preview-content');
  const title = document.getElementById('preview-title');
  modal.classList.remove('hidden');
  title.textContent = file.name;
  content.innerHTML = '<div class="preview-loading"><div class="spinner"></div><p>Loading preview…</p></div>';

  try {
    const { url, blob } = await getPreviewURL(file.id, p => {
      const el = content.querySelector('.preview-loading p');
      if (el) el.textContent = `Loading… ${p}%`;
    });

    const mt = file.mime_type;
    if (mt.startsWith('image/')) {
      content.innerHTML = `<img src="${url}" class="preview-img" alt="${esc(file.name)}">`;
    } else if (mt.startsWith('video/')) {
      content.innerHTML = `<video src="${url}" class="preview-video" controls autoplay></video>`;
    } else if (mt.startsWith('audio/')) {
      content.innerHTML = `<div class="preview-audio-wrap"><div class="audio-icon">🎵</div><p>${esc(file.name)}</p><audio src="${url}" controls autoplay></audio></div>`;
    } else if (mt === 'application/pdf') {
      content.innerHTML = `<iframe src="${url}" class="preview-pdf"></iframe>`;
    } else if (mt.startsWith('text/')) {
      const text = await blob.text();
      content.innerHTML = `<pre class="preview-text">${esc(text)}</pre>`;
    }
  } catch (e) {
    content.innerHTML = `<div class="preview-error">Failed to load preview: ${esc(e.message)}</div>`;
  }
}

document.getElementById('modal-preview')?.addEventListener('click', function(e) {
  if (e.target === this) {
    this.classList.add('hidden');
    document.getElementById('preview-content').innerHTML = '';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD PANEL
// ─────────────────────────────────────────────────────────────────────────────
function addUploadRow(job) {
  const panel = document.getElementById('upload-panel');
  panel?.classList.remove('hidden');
  const list = document.getElementById('upload-list');
  const row = document.createElement('div');
  row.id = `urow-${job.id}`;
  row.className = 'upload-row';
  row.innerHTML = `
    <div class="upload-row-info">
      <span class="upload-name">${esc(job.name)}</span>
      <span class="upload-controls" style="display:flex;align-items:center;gap:6px">
        <span class="upload-status" id="ustatus-${job.id}">Queued</span>
        <button class="btn-icon" style="padding:2px;font-size:12px" title="Pause/Resume" onclick="toggleUploadAction('${job.id}')" id="ubtn-${job.id}"><i data-lucide="pause" size="14"></i></button>
        <button class="btn-icon danger" style="padding:2px;font-size:12px" title="Cancel" onclick="cancelUploadAction('${job.id}')"><i data-lucide="x" size="14"></i></button>
      </span>
    </div>
    <div class="upload-bar-wrap">
      <div class="upload-bar" id="ubar-${job.id}" style="width:0%"></div>
    </div>`;
  list?.appendChild(row);
  if (window.lucide) lucide.createIcons();
}

function updateUploadRow(job) {
  const bar = document.getElementById(`ubar-${job.id}`);
  const status = document.getElementById(`ustatus-${job.id}`);
  const btn = document.getElementById(`ubtn-${job.id}`);
  if (bar) bar.style.width = `${job.progress}%`;
  
  if (job.status === 'paused') {
    if (status) status.textContent = 'Paused';
    if (btn) {
      btn.innerHTML = '<i data-lucide="play" size="14"></i>';
      if (window.lucide) lucide.createIcons();
    }
  } else {
    if (btn) {
      btn.innerHTML = '<i data-lucide="pause" size="14"></i>';
      if (window.lucide) lucide.createIcons();
    }
    if (status) {
      if (job.status === 'hashing') status.textContent = 'Computing checksum…';
      else status.textContent = `${job.progress}%`;
    }
  }
}

function finishUploadRow(job) {
  const bar = document.getElementById(`ubar-${job.id}`);
  const status = document.getElementById(`ustatus-${job.id}`);
  if (bar) { bar.style.width = '100%'; bar.classList.add('done'); }
  if (status) status.innerHTML = 'Complete <i data-lucide="check-circle" size="14" style="vertical-align:middle"></i>';
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById(`urow-${job.id}`)?.remove(), 3000);
  const list = document.getElementById('upload-list');
  if (list && !list.children.length) document.getElementById('upload-panel')?.classList.add('hidden');
  
  showToast(`Upload finished: ${esc(job.name)}`, 'success');
}

function errorUploadRow(job) {
  const status = document.getElementById(`ustatus-${job.id}`);
  if (status) status.textContent = `Error: ${job.error}`;
  const bar = document.getElementById(`ubar-${job.id}`);
  if (bar) bar.classList.add('error');
  
  showToast(`Upload failed: ${esc(job.name)}`, 'error');
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP ZONE
// ─────────────────────────────────────────────────────────────────────────────
function wireDropZone() {
  const zone = document.getElementById('drop-overlay');
  const main = document.getElementById('main-panel');
  if (!main) return;

  let dragCount = 0;
  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCount++;
    zone?.classList.remove('hidden');
  });
  document.addEventListener('dragleave', () => {
    dragCount--;
    if (dragCount <= 0) { dragCount = 0; zone?.classList.add('hidden'); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCount = 0;
    zone?.classList.add('hidden');
    if (e.dataTransfer.files.length) queueFiles(e.dataTransfer.files, App.state.currentFolder);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────────────────────
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      App.clearSelection();
    }
    if (e.key === 'Delete' && App.state.selection.size > 0 && !isInputFocused()) {
      App.state.selection.forEach(id => App.deleteFile(id));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isInputFocused()) {
      e.preventDefault();
      App.state.files.forEach(f => App.state.selection.add(f.id));
      App.emit('selection:change', App.state.selection);
    }
  });
}

function isInputFocused() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function setActiveNav(view) {
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === view));
  const titles = { files: 'My Files', trash: 'Trash' };
  const h = document.getElementById('panel-title');
  if (h) h.textContent = titles[view] || 'Files';
  // Show/hide top bar actions
  const topbar = document.getElementById('topbar-actions');
  if (topbar) topbar.style.display = view === 'files' ? 'flex' : 'none';
}

function renderUserInfo(user) {
  const name = user.display_name || user.email;
  const el = document.getElementById('user-display');
  if (el) el.textContent = name;
  const em = document.getElementById('top-email');
  if (em) em.textContent = user.email || name;
  
  const av = document.getElementById('user-avatar');
  const topAv = document.getElementById('top-avatar');
  if (user.avatar_url) {
    if (av) { av.src = user.avatar_url; av.style.display = 'block'; }
    if (topAv) { topAv.src = user.avatar_url; topAv.style.display = 'block'; document.getElementById('top-avatar-placeholder').style.display = 'none'; }
  } else {
    if (av) { av.style.display = 'none'; }
    if (topAv) { topAv.style.display = 'none'; document.getElementById('top-avatar-placeholder').style.display = 'block'; }
  }
}

async function loadStorage() {
  try {
    const { used, quota } = await App.api.storage();
    const pct = Math.round((used / quota) * 100);
    const bar = document.getElementById('storage-bar');
    const label = document.getElementById('storage-label');
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${App.formatBytes(used)} of ${App.formatBytes(quota)}`;
  } catch {}
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}

function switchAuthTab(tab) {
  document.getElementById('form-login')?.classList.toggle('hidden', tab !== 'login');
  document.getElementById('form-register')?.classList.toggle('hidden', tab !== 'register');
  document.getElementById('tab-login')?.classList.toggle('active-tab', tab === 'login');
  document.getElementById('tab-register')?.classList.toggle('active-tab', tab === 'register');
}

export function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Expose to inline handlers
window.restoreFile = async (id) => { await App.api.restore(id); App.loadTrash(); showToast('Restored', 'success'); };
window.deleteForever = async (id) => { await App.api.deletePermanent(id); App.loadTrash(); showToast('Deleted permanently', 'error'); };

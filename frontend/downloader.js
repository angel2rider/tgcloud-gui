/**
 * TeleDrive — downloader.js
 * Parallel chunk download (4 concurrent), SHA-256 verification, Blob merging.
 */

import { api, emit, WORKER_URL, fetchWithRetry } from './app.js';

const PARALLEL = 4; // concurrent chunk downloads

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256
// ─────────────────────────────────────────────────────────────────────────────
async function sha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD FILE (authenticated)
// ─────────────────────────────────────────────────────────────────────────────
export async function downloadFile(fileId, onProgress) {
  emit('download:start', { fileId });
  const { file, chunks } = await api.download(fileId);
  
  // Try streaming to disk first (for large files)
  if (window.showSaveFilePicker) {
    try {
      await streamDownload(file, chunks, onProgress);
      emit('download:done', { fileId: file.id });
      return;
    } catch (e) {
      if (e.name === 'AbortError') {
        emit('download:done', { fileId: file.id }); // User cancelled picker
        return;
      }
      console.warn('Streaming download failed, falling back to RAM buffer', e);
    }
  }
  
  await assembleAndSave(file, chunks, onProgress);
}

/**
 * Streaming download directly to disk using File System Access API.
 * Uses sequential writing to keep memory footprint minimal.
 */
async function streamDownload(file, chunks, onProgress) {
  const handle = await window.showSaveFilePicker({
    suggestedName: file.name,
  });
  const writable = await handle.createWritable();
  
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  const total = sorted.length;
  let completed = 0;
  
  // To keep memory low, we download PARALLEL chunks but write them sequentially.
  // We use a Map to buffer chunks that arrive out of order.
  const buffer = new Map();
  let nextToWrite = 0;

  return new Promise((resolve, reject) => {
    let cursor = 0;
    let failed = false;

    async function downloadNext() {
      if (cursor >= total || failed) return;
      
      const chunk = sorted[cursor++];
      try {
        const base = WORKER_URL.endsWith('/') ? WORKER_URL.slice(0, -1) : WORKER_URL;
        const url = chunk.url.startsWith('http') ? chunk.url : `${base}${chunk.url}`;
        const res = await fetchWithRetry(url);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        
        const arrayBuffer = await res.arrayBuffer();
        
        if (chunk.checksum) {
          const actual = await sha256(arrayBuffer);
          if (actual !== chunk.checksum) throw new Error(`Checksum mismatch at chunk ${chunk.index}`);
        }

        buffer.set(chunk.index, arrayBuffer);
        
        // Write available sequential chunks
        while (buffer.has(nextToWrite)) {
          const data = buffer.get(nextToWrite);
          await writable.write(data);
          buffer.delete(nextToWrite);
          nextToWrite++;
          completed++;
          if (onProgress) onProgress(Math.round((completed / total) * 100));
          emit('download:progress', { index: nextToWrite - 1, completed, total });
        }

        if (completed === total) {
          await writable.close();
          resolve();
        } else {
          await downloadNext();
        }
      } catch (e) {
        failed = true;
        writable.abort();
        reject(e);
      }
    }

    // Start workers
    for (let i = 0; i < Math.min(PARALLEL, total); i++) {
      downloadNext();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REUSABLE ASSEMBLY LOGIC (RAM Fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function assembleAndSave(file, chunks, onProgress) {
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  const total = sorted.length;
  const downloaded = new Array(total);
  let completed = 0;

  if (file.size > 1024 * 1024 * 500) {
    if (!confirm('This file is large (>500MB) and your browser does not support direct disk streaming. It will be buffered in RAM, which may crash the tab. Continue?')) {
      emit('download:done', { fileId: file.id });
      return;
    }
  }

  async function downloadChunk(chunk) {
    const base = WORKER_URL.endsWith('/') ? WORKER_URL.slice(0, -1) : WORKER_URL;
    const url = chunk.url.startsWith('http') ? chunk.url : `${base}${chunk.url}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Chunk ${chunk.index} fetch failed: ${res.status}`);
    const blob = await res.blob();

    if (chunk.checksum) {
      const buffer = await blob.arrayBuffer();
      const actual = await sha256(buffer);
      if (actual !== chunk.checksum) throw new Error(`Chunk ${chunk.index} checksum mismatch`);
    }

    downloaded[chunk.index] = blob;
    completed++;
    if (onProgress) onProgress(Math.round((completed / total) * 100));
    emit('download:progress', { index: chunk.index, completed, total });
  }

  let cursor = 0;
  async function next() {
    while (cursor < sorted.length) {
      const chunk = sorted[cursor++];
      await downloadChunk(chunk);
    }
  }

  const workers = Array.from({ length: Math.min(PARALLEL, sorted.length) }, () => next());
  await Promise.all(workers);

  const blob = new Blob(downloaded, { type: file.mime_type || 'application/octet-stream' });
  triggerDownload(blob, file.name);
  emit('download:done', { fileId: file.id });
}

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW STREAM  (small files <20MB — return object URL)
// ─────────────────────────────────────────────────────────────────────────────
export async function getPreviewURL(fileId, onProgress) {
  const { file, chunks } = await api.download(fileId);
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  const downloaded = new Array(sorted.length);
  let completed = 0;

  for (const chunk of sorted) {
    const base = WORKER_URL.endsWith('/') ? WORKER_URL.slice(0, -1) : WORKER_URL;
    const url = chunk.url.startsWith('http') ? chunk.url : `${base}${chunk.url}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Chunk ${chunk.index} failed`);
    const blob = await res.blob();
    if (chunk.checksum) {
      const buffer = await blob.arrayBuffer();
      const actual = await sha256(buffer);
      if (actual !== chunk.checksum) throw new Error(`Chunk ${chunk.index} checksum mismatch`);
    }
    downloaded[chunk.index] = blob;
    completed++;
    if (onProgress) onProgress(Math.round((completed / sorted.length) * 100));
  }

  const blob = new Blob(downloaded, { type: file.mime_type || 'application/octet-stream' });
  return { url: URL.createObjectURL(blob), file, blob };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER BROWSER DOWNLOAD
// ─────────────────────────────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

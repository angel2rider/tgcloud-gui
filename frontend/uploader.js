/**
 * TeleDrive — uploader.js
 * Client-side file chunking, SHA-256 checksums, sequential upload with resume.
 */

import { api, state, emit, CHUNK_SIZE, fetchWithRetry } from './app.js';

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 helper
// ─────────────────────────────────────────────────────────────────────────────
async function sha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD QUEUE
// ─────────────────────────────────────────────────────────────────────────────
let uploadQueue = [];
let isProcessing = false;

export function queueFiles(fileList, folderId) {
  const files = Array.from(fileList);
  const sessions = getStoredSessions();
  for (const file of files) {
    // Resume previous session if matched
    const existingSessionId = Object.keys(sessions).find(
      key => sessions[key].name === file.name && sessions[key].size === file.size
    );
    if (existingSessionId) {
      resumeUpload({ id: existingSessionId, ...sessions[existingSessionId] }, file);
    } else {
      const job = createJob(file, folderId);
      uploadQueue.push(job);
      state.uploads.push(job);
      emit('upload:queued', job);
    }
  }
  processQueue();
}

function createJob(file, folderId) {
  return {
    id: crypto.randomUUID(),
    file,
    folderId: folderId || state.currentFolder,
    name: file.name,
    size: file.size,
    status: 'queued',   // queued | hashing | uploading | done | error | paused
    progress: 0,        // 0–100
    bytesUploaded: 0,
    totalChunks: Math.ceil(file.size / CHUNK_SIZE),
    uploadedChunks: [],
    fileId: null,
    sessionId: null,
    error: null,
  };
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  while (uploadQueue.length > 0) {
    const job = uploadQueue.shift();
    if (job.status === 'queued' || job.status === 'paused') {
      try {
        await runUpload(job);
      } catch (e) {
        console.error('Job failed:', job.name, e);
      }
    }
  }
  isProcessing = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN SINGLE UPLOAD
// ─────────────────────────────────────────────────────────────────────────────
async function runUpload(job) {
  try {
    // ── Init upload session ─────────────────────────────────────────────────
    if (!job.fileId) {
      const { file_id, session_id, config } = await api.uploadInit({
        name: job.name,
        mime_type: job.file.type || 'application/octet-stream',
        size: job.size,
        total_chunks: job.totalChunks,
        folder_id: job.folderId,
        checksum: null,
      });
      job.fileId = file_id;
      job.sessionId = session_id;
      job.botConfig = config; // { bot_token, channel_id }
      saveSessionToStorage(job);
    }

    job.status = 'uploading';

    // ── Upload chunks in parallel (Configurable) ───────────────────────────
    const CONCURRENCY = App.state.concurrency || 3;
    let cursor = 0;
    let activeUploads = 0;

    return new Promise((resolve, reject) => {
      const next = async () => {
        // Stop if all chunks sent or job is no longer uploading
        if (cursor >= job.totalChunks || job.status !== 'uploading') {
          if (activeUploads === 0 && job.status === 'uploading') {
            // DOUBLE CHECK: All chunks MUST be uploaded according to client
            if (job.uploadedChunks.length < job.totalChunks) {
              const error = new Error(`Client-side check failed: Only ${job.uploadedChunks.length}/${job.totalChunks} chunks uploaded`);
              job.status = 'error';
              job.error = error.message;
              emit('upload:error', job);
              return reject(error);
            }

            try {
              await api.uploadComplete({ file_id: job.fileId, session_id: job.sessionId });
              job.status = 'done';
              job.progress = 100;
              clearSessionFromStorage(job); // Use existing clearSessionFromStorage
              emit('upload:done', job);
              emit('files:refresh'); // Added this back from original logic
              resolve();
            } catch (e) {
              reject(e);
            }
          }
          return;
        }

        const i = cursor++;
        
        // Skip already uploaded chunks (for resume)
        if (job.uploadedChunks.includes(i)) {
          return next(); // Pipelined: immediately check next
        }

        activeUploads++;
        
        // Start next lane immediately if we haven't reached concurrency limit
        // This ensures all "lanes" are filled as fast as possible (Pipelining)
        if (activeUploads < CONCURRENCY) {
          next();
        }

        try {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, job.size);
          const chunkBlob = job.file.slice(start, end);
          const chunkBuffer = await chunkBlob.arrayBuffer();
          const chunkChecksum = await sha256(chunkBuffer);

          // BYPASS WORKER for large files (>80MB)
          const useDirectUpload = job.size > 80 * 1024 * 1024;

          if (useDirectUpload && job.botConfig) {
            const formData = new FormData();
            formData.append('chat_id', job.botConfig.channel_id);
            formData.append('caption', `td:${job.fileId}:${i}`);
            formData.append('document', chunkBlob, `chunk_${job.fileId}_${i}`);

            // Use custom TG API URL if configured, default is App.state.tgApiUrl
            const baseUrl = App.state.tgApiUrl.replace(/\/+$/, '');
            const tgRes = await fetchWithRetry(`${baseUrl}/bot${job.botConfig.bot_token}/sendDocument`, {
              method: 'POST',
              body: formData
            });
            const tgData = await tgRes.json();
            if (!tgRes.ok || !tgData.ok) {
              throw new Error(`Telegram error: ${tgData.description || tgRes.status}`);
            }

            const msg = tgData.result;
            const tgFileId = msg.document?.file_id || msg.video?.file_id || msg.audio?.file_id || '';

            // Record to Worker
            await api.recordChunk({
              file_id: job.fileId,
              session_id: job.sessionId,
              chunk_index: i,
              tg_message_id: msg.message_id,
              tg_file_id: tgFileId,
              chunk_size: chunkBlob.size,
              checksum: chunkChecksum
            });
          } else {
            // Standard Worker Proxy
            const customHeaders = {
              'X-File-Id': job.fileId,
              'X-Session-Id': job.sessionId,
              'X-Chunk-Index': String(i),
              'X-Checksum': chunkChecksum,
              'Content-Type': 'application/octet-stream'
            };
            await api.uploadChunk(chunkBlob, customHeaders);
          }

          job.uploadedChunks.push(i);
          job.progress = Math.round((job.uploadedChunks.length / job.totalChunks) * 100);
          saveSessionToStorage(job);
          emit('upload:progress', job);
          
          activeUploads--;
          next(); // Start next chunk in this lane immediately
        } catch (e) {
          activeUploads--;
          job.status = 'error';
          job.error = e.message;
          emit('upload:error', job);
          reject(e);
        }
      };

      // Kick off the first lane, which will recursively kick off others until CONCURRENCY is reached
      next();
    });

  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    emit('upload:error', job);
    console.error('Upload error:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME SUPPORT  (session data in localStorage)
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_KEY = 'td_upload_sessions';

function saveSessionToStorage(job) {
  const sessions = getStoredSessions();
  sessions[job.id] = {
    name: job.name,
    size: job.size,
    folderId: job.folderId,
    totalChunks: job.totalChunks,
    uploadedChunks: job.uploadedChunks,
    fileId: job.fileId,
    sessionId: job.sessionId,
    botConfig: job.botConfig,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
}

function clearSessionFromStorage(job) {
  const sessions = getStoredSessions();
  delete sessions[job.id];
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
}

function getStoredSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); }
  catch { return {}; }
}

export function getResumableSessions() {
  return Object.entries(getStoredSessions()).map(([id, s]) => ({ id, ...s }));
}

export function resumeUpload(sessionData, file) {
  const job = {
    ...createJob(file, sessionData.folderId),
    id: sessionData.id,
    fileId: sessionData.fileId,
    sessionId: sessionData.sessionId,
    botConfig: sessionData.botConfig,
    totalChunks: sessionData.totalChunks,
    uploadedChunks: sessionData.uploadedChunks,
    bytesUploaded: sessionData.uploadedChunks.length * CHUNK_SIZE,
    progress: Math.round((sessionData.uploadedChunks.length / sessionData.totalChunks) * 100),
    status: 'queued',
  };
  uploadQueue.push(job);
  state.uploads.push(job);
  emit('upload:queued', job);
  processQueue();
}

export function pauseUpload(jobId) {
  const job = state.uploads.find(j => j.id === jobId);
  if (job && job.status === 'uploading') {
    job.status = 'paused';
    emit('upload:progress', job);
  }
}

export function resumePausedUpload(jobId) {
  const job = state.uploads.find(j => j.id === jobId);
  if (job && job.status === 'paused') {
    job.status = 'queued';
    uploadQueue.push(job);
    emit('upload:progress', job);
    emit('upload:queued', job);
    processQueue();
  }
}

export function cancelUpload(jobId) {
  uploadQueue = uploadQueue.filter(j => j.id !== jobId);
  const idx = state.uploads.findIndex(j => j.id === jobId);
  if (idx >= 0) {
    state.uploads[idx].status = 'cancelled';
    clearSessionFromStorage(state.uploads[idx]);
    emit('upload:cancelled', state.uploads[idx]);
    state.uploads.splice(idx, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────


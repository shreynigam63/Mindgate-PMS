// The MoM recorder (part 2): records a Google Meet call from the manager's
// browser — the Meet tab's audio (everyone on the call) mixed with the
// manager's microphone — and sends it to the PMS in 10-second pieces while
// the call runs.
//
// It lives outside React on purpose: moving to another page of the PMS
// must not stop a recording. Screens subscribe to its state.
//
// Every piece is also kept in this browser (IndexedDB) until the PMS has
// the whole recording. If the network drops or the tab is closed, the
// next visit offers to send it again or save it to the laptop — the
// specification's "the recording is kept in the browser and retried".
import { api, API_BASE } from '../utils/api';

const PIECE_MS = 10000;
const MAX_MS = 3 * 60 * 60 * 1000; // "maximum 3 hours per recording"
const IDB = 'apms-mom-recordings';
const STORE = 'pieces';

let state = { phase: 'idle', meetingId: null, title: '', startedAt: null, sent: 0, total: 0, error: null };
let session = null;
const subs = new Set();
const emit = (patch) => { state = { ...state, ...patch }; subs.forEach((f) => f(state)); };
export const subscribe = (f) => { subs.add(f); f(state); return () => { subs.delete(f); }; };
export const current = () => state;

// Chrome or Edge on a laptop or desktop: phones cannot share tab audio.
export const canRecord = () => typeof window !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder)
  && !/Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);

// ---------------------------------------------------------------- local copy

function idb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: ['meetingId', 'seq'] });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function idbDo(mode, fn) {
  const d = await idb();
  return new Promise((ok, no) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); ok(out && out.result !== undefined ? out.result : undefined); };
    t.onerror = () => { d.close(); no(t.error); };
  });
}
const idbPut = (rec) => idbDo('readwrite', (s) => s.put(rec)).catch(() => {});
const idbAll = () => idbDo('readonly', (s) => s.getAll()).catch(() => []);
async function idbPieces(meetingId) {
  return (await idbAll()).filter((p) => p.meetingId === meetingId).sort((a, b) => a.seq - b.seq);
}
async function idbClear(meetingId) {
  const keys = (await idbPieces(meetingId)).map((p) => [p.meetingId, p.seq]);
  if (keys.length) await idbDo('readwrite', (s) => keys.forEach((k) => s.delete(k))).catch(() => {});
}

// ---------------------------------------------------------------- sending

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const base = (id) => `/pms/mom/meetings/${id}/recording`;

// One piece, retried with back-off. A refusal (the upload was closed, the
// person is not the recorder) is not retried.
async function sendPiece(meetingId, uploadId, seq, blob) {
  const token = localStorage.getItem('apms_token');
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${API_BASE}${base(meetingId)}/${uploadId}/chunks/${seq}`, {
        method: 'PUT', body: blob,
        headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (r.ok) return;
      if (r.status < 500 && r.status !== 408 && r.status !== 429) {
        const d = await r.json().catch(() => ({}));
        throw Object.assign(new Error(d.error || r.statusText), { fatal: true });
      }
    } catch (e) { if (e.fatal) throw e; }
    await sleep(1000 * 2 ** i);
  }
  throw new Error('The network dropped while sending the recording.');
}

const warnLeave = (e) => { e.preventDefault(); e.returnValue = ''; };

// ---------------------------------------------------------------- recording

export async function start(meeting, { replace = false } = {}) {
  if (session) throw new Error('A recording is already running.');
  emit({ phase: 'starting', meetingId: meeting.id, title: meeting.title, sent: 0, total: 0, error: null, startedAt: null });
  let display; let mic; let ctx; let uploadId;
  const cleanup = () => {
    [display, mic].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
    if (ctx) ctx.close().catch(() => {});
  };
  try {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('This browser cannot record audio. Use Chrome or Edge.');
    // The PMS first: consent and storage are checked before the browser asks anything.
    uploadId = (await api(`${base(meeting.id)}/start`, { method: 'POST', body: JSON.stringify({ source: 'browser', mime, replace }) })).upload_id;
    display = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: 'exclude', systemAudio: 'include', preferCurrentTab: false,
    });
    if (!display.getAudioTracks().length) throw new Error('No call audio was shared. Click Record again, pick the Google Meet tab and tick "Share tab audio".');
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      throw new Error('Allow the microphone, so your own voice is recorded too.');
    }
    ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
    ctx.createMediaStreamSource(mic).connect(dest);
    await idbClear(meeting.id);
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 32000 });
    session = { rec, cleanup, uploadId, meetingId: meeting.id, mime, title: meeting.title, seq: 0, queue: Promise.resolve(), failed: false, fatal: null };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) piece(e.data); };
    rec.onstop = () => { finish(); };
    // "Stop sharing" in the browser bar ends the recording like Stop.
    display.getTracks().forEach((t) => t.addEventListener('ended', stop));
    rec.start(PIECE_MS);
    session.limit = setTimeout(stop, MAX_MS);
    window.addEventListener('beforeunload', warnLeave);
    emit({ phase: 'recording', startedAt: Date.now() });
  } catch (e) {
    cleanup();
    if (uploadId) api(`${base(meeting.id)}/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    session = null;
    const msg = e.name === 'NotAllowedError' ? 'Recording did not start: sharing was cancelled.' : e.message;
    emit({ phase: 'idle', error: msg });
    throw Object.assign(new Error(msg), { data: e.data, status: e.status });
  }
}

function piece(blob) {
  const s = session;
  const seq = s.seq++;
  emit({ total: state.total + 1 });
  idbPut({ meetingId: s.meetingId, seq, blob, mime: s.mime, title: s.title, at: Date.now() });
  s.queue = s.queue.then(async () => {
    if (s.fatal) return;
    try { await sendPiece(s.meetingId, s.uploadId, seq, blob); emit({ sent: state.sent + 1 }); } catch (e) {
      s.failed = true;
      if (e.fatal) s.fatal = e.message;
    }
  });
}

export function stop() {
  if (session && session.rec.state !== 'inactive') session.rec.stop();
}

async function finish() {
  const s = session;
  clearTimeout(s.limit);
  s.cleanup();
  window.removeEventListener('beforeunload', warnLeave);
  emit({ phase: 'saving' });
  await s.queue;
  if (s.failed && !s.fatal) {
    // One more go at whatever did not arrive, from the local copy.
    try {
      for (const p of await idbPieces(s.meetingId)) await sendPiece(s.meetingId, s.uploadId, p.seq, p.blob);
      s.failed = false;
    } catch (e) { if (e.fatal) s.fatal = e.message; }
  }
  let error = s.fatal;
  if (!s.failed && !error) {
    try {
      await api(`${base(s.meetingId)}/${s.uploadId}/finish`, { method: 'POST',
        body: JSON.stringify({ chunks: s.seq, duration_sec: Math.round((Date.now() - state.startedAt) / 1000) }) });
      await idbClear(s.meetingId);
      session = null;
      emit({ phase: 'done', error: null });
      return;
    } catch (e) { error = e.message; }
  }
  session = null;
  emit({ phase: 'unsent', error: error || 'Part of the recording did not reach the PMS. It is kept in this browser.' });
}

// ---------------------------------------------------------------- recovery

// Recordings kept in this browser that never reached the PMS whole.
export async function unsent() {
  const by = new Map();
  for (const p of await idbAll()) {
    if (session && p.meetingId === session.meetingId) continue;
    const g = by.get(p.meetingId) || { meetingId: p.meetingId, title: p.title, mime: p.mime, pieces: 0, bytes: 0, at: p.at };
    g.pieces += 1; g.bytes += p.blob.size; g.at = Math.min(g.at, p.at);
    by.set(p.meetingId, g);
  }
  return [...by.values()];
}

// Send a kept recording again, whole, as a new upload that replaces any
// part of it the PMS saved when the tab closed.
export async function resend(meetingId) {
  const pieces = await idbPieces(meetingId);
  if (!pieces.length) throw new Error('Nothing is kept in this browser for that connect.');
  const { upload_id: uploadId } = await api(`${base(meetingId)}/start`, { method: 'POST', body: JSON.stringify({ source: 'browser', mime: pieces[0].mime, replace: true }) });
  for (const [i, p] of pieces.entries()) await sendPiece(meetingId, uploadId, i, p.blob);
  await api(`${base(meetingId)}/${uploadId}/finish`, { method: 'POST', body: JSON.stringify({ chunks: pieces.length }) });
  await idbClear(meetingId);
  if (state.meetingId === meetingId && state.phase === 'unsent') emit({ phase: 'done', error: null });
}

export async function saveToLaptop(meetingId) {
  const pieces = await idbPieces(meetingId);
  if (!pieces.length) return;
  const url = URL.createObjectURL(new Blob(pieces.map((p) => p.blob), { type: pieces[0].mime.split(';')[0] }));
  const a = document.createElement('a');
  a.href = url; a.download = `connect-recording-${new Date(pieces[0].at).toISOString().slice(0, 10)}.webm`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function discard(meetingId) {
  await idbClear(meetingId);
  if (state.meetingId === meetingId && state.phase === 'unsent') emit({ phase: 'idle', error: null });
}

// ---------------------------------------------------------------- a file

const TYPE_BY_EXT = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac' };

// A recording saved to the laptop earlier (or any audio file of the call),
// sent in pieces like a live one.
export async function uploadFile(meetingId, file, { replace = false, onProgress } = {}) {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1];
  const mime = (file.type || TYPE_BY_EXT[(ext || '').toLowerCase()] || '').split(';')[0];
  const r = await api(`${base(meetingId)}/start`, { method: 'POST', body: JSON.stringify({ source: 'file', mime, size: file.size, file_name: file.name, replace }) });
  const n = Math.ceil(file.size / r.chunk_bytes);
  for (let i = 0; i < n; i++) {
    await sendPiece(meetingId, r.upload_id, i, file.slice(i * r.chunk_bytes, (i + 1) * r.chunk_bytes));
    if (onProgress) onProgress((i + 1) / n);
  }
  await api(`${base(meetingId)}/${r.upload_id}/finish`, { method: 'POST', body: JSON.stringify({ chunks: n }) });
}

// Where MoM recordings live: on the server's own disk, encrypted, in the
// pieces the browser sent them in. Specification: "Files stored encrypted
// on the company server".
//
// WHY DISK AND NOT POSTGRES. Evidence and letters are stored in Postgres
// (migration 013) because the first deploy had no persistent disk. The
// EC2 instance has one, and recordings are big and short-lived: a day of
// connects across the teams would be gigabytes in every nightly backup,
// for files that are deleted after 60 days anyway. They are not in the
// backup; the MoM, its action items and the transcript are.
//
// ENCRYPTION. AES-256-GCM, one IV and tag per piece, stored in the piece
// itself (iv | tag | ciphertext). The key is MOM_RECORDING_KEY (32 bytes,
// hex or base64) when set, otherwise derived from JWT_SECRET — so a box
// needs no new secret to start recording. Each recording remembers which
// key it was written with (key_id); changing JWT_SECRET without setting
// MOM_RECORDING_KEY makes the older recordings unreadable, and the player
// says so rather than serving noise.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const root = () => path.resolve(process.env.MOM_STORAGE_DIR || '/var/lib/agentic-pms/mom');

function currentKeyId() { return process.env.MOM_RECORDING_KEY ? 'env' : 'jwt-v1'; }

function keyFor(keyId) {
  if (keyId === 'env') {
    const raw = String(process.env.MOM_RECORDING_KEY || '').trim();
    if (!raw) throw Object.assign(new Error('MOM_RECORDING_KEY is not set, and this recording was written with it.'), { status: 503 });
    const k = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
    if (k.length !== 32) throw Object.assign(new Error('MOM_RECORDING_KEY must be 32 bytes (64 hex characters).'), { status: 503 });
    return k;
  }
  if (keyId === 'jwt-v1') {
    if (!process.env.JWT_SECRET) throw Object.assign(new Error('JWT_SECRET is not set.'), { status: 503 });
    return Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'agentic-pms', 'mom-recordings-v1', 32));
  }
  throw Object.assign(new Error(`Unknown recording key ${keyId}.`), { status: 500 });
}

// The folder of one upload. Only ever built from a uuid, and checked to be
// inside the storage root before anything is written or removed.
function dirOf(uploadId) {
  if (!UUID.test(String(uploadId))) throw new Error('bad upload id');
  const base = root();
  const dir = path.resolve(base, 'rec', String(uploadId).toLowerCase());
  if (!dir.startsWith(base + path.sep)) throw new Error('path outside storage');
  return dir;
}
const segName = (seq) => `${String(seq).padStart(6, '0')}.seg`;

// Can the server write recordings at all? Asked before a recording starts,
// so a box without the folder says so instead of losing the call.
async function ready() {
  try {
    await fsp.mkdir(path.join(root(), 'rec'), { recursive: true });
    await fsp.access(path.join(root(), 'rec'), fs.constants.W_OK);
    keyFor(currentKeyId());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function encrypt(buf, keyId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(keyId), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function decrypt(buf, keyId) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(keyId), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// One piece, written whole or not at all (temp file, then rename). Sending
// the same piece again replaces it, so a retried upload is harmless.
async function writeSegment(uploadId, seq, buf, keyId) {
  const dir = dirOf(uploadId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, segName(seq));
  await fsp.writeFile(`${file}.tmp`, encrypt(buf, keyId));
  await fsp.rename(`${file}.tmp`, file);
}

async function segments(uploadId) {
  try {
    return (await fsp.readdir(dirOf(uploadId))).filter((f) => /^\d{6}\.seg$/.test(f)).map((f) => Number(f.slice(0, 6))).sort((a, b) => a - b);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

// The pieces in order, decrypted one at a time.
async function* readAll(uploadId, keyId) {
  const dir = dirOf(uploadId);
  for (const seq of await segments(uploadId)) {
    yield decrypt(await fsp.readFile(path.join(dir, segName(seq))), keyId);
  }
}

// The recording's size as played: each piece less its IV and tag.
async function plainSize(uploadId) {
  const dir = dirOf(uploadId);
  let size = 0;
  for (const seq of await segments(uploadId)) size += (await fsp.stat(path.join(dir, segName(seq)))).size - 28;
  return size;
}

async function remove(uploadId) {
  await fsp.rm(dirOf(uploadId), { recursive: true, force: true });
}

module.exports = { ready, writeSegment, segments, readAll, plainSize, remove, currentKeyId, dirOf, root };

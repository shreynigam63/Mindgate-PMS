// node --test — the MoM tab, parts 2 and 3, and its emails. Real Postgres,
// real HTTP surface, recordings written to a temporary folder; skips
// cleanly without DATABASE_URL. The AI service is answered by a stand-in
// for api.anthropic.com, so what the PMS sends and does with the reply is
// tested without a key.
//
// Part 2: the recording notice (consent), the recording arriving in
// pieces, stored encrypted, played back and logged, kept when the tab
// closes, replaced on request, deleted by the retention rule.
// Part 3: the Google Meet transcript uploaded (text, .docx), the AI draft
// in the template, its failure reported, a draft retried.
process.env.TZ = 'Asia/Kolkata';
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, mom, tx, store, storageDir;
const id = {};
const tok = {};
const meeting = {};

// The AI stand-in: the reply the next call gets, and what was sent.
let aiReply = null;
const aiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.anthropic.com')) {
    aiCalls.push(JSON.parse(opts.body));
    if (aiReply === 'down') return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(aiReply) }], stop_reason: 'end_turn', usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

const call = async (method, p, who, body, raw) => {
  const r = await realFetch(`${base}${p}`, {
    method, headers: { Authorization: `Bearer ${tok[who]}`, ...(raw ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: raw || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* audio */ }
  return { status: r.status, body: json, buf, type: r.headers.get('content-type') };
};
const get = (p, who) => call('GET', p, who);
const at = (s) => new Date(`${s}+05:30`);
const meetingOn = async (date) => (await db.query(`SELECT * FROM pms.mom_meetings WHERE tenant_id=$1 AND meeting_date=$2`, [tenantId, date])).rows[0];
const notes = async (who, kind) => (await db.query(
  `SELECT title, body FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind=$3 ORDER BY created_at, id`, [tenantId, id[who], kind])).rows;
const mails = async (kind) => Number((await db.query(`SELECT count(*) FROM core.notif_log WHERE tenant_id=$1 AND kind=$2`, [tenantId, kind])).rows[0].count);
async function settled(meetingId) {
  for (let i = 0; i < 200; i++) {
    const r = (await db.query(`SELECT status FROM pms.mom_meetings WHERE id=$1`, [meetingId])).rows[0];
    if (r.status !== 'processing') return r.status;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('still processing');
}
const TRANSCRIPT = `Daily connect - Transcript
Attendees
MoM Mgr, MoM A1
Transcript
00:00:00
MoM Mgr: Good morning. Let us go through the sprint. A1, where are we on the login fix?
MoM A1: The login fix is done and merged yesterday. Today I will start the export report and should finish it by Wednesday.
MoM Mgr: Good. We agreed to freeze the release branch on Thursday. Is anything blocking you?
MoM A1: The staging VPN keeps dropping, I need help from IT to get it stable before the freeze.
MoM Mgr: I will raise it with IT today. Someone also needs to update the onboarding guide for the new joiners this week.
MoM Mgr: That is all for today, thank you everyone.`;

before(async () => {
  if (!HAS_DB) return;
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-rec-'));
  process.env.MOM_STORAGE_DIR = storageDir;
  process.env.ANTHROPIC_API_KEY = 'test-key-for-the-stand-in';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mom-rec';
  process.env.TENANT_SLUG = 'momrec-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  mom = require('../modules/performance/mom');
  tx = require('../modules/performance/mom-transcript');
  store = require('../modules/performance/mom-store');

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  const mk = async (key, name, managerId) => {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status, date_of_joining, location, designation)
       VALUES ($1,$2,$3,'Engineering',$4,'active','2020-01-01','Pune','Engineer') RETURNING id`,
      [t.id, name, `momrec-${key}@x.com`, managerId || null])).rows[0].id;
  };
  await mk('hr', 'MoM HR');
  await mk('mgr', 'MoM Mgr');
  await mk('out', 'MoM Outsider');
  await mk('a1', 'MoM A1', id.mgr);
  await mk('a2', 'MoM A2', id.mgr);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'momrec-hr@x.com','hr'),($1,'momrec-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 4);
  const who = ['hr', 'mgr', 'out', 'a1', 'a2'];
  for (const k of who) await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, `momrec-${k}@x.com`, hash]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const k of who) {
    tok[k] = (await (await realFetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `momrec-${k}@x.com`, password: 'pass' }),
    })).json()).token;
  }
  assert.strictEqual((await call('PUT', `/pms/mom/teams/${id.mgr}`, 'hr', { meet_link: 'https://meet.google.com/abc-defg-hij', enabled: true })).status, 200);
  await mom.tick(tenantId, at('2027-04-05T08:00:00'));
  meeting.d1 = (await meetingOn('2027-04-05')).id;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
  globalThis.fetch = realFetch;
  fs.rmSync(storageDir, { recursive: true, force: true });
});

test('reading a Google Meet transcript: text, captions, .docx; a PDF is refused with what to do', { skip }, async () => {
  const JSZip = require('jszip');
  let r = await tx.parseTranscript(Buffer.from(`\uFEFF${TRANSCRIPT}\r\n`), 'Daily connect - Transcript.txt');
  assert.ok(r.text.startsWith('Daily connect'));
  assert.deepStrictEqual(r.speakers, ['MoM Mgr', 'MoM A1']);
  assert.strictEqual(r.language, 'en');
  r = await tx.parseTranscript(Buffer.from('WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Asha Rao>We shipped the fix yesterday.\n\n2\n00:00:05.000 --> 00:00:08.000\n<v Ravi K>Good, thanks.'), 'call.vtt');
  assert.strictEqual(r.text, 'Asha Rao: We shipped the fix yesterday.\n\nRavi K: Good, thanks.');
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Asha Rao: we agreed to ship &amp; test</w:t></w:r></w:p><w:p><w:r><w:t>Ravi K: फिर मिलते हैं, see you tomorrow</w:t></w:r></w:p></w:body></w:document>');
  r = await tx.parseTranscript(await zip.generateAsync({ type: 'nodebuffer' }), 'notes.docx');
  assert.strictEqual(r.text, 'Asha Rao: we agreed to ship & test\nRavi K: फिर मिलते हैं, see you tomorrow');
  assert.strictEqual(r.language, 'hi-en');
  await assert.rejects(tx.parseTranscript(Buffer.from('%PDF-1.4'), 'x.pdf'), /PDF is not read here/);
  await assert.rejects(tx.parseTranscript(Buffer.from('   '), 'x.txt'), /empty/);
});

test('the AI draft in the template: owners only when named, dates checked, attendance only when shown', { skip }, () => {
  const people = [{ id: 'p1', name: 'Asha Rao' }, { id: 'p2', name: 'Ravi Kumar' }, { id: 'p3', name: 'Ravi Shah' }, { id: 'p4', name: 'Meena Iyer' }];
  const attendees = people.slice(0, 3);
  const d = tx.draftToMinutes({
    summary: 'Sprint review.', discussion: ['Login fix', ''], decisions: ['Freeze Thursday'],
    action_items: [
      { task: 'Export report', owner: 'asha rao', due_date: '2027-04-07', priority: 'high' },
      { task: 'Guide', owner: 'Meena', due_date: 'Friday', priority: 'urgent' },
      { task: 'VPN', owner: 'Ravi', due_date: '' },
      { task: 'Docs', owner: 'Somebody New' },
      { task: '' },
    ],
    blockers: [{ issue: 'VPN drops', help_from: 'IT' }, { issue: '' }],
    carried_forward: [{ ref: 'C1', status: 'done', note: 'merged' }, { ref: 'C9', status: 'done' }, { ref: 'C2', status: 'maybe' }],
    present: ['Asha Rao', 'Ravi Shah'], confidence: 'high', score: 4,
  }, { people, attendees, carried: [{ ref: 'C1', id: 'i1' }, { ref: 'C2', id: 'i2' }], words: 300 });
  assert.deepStrictEqual(d.value.action_items.map((a) => [a.task, a.owner_id, a.due_date, a.priority]), [
    ['Export report', 'p1', '2027-04-07', 'high'],
    ['Guide', 'p4', null, 'medium'],
    ['VPN', null, null, 'medium'],
    ['Docs', null, null, 'medium'],
  ], 'a first name two people share is left for the organiser');
  assert.deepStrictEqual(d.notes.unmatched_owners, ['Ravi', 'Somebody New']);
  assert.deepStrictEqual(d.value.discussion, ['Login fix']);
  assert.deepStrictEqual(d.value.blockers, [{ issue: 'VPN drops', help_from: 'IT' }]);
  assert.deepStrictEqual(d.value.attendance, { p1: 'present', p2: 'absent', p3: 'present' });
  assert.deepStrictEqual(d.notes.carried_hints, [{ id: 'i1', status: 'done', note: 'merged' }]);
  assert.strictEqual(d.confidence, 'high');

  const thin = tx.draftToMinutes({ discussion: [], present: ['Nobody Here'] }, { people, attendees, carried: [], words: 12 });
  assert.strictEqual(thin.confidence, 'low');
  assert.match(thin.notes.confidence_reason, /very short/);
  assert.deepStrictEqual(thin.value.attendance, {}, 'unmatched names mark nobody absent');
});

test('the recording notice: accepted once by everyone on the call before Record works', { skip }, async () => {
  let r = await get('/pms/mom/consent', 'a1');
  assert.strictEqual(r.body.accepted, false);
  assert.match(r.body.notice.text, /deleted after 60 days/);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'mgr', { mime: 'audio/webm' });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(new Set(r.body.missing_consent.map((x) => x.id)), new Set([id.mgr, id.a1, id.a2]), 'the organiser too');
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr');
  assert.strictEqual(r.body.consent.filter((c) => !c.accepted).length, 3);

  for (const k of ['mgr', 'a1', 'a2']) assert.strictEqual((await call('POST', '/pms/mom/consent', k, { accept: true })).status, 200);
  r = await call('POST', '/pms/mom/consent', 'a2', { accept: false });
  assert.strictEqual(r.status, 200);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'mgr', { mime: 'audio/webm' });
  assert.deepStrictEqual(r.body.missing_consent.map((x) => x.name), ['MoM A2'], 'withdrawn is withdrawn');
  await call('POST', '/pms/mom/consent', 'a2', { accept: true });
  r = await get('/pms/mom/consent', 'a2');
  assert.strictEqual(r.body.accepted, true);
  const row = (await db.query(`SELECT notice_version, granted_at FROM core.employee_consents WHERE employee_id=$1 AND consent_type='mom_recording'`, [id.a2])).rows[0];
  assert.strictEqual(row.notice_version, 'v1');
  assert.ok(row.granted_at);
  r = await get('/pms/mom/today', 'mgr');
  assert.ok(Array.isArray(r.body.meetings));
});

test('a recording arrives in pieces, is stored encrypted, plays back whole, and every play is logged', { skip }, async () => {
  let r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'a1', { mime: 'audio/webm' });
  assert.strictEqual(r.status, 403, 'an attendee does not record');
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'mgr', { mime: 'text/plain' });
  assert.strictEqual(r.status, 422);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'mgr', { mime: 'audio/webm;codecs=opus', source: 'browser' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const up = r.body.upload_id;
  const pieces = [Buffer.from('AUDIO-PIECE-ZERO-'.repeat(50)), Buffer.from('AUDIO-PIECE-ONE-'.repeat(40)), Buffer.from('AUDIO-PIECE-TWO')];
  const piece = (i, who = 'mgr') => call('PUT', `/pms/mom/meetings/${meeting.d1}/recording/${up}/chunks/${i}`, who, undefined, pieces[i]);
  assert.strictEqual((await piece(0)).status, 200);
  assert.strictEqual((await piece(2)).status, 200);
  assert.strictEqual((await piece(0, 'a1')).status, 403, 'only the person recording sends pieces');
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/${up}/finish`, 'mgr', { chunks: 3 });
  assert.strictEqual(r.status, 422, 'a piece is missing');
  assert.strictEqual((await piece(1)).status, 200);
  assert.strictEqual((await piece(1)).status, 200, 'sending a piece again is harmless');
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/${up}/finish`, 'mgr', { chunks: 3, duration_sec: 31 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const whole = Buffer.concat(pieces);
  const onDisk = fs.readdirSync(path.join(storageDir, 'rec', up)).map((f) => fs.readFileSync(path.join(storageDir, 'rec', up, f)));
  assert.strictEqual(onDisk.length, 3);
  assert.ok(onDisk.every((b) => !b.includes(Buffer.from('AUDIO-PIECE'))), 'nothing on disk is readable');
  const rec = (await db.query(`SELECT size_bytes, duration_sec, delete_after::text AS d, uploaded_at::date::text AS u FROM pms.mom_recordings WHERE meeting_id=$1`, [meeting.d1])).rows[0];
  assert.strictEqual(Number(rec.size_bytes), whole.length);
  assert.strictEqual(rec.duration_sec, 31);
  assert.strictEqual(Math.round((Date.parse(rec.d) - Date.parse(rec.u)) / 86400000), 60);

  r = await get(`/pms/mom/meetings/${meeting.d1}/recording`, 'a1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.type, 'audio/webm');
  assert.ok(r.buf.equals(whole), 'plays back exactly what was recorded');
  r = await get(`/pms/mom/meetings/${meeting.d1}/recording?download=1`, 'hr');
  assert.ok(r.buf.equals(whole));
  assert.strictEqual((await get(`/pms/mom/meetings/${meeting.d1}/recording`, 'out')).status, 403);
  const logged = (await db.query(`SELECT action, actor_email FROM pms.audit_log WHERE tenant_id=$1 AND action IN ('MOM_RECORDING_PLAYED','MOM_RECORDING_DOWNLOADED') ORDER BY id`, [tenantId])).rows;
  assert.deepStrictEqual(logged.map((x) => [x.action, x.actor_email]), [['MOM_RECORDING_PLAYED', 'momrec-a1@x.com'], ['MOM_RECORDING_DOWNLOADED', 'momrec-hr@x.com']]);

  // Recording again replaces the first, but only when asked; a discarded
  // second try leaves the first as it was.
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'mgr', { mime: 'audio/webm' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.needs_replace, true);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/recording/start`, 'mgr', { mime: 'audio/webm', replace: true });
  const second = r.body.upload_id;
  await call('PUT', `/pms/mom/meetings/${meeting.d1}/recording/${second}/chunks/0`, 'mgr', undefined, Buffer.from('second'));
  assert.strictEqual((await call('DELETE', `/pms/mom/meetings/${meeting.d1}/recording/${second}`, 'mgr')).status, 200);
  assert.ok(!fs.existsSync(path.join(storageDir, 'rec', second)));
  r = await get(`/pms/mom/meetings/${meeting.d1}/recording`, 'mgr');
  assert.ok(r.buf.equals(whole));

  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.body.recording.duration_sec, 31);
  assert.strictEqual(r.body.transcript, null, 'the transcript is the organiser\'s');
});

test('reminders are emailed too; a recorded connect is not Missing; a closed tab keeps what arrived', { skip }, async () => {
  let out = await mom.tick(tenantId, at('2027-04-05T09:50:00'));
  assert.strictEqual(out.reminded, 1);
  assert.strictEqual(await mails('mom_reminder'), 3, 'organiser and both attendees');
  out = await mom.tick(tenantId, at('2027-04-05T18:00:00'));
  assert.strictEqual(out.missing, 0, 'it was recorded');
  assert.strictEqual((await meetingOn('2027-04-05')).status, 'scheduled');

  await mom.tick(tenantId, at('2027-04-06T08:00:00'));
  meeting.d2 = (await meetingOn('2027-04-06')).id;
  let r = await call('POST', `/pms/mom/meetings/${meeting.d2}/recording/start`, 'mgr', { mime: 'audio/webm' });
  const up = r.body.upload_id;
  await call('PUT', `/pms/mom/meetings/${meeting.d2}/recording/${up}/chunks/0`, 'mgr', undefined, Buffer.from('kept-when-the-tab-closed'));
  out = await mom.tick(tenantId, at('2027-04-06T10:05:00'));
  assert.strictEqual(out.autosaved, 0, 'not yet: pieces may still be coming');
  await db.query(`UPDATE pms.mom_uploads SET last_chunk_at = now() - interval '16 minutes' WHERE id=$1`, [up]);
  out = await mom.tick(tenantId, at('2027-04-06T10:20:00'));
  assert.strictEqual(out.autosaved, 1);
  r = await get(`/pms/mom/meetings/${meeting.d2}/recording`, 'mgr');
  assert.strictEqual(r.buf.toString(), 'kept-when-the-tab-closed');
  assert.strictEqual((await notes('mgr', 'mom_recording_saved')).length, 1);
  assert.strictEqual(await mails('mom_recording_saved'), 1);
});

test('the Google Meet transcript is uploaded and the AI drafts the MoM for the organiser', { skip }, async () => {
  aiReply = {
    summary: 'The team reviewed the sprint. The login fix is done; the export report starts today. The release branch freezes on Thursday.',
    discussion: ['Login fix status', 'Export report', 'Release freeze'],
    decisions: ['Freeze the release branch on Thursday'],
    action_items: [
      { task: 'Finish the export report', owner: 'MoM A1', due_date: '2027-04-07', priority: 'high' },
      { task: 'Update the onboarding guide', owner: '', due_date: '' },
    ],
    blockers: [{ issue: 'Staging VPN keeps dropping', help_from: 'IT' }],
    carried_forward: [], present: ['MoM A1'], confidence: 'high', confidence_reason: '',
  };
  let r = await call('POST', `/pms/mom/meetings/${meeting.d1}/transcript`, 'a1', { text: TRANSCRIPT });
  assert.strictEqual(r.status, 403, 'the organiser or HR uploads it');
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/transcript`, 'mgr', {});
  assert.strictEqual(r.status, 422);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/transcript`, 'mgr', { text: TRANSCRIPT });
  assert.strictEqual(r.status, 202, JSON.stringify(r.body));
  assert.strictEqual(await settled(meeting.d1), 'draft_ready');

  const sent = aiCalls[aiCalls.length - 1];
  const input = JSON.parse(sent.messages[0].content.match(/\{[\s\S]*\}\n\nRespond/)[0].replace(/\n\nRespond$/, ''));
  assert.match(input.transcript, /login fix is done/);
  assert.deepStrictEqual(input.attendees.sort(), ['MoM A1', 'MoM A2']);
  assert.strictEqual(input.meeting.date, '2027-04-05');
  assert.match(sent.system, /Never give performance ratings/);

  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr');
  assert.strictEqual(r.body.meeting.status, 'draft_ready');
  assert.strictEqual(r.body.minutes.source, 'ai');
  assert.strictEqual(r.body.minutes.ai_confidence, 'high');
  assert.deepStrictEqual(r.body.minutes.discussion, ['Login fix status', 'Export report', 'Release freeze']);
  assert.deepStrictEqual(r.body.action_items.map((a) => [a.task, a.owner_id, a.due_date]), [
    ['Finish the export report', id.a1, '2027-04-07'], ['Update the onboarding guide', null, null]]);
  assert.deepStrictEqual(r.body.minutes.attendance, { [id.a1]: 'present', [id.a2]: 'absent' });
  assert.match(r.body.transcript.text, /staging VPN/);
  assert.deepStrictEqual(r.body.transcript.speakers, ['MoM Mgr', 'MoM A1']);
  assert.strictEqual(r.body.can_record, true);
  assert.match((await notes('mgr', 'mom_draft_ready'))[0].title, /AI draft ready/);
  assert.strictEqual(await mails('mom_draft_ready'), 1);
  const stored = (await db.query(`SELECT input FROM agentic.drafts WHERE tenant_id=$1 AND kind='mom_draft'`, [tenantId])).rows;
  assert.strictEqual(stored.length, 1, 'the draft is stored with the input that produced it');

  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.body.minutes, null, 'still the organiser\'s until published');
  assert.strictEqual(r.body.transcript, null);

  // A draft is not written over without the organiser saying so.
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/transcript`, 'mgr', { text: TRANSCRIPT });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.needs_replace, true);

  // Publishing still needs the owner and due date the AI left blank.
  const body = { ...r.body };
  const cur = (await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr')).body;
  const items = cur.action_items.map((a) => ({ id: a.id, task: a.task, owner_id: a.owner_id, due_date: a.due_date, priority: a.priority }));
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/publish`, 'mgr', { ...cur.minutes, action_items: items });
  assert.strictEqual(r.status, 422);
  assert.deepStrictEqual(r.body.errors.length, 2, JSON.stringify(body));
  items[1].owner_id = id.a2; items[1].due_date = '2027-04-09';
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/publish`, 'mgr', { ...cur.minutes, action_items: items });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await mails('mom_published'), 2, 'both attendees are emailed');
  assert.strictEqual(await mails('mom_action_assigned'), 2);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/transcript`, 'mgr', { text: TRANSCRIPT, replace: true });
  assert.strictEqual(r.status, 409, 'published: no more drafts');
});

test('an AI failure is reported and can be tried again; a .docx transcript works; consent gates the upload', { skip }, async () => {
  aiReply = 'down';
  let r = await call('POST', `/pms/mom/meetings/${meeting.d2}/transcript`, 'mgr', { text: TRANSCRIPT });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(await settled(meeting.d2), 'scheduled');
  r = await get(`/pms/mom/meetings/${meeting.d2}`, 'mgr');
  assert.ok(r.body.draft_error, 'the failure is on the MoM');
  assert.strictEqual((await notes('mgr', 'mom_draft_failed')).length, 1);

  aiReply = { summary: 'Short.', discussion: ['Export report'], decisions: [], action_items: [], blockers: [],
    carried_forward: [{ ref: 'C1', status: 'done', note: 'A1 said the export is done' }], present: [], confidence: 'low', confidence_reason: 'Much of the audio was unclear.' };
  r = await call('POST', `/pms/mom/meetings/${meeting.d2}/redraft`, 'mgr', {});
  assert.strictEqual(r.status, 202);
  assert.strictEqual(await settled(meeting.d2), 'draft_ready');
  r = await get(`/pms/mom/meetings/${meeting.d2}`, 'mgr');
  assert.strictEqual(r.body.minutes.ai_confidence, 'low');
  assert.match(r.body.minutes.ai_notes.confidence_reason, /unclear/);
  const sent = JSON.parse(aiCalls[aiCalls.length - 1].messages[0].content.match(/\{[\s\S]*\}\n\nRespond/)[0].replace(/\n\nRespond$/, ''));
  assert.deepStrictEqual(sent.open_items_from_previous.map((c) => c.task), ['Finish the export report', 'Update the onboarding guide'],
    'the open items of the previous MoM go with the transcript');
  assert.strictEqual(r.body.minutes.ai_notes.carried_hints.length, 1);
  assert.strictEqual(r.body.carried_forward.length, 2);
  assert.match((await notes('mgr', 'mom_draft_ready'))[1].body, /Low confidence/);

  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>MoM A1: export report finished and shared.</w:t></w:r></w:p><w:p><w:r><w:t>MoM Mgr: thanks, next we pick up the onboarding guide together this week.</w:t></w:r></w:p></w:body></w:document>`);
  const form = new FormData();
  form.append('file', new Blob([await zip.generateAsync({ type: 'nodebuffer' })]), 'Daily connect - Transcript.docx');
  form.append('replace', 'true');
  aiReply = { summary: 'Export done.', discussion: ['Export report finished'], decisions: [], action_items: [], blockers: [], carried_forward: [], present: [], confidence: 'high' };
  r = await realFetch(`${base}/pms/mom/meetings/${meeting.d2}/transcript`, { method: 'POST', headers: { Authorization: `Bearer ${tok.mgr}` }, body: form });
  assert.strictEqual(r.status, 202, await r.text());
  assert.strictEqual(await settled(meeting.d2), 'draft_ready');
  const tr = (await db.query(`SELECT text, source, file_name FROM pms.mom_transcripts WHERE meeting_id=$1`, [meeting.d2])).rows[0];
  assert.deepStrictEqual([tr.source, tr.file_name], ['google_meet', 'Daily connect - Transcript.docx']);
  assert.match(tr.text, /^MoM A1: export report finished and shared\.\nMoM Mgr:/);

  await call('POST', '/pms/mom/consent', 'a2', { accept: false });
  r = await call('POST', `/pms/mom/meetings/${meeting.d2}/transcript`, 'mgr', { text: TRANSCRIPT, replace: true });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /MoM A2 has not accepted the recording notice/);
  await call('POST', '/pms/mom/consent', 'a2', { accept: true });
});

test('HR sets retention and email; old recordings and transcripts are deleted, the MoM stays', { skip }, async () => {
  let r = await call('PUT', '/pms/mom/settings', 'mgr', { recording_days: 30 });
  assert.strictEqual(r.status, 403);
  r = await call('PUT', '/pms/mom/settings', 'hr', { recording_days: 0 });
  assert.strictEqual(r.status, 422);
  r = await call('PUT', '/pms/mom/settings', 'hr', { recording_days: 30, email: { reminder: false } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.settings.email, { reminder: false, published: true, action_items: true, missing: true, draft: true });
  const rec = (await db.query(`SELECT (delete_after - uploaded_at::date) AS days FROM pms.mom_recordings WHERE meeting_id=$1`, [meeting.d1])).rows[0];
  assert.strictEqual(rec.days, 30, 'applies to what is already stored');
  assert.match((await get('/pms/mom/consent', 'a1')).body.notice.text, /after 30 days/);
  r = await get('/pms/mom/settings', 'hr');
  assert.strictEqual(r.body.storage.ok, true);

  await mom.tick(tenantId, at('2027-04-07T08:00:00'));
  const before = await mails('mom_reminder');
  const out = await mom.tick(tenantId, at('2027-04-07T09:50:00'));
  assert.strictEqual(out.reminded, 1);
  assert.strictEqual(await mails('mom_reminder'), before, 'reminder emails off: the bell only');

  const up = (await db.query(`SELECT upload_id FROM pms.mom_recordings WHERE meeting_id=$1`, [meeting.d1])).rows[0].upload_id;
  await db.query(`UPDATE pms.mom_recordings SET delete_after=CURRENT_DATE WHERE meeting_id=$1`, [meeting.d1]);
  await db.query(`UPDATE pms.mom_transcripts SET delete_after=CURRENT_DATE WHERE meeting_id=$1`, [meeting.d1]);
  const swept = await mom.tick(tenantId, at('2027-04-08T08:00:00'));
  assert.strictEqual(swept.expired, 2);
  assert.ok(!fs.existsSync(path.join(storageDir, 'rec', up)));
  assert.strictEqual((await get(`/pms/mom/meetings/${meeting.d1}/recording`, 'a1')).status, 410);
  const tr = (await db.query(`SELECT text, deleted_at FROM pms.mom_transcripts WHERE meeting_id=$1`, [meeting.d1])).rows[0];
  assert.strictEqual(tr.text, null);
  assert.ok(tr.deleted_at);
  const draft = (await db.query(`SELECT input FROM agentic.drafts WHERE tenant_id=$1 AND kind='mom_draft' AND ref->>'meeting_id'=$2`, [tenantId, meeting.d1])).rows[0];
  assert.strictEqual(draft.input.transcript, '(deleted under the retention rule)');
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.body.minutes.status, 'published', 'the MoM stays');
  assert.ok(r.body.recording.deleted_at);
});

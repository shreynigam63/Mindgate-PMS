// node --test — Self-Appraisal overall self-rating (BR-5.3/5.4).
// Reported live with a screenshot: the rating column and cycle.rating_scale
// were already returned by GET, and PUT already accepted the field — but
// nothing on the page let an employee actually set it. This covers the
// backend side of that fix: validation against the cycle's own scale,
// reusing the same validateRating() helper Mid-Year Review uses. Real
// Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, cycleId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sar';
  process.env.TENANT_SLUG = 'sar-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SAR Emp','sar-emp@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'sar-emp@x.com',$2)`, [t.id, await bcrypt.hash('pass', 10)]);

  const scale = JSON.stringify([{ value: 6, label: 'A+' }, { value: 5, label: 'A' }, { value: 4, label: 'B+' }, { value: 3, label: 'B' }, { value: 2, label: 'C' }, { value: 1, label: 'D' }]);
  // A MIDYEAR-type cycle to start with; the last three tests flip it to
  // 'annual' to prove the rules below are the same either way. There was
  // briefly a split here — on an annual cycle overall_self_rating came
  // from the employee's own 7-parameter self-scoring instead — which made
  // the Self-Appraisal page present that figure as the official annual
  // rating. It never was one (BR-6.2/6.3 gives that exclusively to the
  // manager's scoring), so the column has a single owner again: the
  // per-KRA weighted average, on every cycle type.
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, rating_scale) VALUES ($1,'SAR Cycle','FYSAR','midyear','self_appraisal',$2) RETURNING id`,
    [t.id, scale])).rows[0];
  cycleId = cycle.id;

  // Second employee, with an approved KRA sheet (2 KRAs, 60/40 weights) —
  // for the weighted-average test below.
  const emp2 = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SAR Emp2','sar-emp2@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'sar-emp2@x.com',$2)`, [t.id, await bcrypt.hash('pass', 10)]);
  const sheet2 = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`, [t.id, cycle.id, emp2.id])).rows[0];
  await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Ship the launch',60,10)`, [t.id, sheet2.id]);
  await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Support the team',40,20)`, [t.id, sheet2.id]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

async function login(email) {
  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) });
  return r.json();
}
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('GET returns the cycle rating_scale, needed for the self-rating chips', { skip }, async () => {
  const { token } = await login('sar-emp@x.com');
  const r = await api('/pms/my/self-appraisal', token);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.cycle.rating_scale));
  assert.equal(r.body.cycle.rating_scale.length, 6);
});

test('PUT accepts a rating that matches the cycle scale, and it round-trips', { skip }, async () => {
  const { token } = await login('sar-emp@x.com');
  const put = await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ overall_self_rating: 5 }) });
  assert.equal(put.status, 200);
  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(Number(get.body.appraisal.overall_self_rating), 5);
});

test('PUT rejects a rating not on the cycle scale, instead of silently storing garbage', { skip }, async () => {
  const { token } = await login('sar-emp@x.com');
  const put = await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ overall_self_rating: 3.7 }) });
  assert.equal(put.status, 422);
  assert.match(put.body.error, /rating must be one of/);
});

test('omitting overall_self_rating on an unrelated PUT leaves the existing rating untouched', { skip }, async () => {
  const { token } = await login('sar-emp@x.com');
  await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ went_well: 'Shipped the launch on time.' }) });
  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(Number(get.body.appraisal.overall_self_rating), 5, 'still the value set two tests ago');
  assert.equal(get.body.appraisal.went_well, 'Shipped the launch on time.');
});

// Requested: a rating scale per KRA, with the overall DERIVED as the
// weighted average of those — not a separately, manually picked value.
test('overall_self_rating is auto-computed as the weighted average of per-KRA ratings, not manually set', { skip }, async () => {
  const { token } = await login('sar-emp2@x.com');
  await api('/pms/my/self-appraisal', token); // auto-creates the appraisal row, same as the page does on load
  const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=(SELECT id FROM core.employees WHERE email='sar-emp2@x.com')`, [cycleId])).rows[0];
  const kras = (await db.query(`SELECT id, weight FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows;
  assert.equal(kras.length, 2);

  const entries = { [kras[0].id]: { self_rating: 5, narrative: 'Great work' }, [kras[1].id]: { self_rating: 3, narrative: 'Solid' } };
  const put = await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ entries }) });
  assert.equal(put.status, 200);
  // KRA weights are 60/40 — 5*0.6 + 3*0.4 = 4.2
  assert.equal(Number(put.body.overall_self_rating), 4.2);

  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(Number(get.body.appraisal.overall_self_rating), 4.2, 'persisted, not just returned once');
  assert.equal(get.body.appraisal.entries[kras[0].id].self_rating, 5, 'the per-KRA rating is stored alongside the narrative');
});

test('a fractional computed average is accepted even though it is not an exact scale value', { skip }, async () => {
  // 4.2 above is itself proof of this, but confirmed explicitly: a direct
  // overall_self_rating of 4.2 would be REJECTED by validateRating (not an
  // exact scale entry) — the computed path must not go through that check.
  const { token } = await login('sar-emp2@x.com');
  const rejected = await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ overall_self_rating: 4.2 }) });
  assert.equal(rejected.status, 422, 'a MANUALLY-sent 4.2 is still correctly rejected — only the computed path allows fractional values');
});

// ---------------------------------------------------------------------------
// The annual cycle behaves EXACTLY as above. These flip cycle_type and pin
// that, because for a while it did not: overall_self_rating came from the
// employee's own 7-parameter self-scoring on annual cycles, which is what
// let the page label that figure the "Overall Annual Rating". The
// self-scoring is still captured (see self-parameter-scoring.test.js) —
// it just no longer writes this column, so there is one owner and no
// cycle-type-dependent surprise.
// ---------------------------------------------------------------------------

test('on an annual cycle a directly-sent overall_self_rating is stored, same as any other cycle type', { skip }, async () => {
  // This briefly answered 409 and pointed the caller at
  // PUT /my/parameter-scores — a route that no longer exists, since
  // employee self-scoring against the 7 parameters has been removed. This
  // column has one owner on every cycle type, so there is nothing to
  // refuse.
  await db.query(`UPDATE pms.cycles SET cycle_type='annual' WHERE id=$1`, [cycleId]);
  const { token } = await login('sar-emp@x.com');

  const put = await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ overall_self_rating: 5 }) });
  assert.equal(put.status, 200);
  assert.equal(Number(put.body.overall_self_rating), 5);
  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(Number(get.body.appraisal.overall_self_rating), 5, 'persisted, not just echoed');
});

test('on an annual cycle the per-KRA average drives overall_self_rating, overwriting whatever was there', { skip }, async () => {
  const { token } = await login('sar-emp2@x.com');
  const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=(SELECT id FROM core.employees WHERE email='sar-emp2@x.com')`, [cycleId])).rows[0];
  const kras = (await db.query(`SELECT id FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows;

  // A stale value on the row, as the old 7-parameter path would have left
  // it. The per-KRA average owns the column now, so it must win.
  await db.query(`UPDATE pms.self_appraisals SET overall_self_rating=4.6 WHERE cycle_id=$1 AND employee_id=(SELECT id FROM core.employees WHERE email='sar-emp2@x.com')`, [cycleId]);

  const put = await api('/pms/my/self-appraisal', token, {
    method: 'PUT',
    body: JSON.stringify({ entries: { [kras[0].id]: { self_rating: 1, narrative: 'x' }, [kras[1].id]: { self_rating: 1, narrative: 'y' } } }),
  });
  assert.equal(put.status, 200);
  // 60/40, both graded 1 → 1.0
  assert.equal(Number(put.body.overall_self_rating), 1);
  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(Number(get.body.appraisal.overall_self_rating), 1, 'the stale 4.6 is gone, not preserved');
  assert.equal(get.body.appraisal.entries[kras[0].id].self_rating, 1, 'and the entries themselves are stored');
});

test('a PUT that touches only prose reports the rating actually stored, not null', { skip }, async () => {
  const { token } = await login('sar-emp2@x.com');
  const put = await api('/pms/my/self-appraisal', token, { method: 'PUT', body: JSON.stringify({ went_well: 'Kept the pipeline green.' }) });
  assert.equal(put.status, 200);
  assert.equal(Number(put.body.overall_self_rating), 1, 'unchanged means unchanged, not cleared');
  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(Number(get.body.appraisal.overall_self_rating), 1);
});

// Reported from a screenshot of the Annual Review: every parameter showed
// an em-dash and the overall showed "0". Same defect class here —
// computeWeightedRating sums the weighted scores and an ungraded KRA
// contributes nothing, so NOTHING graded comes back as 0, and a stored 0
// renders as "Needs Improvement (0.0)": a rating nobody gave. Saving a
// narrative before grading anything is the ordinary way to hit it.
test('entries with no grades yet do not store an overall self-rating of 0', { skip }, async () => {
  const { token } = await login('sar-emp2@x.com');
  const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=(SELECT id FROM core.employees WHERE email='sar-emp2@x.com')`, [cycleId])).rows[0];
  const kras = (await db.query(`SELECT id FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows;
  await db.query(`UPDATE pms.self_appraisals SET overall_self_rating=NULL WHERE cycle_id=$1 AND employee_id=(SELECT id FROM core.employees WHERE email='sar-emp2@x.com')`, [cycleId]);

  // Narratives only — no self_rating on either KRA.
  const put = await api('/pms/my/self-appraisal', token, {
    method: 'PUT',
    body: JSON.stringify({ entries: { [kras[0].id]: { narrative: 'Wrote this before grading anything.' } } }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.overall_self_rating, null, 'no grades means no rating, not a zero');
  const get = await api('/pms/my/self-appraisal', token);
  assert.equal(get.body.appraisal.overall_self_rating, null);
  assert.equal(get.body.appraisal.entries[kras[0].id].narrative, 'Wrote this before grading anything.', 'the narrative is still saved');

  // One grade is enough to produce a figure — a partial average is a real
  // answer and is meant to show, unlike a total absence of grades.
  const put2 = await api('/pms/my/self-appraisal', token, {
    method: 'PUT',
    body: JSON.stringify({ entries: { [kras[0].id]: { self_rating: 5, narrative: 'x' } } }),
  });
  assert.equal(Number(put2.body.overall_self_rating), 3, '60% weight at grade 5, the other KRA ungraded');
});

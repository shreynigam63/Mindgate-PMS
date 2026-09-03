// node --test — Aspiring Career as a PLAN: milestones with dates and
// tracked progress, not just a target role and a paragraph.
//
// The gap this closes was concrete. The mid-year/annual AI assist was
// written to read "any progress marked in Aspiring Career" and there was
// no progress field anywhere — it could only quote the plan text back.
//
// Deliberately NOT tested, because deliberately not built: an approval
// workflow. BR-3.1 has employees define their own aspiration and the BRD
// has no manager sign-off for it, unlike KRAs and development plans.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId;

const api = async (path, token, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cms';
  process.env.TENANT_SLUG = 'cms-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CMS Mgr','cms-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, manager_id, designation) VALUES ($1,'CMS Emp','cms-emp@x.com','active',$2,'Engineer') RETURNING id`,
    [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const other = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, manager_id, designation) VALUES ($1,'CMS Other','cms-other@x.com','active',$2,'Engineer') RETURNING id`,
    [t.id, mgr.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'cms-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['cms-mgr@x.com', 'cms-emp@x.com', 'cms-other@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'CMS Cycle','FYCMS','annual','growth_planning') RETURNING id`,
    [t.id])).rows[0];
  cycleId = cycle.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (!HAS_DB) return; server.close(); await db.pool.end(); });

async function login(email) {
  const r = await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }),
  });
  return (await r.json()).token;
}

const MS = (title, date, extra = {}) => ({ title, target_date: date, ...extra });

test('milestones need a target role to hang off — the aspiration comes first', { skip }, async () => {
  const token = await login('cms-emp@x.com');
  const r = await api('/people/career/my-milestones', token, {
    method: 'PUT', body: JSON.stringify({ milestones: [MS('Lead a workstream', '2026-06-30')] }),
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /target role first/i);
});

test('a milestone without a date is refused, with the row named', { skip }, async () => {
  const token = await login('cms-emp@x.com');
  await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Technical Manager', target_timeline: '18 months' }) });

  const r = await api('/people/career/my-milestones', token, {
    method: 'PUT',
    body: JSON.stringify({ milestones: [MS('Lead a workstream', '2026-06-30'), { title: 'Mentor someone' }, MS('', '2026-09-30')] }),
  });
  assert.equal(r.status, 422);
  // Per-row, with the row number — the same reporting shape every other
  // bulk editor in this codebase uses. "Something is wrong" makes the
  // author hunt for it.
  assert.deepEqual(r.body.errors.map((e) => `${e.row}:${e.error}`).sort(),
    ['2:target date is required', '3:title is required']);
  const none = await db.query(`SELECT count(*)::int AS n FROM people.career_milestones WHERE tenant_id=$1`, [tenantId]);
  assert.equal(none.rows[0].n, 0, 'nothing partially saved');
});

test('milestones save, come back in order, and roll up to one progress figure', { skip }, async () => {
  const token = await login('cms-emp@x.com');
  const put = await api('/people/career/my-milestones', token, {
    method: 'PUT',
    body: JSON.stringify({ milestones: [
      MS('Lead a delivery workstream end to end', '2026-06-30', { description: 'One project, start to sign-off' }),
      MS('Run the technical design review', '2026-09-30'),
      MS('Mentor a junior through a full cycle', '2026-12-31'),
    ] }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.milestones.length, 3);
  assert.deepEqual(put.body.milestones.map((m) => m.title), [
    'Lead a delivery workstream end to end', 'Run the technical design review', 'Mentor a junior through a full cycle']);
  assert.equal(put.body.progress_pct, 0);

  const get = await api('/people/career/my-path', token);
  assert.equal(get.body.milestones.length, 3);
  assert.equal(get.body.progress_pct, 0);
});

test('no milestones means null progress, not 0% — they are different states', { skip }, async () => {
  // "No steps written down" and "steps written down, none started" are not
  // the same thing, and reporting the first as 0% says someone is failing
  // at something they never started.
  const token = await login('cms-other@x.com');
  await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Technical Manager' }) });
  const r = await api('/people/career/my-path', token);
  assert.deepEqual(r.body.milestones, []);
  assert.equal(r.body.progress_pct, null);
});

test('progress updates are NOT phase-gated — progress happens all year', { skip }, async () => {
  const token = await login('cms-emp@x.com');
  const before = await api('/people/career/my-path', token);
  const first = before.body.milestones[0];

  // Move the cycle well past Growth Planning, where the milestone TEXT is
  // locked, and confirm progress still moves. A gate here would mean
  // marking something done months after you actually did it.
  await db.query(`UPDATE pms.cycles SET phase='self_appraisal' WHERE id=$1`, [cycleId]);

  const blocked = await api('/people/career/my-milestones', token, {
    method: 'PUT', body: JSON.stringify({ milestones: [MS('Rewritten', '2026-06-30')] }),
  });
  assert.equal(blocked.status, 409, 'the text is locked outside Growth Planning');

  const moved = await api(`/people/career/my-milestones/${first.id}/progress`, token, {
    method: 'PUT', body: JSON.stringify({ progress_pct: 100 }),
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.progress_pct, 33, 'one of three complete, rounded');
  await db.query(`UPDATE pms.cycles SET phase='growth_planning' WHERE id=$1`, [cycleId]);
});

test('progress is rejected outside 0-100 rather than clamped silently', { skip }, async () => {
  const token = await login('cms-emp@x.com');
  const { body } = await api('/people/career/my-path', token);
  const id = body.milestones[0].id;
  for (const bad of [-5, 140, 'lots']) {
    const r = await api(`/people/career/my-milestones/${id}/progress`, token, { method: 'PUT', body: JSON.stringify({ progress_pct: bad }) });
    assert.equal(r.status, 400, `expected 400 for ${bad}`);
  }
});

test('one employee cannot move another employee’s milestone by guessing its id', { skip }, async () => {
  const mine = (await api('/people/career/my-path', await login('cms-emp@x.com'))).body.milestones[0];
  const other = await login('cms-other@x.com');
  const r = await api(`/people/career/my-milestones/${mine.id}/progress`, other, {
    method: 'PUT', body: JSON.stringify({ progress_pct: 0 }),
  });
  assert.equal(r.status, 404, 'scoped through the owning path, so it simply is not theirs');
  const still = await db.query(`SELECT progress_pct FROM people.career_milestones WHERE id=$1`, [mine.id]);
  assert.equal(still.rows[0].progress_pct, 100, 'and untouched');
});

test('re-saving the list keeps progress on milestones that survive the edit', { skip }, async () => {
  // Otherwise fixing a typo or reordering would silently reset months of
  // tracked progress.
  const token = await login('cms-emp@x.com');
  const r = await api('/people/career/my-milestones', token, {
    method: 'PUT',
    body: JSON.stringify({ milestones: [
      MS('Run the technical design review', '2026-09-30'),
      MS('Lead a delivery workstream end to end', '2026-07-31'), // reordered + date changed
      MS('Present at an internal forum', '2027-01-31'),          // brand new
    ] }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byTitle = Object.fromEntries(r.body.milestones.map((m) => [m.title, m.progress_pct]));
  assert.equal(byTitle['Lead a delivery workstream end to end'], 100, 'progress carried across the edit');
  assert.equal(byTitle['Present at an internal forum'], 0, 'a new one starts at zero');
  assert.equal(r.body.progress_pct, 33);
});

test('the manager sees how far along a report is, without an approval step', { skip }, async () => {
  const token = await login('cms-mgr@x.com');
  const r = await api('/people/career/team', token);
  assert.equal(r.status, 200);
  const row = r.body.team.find((x) => x.employee_id === empId);
  assert.equal(row.target_role, 'Technical Manager');
  assert.equal(row.milestone_count, 3);
  assert.equal(row.milestones_done, 1);
  assert.equal(row.progress_pct, 33);

  // A report with a path but no milestones reports null, matching the
  // employee's own view rather than claiming 0%.
  const empty = r.body.team.find((x) => x.name === 'CMS Other');
  assert.equal(empty.milestone_count, 0);
  assert.equal(empty.progress_pct, null);
});

test('careerPathFor — the reader other modules use — carries the milestones', { skip }, async () => {
  // This is what the mid-year/annual AI assist reads. Before migration 028
  // it returned a target role and a paragraph, so "progress marked in
  // Aspiring Career" was a promise nothing could keep.
  const { careerPathFor } = require('../modules/people');
  const p = await careerPathFor(tenantId, empId);
  assert.equal(p.target_role, 'Technical Manager');
  assert.equal(p.milestones.length, 3);
  assert.equal(p.progress_pct, 33);
  assert.ok(p.milestones.some((m) => m.progress_pct === 100), 'the completed one is visible to the model');
});

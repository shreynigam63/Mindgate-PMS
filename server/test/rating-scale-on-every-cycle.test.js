// node --test — every page that shows a rating is handed the scale to
// read it with.
//
// Reported on 28 Sep, with a screenshot of the Mid-Year checkpoint:
// "ratings still shows average number instead of alphabets average."
//
// The 24 Sep instruction — "ratings should be measured only in Alphabets
// and not numbers" — was answered with one formatter in the frontend
// (grade.jsx). A formatter needs the cycle's rating_scale to know which
// ladder it is reading. Twenty-one handlers in the performance module
// hand-built their own `cycle` object for the browser and only four of
// them remembered to include it, so most pages had no scale to pass and
// either printed the stored number or fell back to a default ladder that
// happens to be right for a five-point scale and wrong for any other.
//
// Fixing the five screens that were showing numbers would have left the
// twenty-second handler free to make the same mistake. So the shape is
// built in one place now, and this is the test that keeps it there: it
// walks the endpoints a rating-showing page actually calls and insists
// the scale came with the cycle.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId;
const tok = {};

// A scale that is deliberately NOT the five-point default the frontend
// falls back to. A test written against a five-point scale cannot tell
// "read the cycle's scale" from "guessed, and got lucky".
const SCALE = [
  { value: 1, label: 'Well Below' }, { value: 2, label: 'Below' },
  { value: 3, label: 'At Target' }, { value: 4, label: 'Above' },
  { value: 5, label: 'Well Above' }, { value: 6, label: 'Exceptional' },
];

const get = async (path, t) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-rating-scale';
  process.env.TENANT_SLUG = 'rating-scale-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mk = async (name, email, managerId) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active','Executive','Delivery',$4) RETURNING id`,
    [t.id, name, email, managerId || null])).rows[0].id;
  mgrId = await mk('S Manager', 's-mgr@x.com', null);
  empId = await mk('S Employee', 's-emp@x.com', mgrId);
  for (const e of ['s-mgr@x.com', 's-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass', 10)]);
  }
  // The manager runs the HR/HOD screens too — this test is about the
  // shape of the response, not about who may see it.
  for (const p of ['pms_admin', 'pms_hod', 'pms_team_eval']) {
    await db.query(`INSERT INTO core.user_permissions (tenant_id,email,permission) VALUES ($1,$2,$3)
                    ON CONFLICT DO NOTHING`, [t.id, 's-mgr@x.com', p]);
  }

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase,rating_scale)
     VALUES ($1,'FY26 Annual','FY26','annual','mid_year_review',$2) RETURNING id`,
    [t.id, JSON.stringify(SCALE)])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['mgr', 's-mgr@x.com'], ['emp', 's-emp@x.com']]) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

// Every endpoint a page that DISPLAYS a rating loads its cycle from.
// The list is the point: adding a screen means adding a line here.
const RATING_PAGES = [
  ['/pms/my/annual-review', 'emp', 'Final Rating — the Mid-Year checkpoint in the screenshot'],
  ['/pms/my/kra-sheet', 'emp', 'My KRAs — the mid-year rating beside each KRA'],
  ['/pms/my/self-appraisal', 'emp', 'Self Appraisal — the overall self-rating'],
  ['/pms/my/midyear-review', 'emp', 'Mid-Year Review — the derived overall'],
  ['/pms/team/kra-sheets', 'mgr', 'Team KRA Sheets — mid-year beside each KRA'],
  ['/pms/approvals', 'mgr', 'Approvals — mid-year beside each KRA'],
  ['/pms/hod/queue', 'mgr', 'Delivery Head Review — the manager and DH overalls'],
];

test('every rating-showing endpoint hands over the cycle rating scale', { skip }, async () => {
  const missing = [];
  for (const [path, who, why] of RATING_PAGES) {
    const r = await get(path, tok[who]);
    assert.equal(r.status, 200, `${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.ok(r.body.cycle, `${path} returned no cycle at all`);
    if (!Array.isArray(r.body.cycle.rating_scale)) { missing.push(`${path} (${why})`); continue; }
    // Not just present — the CYCLE'S. A hardcoded default would pass a
    // presence check and still show the wrong letters.
    assert.equal(r.body.cycle.rating_scale.length, SCALE.length, `${path} returned a scale of the wrong length`);
    assert.equal(r.body.cycle.rating_scale[5].label, 'Exceptional', `${path} did not return THIS cycle's scale`);
  }
  assert.deepEqual(missing, [],
    'these pages show a rating with no scale to read it with — they will print the stored number');
});

test('the per-employee team screens carry it too', { skip }, async () => {
  // Both take an :employeeId, so they cannot go in the table above.
  for (const path of [`/pms/team/annual-review/${empId}`, `/pms/team/midyear-review/${empId}`]) {
    const r = await get(path, tok.mgr);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    assert.ok(Array.isArray(r.body.cycle.rating_scale), `no scale from ${path}`);
    assert.equal(r.body.cycle.rating_scale[5].label, 'Exceptional', `${path} did not return THIS cycle's scale`);
  }
});

test('a cycle is never half-described: id, name and phase come with the scale', { skip }, async () => {
  // The old hand-built objects varied — three of them omitted `phase`,
  // which several pages use to decide whether a field is editable. One
  // shape means one answer everywhere.
  for (const [path, who] of RATING_PAGES) {
    const c = (await get(path, tok[who])).body.cycle;
    for (const k of ['id', 'name', 'phase', 'cycle_type', 'rating_scale']) {
      assert.ok(k in c, `${path} returned a cycle with no ${k}`);
    }
  }
});

test('no cycle is still no cycle — the shape does not invent one', { skip }, async () => {
  // The guard the helper must not break: with nothing live, these pages
  // render "no active cycle", and an object full of undefined would send
  // them down the wrong branch.
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  try {
    const r = await get('/pms/my/annual-review', tok.emp);
    assert.equal(r.status, 200);
    assert.equal(r.body.cycle, null, 'a closed cycle must read as no cycle, not as an empty one');
  } finally {
    await db.query(`UPDATE pms.cycles SET phase='mid_year_review' WHERE id=$1`, [cycleId]);
  }
});

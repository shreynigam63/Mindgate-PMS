// node --test — the Super 50 window and the derived 9-box, over HTTP.
//
// The pure tests cover the rules. These cover the things only a
// database can get wrong: which ratings the window actually contains,
// what happens when a published cycle and an imported year collide,
// and whether the grid places the people it claims to.
//
// Real Postgres, real HTTP. Skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, annualId, empA, empB, empC, adminTok, empTok;

const call = async (tok, path, method = 'GET', body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const SCALE = [{ label: 'A+', value: 5 }, { label: 'A', value: 4 }, { label: 'B+', value: 3 },
               { label: 'B', value: 2 }, { label: 'C', value: 1 }];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-s50';
  process.env.TENANT_SLUG = 's50-test-' + Date.now();
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
  await require('../migrations/049-competency-mapping').up(db);

  const mk = async (name, email, code) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,emp_code)
     VALUES ($1,$2,$3,'active','Engineer','Delivery',$4) RETURNING id`,
    [t.id, name, email, code])).rows[0].id;
  const adminId = await mk('S50 Admin', 's50-admin@x.com', '00001');
  empA = await mk('S50 Alpha', 's50-a@x.com', '00010');
  empB = await mk('S50 Beta', 's50-b@x.com', '00020');
  empC = await mk('S50 Gamma', 's50-c@x.com', '00030');

  for (const email of ['s50-admin@x.com', 's50-a@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'s50-admin@x.com','admin')`, [t.id]);

  // An ANNUAL cycle graded A+..C, and a MID-YEAR cycle on a completely
  // different scale — which is the shape that broke the importer.
  annualId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase,rating_scale)
     VALUES ($1,'S50 Annual FY26-27','FY26-27','annual','calibration',$2) RETURNING id`,
    [t.id, JSON.stringify(SCALE)])).rows[0].id;
  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase,rating_scale)
     VALUES ($1,'S50 Midyear','FY26-27','midyear','manager_eval',$2)`,
    [t.id, JSON.stringify([{ label: 'Outstanding', value: 5 }, { label: 'Exceeds', value: 4 }])]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  adminTok = await login('s50-admin@x.com');
  empTok = await login('s50-a@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const prior = async (empId, fy, grade, rating, sortYear) => db.query(
  `INSERT INTO pms.prior_ratings (tenant_id, employee_id, fiscal_year, grade, rating, sort_year)
   VALUES ($1,$2,$3,$4,$5,$6)
   ON CONFLICT (tenant_id, employee_id, fiscal_year)
     DO UPDATE SET grade=EXCLUDED.grade, rating=EXCLUDED.rating`,
  [tenantId, empId, fy, grade, rating, sortYear]);

test('an empty watchlist says WHY it is empty', { skip }, async () => {
  const r = await call(adminTok, '/pms/watchlist');
  assert.equal(r.status, 200);
  assert.equal(r.body.watchlist.length, 0);
  // The distinction the old page could not make: nobody qualifies
  // BECAUSE there is no history, not because nobody is good enough.
  assert.equal(r.body.coverage.employees, 4);
  assert.equal(r.body.coverage.with_any_history, 0);
  assert.equal(r.body.coverage.with_full_window, 0);
  assert.match(r.body.rule.statement, /Last 3 annual reviews all A or better, with this year at A\+/);
});

test('imported prior years fill the window and the rule fires', { skip }, async () => {
  await prior(empA, 'FY25-26', 'A+', 5, 2025);
  await prior(empA, 'FY24-25', 'A', 4, 2024);
  await prior(empA, 'FY23-24', 'A+', 5, 2023);
  // Beta: three years, but this year is only an A.
  await prior(empB, 'FY25-26', 'A', 4, 2025);
  await prior(empB, 'FY24-25', 'A+', 5, 2024);
  await prior(empB, 'FY23-24', 'A+', 5, 2023);
  // Gamma: only two years.
  await prior(empC, 'FY25-26', 'A+', 5, 2025);
  await prior(empC, 'FY24-25', 'A+', 5, 2024);

  const r = await call(adminTok, '/pms/watchlist');
  assert.deepEqual(r.body.watchlist.map((x) => x.name), ['S50 Alpha']);
  assert.equal(r.body.coverage.with_full_window, 2, 'Alpha and Beta; Gamma is short a year');

  const beta = r.body.nearly.find((x) => x.name === 'S50 Beta');
  assert.ok(beta, 'Beta is a near miss, not invisible');
  assert.equal(beta.reason, 'latest_not_top');
  // Gamma has too little history, which is NOT a near miss — listing
  // the unmeasured among the nearly-qualified would bury the real ones.
  assert.ok(!r.body.nearly.some((x) => x.name === 'S50 Gamma'));

  // The history comes back most-recent-first, with the grade.
  const alpha = r.body.watchlist[0];
  assert.deepEqual(alpha.history.map((h) => h.fiscal_year), ['FY25-26', 'FY24-25', 'FY23-24']);
  assert.deepEqual(alpha.history.map((h) => h.grade), ['A+', 'A', 'A+']);
});

test('a published cycle beats an imported row for the same year', { skip }, async () => {
  // Alpha's FY26-27 is published at C. It is a NEWER year than any
  // import, so it becomes "this year" and the streak breaks.
  await db.query(
    `INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating)
     VALUES ($1,$2,$3,1) ON CONFLICT (employee_id, cycle_id) DO UPDATE SET final_rating=1`,
    [tenantId, empA, annualId]);
  let r = await call(adminTok, '/pms/watchlist');
  assert.equal(r.body.watchlist.length, 0, 'a C this year takes Alpha off the list');

  // Now the same YEAR from both sources: the published one must win.
  await prior(empA, 'FY26-27', 'A+', 5, 2026);
  r = await call(adminTok, '/pms/watchlist');
  const alpha = r.body.nearly.find((x) => x.name === 'S50 Alpha')
    || r.body.watchlist.find((x) => x.name === 'S50 Alpha');
  assert.ok(alpha);
  assert.equal(alpha.history[0].fiscal_year, 'FY26-27');
  assert.equal(alpha.history[0].source, 'published',
    'the import must not override what this product actually published');
  assert.equal(alpha.history[0].rating, 1);
  // And it is counted once, not twice.
  assert.equal(alpha.history.filter((h) => h.fiscal_year === 'FY26-27').length, 1);
});

test('recompute writes the flag without waiting for a cycle to publish', { skip }, async () => {
  // Put Alpha back to qualifying.
  await db.query(`DELETE FROM pms.employee_performance_history WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empA]);
  await db.query(`DELETE FROM pms.prior_ratings WHERE tenant_id=$1 AND employee_id=$2 AND fiscal_year='FY26-27'`,
    [tenantId, empA]);

  const before = (await db.query(`SELECT super50_flag FROM core.employees WHERE id=$1`, [empA])).rows[0];
  assert.equal(before.super50_flag, false, 'nothing has published, so nothing has flagged them');

  const r = await call(adminTok, '/pms/watchlist/recompute', 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 1);
  assert.equal(r.body.on_list, 1);
  const after = (await db.query(`SELECT super50_flag FROM core.employees WHERE id=$1`, [empA])).rows[0];
  assert.equal(after.super50_flag, true);

  // Idempotent — running it again changes nothing.
  const again = await call(adminTok, '/pms/watchlist/recompute', 'POST');
  assert.equal(again.body.added, 0);
  assert.equal(again.body.removed, 0);

  // And it is audited, because this writes a flag that feeds retention.
  const trail = (await db.query(
    `SELECT action FROM pms.audit_log WHERE tenant_id=$1 AND action IN ('SUPER50_FLAGGED','SUPER50_RECOMPUTED')`,
    [tenantId])).rows.map((x) => x.action);
  assert.ok(trail.includes('SUPER50_FLAGGED'));
  assert.ok(trail.includes('SUPER50_RECOMPUTED'));
});

test('the rule is read from settings, not from the code', { skip }, async () => {
  // Beta fails only on "this year must be A+". Relax that to A and
  // they qualify — with no deploy.
  await call(adminTok, '/pms/hr/settings/super50_latest_grade', 'PUT', { value: 'A' });
  const r = await call(adminTok, '/pms/watchlist');
  assert.ok(r.body.watchlist.some((x) => x.name === 'S50 Beta'), 'Beta qualifies under the looser rule');
  assert.match(r.body.rule.statement, /this year at A\./);

  // A two-year window lets Gamma in — but only with this year back at
  // A+, since Gamma's latest is an A+ and the loosened rule above asks
  // for exactly an A. Resetting between the two is the point: these
  // are three independent settings, not one switch.
  await call(adminTok, '/pms/hr/settings/super50_latest_grade', 'PUT', { value: 'A+' });
  await call(adminTok, '/pms/hr/settings/super50_window', 'PUT', { value: '2' });
  const r2 = await call(adminTok, '/pms/watchlist');
  assert.ok(r2.body.watchlist.some((x) => x.name === 'S50 Gamma'),
    `two years of A+ qualifies under a 2-year window — got ${JSON.stringify(r2.body.watchlist.map((x) => x.name))}`);

  // Put it back.
  await call(adminTok, '/pms/hr/settings/super50_latest_grade', 'PUT', { value: 'A+' });
  await call(adminTok, '/pms/hr/settings/super50_window', 'PUT', { value: '3' });
});

test('Super 50 reads the ANNUAL scale even when a mid-year cycle is active', { skip }, async () => {
  // THE BUG THIS EXISTS FOR, found by importing a real file. The
  // active cycle here can be the mid-year one, graded
  // "Outstanding/Exceeds" — a scale with no A+ on it. Reading the
  // rule's grades off THAT made a perfectly good file of A/A+ ratings
  // fail with "A+ is not a grade on this scale".
  const r = await call(adminTok, '/pms/watchlist');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.scale.map((s) => s.label), ['A+', 'A', 'B+', 'B', 'C']);
  assert.notEqual(r.body.rule.statement.includes('scale'), true);
  assert.ok(r.body.watchlist.length + r.body.nearly.length > 0,
    'somebody is judged, rather than everybody failing on a scale mismatch');
});

test('the watchlist and the import are HR-only', { skip }, async () => {
  for (const [path, method] of [['/pms/watchlist', 'GET'], ['/pms/watchlist/recompute', 'POST'],
                                ['/pms/watchlist/prior-ratings/template.xlsx', 'GET']]) {
    const r = await call(empTok, path, method);
    assert.equal(r.status, 403, `${path} must refuse a non-admin`);
  }
});

// ---- the derived 9-box ---------------------------------------------------

test('the 9-box places people from the annual rating and the competencies', { skip }, async () => {
  // Alpha: top rating, strong forward competencies -> Star.
  // Beta:  top rating, weak forward competencies   -> Trusted professional.
  const comps = (await db.query(
    `SELECT id, category FROM pms.competencies WHERE tenant_id=$1`, [tenantId])).rows;
  const forward = comps.filter((c) => /LEADERSHIP|DIGITAL/.test(c.category));
  const functional = comps.filter((c) => /FUNCTIONAL/.test(c.category));
  assert.ok(forward.length && functional.length);

  for (const [emp, rating, fwd, fn] of [[empA, 5, 5, 1], [empB, 5, 2, 5]]) {
    await db.query(
      `INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating)
       VALUES ($1,$2,$3,$4) ON CONFLICT (employee_id, cycle_id) DO UPDATE SET final_rating=EXCLUDED.final_rating`,
      [tenantId, emp, annualId, rating]);
    const a = (await db.query(
      `INSERT INTO pms.competency_assessments (tenant_id, cycle_id, employee_id, manager_status)
       VALUES ($1,$2,$3,'submitted')
       ON CONFLICT (tenant_id, cycle_id, employee_id) DO UPDATE SET manager_status='submitted'
       RETURNING id`, [tenantId, annualId, emp])).rows[0].id;
    for (const c of forward) {
      await db.query(
        `INSERT INTO pms.competency_ratings (tenant_id, assessment_id, competency_id, required_level, manager_rating)
         VALUES ($1,$2,$3,4,$4) ON CONFLICT (assessment_id, competency_id)
           DO UPDATE SET manager_rating=EXCLUDED.manager_rating`, [tenantId, a, c.id, fwd]);
    }
    for (const c of functional) {
      await db.query(
        `INSERT INTO pms.competency_ratings (tenant_id, assessment_id, competency_id, required_level, manager_rating)
         VALUES ($1,$2,$3,4,$4) ON CONFLICT (assessment_id, competency_id)
           DO UPDATE SET manager_rating=EXCLUDED.manager_rating`, [tenantId, a, c.id, fn]);
    }
  }

  const r = await call(adminTok, '/pms/nine-box?source=derived');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cells = r.body.groups[0].cells;
  const find = (name) => Object.entries(cells).find(([, v]) => v.some((p) => p.name === name));
  assert.equal(find('S50 Alpha')[0], 'high-high');
  // Beta's FUNCTIONAL ratings are the best in the company and their
  // forward ones are the worst. If functional competencies leaked onto
  // the potential axis, Beta would not land in low potential.
  assert.equal(find('S50 Beta')[0], 'high-low');
  assert.equal(r.body.coverage.with_final_rating, 2);
  assert.equal(r.body.coverage.derived, 2);
});

test('the derived grid never overwrites a calibrated cell, and flags the difference', { skip }, async () => {
  await db.query(
    `INSERT INTO pms.top_talent (tenant_id, cycle_id, employee_id, nine_box_cell, noted_by)
     VALUES ($1,$2,$3,'mid-mid','test')
     ON CONFLICT (cycle_id, employee_id) DO UPDATE SET nine_box_cell='mid-mid'`,
    [tenantId, annualId, empA]);

  const cal = await call(adminTok, '/pms/nine-box?source=calibrated');
  assert.ok(cal.body.groups[0].cells['mid-mid'].some((p) => p.name === 'S50 Alpha'),
    'calibration still says what HR said');

  const der = await call(adminTok, '/pms/nine-box?source=derived');
  const alpha = der.body.groups[0].cells['high-high'].find((p) => p.name === 'S50 Alpha');
  assert.ok(alpha, 'and the derived view still says what the data says');
  assert.equal(alpha.differs, true);
  assert.equal(alpha.calibrated_cell, 'mid-mid');
  assert.equal(der.body.coverage.differs, 1);
  assert.ok(alpha.why.includes('final rating'), 'and it explains itself');
});

test('the 9-box is closed to somebody without the permission', { skip }, async () => {
  assert.equal((await call(empTok, '/pms/nine-box')).status, 403);
  assert.equal((await call(empTok, '/pms/nine-box?source=derived')).status, 403);
});

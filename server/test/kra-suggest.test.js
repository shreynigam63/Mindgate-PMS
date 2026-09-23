// node --test — AI-suggested KRAs: the candidate list, and the guarantees.
//
// Asked for on 23 Sep: "can we have AI suggested KRAs in My KRAs as per
// department and designation of employees."
//
// THE MODEL IS NOT TESTED HERE, and cannot be: it is a network call to a
// third party whose output varies by design. What IS tested is everything
// around it, which is where this feature can actually hurt someone:
//
//   1. THE CANDIDATE LIST IS CLOSED and correctly ordered. The model only
//      ever sees KRAs HR has published, nearest shelf first. If this
//      widens, the model starts being offered other departments' work.
//   2. THE MODEL NEVER SEES A WEIGHT. Ratings are computed from weights.
//      A model that could see one could nudge one, so the input carries
//      none and the weight is looked up from the library afterwards.
//   3. AN EMPLOYEE WITH NO DESIGNATION, OR NO LIBRARY, IS TOLD SO — the
//      route refuses rather than asking the model to invent a role.
//
// Real Postgres. Skips cleanly without DATABASE_URL. The route itself is
// exercised only as far as the AI call, which is absent in tests.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, salesId, infraId, nakedId;
const tok = {};

const post = async (p, t) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sug';
  process.env.TENANT_SLUG = 'sug-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  // No key: the route must reach the AI call and fail THERE, which is how
  // these tests prove everything before it ran.
  delete process.env.ANTHROPIC_API_KEY;
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

  const mk = async (name, email, dept, desig) => {
    const id = (await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,department,designation)
       VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`, [t.id, name, email, dept, desig])).rows[0].id;
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
    return id;
  };
  salesId = await mk('S Rep', 'sug-sales@x.com', 'Sales', 'Executive');
  infraId = await mk('I Eng', 'sug-infra@x.com', 'Infrastructure', 'Cloud Engineer');
  nakedId = await mk('N Body', 'sug-naked@x.com', 'Sales', null);

  // Three rings for the Sales Executive:
  //   own shelf     — Executive, Sales
  //   department    — Sales Manager, Sales (a neighbouring role)
  //   elsewhere     — Cloud Engineer, Infrastructure (MUST NOT appear)
  const lib = [
    ['Sales', 'Executive', 'Financial', 'Quota attainment', 'Hit 100% of assigned quota', 30],
    ['Sales', 'Executive', 'Customer', 'Pipeline hygiene', 'Every opportunity updated weekly', 20],
    ['Sales', 'Sales Manager', 'People', 'Coach the team', 'One coaching session per rep per month', 25],
    ['Infrastructure', 'Cloud Engineer', 'Operational', 'Platform uptime', '99.95% availability', 40],
    [null, 'Executive', 'Financial', 'Company-wide cost line', 'Keep spend within budget', null],
  ];
  for (const [dept, desig, cat, title, kpi, w] of lib) {
    await db.query(
      `INSERT INTO pms.kra_library (tenant_id, department, designation, category, title, measures, suggested_weight, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)`, [t.id, dept, desig, cat, title, kpi, w]);
  }

  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'S Cycle','FY26','annual','kra_open')`, [t.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['sales', 'sug-sales@x.com'], ['infra', 'sug-infra@x.com'], ['naked', 'sug-naked@x.com']]) {
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

// ---- the candidate list, which is what keeps the model grounded --------

test('candidates come from the employee\'s own shelf first, then their department', { skip }, async () => {
  const { kraSuggestionCandidates } = require('../modules/performance');
  const { candidates, rings } = await kraSuggestionCandidates(tenantId, salesId);
  const titles = candidates.map((c) => c.title);

  assert.ok(titles.includes('Quota attainment'), 'own shelf');
  assert.ok(titles.includes('Pipeline hygiene'), 'own shelf');
  assert.ok(titles.includes('Coach the team'), "a neighbouring role in the employee's own department");
  assert.ok(titles.includes('Company-wide cost line'), 'the company-wide shelf for this designation');

  // THE ONE THAT MATTERS: another department's work is not on the menu.
  assert.ok(!titles.includes('Platform uptime'),
    "Infrastructure's KRAs must never be offered to a Sales Executive");

  assert.equal(candidates[0].ring, 'own_shelf', 'nearest ring first');
  assert.ok(rings.own_shelf >= 2);
});

test('THE MODEL NEVER SEES A WEIGHT — the library keeps that number', { skip }, async () => {
  // Ratings are computed from weights. The candidate rows the route hands
  // to the model are built by stripping suggested_weight; the weight on a
  // returned suggestion is looked up from the library row afterwards. This
  // asserts the source still CARRIES the weight, so the lookup has
  // something to find — and the route's own input-building is asserted by
  // reading the route source, below.
  const { kraSuggestionCandidates } = require('../modules/performance');
  const { candidates } = await kraSuggestionCandidates(tenantId, salesId);
  const quota = candidates.find((c) => c.title === 'Quota attainment');
  assert.equal(quota.suggested_weight, 30, "the library's figure, available server-side");

  const src = require('fs').readFileSync(
    require.resolve('../modules/agentic/index.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/kra-suggest'"), src.indexOf("11) Aspiring-career"));
  const input = route.slice(route.indexOf('candidates: candidates.map'), route.indexOf('const out = await ai.narrate'));
  assert.ok(!/suggested_weight/.test(input),
    'the candidate list sent to the model must not carry suggested_weight');
  assert.ok(/suggested_weight: src\.suggested_weight/.test(route),
    'the weight on a suggestion must be read from the library row, not from the model');
});

test('a blank suggested weight stays blank — it must not become a zero', { skip }, async () => {
  const { kraSuggestionCandidates } = require('../modules/performance');
  const { candidates } = await kraSuggestionCandidates(tenantId, salesId);
  const wide = candidates.find((c) => c.title === 'Company-wide cost line');
  assert.equal(wide.suggested_weight, null, 'no suggested weight is not the same as 0%');
});

test('an employee in a department with no neighbours still gets their own shelf', { skip }, async () => {
  const { kraSuggestionCandidates } = require('../modules/performance');
  const { candidates, rings } = await kraSuggestionCandidates(tenantId, infraId);
  assert.deepEqual(candidates.map((c) => c.title), ['Platform uptime']);
  assert.equal(rings.own_shelf, 1);
});

test('no designation means no candidates and a reason, not a guess', { skip }, async () => {
  const { kraSuggestionCandidates } = require('../modules/performance');
  const r = await kraSuggestionCandidates(tenantId, nakedId);
  assert.equal(r.reason, 'no_designation');
  assert.deepEqual(r.candidates, []);
});

// ---- the route's refusals ----------------------------------------------

test('the route refuses before calling the model when there is no designation', { skip }, async () => {
  const r = await post('/agentic/kra-suggest', tok.naked);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no designation/i);
  assert.ok(!/ANTHROPIC/i.test(r.body.error), 'it never reached the AI call');
});

test('an empty library no longer refuses — it drafts for the role instead', { skip }, async () => {
  // CHANGED on 23 Sep at the client's request: "AI should be able to
  // suggest KRAs based on department and designation mapped to
  // employee", not only what the library holds. This used to 409. The
  // ~60 job titles with no published shelf were precisely the people
  // that refusal turned away, so now it proceeds and the model drafts.
  await db.query(`UPDATE core.employees SET designation='Nobody Holds This', department='Nowhere'
                   WHERE id=$1`, [nakedId]);
  const r = await post('/agentic/kra-suggest', tok.naked);
  assert.equal(r.status, 503, 'it reaches the AI call rather than refusing early');
  assert.match(r.body.error, /not configured|ANTHROPIC_API_KEY/i);
});

test('a DRAFTED KRA never carries a weight, whatever the model says', { skip }, async () => {
  // The one rule that did not move when the closed list opened up. The
  // model is told not to mention weights; this is what happens if it
  // does anyway — asserted against the route's own mapping, because a
  // drafted KRA with an invented weight would feed a rating.
  const src = require('fs').readFileSync(require.resolve('../modules/agentic/index.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/kra-suggest'"), src.indexOf('11) Aspiring-career'));
  const mapping = route.slice(route.indexOf('const drafted ='), route.indexOf('res.json('));
  assert.match(mapping, /suggested_weight: null/,
    'a drafted KRA must arrive weightless');
  assert.ok(!/suggested_weight: d\./.test(mapping),
    "the model's own weight, if it sends one, must never be read");
  assert.match(mapping, /source: 'ai'/, 'and it must be labelled as drafted, not as library');
});

test('with candidates it proceeds as far as the AI call, and fails THERE', { skip }, async () => {
  // Which is the proof that every guard above ran and passed: the only
  // thing left to stop it is the missing key.
  const r = await post('/agentic/kra-suggest', tok.sales);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not configured|ANTHROPIC_API_KEY/i);
});

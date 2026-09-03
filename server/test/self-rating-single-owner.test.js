// node --test — migration 032, the repair pass that comes with giving
// pms.self_appraisals.overall_self_rating a single owner.
//
// The column is the per-KRA weighted average on every cycle type now. It
// was briefly the employee's own 7-parameter self-score on annual cycles,
// which is what let the Self-Appraisal page label that figure the
// "Overall Annual Rating" — a rating an employee never sets (BR-6.2/6.3
// gives it to the MANAGER's scoring of the same 7 parameters). Rows left
// over from that arrangement carry a parameter-derived number under a
// heading describing a KRA-derived one, so 032 recomputes them.
//
// These are the three cases that actually matter: recompute where the
// KRAs are graded, clear where they are not, and DO NOT TOUCH a submitted
// appraisal (rewriting a figure someone signed off on would be worse than
// the mislabelling). Real Postgres; skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, tenantId, cycleId;
const ids = {};

// One employee per case, each with the SAME 60/40 sheet, so the only
// difference between them is the thing under test.
async function seedEmployee(key, { grades, status }) {
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,$2,$3,'active') RETURNING id`,
    [tenantId, `SRSO ${key}`, `srso-${key}@x.com`])).rows[0];
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
    [tenantId, cycleId, emp.id])).rows[0];
  const k1 = (await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Delivery',60,1) RETURNING id`,
    [tenantId, sheet.id])).rows[0];
  const k2 = (await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Quality',40,2) RETURNING id`,
    [tenantId, sheet.id])).rows[0];
  const entries = {};
  if (grades) {
    if (grades[0] != null) entries[k1.id] = { self_rating: grades[0], narrative: 'a' };
    if (grades[1] != null) entries[k2.id] = { self_rating: grades[1], narrative: 'b' };
  }
  // 4.6 is the stale parameter-derived value in every case — a number the
  // per-KRA grades below could not produce, so a passing assertion can
  // only mean it was recomputed rather than left alone.
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, entries, overall_self_rating, status)
     VALUES ($1,$2,$3,$4,4.6,$5)`,
    [tenantId, cycleId, emp.id, JSON.stringify(entries), status]);
  ids[key] = emp.id;
}

const ratingOf = async (key) => (await db.query(
  `SELECT overall_self_rating FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`,
  [cycleId, ids[key]])).rows[0].overall_self_rating;

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, ['srso-test-' + Date.now()])).rows[0];
  tenantId = t.id;
  const c = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'SRSO Cycle','FYSRSO','annual','self_appraisal') RETURNING id`,
    [tenantId])).rows[0];
  cycleId = c.id;

  await seedEmployee('graded', { grades: [5, 3], status: 'in_progress' });
  await seedEmployee('partial', { grades: [5, null], status: 'in_progress' });
  await seedEmployee('ungraded', { grades: null, status: 'in_progress' });
  await seedEmployee('submitted', { grades: [5, 3], status: 'submitted' });

  // The migration ran at boot before this data existed, so run its up()
  // directly against the rows above — the same function, not a copy of it.
  await require('../migrations/032-self-rating-single-owner').up(db);
});

after(async () => { if (HAS_DB) await db.pool.end(); });

test('a fully graded annual appraisal is recomputed from its per-KRA grades', { skip }, async () => {
  // 60/40 on grades 5 and 3 → 5*0.6 + 3*0.4 = 4.2, not the stale 4.6.
  assert.equal(Number(await ratingOf('graded')), 4.2);
});

test('a partly graded one keeps the partial figure the running route would show', { skip }, async () => {
  // Matches computeWeightedRating exactly: an ungraded KRA contributes
  // zero rather than being normalised away, so 5*0.6 = 3.0. The employee
  // sees the same "so far" number here as while they are still grading.
  assert.equal(Number(await ratingOf('partial')), 3);
});

test('one with no grades at all is cleared, not zeroed', { skip }, async () => {
  // NULL means "no self-rating yet". A 0 would render as "Needs
  // Improvement" — a rating nobody gave.
  assert.equal(await ratingOf('ungraded'), null);
});

test('a SUBMITTED appraisal is left exactly as it was', { skip }, async () => {
  assert.equal(Number(await ratingOf('submitted')), 4.6, 'a signed-off figure is not silently rewritten');
});

test('running the migration again changes nothing', { skip }, async () => {
  await require('../migrations/032-self-rating-single-owner').up(db);
  assert.equal(Number(await ratingOf('graded')), 4.2);
  assert.equal(Number(await ratingOf('partial')), 3);
  assert.equal(await ratingOf('ungraded'), null);
  assert.equal(Number(await ratingOf('submitted')), 4.6);
});

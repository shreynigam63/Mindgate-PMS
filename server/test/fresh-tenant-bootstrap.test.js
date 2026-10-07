// node --test — a brand-new tenant must get EVERY page, not just the ones
// that existed when migration 042 was written.
//
// THE BUG THIS PINS. Found on 5 Oct, rebuilding the local stack from an
// empty database: the HRBP tab and every RnR screen were simply absent.
// Not refused — absent. core.page_permission drives both the menu and the
// direct-URL guard, so a missing row removes the page from the nav and
// 404s the URL, and nothing anywhere says why.
//
// The cause is the oldest trap in this repo, written down in the
// conventions and still stepped in: index.js creates the tenant row AFTER
// runMigrations(), so a migration that loops `SELECT id FROM core.tenants`
// to seed per-tenant rows seeds NOBODY on a fresh deploy. 042 knows this
// and exports ensurePageSeeds() for index.js to call at boot. 068, 069 and
// 078 added 27 more pages between them and did not.
//
// It never showed on the client's box because that tenant already existed
// when those three migrations ran. It would have hit the next install —
// which is every new client.
//
// Two tests, doing different jobs:
//   1. the behaviour: a fresh tenant, taken through exactly the boot
//      sequence, ends up with the HRBP, RnR and HRBP-admin pages;
//   2. the guard: any migration that declares PAGES must also export an
//      ensure, and index.js must call it — so the next one cannot repeat
//      this quietly.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db;
before(async () => { if (HAS_DB) db = require('../core/db'); });
after(async () => { if (db && db.pool) await db.pool.end(); });

// Exactly what index.js runs against a tenant it has just created.
const BOOT_SEEDS = [
  ['002-default-permission-bundles', 'ensureTenantSeeds'],
  ['008-review-parameters', 'ensureDefaultParameters'],
  ['042-seed-page-permissions', 'ensurePageSeeds'],
  ['068-hrbp-scope', 'ensureHrbpScopePages'],
  ['069-hrbp-all-hr-pages', 'ensureHrbpPages'],
  ['078-rnr-pages', 'ensureRnrPages'],
  ['077-rnr', 'seedFor'],
  ['060-grade-ladder', 'seed'],
];

test('a tenant created after the migrations gets the HRBP and RnR pages', { skip }, async () => {
  const slug = `zz-fresh-${Date.now()}`;
  const t = (await db.query(
    `INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [slug])).rows[0].id;
  try {
    // A tenant born after the migrations starts with nothing.
    const before0 = (await db.query(
      `SELECT count(*)::int c FROM core.page_permission WHERE tenant_id=$1`, [t])).rows[0].c;
    assert.equal(before0, 0, 'a new tenant starts with no page rows — that is the whole problem');

    for (const [file, fn] of BOOT_SEEDS) {
      const m = require(`../migrations/${file}`);
      assert.equal(typeof m[fn], 'function', `${file} must export ${fn}() for index.js to call`);
      await m[fn](db, t);
    }

    const routes = new Set((await db.query(
      `SELECT route FROM core.page_permission WHERE tenant_id=$1`, [t])).rows.map((r) => r.route));

    // The HRBP pages: the whole tab, which was missing outright.
    const hrbp = require('../migrations/069-hrbp-all-hr-pages').PAGES;
    for (const [, route] of hrbp) {
      assert.ok(routes.has(route), `HRBP page ${route} missing — the HRBP tab would not appear`);
    }
    // The 7 RnR screens.
    for (const [, route] of require('../migrations/078-rnr-pages').PAGES) {
      assert.ok(routes.has(route), `RnR page ${route} missing — the screen would 404`);
    }
    // And HR's own screen for handing an HRBP their people. Without it an
    // HRBP exists but can never be given anyone, which looks like a bug in
    // the HRBP tab rather than a missing page.
    assert.ok(routes.has('/admin/hrbp'), 'HR cannot assign an HRBP remit without /admin/hrbp');

    // The retired bespoke view must NOT come back: a row for a route the
    // router does not serve is a menu entry that opens a blank screen.
    assert.ok(!routes.has('/hrbp/employees'), '/hrbp/employees was retired by 069');
    // Nor the nine taken off the HRBP tab on 7 Oct (085).
    for (const route of require('../migrations/085-hrbp-tab-trim').REMOVED) {
      assert.ok(!routes.has(route), `${route} was taken off the HRBP tab by 085 and must not be re-seeded`);
    }

    // The hrbp role needs the salary permission the HRBP tab's two
    // compensation pages sit behind, or those pages 403 from a menu that
    // offered them.
    const grants = (await db.query(
      `SELECT permission FROM core.role_permissions WHERE tenant_id=$1 AND role='hrbp'`, [t]))
      .rows.map((r) => r.permission);
    for (const perm of require('../migrations/069-hrbp-all-hr-pages').ROLE_GRANTS) {
      assert.ok(grants.includes(perm), `hrbp role is missing ${perm}`);
    }

    // THE RnR MASTER. Found by running this suite against a virgin
    // database on 5 Oct: rnr.awards was empty, so the nomination screen
    // offered nothing and the eligibility engine had no rules to apply.
    // 077 has carried a docstring since it was written saying it is
    // "seeded at request time as well as here" — index.js just never
    // made the call. The comment was true about the intent and false
    // about the code.
    const master = await db.query(
      `SELECT (SELECT count(*) FROM rnr.awards WHERE tenant_id=$1) AS awards,
              (SELECT count(*) FROM rnr.band_levels WHERE tenant_id=$1) AS bands,
              (SELECT count(*) FROM rnr.employment_statuses WHERE tenant_id=$1) AS statuses,
              (SELECT count(*) FROM rnr.settings WHERE tenant_id=$1) AS settings`, [t]);
    const m = master.rows[0];
    assert.equal(Number(m.awards), require('../migrations/077-rnr').AWARDS.length,
      'every award in the master must exist, or RnR has nothing to nominate for');
    assert.equal(Number(m.bands), require('../migrations/077-rnr').BANDS.length,
      'without the band mapping no employee resolves to a junior/mid/senior level');
    assert.ok(Number(m.statuses) > 0, 'no employment statuses means nobody counts as active');
    assert.equal(Number(m.settings), 1, 'the 3% quota and tenure rules come from this row');

    // THE GRADE LADDER, the third one the guard turned up. Without it the
    // Career Pathing Matrix is empty and no designation resolves to a
    // grade, so the increment and 9-box screens have nothing to work from.
    const ladder = (await db.query(
      `SELECT (SELECT count(*) FROM pms.grade_ladder WHERE tenant_id=$1) AS grades,
              (SELECT count(*) FROM pms.grade_roles WHERE tenant_id=$1) AS roles`, [t])).rows[0];
    assert.ok(Number(ladder.grades) > 0, 'a fresh tenant has no grade ladder');
    assert.ok(Number(ladder.roles) > 0, 'a fresh tenant has no role families');

    // Running the boot sequence twice must change nothing — it runs on
    // every boot, not only the first.
    const n1 = (await db.query(
      `SELECT count(*)::int c FROM core.page_permission WHERE tenant_id=$1`, [t])).rows[0].c;
    for (const [file, fn] of BOOT_SEEDS) await require(`../migrations/${file}`)[fn](db, t);
    const n2 = (await db.query(
      `SELECT count(*)::int c FROM core.page_permission WHERE tenant_id=$1`, [t])).rows[0].c;
    assert.equal(n2, n1, 'the boot seeds are not idempotent');
  } finally {
    for (const tbl of ['rnr.awards', 'rnr.band_levels', 'rnr.employment_statuses', 'rnr.settings',
      'pms.grade_roles', 'pms.grade_ladder', 'pms.designation_grade', 'pms.department_family']) {
      await db.query(`DELETE FROM ${tbl} WHERE tenant_id=$1`, [t]);
    }
    await db.query(`DELETE FROM core.page_permission WHERE tenant_id=$1`, [t]);
    await db.query(`DELETE FROM core.role_permissions WHERE tenant_id=$1`, [t]);
    await db.query(`DELETE FROM core.user_permissions WHERE tenant_id=$1`, [t]);
    await db.query(`DELETE FROM pms.review_parameters WHERE tenant_id=$1`, [t]);
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [t]);
  }
});

// THE SECOND GUARD, added after the first one proved too narrow. It only
// looked at migrations declaring PAGES, so it said nothing about 077,
// which declares AWARDS and exports seedFor() — a per-tenant seeder that
// existed, was documented as being called at boot, and was called by
// nobody. A seeder nothing calls is dead code that reads as a feature.
//
// Not "index.js must call it": some seeders are legitimately called from a
// module at request time (056's seedTemplates is). The rule is weaker and
// still catches this — somebody outside migrations/ and test/ has to call
// it at all.
test('every per-tenant seeder a migration exports is actually called somewhere', () => {
  const root = path.join(__dirname, '..');
  const dir = path.join(root, 'migrations');
  const sources = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'migrations', 'test', '.git'].includes(e.name)) continue;
        walk(full);
      } else if (e.name.endsWith('.js')) sources.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  const callers = sources.join('\n');

  const orphans = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const m = require(path.join(dir, file));
    for (const name of Object.keys(m)) {
      if (typeof m[name] !== 'function') continue;
      if (!/^(ensure|seed)/.test(name)) continue;
      if (!new RegExp(`\\b${name}\\s*\\(`).test(callers)) {
        orphans.push(`${file} exports ${name}() and nothing outside migrations/ calls it`);
      }
    }
  }
  assert.deepEqual(orphans, [],
    'a per-tenant seeder that nobody calls leaves a fresh install missing that data:\n'
    + orphans.join('\n'));
});

// THE GUARD. The test above only knows about the three migrations that
// were already wrong. This one fails for the NEXT one.
test('every migration that declares PAGES exports an ensure, and index.js calls it', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!/INSERT INTO core\.page_permission/.test(src)) continue;
    const m = require(path.join(dir, file));
    if (!Array.isArray(m.PAGES) || !m.PAGES.length) continue;   // see note below
    const ensure = Object.keys(m).find((k) => /^ensure/.test(k) && typeof m[k] === 'function');
    const stem = file.replace(/\.js$/, '');
    if (!ensure) { offenders.push(`${file} seeds pages but exports no ensure*()`); continue; }
    if (!indexSrc.includes(stem) || !indexSrc.includes(`${ensure}(`)) {
      offenders.push(`${file} exports ${ensure}() but index.js never calls it at boot`);
    }
  }
  assert.deepEqual(offenders, [],
    'a migration seeding page_permission per tenant cannot reach a tenant created after it ran:\n'
    + offenders.join('\n'));
});

// A migration that inlines its page rows without exporting PAGES is out of
// the guard's reach — 047, 048, 050, 053 and 058 all do that. They are
// safe today only because every page they add is ALSO in 042's list, which
// is the list index.js seeds. Asserted here so that stays true rather than
// being a thing somebody remembered.
test('migrations that inline page rows add nothing 042 does not already carry', { skip }, async () => {
  const base = new Set(require('../migrations/042-seed-page-permissions').PAGES.map((p) => p[0]));
  const dir = path.join(__dirname, '..', 'migrations');
  const missing = [];
  for (const file of ['047-page-moves-and-parameter-removal.js', '048-manager-dashboard-page.js',
    '050-competency-pages.js', '053-timesheet.js', '058-engagement-insights.js']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // The page key is the first string in each row literal it inserts.
    for (const key of src.matchAll(/\[\s*'([a-z0-9_]+)'\s*,\s*'\/[^']*'/g)) {
      if (!base.has(key[1])) missing.push(`${file}: page '${key[1]}' is in no boot-seeded list`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('a tenant created after migrations still gets the HRBP role bundle', () => {
  // 068 granted it in up() only, to tenants that existed then — the
  // core.tenants trap this file exists for. The boot seed must carry it.
  const { BUNDLES } = require('../migrations/002-default-permission-bundles');
  assert.deepEqual([...BUNDLES.hrbp].sort(), ['engagement_take', 'onboarding_ops', 'people_view', 'pms_hrbp', 'pms_self']);
  assert.ok(BUNDLES.hr.includes('pms_hrbp'), 'HR opens the HRBP pages too (068)');
});

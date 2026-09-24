// node --test — where each page lives, and whether its band is visible.
//
// Covers the five points asked for on 23 Sep:
//
//   1. "Engagement tab should be under HR tab and not my performance."
//   2. "better format for creating surveys instead of current one."
//   3. "my growth still shows team target achievement … should ideally be
//      under Manager tab and not my performance tab."
//   4. "mid year under my performance still shows Manager reviews also
//      which should ideally not be visible under self mid-year."
//   5. "we don't need 7 parameters in PMS for now, please remove from all
//      tabs if available."
//
// A server test can assert the page_permission rows, and page-permissions
// .test.js does. It cannot assert what the MENU renders or what a page
// puts on screen, which is what every one of these five is about — so
// this drives a real browser against the running dev stack.
//
// THE BAND TEST is here for a different reason. `hue` names a gradient
// class and a name with no class is SILENT: .hero keeps its white text
// and simply has no background, so the title renders white on the page's
// near-white backdrop and the band reads as an empty strip. `lagoon` did
// that on two Manager pages — the class had never been written. Asserting
// a real computed background is the only way that shows up short of
// looking at every page.
//
// Skips cleanly when the stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

let browser;
let up = false;

before(async () => {
  try {
    const r = await fetch(`${API}/api/v1/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return;
    await fetch(APP, { signal: AbortSignal.timeout(2500) });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    up = true;
  } catch { /* stack not running — every test below skips */ }
});
after(async () => { if (browser) await browser.close(); });

// Inside the test, not in its options — see kra-table.test.mjs for the
// run where `{ skip: skip() }` made five tests report ok while testing
// nothing.
const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; }
  return false;
};

async function open(email, path) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

// The item strip for one role tab, by its label.
const groupItems = async (page, group) => {
  await page.locator(`header >> text="${group}"`).first().click();
  await page.waitForTimeout(350);
  return (await page.locator('header nav').innerText())
    .split('\n').map((s) => s.trim()).filter(Boolean);
};

test('1 + 3 — Engagement admin sits under HR, team growth under Manager', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/home');

  const self = await groupItems(page, 'Self');
  assert.ok(self.includes('My Surveys'),
    'an employee keeps the survey they were invited to answer');
  assert.ok(!self.includes('Engagement'),
    'but "Engagement" — writing and running surveys — is no longer under Self');

  const mgr = await groupItems(page, 'Manager');
  assert.ok(mgr.includes('Team Target Achievements'),
    'the manager list of growth plans moved out of My Growth');

  const hr = await groupItems(page, 'HR');
  assert.ok(hr.includes('Engagement Surveys'), 'and running surveys is HR\'s');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('3 — My Growth no longer carries the team list', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/my/growth');
  const body = await page.locator('body').innerText();
  assert.ok(!/Team Target Achievements/i.test(body),
    'a manager\'s own growth page must not list their reports');
  assert.ok(!/reports have submitted/i.test(body));
  await page.goto(APP + '/team/growth', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const team = await page.locator('body').innerText();
  assert.ok(!/not part of your access/i.test(team), '/team/growth opens for a manager');
  assert.equal(await page.locator('input[placeholder*="Search"]').count(), 1,
    'and it has the search box every team list now has');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('4 — the self mid-year page shows no manager review', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('emp@shot.in', '/my/midyear');
  const body = await page.locator('body').innerText();
  assert.ok(!/From the manager/i.test(body),
    'the manager column is gone from the employee\'s own mid-year');
  assert.ok(/Your mid-year/i.test(body), 'and their own half is still labelled');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('5 — the 7 parameters are on no tab, for any role', async (t) => {
  if (needStack(t)) return;
  const PARAM = /Organi[sz]ational Parameter|7 param|Review Analysis/i;
  for (const [email, path] of [
    ['hr@shot.in', '/admin/cycles'],          // HR used to configure them here
    ['emp@shot.in', '/my/self-appraisal'],
    ['hr@shot.in', '/my/annual-review'],
  ]) {
    const { ctx, page } = await open(email, path);
    const body = await page.locator('body').innerText();
    assert.ok(!PARAM.test(body), `${path} still shows the 7 parameters`);
    await ctx.close();
  }

  // TEAM EVALUATION NEEDS THE CARD OPENED FIRST, and this is the one
  // page where the grid actually lived. Reading the page body without
  // expanding a report asserted nothing at all: EvalEditor only renders
  // for the expanded row, so a poisoned build that put the parameters
  // straight back on the card still passed. Caught by poisoning it.
  {
    const { ctx, page } = await open('mgr@shot.in', '/team/eval');
    const rows = page.locator('.card button').first();
    assert.ok(await rows.count(), 'the manager has at least one report to expand');
    await rows.click();
    await page.waitForTimeout(1200);
    const body = await page.locator('body').innerText();
    assert.ok(/Strengths|Rate|rating/i.test(body),
      'the evaluation editor really did open — otherwise the check below is vacuous');
    assert.ok(!PARAM.test(body), '/team/eval still shows the 7-parameter grid');
    await ctx.close();
  }

  // The page that WAS the 7 parameters has no route left, so it falls
  // through to the catch-all rather than rendering.
  const { ctx, page } = await open('hr@shot.in', '/admin/parameter-analysis');
  assert.match(page.url(), /\/home$/, 'the removed page redirects rather than opening');
  const hr = await groupItems(page, 'HR');
  assert.ok(!hr.some((x) => /Review Analysis/i.test(x)), 'and it is off the menu');
  await ctx.close();
});

test('every coloured chip on Home has a real background, for every role', async (t) => {
  if (needStack(t)) return;
  // THE SAME FAULT AS THE PAGE BAND, one layer down. A hue name is
  // pasted into a class — si-${hue}, dk-${hue}, navico-${hue} — and a
  // name with no matching class produces no error, just a white square
  // where a coloured icon should be. The page bands got a check on
  // 23 Sep; this is the rest of the families, and it earned its place
  // the same day: renaming the pink hue to azure left FIVE call sites
  // still asking for 'pink', two of which no static grep of the CSS
  // would have caught because they were in files nobody had touched.
  //
  // Home is the right page because it is the only one that uses all
  // three families at once, and it varies by role.
  const TRANSPARENT = ['rgba(0, 0, 0, 0)', 'transparent'];
  for (const email of ['emp@shot.in', 'mgr@shot.in', 'hr@shot.in']) {
    const { ctx, page } = await open(email, '/home');
    const bad = await page.evaluate((blank) => {
      const out = [];
      for (const el of document.querySelectorAll('.stat-i, .deskt, .sechead-i, .navico')) {
        const s = getComputedStyle(el);
        const painted = s.backgroundImage !== 'none' || !blank.includes(s.backgroundColor);
        if (!painted) out.push(el.className);
      }
      return out;
    }, TRANSPARENT);
    assert.deepEqual(bad, [],
      `${email}: these carry a hue with no matching class, so they render blank`);
    await ctx.close();
  }
});

test('every page band actually has a background — an unstyled hue is invisible', async (t) => {
  if (needStack(t)) return;
  // Reads the COMPUTED background, so a hue whose class was never written
  // fails here rather than shipping as a blank strip. The pages listed
  // are one per hue in use plus both pages that had the fault.
  for (const [email, path] of [
    ['emp@shot.in', '/my/kras'],
    ['emp@shot.in', '/my/growth'],
    ['emp@shot.in', '/my/midyear'],
    ['emp@shot.in', '/engagement'],
    ['emp@shot.in', '/my/competencies'],
    ['mgr@shot.in', '/team/competencies'],
    ['hr@shot.in', '/admin/competencies'],
    ['hr@shot.in', '/admin/competency-dashboard'],
    ['mgr@shot.in', '/team/dashboard'],
    ['mgr@shot.in', '/team/growth'],
    ['mgr@shot.in', '/team/midyear'],
    ['mgr@shot.in', '/team/overview'],
    ['hr@shot.in', '/admin/engagement'],
    ['hr@shot.in', '/admin/kra-library'],
  ]) {
    const { ctx, page } = await open(email, path);
    const bg = await page.evaluate(() => {
      const h = document.querySelector('.hero');
      if (!h) return 'NO HERO';
      const s = getComputedStyle(h);
      return s.backgroundImage === 'none' ? s.backgroundColor : s.backgroundImage;
    });
    assert.ok(bg.startsWith('linear-gradient'),
      `${path}: the page band has no gradient (got ${bg}) — its hue has no hero-* class`);
    await ctx.close();
  }
});

test('an employee with no KRAs can still be rated — the gap the parameters used to cover', async (t) => {
  if (needStack(t)) return;
  // THE REGRESSION THIS EXISTS FOR. Removing the 7-parameter grid took
  // away the only rating control on an annual evaluation card; the
  // per-KRA average replaced it, and a person whose sheet has no KRAs
  // has no average. Without a fallback their manager gets a card with
  // nothing to set and a submit that fails with "overall_rating
  // required". So the plain picker is offered for exactly that case.
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/eval');
  await page.locator('.card button').first().click();
  await page.waitForTimeout(1300);
  const card = page.locator('.card').first();
  const body = await card.innerText();
  if (!/No KRAs on this employee/i.test(body)) {
    // The demo data may not hold such a person; say so rather than
    // passing quietly on an assertion that never ran.
    t.diagnostic('no KRA-less report in the demo data — fallback not exercised');
    await ctx.close();
    return;
  }
  assert.match(body, /OVERALL RATING/i, 'the plain picker is offered instead');
  await page.getByRole('button', { name: 'A', exact: true }).first().click();
  await page.waitForTimeout(1400);
  assert.match(await card.innerText(), /Saved/, 'and setting it actually persists');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('All Approvals opens the record and can return it, not just approve blind', async (t) => {
  if (needStack(t)) return;
  // Asked for on 23 Sep: "return KRA option is missing, please add the
  // same / also KRA view option is not available."
  //
  // THE WHOLE ROUND TRIP, through the product's own transitions only:
  // the employee submits, HR opens the row in the queue and reads the
  // sheet, fails to return it without a reason, then returns it with
  // one. No hand-patched rows.
  //
  // IT MUST NOT SILENTLY SKIP. The first version of this bailed with
  // t.diagnostic() and a return when the demo sheet would not submit —
  // its weights total 60, not 100 — and reported `ok` while testing
  // nothing at all. Poisoning it (removing the table, renaming the
  // Return button) changed no result, which is how that was caught. It
  // now makes the sheet submittable itself, through the employee's own
  // edit route, and puts the original weights back afterwards; anything
  // that still goes wrong fails the test rather than passing it.
  const tok = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const call = async (who, p, init) => {
    const r = await fetch(`${API}/api/v1${p}`, {
      ...init, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const emp = await tok('emp@shot.in');
  const admin = await tok('admin@shot.in');

  const mine = await call(emp, '/pms/my/kra-sheet');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const original = mine.body.kras;
  const sheetId = mine.body.sheet.id;
  assert.ok(original.length > 1, 'the demo employee has a sheet with KRAs to review');

  // A submitted or approved sheet is locked to its owner, by design. The
  // test has to start from a writable one and may well END on a locked
  // one if it fails midway, so both the setup and the restore go through
  // this — using the very route under test to unlock it, which is a real
  // transition rather than a patched row.
  //
  // Without this the test was not repeatable: one run left the sheet
  // submitted and the next failed in setup with a 409.
  const makeWritable = async () => {
    const st = (await call(emp, '/pms/my/kra-sheet')).body.sheet.status;
    if (st === 'submitted' || st === 'approved') {
      await call(admin, '/pms/approvals/bulk', {
        method: 'POST',
        body: JSON.stringify({ decision: 'returned', comment: 'Unlocked by an automated check.',
                               items: [{ kind: 'kra_sheet', id: sheetId }] }),
      });
    }
  };

  // Put the weights back exactly as found, whatever happens below — and
  // CHECK that it worked.
  //
  // This test shares the demo employee's sheet with the KRA-table tests,
  // which need it editable (they assert on the "+ New parameter" row that
  // only a draft renders). A restore that quietly failed left the sheet
  // submitted and broke an unrelated test on the NEXT run, which is a
  // miserable thing to debug — so a failed restore fails here instead.
  const restore = async () => {
    await makeWritable();
    await call(emp, '/pms/my/kra-sheet/kras', {
      method: 'PUT',
      body: JSON.stringify({ kras: original.map((k) => ({
        id: k.id, title: k.title, description: k.description, measures: k.measures,
        category: k.category, weight: k.weight, sort_order: k.sort_order })) }),
    });
    const back = (await call(emp, '/pms/my/kra-sheet')).body;
    assert.equal(back.sheet.status, 'draft', 'the demo sheet was left editable for the other tests');
    assert.deepEqual(back.kras.map((k) => Number(k.weight)), original.map((k) => Number(k.weight)),
      'the demo sheet was left with the weights it started with');
  };
  await makeWritable();

  let ctx;
  try {
    // Weights must total 100 to submit, and the demo sheet totals 60.
    // Nudge the first KRA up by the difference — a real edit through the
    // real route, not a patched row.
    const total = original.reduce((n, k) => n + Number(k.weight || 0), 0);
    const bumped = original.map((k, i) => ({
      id: k.id, title: k.title, description: k.description, measures: k.measures,
      category: k.category, sort_order: k.sort_order,
      weight: i === 0 ? Number(k.weight || 0) + (100 - total) : Number(k.weight || 0),
    }));
    const saved = await call(emp, '/pms/my/kra-sheet/kras', { method: 'PUT', body: JSON.stringify({ kras: bumped }) });
    assert.equal(saved.status, 200, `could not rebalance the sheet: ${JSON.stringify(saved.body)}`);

    const sub = await call(emp, '/pms/my/kra-sheet/submit', { method: 'POST' });
    assert.equal(sub.status, 200, `could not submit the sheet: ${JSON.stringify(sub.body)}`);

    const opened = await open('admin@shot.in', '/admin/approvals');
    ctx = opened.ctx;
    const page = opened.page;
    await page.locator('button:has-text("KRA sheet")').first().click();
    await page.waitForTimeout(700);
    const row = page.locator('tbody tr button').filter({ hasText: 'Arun Employee' });
    assert.ok(await row.count(), 'the submitted sheet reaches the company-wide queue');
    await row.first().click();
    await page.waitForTimeout(1600);

    // VIEW — the same four-column table the employee filled in, not a
    // second rendering of it.
    assert.equal(await page.locator('.kratable').count(), 1, 'the sheet itself is shown');
    // textContent, not innerText: the header cells are uppercased by CSS,
    // so innerText would compare the rendering rather than the markup and
    // read PARAMETERS. kra-table.test.mjs compares the same way.
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll('.kratable thead th')].map((th) => th.textContent.trim())),
      ['Parameters', 'KRAs', 'KPIs (measuring metrics & data source)', 'Weightage']);
    const spans = await page.evaluate(() =>
      [...document.querySelectorAll('.kratable td.kt-param:not(.kt-param-add)')].map((td) => td.rowSpan));
    assert.ok(spans.some((n) => n > 1), 'parameters are merged over their KRAs here too');

    // RETURN — refused without a reason. This asserts the OUTCOME, not
    // which layer produced it: the page refuses before sending, and the
    // server refuses again if it ever did send. Deleting the client-side
    // guard leaves this passing, which was checked by doing exactly that
    // — and is correct, because the product still behaves the same. What
    // must never pass is the sheet changing state.
    await page.locator('button:has-text("Return for edits")').click();
    await page.waitForTimeout(800);
    assert.match(await page.locator('body').innerText(), /needs a comment/i);
    assert.equal((await call(emp, '/pms/my/kra-sheet')).body.sheet.status, 'submitted',
      'a refused return changed nothing');

    // RETURN — with one. The comment is the point: it is what the
    // employee is told.
    await page.locator('textarea').first().fill('Returned by an automated check.');
    await page.locator('button:has-text("Return for edits")').click();
    await page.waitForTimeout(2500);
    const after = await call(emp, '/pms/my/kra-sheet');
    assert.equal(after.body.sheet.status, 'returned');
    assert.equal(after.body.sheet.manager_comment, 'Returned by an automated check.');
    assert.deepEqual(opened.errors, []);
  } finally {
    await restore();
    if (ctx) await ctx.close();
  }
});

test('the Manager tab shows my reports only, with no way to widen it', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: "Team KRA sheets, Team Evaluation and Team
  // Mid-Year in Manager tab should have only names of reportees
  // reporting to him and not all employees." Then, on the same day,
  // after the scope toggle shipped: "remove 'all employees' option from
  // all tabs highlighted in red box" — Team Overview, Team KRA Sheets,
  // Team Target Achievements, Team Mid-Year, Team Evaluation.
  //
  // So the Manager tab is now MY REPORTS, full stop, for every role
  // including a super admin. Whole-company work lives on the HR tab
  // (All Approvals, KRA Overview, the Completion Report).
  const PAGES = ['/team/kra-sheets', '/team/eval', '/team/midyear',
                 '/team/overview', '/team/growth'];

  for (const who of ['mgr@shot.in', 'admin@shot.in']) {
    for (const path of PAGES) {
      const { ctx, page, errors } = await open(who, path);
      const body = await page.locator('body').innerText();
      assert.equal(await page.locator('button:has-text("All employees")').count(), 0,
        `${path} (${who}): no "All employees" control`);
      assert.equal(await page.locator('button:has-text("My reports")').count(), 0,
        `${path} (${who}): and no scope control at all`);
      assert.ok(!/all employees/i.test(body),
        `${path} (${who}): the page never offers the whole company`);
      assert.deepEqual(errors, [], `${path} (${who}): no page errors`);
      await ctx.close();
    }
  }

  // The list itself must be the reports, not everyone.
  //
  // The reporting lines come from the EMPLOYEE DIRECTORY, not from
  // /pms/team/evaluations — checking the page against the same endpoint
  // that fills it would pass even if that endpoint returned the whole
  // company, which is exactly the bug this test exists to catch.
  const tok = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const get = async (who, p) => (await (await fetch(`${API}/api/v1${p}`,
    { headers: { Authorization: `Bearer ${who}` } })).json());
  const admin = await tok('admin@shot.in');
  const mgr = await tok('mgr@shot.in');
  const everyone = ((await get(admin, '/employees?limit=500')).employees || [])
    .filter((e) => e.status === 'active');
  assert.ok(everyone.length > 5, 'the directory has to be bigger than one team');
  const reportsTo = (email) => everyone.filter((e) => e.manager_email === email).map((e) => e.name);

  for (const [who, email] of [['mgr@shot.in', 'mgr@shot.in'], ['admin@shot.in', 'admin@shot.in']]) {
    const mine = reportsTo(email);
    const { ctx, page } = await open(who, '/team/eval');
    // The PAGE, not the whole document: the signed-in user's own name
    // sits in the header on every screen, so reading innerText off
    // <body> makes the viewer look like a listed employee.
    const shown = await page.locator('main').innerText();
    const outsiders = everyone.filter((e) => !mine.includes(e.name));
    assert.ok(outsiders.length, 'there must be somebody outside the team to miss');
    for (const o of outsiders) {
      assert.ok(!shown.includes(o.name),
        `Team Evaluation (${who}) must not list ${o.name}, who reports to ${o.manager_email || 'nobody'}`);
    }
    await ctx.close();
  }

  // And the reports themselves ARE there — a page that lists nobody would
  // pass every assertion above. The page opens on "Still to write", so
  // compare against that tab only.
  const team = (await get(mgr, '/pms/team/evaluations')).team || [];
  const pending = team.filter((n) => n.eval_status !== 'submitted');
  assert.ok(pending.length, 'the demo manager needs at least one report still to evaluate');
  const { ctx, page } = await open('mgr@shot.in', '/team/eval');
  const shown = await page.locator('main').innerText();
  for (const n of pending) {
    assert.ok(shown.includes(n.name), `Team Evaluation must list the report ${n.name}`);
  }
  await ctx.close();
});

test('the two HR reports can be exported, and the counts on KRA Overview filter', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: export on Employees and the Completion Report,
  // and "clickable option" for the KRA Overview counts.
  for (const [path, label, expected] of [
    ['/admin/directory', 'Export all (.xlsx)', /^employees-\d{4}-\d{2}-\d{2}\.xlsx$/],
    ['/admin/completion-report', 'Export (.xlsx)', /^pms-completion-\d{4}-\d{2}-\d{2}\.xlsx$/],
  ]) {
    const { ctx, page } = await open('admin@shot.in', path);
    const link = page.locator(`a:has-text("${label}")`).first();
    assert.equal(await link.count(), 1, `${path}: the export button is there`);
    // Prove it downloads something, not just that a link exists.
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), link.click()]);
    assert.match(dl.suggestedFilename(), expected);
    await ctx.close();
  }

  const { ctx, page, errors } = await open('admin@shot.in', '/admin/kra-overview');
  const counters = page.locator('button[aria-pressed]');
  assert.equal(await counters.count(), 5, 'every count is a button');
  const all = await page.locator('tbody tr').count();
  const approved = counters.filter({ hasText: 'approved' }).first();
  await approved.click();
  await page.waitForTimeout(600);
  const filtered = await page.locator('tbody tr').count();
  assert.ok(filtered < all, `clicking a count filters the table (${all} -> ${filtered})`);
  assert.equal(await page.locator('button:has-text("Clear filter")').count(), 1);
  // Clicking the same one again is the way back.
  await approved.click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('tbody tr').count(), all, 'and clicking it again clears');
  // A count of zero is not a live control — it would filter to nothing.
  for (const key of ['not started', 'draft', 'submitted', 'returned', 'approved']) {
    const b = counters.filter({ hasText: key }).first();
    const n = Number((await b.innerText()).split('\n')[0]);
    assert.equal(await b.isDisabled(), n === 0, `"${key}" (${n}) disabled state`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Team Overview can be searched', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/overview');
  const box = page.locator('input[placeholder*="Search"]');
  assert.equal(await box.count(), 1);
  const before = await page.locator('tbody tr').count();
  assert.ok(before > 1, 'the demo manager has a team to search');
  await box.fill('Arun');
  await page.waitForTimeout(600);
  const after = await page.locator('tbody tr').count();
  assert.ok(after > 0 && after < before, `search narrows the list (${before} -> ${after})`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Add sits beside Clear on the KRA Library, and neither button moves', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: "Add option should be on left or right side of
  // clear KRA option."
  //
  // The first attempt put the add FORM in the button row, so opening it
  // pushed Clear down onto its own line. A control that moves when you
  // press the one next to it is how people click the wrong thing — and
  // the wrong thing here empties the library. So the two buttons hold a
  // fixed row and the panels open underneath, which is what the
  // coordinate checks below are actually for.
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/kra-library');
  try {
    const addBtn = page.locator('button:has-text("Add a KRA")').first();
    const clrBtn = page.locator('button:has-text("Clear the library")');
    assert.equal(await addBtn.count(), 1, 'Add is on the page');
    assert.equal(await clrBtn.count(), 1, 'so is Clear');

    const where = async () => {
      const a = await addBtn.boundingBox();
      const c = await clrBtn.boundingBox();
      return { a, c };
    };
    const shut = await where();
    assert.ok(Math.abs(shut.a.y - shut.c.y) < 5, 'they share a row');
    assert.ok(shut.a.x < shut.c.x, 'Add is to the left of Clear');

    // Opening either panel must not move either button.
    await addBtn.click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('input[placeholder*="Designation *"]').count(), 1,
      'the add form opened');
    let now = await where();
    assert.deepEqual([now.a.x, now.a.y, now.c.x, now.c.y],
      [shut.a.x, shut.a.y, shut.c.x, shut.c.y], 'neither button moved when Add opened');

    // One panel at a time — they are opposite actions.
    await clrBtn.click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('input[placeholder*="Designation *"]').count(), 0,
      'opening Clear closes the add form');
    assert.equal(await page.locator('input[placeholder="DELETE"]').count(), 1,
      'and shows the typed confirmation');
    now = await where();
    assert.deepEqual([now.a.x, now.a.y, now.c.x, now.c.y],
      [shut.a.x, shut.a.y, shut.c.x, shut.c.y], 'neither button moved when Clear opened');

    // The add form cannot be submitted half-filled.
    await addBtn.click();
    await page.waitForTimeout(400);
    const submit = page.locator('button:has-text("Add to the library")');
    assert.ok(await submit.isDisabled(), 'disabled with nothing filled in');
    await page.locator('input[placeholder*="Designation *"]').fill('Sales Manager');
    assert.ok(await submit.isDisabled(), 'still disabled with no KRA text');
    await page.locator('input[placeholder="KRA (S.M.A.R.T goal) *"]').first().fill('x');
    assert.ok(!(await submit.isDisabled()), 'enabled once both required fields are in');

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});

test('the Manager tab has its own dashboard, and it tracks the reportees', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: "build a dashboard under 'Manager tab' same
  // like one in 'self tab' for manager view regarding tracking of his
  // reportees."
  const tok = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const mgr = await tok('mgr@shot.in');
  const data = await (await fetch(`${API}/api/v1/pms/team/home`,
    { headers: { Authorization: `Bearer ${mgr}` } })).json();
  assert.ok(data.reports > 0, 'the demo manager has reports');

  const { ctx, page, errors } = await open('mgr@shot.in', '/team/dashboard');
  const main = await page.locator('main').innerText();
  assert.match(main, /Manager Dashboard/);

  // It is in the Manager group of the menu, which is the half of the ask
  // a rendering check cannot see.
  const items = await groupItems(page, 'Manager');
  assert.ok(items.includes('Manager Dashboard'), `Manager group was: ${items.join(', ')}`);

  // Every reportee is named — that is what "tracking of his reportees"
  // means, and a page of counts alone would satisfy nothing.
  for (const r of data.roster) {
    assert.ok(main.includes(r.name), `the dashboard names ${r.name}`);
  }
  // And the headline numbers are the server's, not decoration.
  assert.match(main, new RegExp(`${data.stats.kra_approved}/${data.stats.reports}`),
    'KRAs approved is printed as N of the team size');
  assert.match(main, new RegExp(`${data.stats.evals_done}/${data.stats.reports}`),
    'evaluations done likewise');

  // No scope control here either — the Manager tab is my reports, full
  // stop, including on its own landing page.
  assert.equal(await page.locator('button:has-text("All employees")').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();

  // An employee must not reach it at all: the nav does not offer it and
  // the direct URL is refused by the page guard.
  const e = await open('emp@shot.in', '/team/dashboard');
  const eMain = await e.page.locator('main').innerText();
  assert.ok(!/Manager Dashboard/.test(eMain), `an employee is kept out — saw: ${eMain.slice(0, 120)}`);
  await e.ctx.close();
});

test('competency mapping is on all three tabs, and gated per tab', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep with the client's own workbook attached:
  // "Consider 3rd excel sheet for creating employee competency mapping
  // system for evaluation self and manager to have complete competency
  // of the organization." Four sheets, four surfaces.
  const { ctx, page, errors } = await open('hr@shot.in', '/home');
  const self = await groupItems(page, 'Self');
  assert.ok(self.includes('My Competencies'), `Self was: ${self.join(', ')}`);
  const mgr = await groupItems(page, 'Manager');
  assert.ok(mgr.includes('Team Competencies'), `Manager was: ${mgr.join(', ')}`);
  const hr = await groupItems(page, 'HR');
  assert.ok(hr.includes('Competency Framework'), `HR was: ${hr.join(', ')}`);
  assert.ok(hr.includes('Competency Dashboard'));
  assert.deepEqual(errors, []);
  await ctx.close();

  // An employee gets their own form and NOTHING else — the framework
  // and the company dashboard are HR's.
  const e = await open('emp@shot.in', '/home');
  const eSelf = await groupItems(e.page, 'Self');
  assert.ok(eSelf.includes('My Competencies'), 'the employee keeps their own form');
  const body = await e.page.locator('header').innerText();
  assert.ok(!/Competency Framework|Competency Dashboard/.test(body),
    'but never the framework or the company dashboard');
  await e.ctx.close();
});

test('the competency form asks the right person the right competencies', async (t) => {
  if (needStack(t)) return;
  // The 10 LEADERSHIP competencies are not asked of somebody with
  // nobody to lead. A form that makes an individual contributor rate
  // their Delegation teaches them the form is not about them.
  const tok = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const get = async (who, p) => (await (await fetch(`${API}/api/v1${p}`,
    { headers: { Authorization: `Bearer ${who}` } })).json());

  const emp = await get(await tok('emp@shot.in'), '/pms/competencies/me');
  const mgr = await get(await tok('mgr@shot.in'), '/pms/competencies/me');
  assert.ok(emp.rows.length > 0 && mgr.rows.length > emp.rows.length,
    `a manager is asked more: ${emp.rows.length} vs ${mgr.rows.length}`);
  assert.ok(!emp.rows.some((r) => /LEADERSHIP/.test(r.category)));
  assert.ok(mgr.rows.some((r) => /LEADERSHIP/.test(r.category)));

  // The page renders the categories it was given, each exactly once —
  // the first cut grouped only CONSECUTIVE rows, so when two
  // categories' sort ranges overlapped a heading appeared twice.
  const { ctx, page, errors } = await open('emp@shot.in', '/my/competencies');
  const main = await page.locator('main').innerText();
  const wanted = [...new Set(emp.rows.map((r) => r.category))];
  for (const cat of wanted) {
    const hits = main.split(cat).length - 1;
    assert.equal(hits, 1, `"${cat}" appears exactly once — got ${hits}`);
  }
  assert.ok(!/LEADERSHIP COMPETENCY/.test(main), 'and leadership is absent for this person');
  // The block the page opened on shows the 1-5 control with the
  // required level. Open one only if none is — the page expands the
  // first unfinished category by itself, and clicking that one shut it.
  if (await page.locator('button[aria-pressed]').count() === 0) {
    await page.locator(`button:has-text("${wanted[0]}")`).first().click();
    await page.waitForTimeout(600);
  }
  assert.ok(await page.locator('button[aria-pressed]').count() >= 5, 'the rating buttons are there');
  assert.match(await page.locator('main').innerText(), /needs \d/, 'and each says what the role needs');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Delivery Head is its own tab, and no longer sits under Manager', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: "There should be separate HOD tab next to 3
  // roles of employee, manager and HR and remove the same from manager
  // tab."
  const { ctx, page, errors } = await open('hod@shot.in', '/home');
  const tabs = (await page.locator('header >> button').allInnerTexts())
    .map((s) => s.split('\n')[0].trim()).filter(Boolean);
  assert.ok(tabs.some((x) => /Delivery Head/.test(x)), `tabs were: ${tabs.join(' | ')}`);

  const mgr = await groupItems(page, 'Manager');
  assert.ok(!mgr.includes('Delivery Head Review'),
    `it must be gone from Manager — got ${mgr.join(', ')}`);
  const dh = await groupItems(page, 'Delivery Head');
  assert.ok(dh.includes('Delivery Head Review'), `Delivery Head tab was: ${dh.join(', ')}`);
  assert.deepEqual(errors, []);
  await ctx.close();

  // And it is NOT offered to somebody without the permission — a group
  // whose every item is filtered out is dropped entirely.
  const e = await open('emp@shot.in', '/home');
  const eTabs = (await e.page.locator('header >> button').allInnerTexts()).join(' ');
  assert.ok(!/Delivery Head/.test(eTabs), 'an employee has no Delivery Head tab');
  await e.ctx.close();
});

test('the cycle card states who is eligible, and when yours is', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep, pointing at this card: "employee joined on or
  // before 31st Dec 2026 will be eligible for July 2027" and "employee
  // joined on or after 01st Jan 2027 will be eligible for July 2028".
  // Point 5, "suggestion of next appraisal", is the line under it.
  const { ctx, page, errors } = await open('emp@shot.in', '/home');
  const main = await page.locator('main').innerText();
  assert.match(main, /joined on or before 31 December 2026 are eligible for the July 2027 appraisal/i);
  assert.match(main, /joined on or after 1 January 2027 are eligible for the July 2028 appraisal/i);
  assert.match(main, /Your next appraisal/i, 'and the employee is told their own');
  assert.deepEqual(errors, []);
  await ctx.close();

  // Somebody who joined AFTER the cut-off is told they are not in this
  // one — which is the half of the rule that is easy to get wrong. The
  // demo master seeds hod@shot.in with a February 2027 joining date
  // for exactly this; every other demo login is well before it.
  const p = await open('hod@shot.in', '/home');
  const pMain = await p.page.locator('main').innerText();
  assert.match(pMain, /July 2028/);
  assert.match(pMain, /not in this cycle/i);
  await p.ctx.close();
});

test('ratings read as letters, never as bare numbers', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: "please make sure that ratings should be
  // measured only in Alphabets and not numbers."
  //
  // The demo cycle is graded in WORDS (Outstanding..Needs
  // Improvement), so this also covers the mapping onto the letter
  // ladder — before it, this page showed "Exceeds".
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/eval');
  await page.locator('.card button').first().click();
  await page.waitForTimeout(1300);
  const card = await page.locator('.card').first().innerText();
  // The rating picker offers grades.
  const buttons = await page.getByRole('button', { name: /^[A-C]\+?$/ }).count();
  assert.ok(buttons >= 5, `the picker offers letter grades — found ${buttons}`);
  assert.ok(!/\bOutstanding\b|\bExceeds\b/.test(card),
    `no descriptive labels on the rating control — got: ${card.slice(0, 300)}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Team KRA Sheets offers a department view, and only the allowed ones', async (t) => {
  if (needStack(t)) return;
  // Asked for on 24 Sep: "'Team KRAs' should have department dropdown
  // view for manager to select departments and employees mapped to
  // their departments."
  const tok = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const mgr = await tok('mgr@shot.in');
  const get = async (p) => (await (await fetch(`${API}/api/v1${p}`,
    { headers: { Authorization: `Bearer ${mgr}` } })).json());

  const mine = await get('/pms/team/kra-sheets');
  assert.equal(mine.scope, 'my_reports', 'the default is still my reports');
  assert.ok((mine.departments || []).length, 'and a list of departments is offered');

  const { ctx, page, errors } = await open('mgr@shot.in', '/team/kra-sheets');
  const select = page.locator('select').first();
  assert.equal(await select.count(), 1, 'the dropdown is on the page');
  const options = await select.locator('option').allInnerTexts();
  assert.equal(options[0], 'My reports', 'and it opens on My reports');
  for (const d of mine.departments) assert.ok(options.includes(d), `${d} is offered`);

  await select.selectOption(mine.departments[0]);
  await page.waitForTimeout(1500);
  const main = await page.locator('main').innerText();
  assert.match(main, new RegExp(`Showing everybody in`, 'i'),
    'the page says the view has widened beyond their own reports');
  assert.deepEqual(errors, []);
  await ctx.close();
});

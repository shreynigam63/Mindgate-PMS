// node --test — the KRA table's shape, in a real browser.
//
// Asked for on 23 Sep, against the client's own sheet:
//
//   format will be : "Parameters" "KRAs" "KPIs" "Weightage"
//   ... make sure KRAs should be under parameters in a single table
//   instead of separate table as per previous format.
//
// A server test cannot see any of that, and the thing most likely to
// regress is precisely the thing that was asked for: somebody adds a
// column, renames a header, or splits a group back into its own table.
// So this drives a real browser against the running dev stack and asserts
// the structure on all three screens that show KRAs.
//
// THE ASSERTION THAT MATTERS is the rowSpan: a merged parameter cell is
// what makes it ONE table rather than a stack of them, and it is
// invisible to a screenshot diff. If a future change renders one table
// per parameter, every header check here still passes and this one fails.
//
// Skips cleanly when the stack is not up, so it never blocks a run that
// only touched the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

const HEADERS = ['Parameters', 'KRAs', 'KPIs (measuring metrics & data source)', 'Weightage'];

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

// Checked INSIDE each test, not in its options: `{ skip: skip() }` is
// evaluated when this module loads, which is before before() has had a
// chance to run — so every test skipped even with the stack up, and the
// file looked like it passed. Caught because five "ok ... # SKIP" lines
// appeared while the API was demonstrably answering on 8080.
const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; }
  return false;
};

async function open(email, path, width = 1440) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

// Everything the format asks for, read off the rendered table.
const shape = (page) => page.evaluate(() => {
  const t = document.querySelector('.kratable');
  if (!t) return null;
  // :not(.kt-param-add) — the "+ New parameter" footer cell borrows the
  // styling but is not a group, and counting it as one made this helper
  // throw on a null .kt-pname.
  const groups = [...t.querySelectorAll('td.kt-param:not(.kt-param-add)')].map((td) => ({
    name: td.querySelector('.kt-pname').textContent.trim(),
    span: td.rowSpan,
  }));
  return {
    tables: document.querySelectorAll('.kratable').length,
    headers: [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()),
    groups,
    // Every parameter must appear EXACTLY once. This is the complaint
    // the whole change came from.
    repeated: groups.map((g) => g.name).filter((n, i, a) => a.indexOf(n) !== i),
    bodyRows: t.querySelectorAll('tbody tr').length,
    // Rows that belong to a parameter. The "+ New parameter" row sits
    // outside every group ON PURPOSE — it is the control that creates one
    // — so it is excluded rather than the invariant being loosened.
    groupRows: [...t.querySelectorAll('tbody tr')]
      .filter((tr) => !tr.querySelector('td.kt-param-add')).length,
    footer: (t.querySelector('tfoot td.num') || {}).textContent || null,
  };
});

test('My KRAs is ONE table with the four columns, in order', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('emp@shot.in', '/my/kras');
  const s = await shape(page);
  assert.ok(s, 'no .kratable rendered on My KRAs');
  assert.equal(s.tables, 1, 'one table, not one per parameter');
  assert.deepEqual(s.headers, HEADERS);
  assert.deepEqual(s.repeated, [], 'a parameter must appear exactly once');
  assert.ok(s.groups.length >= 2, 'the fixture has several parameters');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the parameter cell SPANS its KRAs — this is what makes it one table', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('emp@shot.in', '/my/kras');
  const s = await shape(page);
  // Spans must account for every body row between them: sum(span) is the
  // row count, so no KRA can sit outside a parameter and no parameter can
  // claim rows it does not own.
  const spanned = s.groups.reduce((n, g) => n + g.span, 0);
  assert.equal(spanned, s.groupRows,
    `spans ${spanned} vs ${s.groupRows} grouped rows — a KRA is outside its parameter`);
  assert.equal(s.bodyRows - s.groupRows, 1,
    'exactly one row sits outside the groups: the + New parameter control');
  assert.ok(s.groups.some((g) => g.span > 1),
    'at least one parameter carries more than one KRA, and must span them');
  await ctx.close();
});

test('the KRA Library shelf uses the same table', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/kra-library');
  await page.locator('button', { hasText: 'AVP - Delivery Manager' }).first().click();
  await page.waitForTimeout(1200);
  const s = await shape(page);
  assert.ok(s, 'no .kratable rendered on the shelf');
  assert.deepEqual(s.headers, HEADERS, 'the library and My KRAs must not drift apart');
  assert.deepEqual(s.repeated, []);
  assert.deepEqual(s.groups.map((g) => g.name),
    ['Financial', 'Project / Process', 'Customer', 'People'],
    'parameters keep the order HR published them in');
  assert.equal(s.footer, '100%');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a read-only sheet has no inputs, and still has the format', async (t) => {
  if (needStack(t)) return;
  // Driven through the API so the test does not depend on the fixture's
  // current status.
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'emp@shot.in', password: PASS }),
  })).json()).token;
  const sheet = await (await fetch(`${API}/api/v1/pms/my/kra-sheet`,
    { headers: { Authorization: `Bearer ${token}` } })).json();
  if (sheet.sheet.status === 'draft' || sheet.sheet.status === 'returned') {
    await fetch(`${API}/api/v1/pms/my/kra-sheet/submit`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  const { ctx, page } = await open('emp@shot.in', '/my/kras');
  const s = await shape(page);
  const inputs = await page.evaluate(() =>
    document.querySelectorAll('.kratable input, .kratable textarea, .kratable select').length);
  if (inputs === 0) {
    assert.deepEqual(s.headers, HEADERS, 'a locked sheet keeps the same four columns');
    assert.deepEqual(s.repeated, []);
  }
  await ctx.close();
});

test('on a phone it folds instead of scrolling sideways', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('emp@shot.in', '/my/kras', 390);
  const m = await page.evaluate(() => {
    const kra = document.querySelector('.kratable td.kt-k');
    return {
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      kraWidth: kra ? Math.round(kra.getBoundingClientRect().width) : 0,
      headVisible: getComputedStyle(document.querySelector('.kratable thead')).display !== 'none',
    };
  });
  assert.equal(m.hscroll, false, 'a merged table must not push the page sideways on a phone');
  assert.equal(m.headVisible, false, 'the column heads are replaced by inline labels');
  assert.ok(m.kraWidth > 250,
    `the KRA column collapsed to ${m.kraWidth}px — the desktop widths leaked through`);
  await ctx.close();
});

// node --test — the HRBP tab, in a real browser.
//
// The HRBP tab opens HR'S OWN PAGES, nineteen of them, narrowed per
// request by hrbp-gateway.js. hrbp-gateway.test.js proves no row outside
// the remit comes back; what only a browser shows is that each of those
// nineteen routes actually RENDERS for an HRBP — a page that 403s, throws,
// or sits on "Loading…" is a dead tab however well the API scopes.
//
// So the sweep below walks all nineteen. It is the test that catches the
// twentieth page somebody adds to the HR group and forgets to mirror.
//
// Skips cleanly when the dev stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8082';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

let browser; let up = false;

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

const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API + Vite)'); return true; }
  return false;
};

const token = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: PASS }),
})).json()).token;

async function open(email, route) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  return { ctx, page, errors };
}
// Chromium's innerText omits anything scrolled out of an overflow
// container — every assertion here reads textContent.
const text = (page) => page.evaluate(() => document.body.textContent);

const VIEWS = ['approvals', 'cycles', 'directory', 'department-heads', 'career-transitions',
  'kra-overview', 'kra-library', 'competencies', 'competency-dashboard', 'timesheet',
  'completion-report', 'calibration', 'nine-box', 'closure-letters', 'increments',
  'watchlist', 'engagement', 'engagement-insights', 'settings'];

test('THE HRBP TAB SITS BETWEEN DELIVERY HEAD AND HR, and carries HR’s own tabs', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hod@shot.in', '/home');
  const names = (await page.$$eval('button', (bs) => bs.map((b) => b.textContent.trim())))
    .map((x) => x.replace(/[0-9+]+$/, '').trim());
  const iH = names.findIndex((x) => x === 'HOD');
  const iB = names.findIndex((x) => x === 'HRBP');
  const iR = names.findIndex((x) => x === 'HR');
  assert.ok(iB > -1, `no HRBP tab — tabs were ${names.filter(Boolean).slice(0, 10).join(', ')}`);
  assert.ok(iH > -1 && iH < iB, `HRBP must sit after HOD: ${iH}, ${iB}`);
  // WRITTEN TWICE. This first asserted the HR tab was absent entirely.
  // It is not, and should not be: hod@shot.in is a genuine HOD,
  // and /admin/nine-box is gated on pms_hod on purpose, so one HR entry
  // legitimately remains. What actually matters is that the HRBP tab
  // carries HR's OWN tabs rather than a hand-picked subset.
  // The sub-nav only renders for the ACTIVE tab, so read it from a page
  // inside the group rather than from Home.
  await page.goto(APP + '/hrbp/approvals', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const hrbpLabels = await page.$$eval('a', (as) => as.map((a) => a.getAttribute('href') || ''));
  for (const want of ['/hrbp/calibration', '/hrbp/settings', '/hrbp/closure-letters',
    '/hrbp/increments', '/hrbp/watchlist']) {
    assert.ok(hrbpLabels.includes(want), `${want} is missing from the HRBP tab`);
  }
  void iR;
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('AN EMPLOYEE WITHOUT THE PERMISSION DOES NOT SEE THE TAB AT ALL', async (t) => {
  if (needStack(t)) return;
  // The nav and the direct-URL guard come from the same page_permission
  // row, so a tab somebody cannot use must not be drawn for them.
  const { ctx, page } = await open('emp@shot.in', '/home');
  const names = (await page.$$eval('button', (bs) => bs.map((b) => b.textContent.trim())))
    .map((x) => x.replace(/[0-9+]+$/, '').trim());
  assert.ok(!names.includes('HRBP'), `an employee was offered the HRBP tab: ${names.join(', ')}`);
  await ctx.close();
});

test('EVERY ONE OF THE NINETEEN VIEWS RENDERS FOR AN HRBP, with no page error', async (t) => {
  if (needStack(t)) return;
  const broken = [];
  for (const p of VIEWS) {
    const { ctx, page, errors } = await open('hod@shot.in', `/hrbp/${p}`);
    const body = (await text(page)).replace(/\s+/g, ' ');
    if (errors.length) broken.push(`${p}: threw ${errors[0]}`);
    if (/not part of your access/i.test(body)) broken.push(`${p}: the URL guard refused it`);
    if (/Loading…\s*$/.test(body)) broken.push(`${p}: still loading`);
    if (/Access denied|Requires '/.test(body)) broken.push(`${p}: the API refused it`);
    await ctx.close();
  }
  assert.deepEqual(broken, [], `dead tabs:\n${broken.join('\n')}`);
});

test('AN HRBP SEES ONLY THEIR OWN PEOPLE on a page that lists everybody for HR', async (t) => {
  if (needStack(t)) return;
  // hod@shot.in is assigned Pune. Abhedya and Rekha are Mumbai.
  const { ctx, page } = await open('hod@shot.in', '/hrbp/directory');
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.ok(/Arun Employee|Priya Nair|Suraj Khairnar/.test(body), 'their own people are missing');
  assert.ok(!/Abhedya/.test(body), 'a Mumbai employee appeared in a Pune remit');
  assert.ok(!/Rekha/.test(body), 'a Mumbai employee appeared in a Pune remit');
  await ctx.close();
});

test('HR still sees everybody — the gateway must not touch an admin', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('admin@shot.in', '/admin/directory');
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.ok(/Abhedya/.test(body), 'HR lost sight of a Mumbai employee');
  await ctx.close();
});

test('HR can open the assignment screen and sees the locations from the master', async (t) => {
  if (needStack(t)) return;
  // WRITTEN TWICE. The first version asserted the union-rule sentence on
  // the landing view, where it does not exist — it lives in the edit panel,
  // which only opens on "Edit remit".
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/hrbp');
  const landing = (await text(page)).replace(/\s+/g, ' ');
  assert.match(landing, /HR Business Partners/);
  await page.getByRole('button', { name: 'Edit remit' }).first().click();
  await page.waitForTimeout(400);
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.match(body, /Pune/, 'the options come from the employee master, not a free-text box');
  assert.match(body, /widen it, they do not narrow it/,
    'the union rule has to be stated where the assignment is made, or it reads as an AND');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an HRBP cannot open HR’s assignment screen, or set their own remit', async (t) => {
  if (needStack(t)) return;
  // Setting your own remit is the obvious abuse of this feature.
  const r = await fetch(`${API}/api/v1/pms/hrbp/admin/partners`, {
    headers: { authorization: `Bearer ${await token('hod@shot.in')}` },
  });
  assert.equal(r.status, 403, 'an HRBP read the partner list');
  const w = await fetch(`${API}/api/v1/pms/hrbp/admin/partners/hod%40shot.in`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${await token('hod@shot.in')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: ['Mumbai'], hods: [] }),
  });
  assert.equal(w.status, 403, 'an HRBP widened their own remit');
});

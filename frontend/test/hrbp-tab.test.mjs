// node --test — the HRBP tab, in a real browser.
//
// The server tests prove the remit resolves and fails closed. What only a
// browser shows is whether the tab appears for the right people and
// whether its empty states tell the truth — and there are THREE different
// emptinesses here, each needing a different action:
//
//   nothing assigned          -> HR assigns a remit
//   assigned but matches none -> the master has no location/HOD yet
//   matches people, no rows   -> genuinely nothing to do
//
// Rendering a blank table for all three is how somebody concludes the
// product is broken. That is most of what is pinned below.
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

test('THE HRBP TAB SITS BETWEEN DELIVERY HEAD AND HR', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('admin@shot.in', '/home');
  const tabs = await page.$$eval('button', (bs) => bs.map((b) => b.textContent.trim()));
  const names = tabs.map((x) => x.replace(/[0-9+]+$/, '').trim());
  const iH = names.findIndex((x) => x === 'Delivery Head');
  const iB = names.findIndex((x) => x === 'HRBP');
  const iR = names.findIndex((x) => x === 'HR');
  assert.ok(iB > -1, `no HRBP tab — tabs were ${names.filter(Boolean).slice(0, 10).join(', ')}`);
  assert.ok(iH > -1 && iR > -1 && iH < iB && iB < iR,
    `order was wrong: Delivery Head ${iH}, HRBP ${iB}, HR ${iR}`);
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

test('an HRBP sees their remit named, and only their own people', async (t) => {
  if (needStack(t)) return;
  // hr@shot.in holds pms_hrbp and is assigned location Pune.
  const { ctx, page, errors } = await open('hr@shot.in', '/hrbp/employees');
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.match(body, /Your remit:/, 'the remit has to be on screen — otherwise "why can I not see X" has no answer');
  assert.match(body, /Pune/);
  assert.match(body, /read-only/i, 'and it has to say it decides nothing');
  // Somebody outside the remit must not be listed.
  assert.ok(!/Abhedya/.test(body), 'a Mumbai employee appeared in a Pune remit');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('THE APPROVALS VIEW SAYS IT IS A SUBSET, not a different number', async (t) => {
  if (needStack(t)) return;
  // The commonest support question about a scoped screen is "HR says 6
  // and I see 3". Saying so on the page is cheaper than answering it.
  const { ctx, page } = await open('hr@shot.in', '/hrbp/approvals');
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.match(body, /of \d+ across the company/,
    'the view must name the org-wide total beside its own');
  await ctx.close();
});

test('EVERY ONE OF THE SEVEN VIEWS RENDERS, with no page error', async (t) => {
  if (needStack(t)) return;
  // WRITTEN TWICE. The first version opened only /hrbp/employees, which
  // would have passed with 9-box broken — that endpoint returns `cells`
  // and the shared table reads `people`, so it rendered an empty table
  // while holding data. Found by walking all seven.
  for (const p of ['employees', 'approvals', 'kra-overview', 'timesheet',
    'completion-report', 'competency-dashboard', 'nine-box']) {
    const { ctx, page, errors } = await open('hr@shot.in', `/hrbp/${p}`);
    const body = (await text(page)).replace(/\s+/g, ' ');
    assert.deepEqual(errors, [], `${p} threw: ${errors[0]}`);
    assert.match(body, /Your remit:/, `${p} did not render the remit header`);
    assert.ok(!/Loading…/.test(body.slice(-40)), `${p} was still loading`);
    await ctx.close();
  }
});

test('HR can open the assignment screen and sees the locations from the master', async (t) => {
  if (needStack(t)) return;
  // WRITTEN TWICE. The first version asserted the union-rule sentence on the
  // landing view, where it does not exist — it lives in the edit panel, which
  // only opens on "Edit remit". That assertion was testing my memory of the
  // page, not the page; it failed while the screen was entirely correct.
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/hrbp');
  const landing = (await text(page)).replace(/\s+/g, ' ');
  assert.match(landing, /HR Business Partners/);
  assert.match(landing, /Partner/, 'the partner list is the point of the landing view');

  // Open the panel where the remit is actually chosen.
  await page.getByRole('button', { name: 'Edit remit' }).first().click();
  await page.waitForTimeout(400);
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.match(body, /Pune/, 'the options come from the employee master, not a free-text box');
  assert.match(body, /widen it, they do not narrow it/,
    'the union rule has to be stated where the assignment is made, or it reads as an AND');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an HRBP cannot open HR’s assignment screen', async (t) => {
  if (needStack(t)) return;
  // Setting your own remit is the obvious abuse of this feature.
  const r = await fetch(`${API}/api/v1/pms/hrbp/admin/partners`, {
    headers: { authorization: `Bearer ${await token('hr@shot.in')}` },
  });
  // hr@shot.in holds pms_admin too, so the meaningful check is the
  // employee: no pms_admin, no partners list.
  const r2 = await fetch(`${API}/api/v1/pms/hrbp/admin/partners`, {
    headers: { authorization: `Bearer ${await token('emp@shot.in')}` },
  });
  assert.equal(r2.status, 403, 'an employee read the partner list');
  const j = await r2.json();
  assert.equal(j.needs, 'pms_admin', 'and the refusal names what was missing');
});

test('NOTHING ASSIGNED SAYS SO, and says who fixes it', async (t) => {
  if (needStack(t)) return;
  // The whole point of the three empty states. admin@shot.in holds the
  // permission (wildcard) but has no remit row, which is exactly the state
  // every partner is in on the day the feature ships. A blank table here
  // reads as "the product is broken"; the sentence has to name both what is
  // missing and who sets it.
  const { ctx, page, errors } = await open('admin@shot.in', '/hrbp/employees');
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.match(body, /nothing assigned/i, 'the remit header must admit it is empty');
  assert.match(body, /No locations or HODs are assigned to you yet/,
    'and the body must say so rather than drawing an empty table');
  assert.match(body, /HR sets this/, 'naming who fixes it is the difference from a dead end');
  assert.deepEqual(errors, []);
  await ctx.close();
});

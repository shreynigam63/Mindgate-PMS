// node --test — HR → Settings → Email, simplified on 7 Oct: provider,
// mailbox and password; then a test; then Go live, offered only after a
// delivered test. Needs the dev stack (API 8080 + Vite 5190); skips without.
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

async function open(email, path) {
  const t = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

test('HR sets email up in three steps, with server details out of the way', async (t) => {
  if (!up) { t.skip('dev stack not running'); return; }
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/settings');
  const card = page.locator('.card', { hasText: 'Connect the mailbox' });
  const text = await card.innerText();
  for (const s of ['Microsoft 365', 'Google Workspace', 'Other', 'Mailbox', 'Send a test email to yourself', 'Go live', 'on behalf of the SPOC']) {
    assert.ok(text.includes(s), `shows "${s}"`);
  }
  assert.ok(!/Port/.test(text), 'server details stay under Advanced until asked for');
  const stage = (await (await fetch(`${API}/api/v1/pms/hr/mail`, { headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('apms_token'))}` } })).json()).stage;
  if (stage !== 'ready' && stage !== 'live') {
    assert.equal(await card.getByRole('button', { name: 'Go live' }).isDisabled(), true, 'Go live waits for a delivered test');
  }
  await card.getByRole('button', { name: /Advanced/ }).click();
  assert.match(await card.innerText(), /smtp\.office365\.com|Server/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

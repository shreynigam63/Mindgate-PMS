// Re-shoot the screenshots embedded in PAGE-MY-KRAS-LIBRARY-PICKER.md and
// PAGE-HR-KRA-LIBRARY.md. Run this after any change to either page — the
// captions quote counts that come out of the images, so a stale image
// makes the docs lie.
//
//   1. Restore a copy of the live database (never shoot against prod).
//   2. Boot the API and Vite against it, note the two ports.
//   3. node docs/capture-screenshots.mjs
//
// Env: UI, API, EMPLOYEE, HR, PASSWORD, OUT — all have defaults below.
// Needs Playwright. `import` takes a literal, so the path is resolved at
// runtime instead — set PW if yours lives somewhere else.
import path from 'node:path';

const { chromium } = await import(process.env.PW
  || '/opt/node22/lib/node_modules/playwright/index.mjs');

const UI  = process.env.UI  || 'http://127.0.0.1:5222';
const API = process.env.API || 'http://127.0.0.1:8080/api/v1';
const OUT = process.env.OUT || path.join(import.meta.dirname, 'images');
// An employee whose department employs several titles, so the department
// figures are interesting rather than all 1s.
const EMPLOYEE = process.env.EMPLOYEE || 'mohan.yassh@mindgate.in';
const HR       = process.env.HR       || 'hr.admin@mindgate.in';
const PASSWORD = process.env.PASSWORD || 'Demo#2026pms';

const tok = async (email) => {
  const r = await fetch(`${API}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const d = await r.json();
  if (!d.token) throw new Error(`login failed for ${email}: ${JSON.stringify(d)}`);
  return d.token;
};

const errs = [];
// Animations mid-flight make screenshot() time out rather than produce a
// blurred frame, so they are stopped dead before every shot.
const shot = async (page, file) => {
  await page.evaluate(() => document.querySelectorAll('*')
    .forEach((e) => { e.style.animation = 'none'; e.style.transition = 'none'; }));
  await page.screenshot({ path: `${OUT}/${file}`, animations: 'disabled',
    caret: 'hide', timeout: 60000 });
  console.log('  wrote', file);
};

const browser = await chromium.launch();

// ---- My KRAs -----------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 360 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`my/kras: ${e.message}`));
  await p.goto(`${UI}/`, { waitUntil: 'domcontentloaded' });
  await p.evaluate((t) => localStorage.setItem('apms_token', t), await tok(EMPLOYEE));
  await p.goto(`${UI}/my/kras`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await shot(p, 'my-kras-01-all-departments.png');

  // The Department control only exists when kra_library_scope is
  // 'department+designation'. On a tenant where it is off there is
  // nothing to shoot, and dying here would stop the rest of the run — so
  // it is skipped, loudly.
  if (await p.locator('#shelf-dept option').count() > 1) {
    const dept = await p.locator('#shelf-dept option').nth(1).getAttribute('value');
    await p.selectOption('#shelf-dept', dept);
    await p.waitForTimeout(2200);
    await shot(p, 'my-kras-02-department-chosen.png');
  } else {
    console.log('  SKIPPED my-kras-02-department-chosen.png — department matching is off on this tenant');
  }

  await p.locator('text=Choose from library').click();
  await p.waitForTimeout(1500);
  await p.setViewportSize({ width: 1280, height: 760 });
  await p.waitForTimeout(600);
  await shot(p, 'my-kras-03-pick-list.png');
  await ctx.close();
}

// ---- HR Admin · KRA Library -------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`kra-library: ${e.message}`));
  await p.goto(`${UI}/`, { waitUntil: 'domcontentloaded' });
  await p.evaluate((t) => localStorage.setItem('apms_token', t), await tok(HR));
  await p.goto(`${UI}/admin/kra-library`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);
  await shot(p, 'hr-kra-library-01-overview.png');

  await p.selectOption('#dept-filter', 'Admin');
  await p.waitForTimeout(2800);
  await shot(p, 'hr-kra-library-02-department-view.png');

  if (await p.locator('#desig-filter').count()) {
    await p.selectOption('#desig-filter', 'Executive');
    await p.waitForTimeout(1200);
    await shot(p, 'hr-kra-library-03-designation-cascade.png');
  } else {
    errs.push('kra-library: the designation cascade did not render');
  }

  await p.selectOption('#dept-filter', '');
  await p.waitForTimeout(2500);
  await p.setViewportSize({ width: 1280, height: 700 });
  await p.locator('text=Designations with no shelf yet').scrollIntoViewIfNeeded();
  await p.waitForTimeout(600);
  await shot(p, 'hr-kra-library-04-uncovered.png');

  await p.locator('text=Accounts Consultant').first().click();
  await p.waitForTimeout(1500);
  await p.locator('text=Accounts Consultant').first().scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  await shot(p, 'hr-kra-library-05-shelf-expanded.png');
  await ctx.close();
}

// ---- HR Admin · Career Pathing Matrix (the upload card) ---------------
//
// Only the card itself is shot here. The rejected / valid / published
// states need a filled-in file and a matrix to publish into, so they are
// captured by hand against a scratch database — re-shoot those only when
// the report layout changes, not on every run.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 420 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`career-transitions: ${e.message}`));
  await p.goto(`${UI}/`, { waitUntil: 'domcontentloaded' });
  await p.evaluate((t) => localStorage.setItem('apms_token', t), await tok(HR));
  await p.goto(`${UI}/admin/career-transitions`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await shot(p, 'career-matrix-01-upload-card.png');
  await ctx.close();
}

await browser.close();
// A console error means the shot may show a half-rendered page, so it is
// worth failing on rather than leaving for somebody to notice in a diff.
if (errs.length) { console.error('PAGE ERRORS:', errs); process.exit(1); }
console.log('all screenshots written to', OUT);

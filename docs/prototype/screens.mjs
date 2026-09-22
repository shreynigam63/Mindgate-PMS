// Capture every screen of the prototype, per role, and bind each role's set
// into one PDF that can be sent to someone who will not open an HTML file.
//
//   node docs/prototype/screens.mjs            # all three roles
//   OUT=/somewhere node docs/prototype/screens.mjs
//
// playwright-core is not a dependency of this repo (see docs/tools/README.md);
// point PW at an install and CHROME at the browser if the defaults miss.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
let chromium;
for (const c of [process.env.PW, 'playwright-core', 'playwright',
                 '/usr/lib/node_modules/playwright-core'].filter(Boolean)) {
  try { ({ chromium } = require_(c)); break; } catch { /* try next */ }
}
if (!chromium) {
  console.error('playwright-core not found. Install it anywhere and point PW at it:\n' +
                '  npm i -g playwright-core && PW=playwright-core node docs/prototype/screens.mjs');
  process.exit(1);
}
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Shoots whichever layout is the current one; FILE= points it at the other.
const SRC = process.env.FILE || 'pms-ui-prototype.html';
const FILE = pathToFileURL(join(here, SRC)).href;
const OUT = process.env.OUT || join(here, 'screens');
const WORK = join(OUT, '.work');

// Must match PERSONAS in generate.py.
const ROLES = {
  employee: { label: 'Employee', who: 'Vishakha Rane', tabs: 'Self', groups: ['self'] },
  manager: { label: 'Manager', who: 'Nida Vajid Momin', tabs: 'Self + Manager', groups: ['self', 'mgr'] },
  hr: { label: 'HR / Super Admin', who: 'Akshay Raut', tabs: 'Self + Manager + HR / Admin', groups: ['self', 'mgr', 'hr'] },
};
const TAB = { self: 'Self', mgr: 'Manager', hr: 'HR / Admin' };

// Inter comes from the product's own build output. A webfont that silently
// fails to load ships the PDF in DejaVu fallbacks, which is exactly what the
// first render of the testing guide did — so this also verifies it landed.
function interFaces() {
  const dir = join(here, '..', '..', 'frontend', 'dist', 'assets');
  let files = [];
  try { files = readdirSync(dir); } catch { return ''; }
  const out = [];
  for (const w of [400, 600, 700, 800]) {
    const hit = files.filter((f) => f.startsWith(`inter-latin-${w}-normal-`) && f.endsWith('.woff2')).sort()[0];
    if (!hit) continue;
    const b64 = readFileSync(join(dir, hit)).toString('base64');
    out.push(`@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:block;` +
             `src:url(data:font/woff2;base64,${b64}) format('woff2')}`);
  }
  return out.join('');
}

const CSS = `
@page{size:A4 landscape;margin:9mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;color:#101f3d}
.cover{height:178mm;display:flex;flex-direction:column;justify-content:center;page-break-after:always}
.cover h1{font-size:34px;letter-spacing:-.02em}
.cover .r{font-size:19px;color:#ec407a;font-weight:700;margin-top:6px}
.cover p{font-size:12.5px;color:#3a5a8c;margin-top:14px;line-height:1.7;max-width:190mm}
.cover ol{margin:14px 0 0 20px;font-size:12.5px;color:#1b3b6f;line-height:1.85;columns:2;max-width:200mm}
.cover .note{margin-top:18px;font-size:11.5px;color:#a35a0c;background:#fff6ec;border-left:3px solid #f5821f;padding:9px 13px;max-width:190mm}
.sh{page-break-after:always;height:178mm;display:flex;flex-direction:column}
.sh:last-child{page-break-after:auto}
.cap{font-size:11px;font-weight:700;color:#3a5a8c;letter-spacing:.04em;text-transform:uppercase;margin-bottom:5px;flex-shrink:0}
.cap b{color:#ec407a}
.fr{flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center}
img{max-width:100%;max-height:100%;object-fit:contain;border:1px solid #dbe3ef;border-radius:4px}
`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5 })).newPage();
await p.goto(FILE, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);

const faces = interFaces();
if (!faces) console.warn('frontend/dist not built — PDFs will use a system sans.');

for (const [role, meta] of Object.entries(ROLES)) {
  await p.click(`.pb[data-p="${role}"]`);
  await p.waitForTimeout(120);
  const shots = [];
  // Tab layout hides a group's pages until its tab is opened; the sidebar
  // lists them all. One walk covers both.
  const sidebar = await p.$('.sidenav');
  for (const g of meta.groups) {
    const sel = sidebar ? `.sidenav[data-persona="${role}"] .s-${g} a`
                        : `.subnav[data-for="${g}"] a`;
    // Tabs: open the group's tab. Sidebar: expand the group if it is shut.
    const opener = sidebar ? `.sidenav[data-persona="${role}"] .s-${g}.closed .sglab`
                           : `.rolebar[data-persona="${role}"] .gt[data-group="${g}"]`;
    const el = await p.$(opener);
    if (el) { await el.click(); await p.waitForTimeout(90); }
    const links = await p.$$eval(sel, (as) => as.map((a) => [a.dataset.go, a.textContent.trim()]));
    for (const [id, label] of links) {
      await p.click(`${sel}[data-go="${id}"]`);
      await p.waitForTimeout(120);
      const n = String(shots.length + 1).padStart(2, '0');
      // JPEG, not PNG: these are photographs of gradients, and a 21-screen
      // PNG deck comes out at 16MB — too big to email, which is the point.
      const file = join(WORK, `${role}-${n}.jpg`);
      await p.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 88 });
      shots.push({ file, tab: TAB[g], label });
    }
  }

  const list = shots.map((s, i) => `<li>${s.tab} &middot; ${s.label}</li>`).join('');
  const pages = shots.map((s, i) =>
    `<div class="sh"><div class="cap">${i + 1}/${shots.length} &nbsp;&middot;&nbsp; ${s.tab}` +
    ` &nbsp;&middot;&nbsp; <b>${s.label}</b></div>` +
    `<div class="fr"><img src="${pathToFileURL(s.file).href}"></div></div>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>PMS screens — ${meta.label}</title>` +
    `<style>${faces}${CSS}</style>` +
    `<div class="cover"><h1>Agentic PMS — proposed UI</h1>` +
    `<div class="r">Every screen visible to: ${meta.label}</div>` +
    `<p>Screens as they appear signed in as <b>${meta.who}</b> (${meta.label}). ` +
    `Tabs available to this role: <b>${meta.tabs}</b>. ${shots.length} screens, in menu order.</p>` +
    `<ol>${list}</ol><div class="note"><b>Visual prototype.</b> Numbers are illustrative and the ` +
    `live PMS is unchanged — nothing in the product was modified to produce these.</div></div>${pages}`;
  const htmlPath = join(WORK, `${role}.html`);
  writeFileSync(htmlPath, html);

  const pp = await (await b.newContext()).newPage();
  await pp.emulateMedia({ media: 'print', colorScheme: 'light' });
  await pp.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
  await pp.evaluate(() => document.fonts.ready);
  if (faces && !(await pp.evaluate(() => document.fonts.check('700 20px Inter')))) {
    console.error('Inter did not load — refusing to ship a fallback-font PDF');
    process.exit(1);
  }
  const pdf = join(OUT, `PMS-screens-${role}.pdf`);
  await pp.pdf({
    path: pdf, preferCSSPageSize: true, printBackground: true,
    displayHeaderFooter: true, headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font:7.5pt Inter,sans-serif;color:#6d7d8e;padding:0 10mm;' +
      `display:flex;justify-content:space-between;"><span>Agentic PMS — proposed UI — ${meta.label}</span>` +
      '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: '9mm', bottom: '11mm', left: '9mm', right: '9mm' },
  });
  await pp.close();
  console.log(`${role.padEnd(9)} ${String(shots.length).padStart(2)} screens -> ${pdf}`);
}
await b.close();
// KEEP=1 leaves the per-screen JPEGs and the print HTML behind, which is how
// you check the PDF layout without a PDF rasteriser.
if (!process.env.KEEP) rmSync(WORK, { recursive: true, force: true });
else console.log('kept intermediates in', WORK);

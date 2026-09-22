// Click-through check for the prototype.
//
// A screenshot cannot tell you whether the router is bound: an earlier build
// of this file rendered perfectly and had no working handlers at all, because
// the generator had escaped its own JavaScript. So drive it in a real browser
// and assert what matters — every screen reachable, exactly one visible at a
// time, no control on screen that the signed-in role may not use, clean
// console. Exits non-zero on any failure.
//
//   node docs/prototype/check.mjs
//
// playwright-core is not a dependency of this repo (see docs/tools/README.md).
// Point PW at an install and CHROME at the browser if the defaults miss.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
let chromium;
for (const c of [process.env.PW, 'playwright-core', 'playwright',
                 '/usr/lib/node_modules/playwright-core'].filter(Boolean)) {
  try { ({ chromium } = require_(c)); break; } catch { /* try next */ }
}
if (!chromium) {
  console.error('playwright-core not found. Install it anywhere and point PW at it:\n' +
                '  npm i -g playwright-core && PW=playwright-core node docs/prototype/check.mjs');
  process.exit(1);
}
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FILE = pathToFileURL(join(here, 'pms-ui-prototype.html')).href;

// Must match PERSONAS in generate.py — that is the point of the check.
const EXPECT = { employee: ['self'], manager: ['self', 'mgr'], hr: ['self', 'mgr', 'hr'] };

const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('JS ERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
await p.goto(FILE, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);

const bad = [], gate = [], seen = new Set();
for (const person of Object.keys(EXPECT)) {
  await p.click(`.pb[data-p="${person}"]`);
  await p.waitForTimeout(120);
  const groups = await p.$$eval(`.rolebar[data-persona="${person}"] .gt`, (bs) => bs.map((x) => x.dataset.group));
  const ok = JSON.stringify(groups) === JSON.stringify(EXPECT[person]);
  if (!ok) gate.push({ person, got: groups, want: EXPECT[person] });
  // Nothing on screen may lead anywhere this person is not allowed.
  const strays = await p.$$eval('.subnav:not([hidden]) a, .rolebar:not([hidden]) .gt',
    (els, allowed) => els.filter((e) => {
      const g = e.dataset.group || (e.dataset.go || '').split('-')[0];
      return !allowed.includes(g);
    }).length, EXPECT[person]);
  if (strays) gate.push({ person, offLimitsControlsVisible: strays });
  console.log(`${person.padEnd(9)} tabs: [${groups}] ${ok ? 'OK' : 'MISMATCH'}, off-limits controls visible: ${strays}`);

  for (const g of groups) {
    await p.click(`.rolebar[data-persona="${person}"] .gt[data-group="${g}"]`);
    await p.waitForTimeout(80);
    const links = await p.$$eval(`.subnav[data-for="${g}"] a`, (as) => as.map((a) => a.dataset.go));
    for (const id of links) {
      await p.click(`.subnav[data-for="${g}"] a[data-go="${id}"]`, { timeout: 3000 });
      await p.waitForTimeout(50);
      const info = await p.evaluate((i) => {
        const s = document.getElementById(i);
        return { hidden: s.hidden, chars: s.innerText.trim().length,
                 visible: document.querySelectorAll('.screen:not([hidden])').length,
                 hero: !!s.querySelector('.hero h1') };
      }, id);
      seen.add(id);
      if (info.hidden || info.chars < 120 || info.visible !== 1 || !info.hero) bad.push({ person, id, ...info });
    }
  }
}
const all = await p.$$eval('.screen', (s) => s.map((x) => x.id));
const unreachable = all.filter((i) => !seen.has(i));
console.log(`screens: ${seen.size} reached of ${all.length}${unreachable.length ? ', unreachable: ' + unreachable : ''}`);
console.log('screens that failed to render properly:', bad.length, bad.length ? JSON.stringify(bad) : '');
console.log('role-gating problems:', gate.length, gate.length ? JSON.stringify(gate) : '');
console.log('js errors:', errs.length ? errs : 'none');
await b.close();
process.exit(bad.length || gate.length || errs.length || unreachable.length ? 1 : 0);

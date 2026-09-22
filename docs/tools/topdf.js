// playwright-core is NOT a dependency of this repo — it is only ever needed
// to regenerate the PDF, and adding it to package.json would make every
// `npm ci` pull a browser driver nobody else uses. So resolve it from
// wherever it happens to be installed, and say plainly what to do when it
// is not. Set PW to override (e.g. PW=/path/to/node_modules/playwright-core).
function loadChromium() {
  const { createRequire } = require('node:module');
  const candidates = [process.env.PW, 'playwright-core', 'playwright',
    '/usr/lib/node_modules/playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try { return createRequire(__filename)(c).chromium; } catch (_) { /* try next */ }
    try { return require(c).chromium; } catch (_) { /* try next */ }
  }
  console.error(
    'playwright-core not found. Install it anywhere and point PW at it:\n' +
    '  npm i -g playwright-core && PW=playwright-core node docs/tools/topdf.js\n' +
    'CHROME= may also be needed if the browser is not at the default path.');
  process.exit(1);
}
const chromium = loadChromium();
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Input, output and the footer caption are all parameters: there is more
// than one document in docs/ now, and a second copy of this script that
// differed only in three strings would be the thing that goes stale.
const IN = process.env.IN;
const OUT = process.env.OUT;
const FOOTER = process.env.FOOTER || '';
if (!IN || !OUT) {
  console.error('usage: IN=/abs/in.html OUT=/abs/out.pdf [FOOTER="left caption"] node docs/tools/topdf.js');
  process.exit(1);
}
(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const page = await (await b.newContext()).newPage();
  await page.emulateMedia({ media: 'print', colorScheme: 'light' });
  await page.goto('file://' + IN, { waitUntil: 'networkidle' });
  // Google Fonts must actually have landed, or the PDF ships in fallbacks.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font:7.5pt Inter,sans-serif;color:#6d7d8e;' +
      'padding:0 14mm;display:flex;justify-content:space-between;">' +
      `<span>${FOOTER}</span>` +
      '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: '13mm', bottom: '15mm', left: '13mm', right: '13mm' },
  });
  console.log('pdf written');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });

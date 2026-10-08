// node --test — the screens are built in GitHub Actions and the instance
// only downloads them (asked for on 8 Oct, after a deploy took the PoC down
// for about seven hours while it built the frontend on the box).
//
// Two layers, both against REAL temporary git repositories standing in
// for GitHub, the CI checkout and the instance:
//
//   1. deploy/service/web-bundle.sh — publish, fetch, prune.
//   2. deploy/service/update.sh itself, run for real with stand-ins for
//      the parts that need root, systemd, nginx and npm — so the order of
//      operations is tested, not just the helpers: no bundle means NOTHING
//      on the box moves.
//
// No root, no network, no database.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

// Hermetic: the machine's own git settings (signing, push negotiation)
// are not the box's or GitHub's, and must not decide what these tests see.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const DEPLOY = path.resolve(__dirname, '../../deploy/service');
const HELPERS = path.join(DEPLOY, 'web-bundle.sh');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const write = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const bash = (script, env = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });

// origin (bare, "GitHub"), with main carrying two commits; a CI clone.
function world() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'apms-web-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });  // "cloned an empty repository" is expected
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 'T');
  write(path.join(work, 'server/package.json'), '{"name":"s"}');
  write(path.join(work, 'server/package-lock.json'), '{"lockfileVersion":3}');
  write(path.join(work, 'frontend/package.json'), '{"name":"f"}');
  write(path.join(work, '.gitignore'), 'dist/\nnode_modules/\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'first'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  const c1 = git(work, 'rev-parse', 'HEAD');
  write(path.join(work, 'server/app.js'), 'v2');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'second'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  const c2 = git(work, 'rev-parse', 'HEAD');
  return { root, origin, work, c1, c2 };
}

// A built dist/ the way vite leaves it: index.html naming its entry, and
// the entry carrying the commit stamp.
function dist(dir, sha, { stamp = sha } = {}) {
  write(path.join(dir, 'index.html'), `<script src="/assets/index-${sha.slice(0, 6)}.js"></script>`);
  write(path.join(dir, `assets/index-${sha.slice(0, 6)}.js`), `const build="${stamp.slice(0, 7)}";`);
  return dir;
}
const publish = (w, sha, opts) => {
  const d = dist(path.join(w.root, `dist-${sha.slice(0, 7)}-${Math.round(Math.random() * 1e6)}`), sha, opts);
  const r = bash(`set -e; . "${HELPERS}"; publish_web_bundle "${w.work}" "${d}" "${sha}"`);
  assert.equal(r.status, 0, r.stderr);
  return r;
};

test('publish then fetch: the instance gets exactly the bundle built for its commit', () => {
  const w = world();
  try {
    // The instance was cloned long before; it only ever fetches.
    const box = path.join(w.root, 'box');
    execFileSync('git', ['clone', '-q', w.origin, box]);

    const before = git(w.work, 'status', '--porcelain');
    publish(w, w.c2);
    assert.equal(git(w.work, 'status', '--porcelain'), before, 'the CI checkout is left exactly as it was');
    assert.match(git(w.origin, 'for-each-ref', 'refs/tags/web-build/'), new RegExp(w.c2));

    // The box's normal fetch (update.sh's own) does not drag every bundle
    // along with it: the bundles are orphans, so no tag auto-follows.
    git(box, 'fetch', '--all', '--prune');
    assert.equal(git(box, 'tag', '-l'), '', 'no web-build tags in the box\'s own tag list');

    const out = path.join(w.root, 'out');
    const r = bash(`. "${HELPERS}"; fetch_web_bundle "${box}" "${w.c2}" "${out}"`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    assert.ok(fs.existsSync(path.join(out, `assets/index-${w.c2.slice(0, 6)}.js`)));
    assert.equal(git(box, 'tag', '-l'), '', 'fetched into refs/web-build/, still not a tag on the box');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('no bundle for the commit, or a bundle built from another commit, is refused', () => {
  const w = world();
  try {
    const box = path.join(w.root, 'box');
    execFileSync('git', ['clone', '-q', w.origin, box]);
    let r = bash(`. "${HELPERS}"; fetch_web_bundle "${box}" "${w.c2}" "${w.root}/o1"`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No prebuilt web bundle/);

    publish(w, w.c2, { stamp: w.c1 });  // tagged c2, built from c1
    r = bash(`. "${HELPERS}"; fetch_web_bundle "${box}" "${w.c2}" "${w.root}/o2"`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /was not built from/);

    // A bundle whose index.html names an asset it does not carry — what a
    // truncated download or extract looks like — is refused, not served.
    const d = dist(path.join(w.root, 'dist-incomplete'), w.c2);
    fs.appendFileSync(path.join(d, 'index.html'), '<link rel="stylesheet" href="/assets/index-gone.css">');
    assert.equal(bash(`set -e; . "${HELPERS}"; publish_web_bundle "${w.work}" "${d}" "${w.c2}"`).status, 0);
    r = bash(`. "${HELPERS}"; fetch_web_bundle "${box}" "${w.c2}" "${w.root}/o3"`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /incomplete — missing or empty: assets\/index-gone\.css/);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('prune keeps the bundles for recent commits and named extras, and keeps everything when it cannot tell', () => {
  const w = world();
  try {
    publish(w, w.c1); publish(w, w.c2);
    const fake = 'f'.repeat(40);
    publish(w, fake, { stamp: fake });
    git(w.work, 'fetch', '-q', 'origin');
    // Unreadable branch: nothing deleted.
    let r = bash(`. "${HELPERS}"; prune_remote_web_bundles "${w.work}" 1 no-such-branch`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Kept every web bundle/);
    assert.equal(git(w.origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/web-build/').split('\n').length, 3);
    // Keep the last 1 commit of main (c2) plus c1 by name; the stranger goes.
    r = bash(`. "${HELPERS}"; prune_remote_web_bundles "${w.work}" 1 main "${w.c1}"`);
    assert.equal(r.status, 0, r.stderr);
    const left = git(w.origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/web-build/');
    assert.match(left, new RegExp(w.c1)); assert.match(left, new RegExp(w.c2));
    assert.ok(!left.includes(fake));
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- update.sh
// Runs the real update.sh from a copy of deploy/service (as the GitHub
// deploy does), against a box clone, with stand-ins on PATH for what needs
// root, systemd, nginx and npm. rsync is the real one: its handling of the
// web root's mode is part of what is being tested.
const crypto = require('node:crypto');
// GitHub's Ubuntu runners and the instance both have rsync; a laptop
// without it skips these, by name, rather than failing on a stand-in.
const NO_RSYNC = spawnSync('bash', ['-c', 'command -v rsync']).status !== 0 && 'rsync is not installed here';
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const depsSum = (dir) => crypto.createHash('sha256')
  .update(Buffer.concat(['server/package.json', 'server/package-lock.json'].map((f) => fs.readFileSync(path.join(dir, f)))))
  .digest('hex');

function box(w) {
  const app = path.join(w.root, 'app');
  const web = path.join(w.root, 'www');
  execFileSync('git', ['clone', '-q', w.origin, app]);
  git(app, 'checkout', '-q', '-B', 'main', '--track', 'origin/main');
  git(app, 'reset', '-q', '--hard', w.c1);
  // Installed packages, stamped as update.sh stamps a successful npm ci.
  write(path.join(app, 'server/node_modules/.apms-installed'), `${depsSum(app)}\n`);
  write(path.join(web, 'index.html'), 'OLD SITE');
  fs.chmodSync(web, 0o755);
  const scripts = path.join(w.root, 'scripts');
  fs.cpSync(DEPLOY, scripts, { recursive: true });
  write(path.join(scripts, 'backup.sh'), '#!/usr/bin/env bash\necho "    (backup stand-in)"\n');
  write(path.join(scripts, 'reconcile-settings.sh'), '#!/usr/bin/env bash\necho "    (settings stand-in)"\n');
  fs.chmodSync(path.join(scripts, 'backup.sh'), 0o755);
  fs.chmodSync(path.join(scripts, 'reconcile-settings.sh'), 0o755);
  const bin = path.join(w.root, 'bin');
  const log = path.join(w.root, 'calls.log');
  const stub = (name, body) => { write(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  stub('id', 'echo 0');
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  stub('journalctl', 'true');
  stub('chown', 'true');
  // npm: logs where it ran. `npm ci` empties node_modules first, as the
  // real one does, and fails on NPM_FAIL=ci; `npm run build` writes a
  // vite-shaped dist stamped with the commit it ran on, or fails on
  // NPM_FAIL=build.
  stub('npm', `echo "npm $* in $PWD" >> "${log}"
if [ "$1" = ci ]; then rm -rf node_modules; mkdir -p node_modules; [ "\${NPM_FAIL:-}" = ci ] && exit 1; exit 0; fi
if [ "$1" = run ] && [ "$2" = build ]; then
  [ "\${NPM_FAIL:-}" = build ] && exit 1
  mkdir -p dist/assets
  echo '<script type="module" src="/assets/index-box.js"></script>' > dist/index.html
  echo "const build=\\"$(git rev-parse --short=7 HEAD)\\";" > dist/assets/index-box.js
fi`);
  stub('curl', `case "$*" in *api/v1/health*) echo '{"ok":true,"build":"test"}' ;; *) cat "${web}/index.html" ;; esac`);
  const run = (args, env = {}) => spawnSync('bash', [path.join(scripts, 'update.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APMS_APP_DIR: app, APMS_WEB_ROOT: web, ...env },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const site = () => fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  return { app, web, run, calls, site };
}
// A commit on a second branch, pushed to origin.
function sideBranch(w) {
  git(w.work, 'checkout', '-q', '-b', 'side');
  write(path.join(w.work, 'side.txt'), 'x'); git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'side');
  git(w.work, 'push', '-q', 'origin', 'side');
  const sha = git(w.work, 'rev-parse', 'HEAD');
  git(w.work, 'checkout', '-q', 'main');
  return sha;
}

test('UPDATE.SH: deploys the pinned commit with the downloaded screens, and does not reinstall unchanged packages', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    publish(w, w.c2);
    const b = box(w);
    const r = b.run(['main', w.c2]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Downloaded the web bundle/);
    assert.match(r.stdout, new RegExp(`Healthy\\. Deployed ${w.c1.slice(0, 7)} -> ${w.c2.slice(0, 7)} on main`));
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c2);
    assert.match(b.site(), new RegExp(`index-${w.c2.slice(0, 6)}`));
    assert.match(r.stdout, /unchanged — not reinstalled/);
    assert.ok(!/npm/.test(b.calls()), 'no npm at all on the box: nothing built, nothing reinstalled');
    assert.match(b.calls(), /systemctl restart agentic-pms-api/);
    // rsync -a copies the source directory's mode, and the download lands
    // in a 0700 mktemp directory: without --chmod nginx gets 403 everywhere.
    assert.equal(mode(b.web), '755', 'the web root stays readable by nginx');
    assert.equal(mode(path.join(b.web, 'index.html')), '644');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: with no bundle for the commit it stops BEFORE changing anything', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    const b = box(w);
    const r = b.run(['main', w.c2]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Stopping before any change/);
    assert.match(r.stderr, /sudo BUILD_ON_BOX=1 /, 'the fallback is spelled out with sudo in the right place');
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c1, 'the checkout did not move');
    assert.equal(b.site(), 'OLD SITE', 'the site was not touched');
    assert.equal(b.calls(), '', 'no npm, no restart');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: BUILD_ON_BOX=1 builds in a worktree of the target, and a failed build changes nothing', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    const b = box(w);
    let r = b.run(['main', w.c2], { BUILD_ON_BOX: '1', NPM_FAIL: 'build' });
    assert.notEqual(r.status, 0);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c1, 'a failed build leaves the checkout where it was');
    assert.equal(b.site(), 'OLD SITE');
    assert.ok(!/systemctl/.test(b.calls()), 'and nothing restarted');
    assert.equal(git(b.app, 'worktree', 'list').split('\n').length, 1, 'the build worktree is cleaned up');

    r = b.run(['main', w.c2], { BUILD_ON_BOX: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const build = b.calls().split('\n').filter((l) => /npm run build/.test(l)).pop();
    assert.ok(build && !build.includes(`${b.app}/frontend`), `built outside the live checkout: ${build}`);
    assert.match(b.site(), /index-box/);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c2);
    assert.equal(mode(b.web), '755');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: never moves backwards, and touches nothing when asked to', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    publish(w, w.c1); publish(w, w.c2);
    const b = box(w);
    assert.equal(b.run(['main', w.c2]).status, 0);
    const restarts = () => (b.calls().match(/systemctl restart/g) || []).length;
    const before = restarts();
    const r = b.run(['main', w.c1]);  // an old deploy re-run
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /==> Already past /);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c2, 'no rollback');
    assert.equal(restarts(), before, 'no restart, no settings, no screens');
    assert.match(b.site(), new RegExp(`index-${w.c2.slice(0, 6)}`));

    // The same commit again is a repair, not a no-op: screens re-synced,
    // API restarted, and said to be NOTHING NEW.
    const again = b.run(['main', w.c2]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /NOTHING NEW was deployed: still at/);
    assert.equal(restarts(), before + 1);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: refuses a commit off the branch, a tag or sha for a branch, and a diverged box — before anything moves', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    publish(w, w.c2);
    const side = sideBranch(w);
    publish(w, side);
    const b = box(w);
    let r = b.run(['main', side]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not on origin\/main/);

    r = b.run([w.c2, w.c2]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not a branch on origin/);
    assert.equal(git(b.app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'not left detached');

    // The box's own main has a commit origin does not.
    write(path.join(b.app, 'local.txt'), 'x');
    git(b.app, 'add', '.'); git(b.app, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'local');
    const local = git(b.app, 'rev-parse', 'HEAD');
    r = b.run(['main', w.c2]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has diverged/);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), local);
    assert.equal(b.site(), 'OLD SITE');
    assert.equal(b.calls(), '');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: switching branches moves only once the screens are in hand, and lands on the asked commit', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    const side = sideBranch(w);
    const b = box(w);
    // No bundle for side yet: the box stays on main, untouched.
    let r = b.run(['side', side]);
    assert.equal(r.status, 1);
    assert.equal(git(b.app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c1);

    publish(w, side);
    r = b.run(['side', side]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(b.app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side');
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), side);
    assert.equal(git(b.app, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/side');
    assert.match(b.site(), new RegExp(`index-${side.slice(0, 6)}`), 'the screens are side\'s, not main\'s');
    assert.match(r.stdout, new RegExp(`Deployed ${w.c1.slice(0, 7)} -> ${side.slice(0, 7)} on side`));

    // And back to main.
    publish(w, w.c2);
    r = b.run(['main', w.c2]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(b.app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c2);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: packages are reinstalled when the lock changes, and again after an install that failed', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    write(path.join(w.work, 'server/package-lock.json'), '{"lockfileVersion":3,"x":1}');
    git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'deps'); git(w.work, 'push', '-q', 'origin', 'HEAD:main');
    const c3 = git(w.work, 'rev-parse', 'HEAD');
    publish(w, c3);
    const b = box(w);
    let r = b.run(['main', c3], { NPM_FAIL: 'ci' });
    assert.notEqual(r.status, 0, 'a failed npm ci fails the deploy');
    assert.equal(b.site(), 'OLD SITE', 'before the screens moved');
    assert.ok(!/systemctl restart/.test(b.calls()), 'and before the restart');

    // The re-run: the checkout is already at c3, but the packages are not
    // installed — it must install, not decide "unchanged".
    r = b.run(['main', c3]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /unchanged — not reinstalled/);
    assert.equal((b.calls().match(/npm ci --omit=dev/g) || []).length, 2);
    // And from then on, not again.
    r = b.run(['main', c3]);
    assert.match(r.stdout, /unchanged — not reinstalled/);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: no web-build tag survives on the box, however it fetched', { skip: NO_RSYNC }, () => {
  const w = world();
  try {
    publish(w, w.c1); publish(w, w.c2);
    const b = box(w);
    assert.equal(b.run(['main', w.c2]).status, 0);
    git(b.app, 'fetch', '-q', 'origin');  // a plain fetch by hand auto-follows the deployed bundle
    // The next deploy's local prune drops it.
    write(path.join(w.work, 'server/app.js'), 'v3');
    git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'third'); git(w.work, 'push', '-q', 'origin', 'HEAD:main');
    const c3 = git(w.work, 'rev-parse', 'HEAD');
    publish(w, c3);
    const r = b.run(['main', c3]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(b.app, 'tag', '-l'), '', 'no web-build tags on the box');
    assert.equal(git(b.app, 'for-each-ref', '--format=%(refname)', 'refs/web-build/'), `refs/web-build/${c3}`, 'only the deployed bundle is kept');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('THE DEPLOY COMMAND: what the workflow sends runs update.sh from the deployed commit, with the right arguments', () => {
  const yml = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy.yml'), 'utf8');
  const remote = /REMOTE='(.*)'\n/.exec(yml);
  assert.ok(remote, 'the REMOTE script is where the test expects it');
  const has = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
  if (!has('jq')) return;  // the runner has jq; a laptop may not
  const w = world();
  try {
    // A deploy/service in the commit that records how it was called.
    write(path.join(w.work, 'deploy/service/update.sh'), `#!/usr/bin/env bash\necho "called from $(dirname "$0") with $*"\n`);
    fs.chmodSync(path.join(w.work, 'deploy/service/update.sh'), 0o755);
    git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'scripts'); git(w.work, 'push', '-q', 'origin', 'HEAD:main');
    const sha = git(w.work, 'rev-parse', 'HEAD');
    const app = path.join(w.root, 'app');
    execFileSync('git', ['clone', '-q', w.origin, app]);
    git(app, 'reset', '-q', '--hard', w.c1);
    const script = remote[1].replace(/\/opt\/agentic-pms/g, app);
    const params = execFileSync('jq', ['-nc', '--arg', 'remote', script, '--arg', 'sha', sha, '--arg', 'ref', 'main',
      '{commands: [("sudo bash -c " + ($remote | @sh) + " deploy " + $sha + " " + $ref)]}'], { encoding: 'utf8' });
    const cmd = JSON.parse(params).commands[0].replace(/^sudo /, '');
    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`with main ${sha}$`, 'm'), 'update.sh gets <branch> <commit>');
    assert.ok(!r.stdout.includes(app), 'and runs from a copy, not from the box\'s own checkout');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('THE FIRST DEPLOY, END TO END: the workflow\'s command runs the real scripts from the new commit on a box still on the old one', { skip: NO_RSYNC }, () => {
  const yml = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy.yml'), 'utf8');
  const remote = /REMOTE='(.*)'\n/.exec(yml)[1];
  if (spawnSync('bash', ['-c', 'command -v jq']).status !== 0) return;
  const w = world();
  try {
    const b = box(w);  // on c1, which has no deploy/service at all — older than any of this
    // c3 carries the real deploy scripts (backup and settings stood in, as in box()).
    fs.cpSync(DEPLOY, path.join(w.work, 'deploy/service'), { recursive: true });
    for (const f of ['backup.sh', 'reconcile-settings.sh']) {
      write(path.join(w.work, 'deploy/service', f), '#!/usr/bin/env bash\necho "    (stand-in)"\n');
      fs.chmodSync(path.join(w.work, 'deploy/service', f), 0o755);
    }
    git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'scripts'); git(w.work, 'push', '-q', 'origin', 'HEAD:main');
    const c3 = git(w.work, 'rev-parse', 'HEAD');
    publish(w, c3);
    const script = remote.replace(/\/opt\/agentic-pms/g, b.app);
    const params = execFileSync('jq', ['-nc', '--arg', 'remote', script, '--arg', 'sha', c3, '--arg', 'ref', 'main',
      '{commands: [("sudo bash -c " + ($remote | @sh) + " deploy " + $sha + " " + $ref)]}'], { encoding: 'utf8' });
    const cmd = JSON.parse(params).commands[0].replace(/^sudo /, '');
    const r = spawnSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(w.root, 'bin')}:${process.env.PATH}`, APMS_APP_DIR: b.app, APMS_WEB_ROOT: b.web },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Healthy\\. Deployed ${w.c1.slice(0, 7)} -> ${c3.slice(0, 7)} on main`));
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), c3);
    assert.match(b.site(), new RegExp(`index-${c3.slice(0, 6)}`));
    assert.equal(mode(b.web), '755');
    assert.equal(git(b.app, 'tag', '-l'), '');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

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
// deploy does), against a box clone, with stand-ins on PATH.
function box(w) {
  const app = path.join(w.root, 'app');
  const web = path.join(w.root, 'www');
  execFileSync('git', ['clone', '-q', w.origin, app]);
  git(app, 'checkout', '-q', w.c1);
  git(app, 'checkout', '-q', '-B', 'main', '--track', 'origin/main');
  git(app, 'reset', '-q', '--hard', w.c1);
  fs.mkdirSync(path.join(app, 'server/node_modules'), { recursive: true });
  write(path.join(web, 'index.html'), 'OLD SITE');
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
  stub('npm', `echo "npm $*" >> "${log}"; if [ "$1" = run ] && [ "$2" = build ]; then mkdir -p dist; echo '<script src="/assets/index-box.js"></script>' > dist/index.html; fi`);
  stub('rsync', 'src="${@: -2:1}"; dst="${@: -1}"; rm -rf "$dst"; mkdir -p "$dst"; cp -a "$src". "$dst"');
  stub('curl', `case "$*" in *api/v1/health*) echo '{"ok":true,"build":"test"}' ;; *) cat "${web}/index.html" ;; esac`);
  const run = (args, env = {}) => spawnSync('bash', [path.join(scripts, 'update.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APMS_APP_DIR: app, APMS_WEB_ROOT: web, ...env },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return { app, web, run, calls };
}

test('UPDATE.SH: deploys the pinned commit with the downloaded screens, and does not reinstall unchanged packages', () => {
  const w = world();
  try {
    publish(w, w.c2);
    const b = box(w);
    const r = b.run(['main', w.c2]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Downloaded the web bundle/);
    assert.match(r.stdout, new RegExp(`Healthy\\. Deployed ${w.c1.slice(0, 7)} -> ${w.c2.slice(0, 7)} on main`));
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c2);
    assert.match(fs.readFileSync(path.join(b.web, 'index.html'), 'utf8'), new RegExp(`index-${w.c2.slice(0, 6)}`));
    assert.match(r.stdout, /unchanged — not reinstalled/);
    assert.ok(!/npm/.test(b.calls()), 'no npm at all on the box: nothing built, nothing reinstalled');
    assert.match(b.calls(), /systemctl restart agentic-pms-api/);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: with no bundle for the commit it stops BEFORE changing anything', () => {
  const w = world();
  try {
    const b = box(w);
    const r = b.run(['main', w.c2]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Stopping before any change/);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c1, 'the checkout did not move');
    assert.equal(fs.readFileSync(path.join(b.web, 'index.html'), 'utf8'), 'OLD SITE', 'the site was not touched');
    assert.equal(b.calls(), '', 'no npm, no restart');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: BUILD_ON_BOX=1 is the deliberate way to build on the instance', () => {
  const w = world();
  try {
    const b = box(w);
    const r = b.run(['main', w.c2], { BUILD_ON_BOX: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(b.calls(), /npm run build/);
    assert.match(fs.readFileSync(path.join(b.web, 'index.html'), 'utf8'), /index-box/);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('UPDATE.SH: never moves backwards, refuses a commit off the branch, and reinstalls packages when the lock changes', () => {
  const w = world();
  try {
    publish(w, w.c2);
    // A commit on another branch.
    git(w.work, 'checkout', '-q', '-b', 'side');
    write(path.join(w.work, 'side.txt'), 'x'); git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'side');
    git(w.work, 'push', '-q', 'origin', 'side');
    const side = git(w.work, 'rev-parse', 'HEAD');
    git(w.work, 'checkout', '-q', 'main');

    const b = box(w);
    let r = b.run(['main', side]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not on origin\/main/);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c1);

    assert.equal(b.run(['main', w.c2]).status, 0);
    r = b.run(['main', w.c1]);  // an old deploy re-run
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already past/);
    assert.match(r.stdout, /NOTHING NEW/);
    assert.equal(git(b.app, 'rev-parse', 'HEAD'), w.c2, 'no rollback');

    // A dependency change is installed.
    write(path.join(w.work, 'server/package-lock.json'), '{"lockfileVersion":3,"x":1}');
    git(w.work, 'add', '.'); git(w.work, 'commit', '-qm', 'deps'); git(w.work, 'push', '-q', 'origin', 'HEAD:main');
    const c3 = git(w.work, 'rev-parse', 'HEAD');
    publish(w, c3);
    r = b.run(['main', c3]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(b.calls(), /npm ci --omit=dev/);
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

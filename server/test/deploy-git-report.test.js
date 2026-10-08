// node --test — a deploy must say what it did to the checkout, and must
// say so when it did nothing.
//
// Asked for on 28 Sep: "please fix update.sh to report before and after
// commit."
//
// THE INCIDENT. A change went to main; the PoC tracks a feature branch,
// so `git pull` brought nothing. update.sh rebuilt identical code,
// restarted, printed "==> Healthy." and exited 0 — all true, and the
// deploy had done nothing. The same run had already chowned a file to
// the new service account, leaving the box one restart from failing to
// boot. Nothing in the output said so.
//
// These tests drive deploy/service/git-report.sh against REAL temporary
// git repositories. No root, no systemd, no database, no network — so
// they run everywhere the rest of the suite runs, which is the only
// reason deploy scripts get tested at all.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../../deploy/service/git-report.sh');

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

// A repo with two commits on `main` and a second branch left behind at
// the first — the exact shape that caused the incident.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'apms-git-report-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'f.txt'), 'one');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'the first commit');
  const first = git(dir, 'rev-parse', '--short', 'HEAD');
  git(dir, 'branch', 'stale');
  writeFileSync(path.join(dir, 'f.txt'), 'two');
  git(dir, 'commit', '-qam', 'the second commit');
  const second = git(dir, 'rev-parse', '--short', 'HEAD');
  return { dir, first, second };
}

// Runs report_git_change and returns {out, code}. `bash -e` deliberately
// NOT used: the function returns 1 for "did not move", and the caller is
// supposed to survive that.
function report(dir, beforeBranch, beforeSha) {
  const script = `. "${SCRIPT}"; report_git_change "${dir}" "${beforeBranch}" "${beforeSha}"; echo "rc=$?"`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return { out, code: Number(/rc=(\d+)/.exec(out)[1]) };
}

test('a real move prints before, after and the subject', () => {
  const { dir, first, second } = fixture();
  try {
    const { out, code } = report(dir, 'main', first);
    assert.match(out, new RegExp(`before: ${first}`));
    assert.match(out, new RegExp(`after:  ${second}`));
    assert.match(out, /the second commit/, 'the subject, so a reader can tell WHAT landed');
    assert.match(out, /branch: main/, 'and which branch it landed on');
    assert.equal(code, 0);
    assert.ok(!/NOTHING NEW/.test(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('THE INCIDENT: an unchanged checkout says so, loudly', () => {
  const { dir, second } = fixture();
  try {
    // Nothing happened between before and after — exactly what a pull
    // brings when the commit is on a branch this box does not track.
    const { out, code } = report(dir, 'main', second);
    assert.match(out, /NOTHING NEW/, 'silence here is what cost a deploy');
    assert.equal(code, 1, 'the caller has to be able to tell, not just a human reading it');
    assert.match(out, new RegExp(`before: ${second}`));
    assert.match(out, new RegExp(`after:  ${second}`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('and it names the likeliest cause rather than leaving it to be guessed', () => {
  const { dir, second } = fixture();
  try {
    const { out } = report(dir, 'main', second);
    // The branch is the cause, so the branch has to be in the sentence.
    assert.match(out, /check that it is on 'main'/,
      'naming the tracked branch is what turns "nothing moved" into a diagnosis');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a deploy that switches branch reports the switch', () => {
  const { dir, first, second } = fixture();
  try {
    git(dir, 'checkout', '-q', 'stale');
    const { out, code } = report(dir, 'main', second);
    assert.match(out, /branch: stale/);
    assert.match(out, /branch changed from main/,
      'a checkout that moved BACKWARDS looks like a normal deploy without this');
    assert.equal(code, 0, 'the sha did change, even though it went backwards');
    assert.match(out, new RegExp(`after:  ${first}`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('git_state is one line: branch, sha, subject', () => {
  const { dir, second } = fixture();
  try {
    const out = execFileSync('bash', ['-c', `. "${SCRIPT}"; git_state "${dir}"`], { encoding: 'utf8' });
    assert.equal(out.split('\n').length, 1, 'one line — it is printed inline');
    assert.match(out, new RegExp(`^main ${second} the second commit$`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a directory that is not a git checkout does not crash the deploy', () => {
  // update.sh refuses non-checkouts earlier, but a reporting helper that
  // throws while REPORTING would turn a handled situation into a failed
  // deploy with no explanation.
  const dir = mkdtempSync(path.join(tmpdir(), 'apms-not-git-'));
  try {
    const out = execFileSync('bash', ['-c', `. "${SCRIPT}"; git_state "${dir}"; echo " rc=$?"`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(out, /\?/, 'unknowns are printed as ? rather than blowing up');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('update.sh actually uses it, and reports on the success line', () => {
  // The helper being right is worth nothing if update.sh does not call
  // it. Read the script rather than trusting that it was wired up.
  const src = require('fs').readFileSync(
    path.resolve(__dirname, '../../deploy/service/update.sh'), 'utf8');
  // From its own directory (HERE), not APP_DIR: the GitHub deploy runs
  // update.sh from a copy taken out of the commit being deployed.
  assert.match(src, /\.\s+"\$\{HERE\}\/git-report\.sh"/, 'it sources the helper');
  assert.match(src, /BEFORE_SHA=/, 'it captures the before sha BEFORE fetching');
  assert.ok(src.indexOf('BEFORE_SHA=') < src.indexOf('git -C "$APP_DIR" fetch'),
    'capturing the before sha after the fetch would record the wrong thing');
  assert.match(src, /report_git_change "\$APP_DIR"/, 'it calls the reporter after the pull');
  // And the summary reaches the END of the output, because "==> Healthy."
  // on its own is exactly what made a no-op look like a real deploy.
  assert.match(src, /Healthy\. Deployed \$\{BEFORE_SHA\} ->/);
  assert.match(src, /Healthy — but NOTHING NEW was deployed/);
});

// node --test — a deploy may carry non-secret settings, and must not be
// able to carry anything else.
//
// WHY THIS EXISTS. install.sh never overwrites /etc/agentic-pms/api.env
// and update.sh never touched it, because that file holds the Anthropic
// key, the database URL and the JWT secret. The cost was paid by the
// settings in the same file that are NOT secret: AI_MODEL is
// version-controlled by our own documentation, yet changing it in the
// repo and deploying did nothing at all. Twice, in front of the client.
//
// So the deploy now reconciles a named allow-list. That is a script
// rewriting a file full of credentials on every deploy, which is exactly
// the kind of thing that has to be pinned rather than trusted:
//
//   1. it changes the managed key
//   2. it changes NOTHING else in the file — the key, the URL, comments,
//      blank lines, ordering
//   3. it REFUSES a secret-shaped key name outright
//   4. it is idempotent
//   5. an operator can pin a box and the deploy says so
//
// Drives the real script against real temp files. No root, no systemd —
// same reason deploy-git-report.test.js can exist at all.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../../deploy/service/reconcile-settings.sh');
const MANAGED = path.resolve(__dirname, '../../deploy/service/managed-settings.env');

// An env file shaped like the real one: secrets, config, comments, blanks.
const ENV = `# Agentic PMS instance settings
DATABASE_URL=postgres://postgres:s3cr3t@127.0.0.1:5432/apms
JWT_SECRET=a-real-looking-jwt-secret-value
TENANT_SLUG=mindgate
AUTH_DEV=true

# Optional. Empty = no AI.
ANTHROPIC_API_KEY=sk-ant-api03-NOT-A-REAL-KEY-0000000000000000
AI_MODEL=claude-opus-5

PORT=8080
BIND_HOST=127.0.0.1
`;

function bed(envText = ENV, managed = 'AI_MODEL=claude-opus-5-5\n') {
  const dir = mkdtempSync(path.join(tmpdir(), 'apms-reconcile-'));
  const envFile = path.join(dir, 'api.env');
  const managedFile = path.join(dir, 'managed.env');
  writeFileSync(envFile, envText);
  chmodSync(envFile, 0o640);
  writeFileSync(managedFile, managed);
  return { dir, envFile, managedFile };
}
const run = (b) => execFileSync('bash', [SCRIPT, b.envFile, b.managedFile], { encoding: 'utf8' });
const read = (b) => readFileSync(b.envFile, 'utf8');
const valueOf = (text, key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1];

test('it changes the managed setting', () => {
  const b = bed();
  try {
    const out = run(b);
    assert.equal(valueOf(read(b), 'AI_MODEL'), 'claude-opus-5-5');
    assert.match(out, /AI_MODEL: claude-opus-5 -> claude-opus-5-5/);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

// THE ONE THAT MATTERS. Everything else in that file is a credential or
// an instance decision, and a deploy that disturbs any of it is worse
// than a deploy that never carried the model at all.
test('IT CHANGES NOTHING ELSE — every other byte of the file survives', () => {
  const b = bed();
  try {
    run(b);
    const after = read(b);
    const before = ENV.split('\n');
    const now = after.split('\n');
    assert.equal(now.length, before.length, 'no line was added or removed');
    before.forEach((line, i) => {
      if (line.startsWith('AI_MODEL=')) return;        // the one we asked for
      assert.equal(now[i], line, `line ${i + 1} changed: ${JSON.stringify(line)} -> ${JSON.stringify(now[i])}`);
    });
    // Named explicitly, because "some line changed" is not the fear.
    assert.match(after, /^ANTHROPIC_API_KEY=sk-ant-api03-NOT-A-REAL-KEY-0000000000000000$/m);
    assert.match(after, /^DATABASE_URL=postgres:\/\/postgres:s3cr3t@127\.0\.0\.1:5432\/apms$/m);
    assert.match(after, /^JWT_SECRET=a-real-looking-jwt-secret-value$/m);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('it keeps the file\'s own permissions — the service reads it as root, 0640', () => {
  const b = bed();
  try {
    const before = statSync(b.envFile).mode;
    run(b);
    assert.equal(statSync(b.envFile).mode, before,
      'rewritten through a copy-back, not a move — a move replaces the inode and its mode');
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('REFUSES a secret-shaped key, however the managed file spells it', () => {
  for (const bad of ['ANTHROPIC_API_KEY=sk-ant-whatever', 'DATABASE_URL=postgres://x',
    'JWT_SECRET=hunter2', 'SOME_TOKEN=abc', 'ADMIN_PASSWORD=abc']) {
    const b = bed(ENV, `${bad}\n`);
    try {
      assert.throws(() => run(b), /refusing to manage/,
        `${bad.split('=')[0]} must be refused`);
      assert.equal(read(b), ENV, 'and the file is untouched when it refuses');
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  }
});

test('it is idempotent, and says so rather than going quiet', () => {
  const b = bed();
  try {
    run(b);
    const after1 = read(b);
    const out = run(b);
    assert.equal(read(b), after1, 'a second run changes nothing');
    assert.match(out, /AI_MODEL: already claude-opus-5-5/);
    assert.match(out, /0 setting\(s\) changed/);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('an operator can pin a box, and the deploy says it left it alone', () => {
  const b = bed(`${ENV}UNMANAGED=AI_MODEL\n`);
  try {
    const out = run(b);
    assert.equal(valueOf(read(b), 'AI_MODEL'), 'claude-opus-5', 'the pin held');
    assert.match(out, /AI_MODEL: pinned by UNMANAGED/);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

test('a managed key the env file lacks is appended, not silently dropped', () => {
  const b = bed(ENV.replace(/^AI_MODEL=.*\n/m, ''));
  try {
    const out = run(b);
    assert.equal(valueOf(read(b), 'AI_MODEL'), 'claude-opus-5-5');
    assert.match(out, /AI_MODEL: \(unset\) -> claude-opus-5-5/);
  } finally { rmSync(b.dir, { recursive: true, force: true }); }
});

// The file that actually ships. A secret added to it would be refused at
// deploy time by the test above, but failing in the repo is cheaper than
// failing on somebody's box.
test('the shipped managed-settings.env carries only non-secret keys', () => {
  const keys = readFileSync(MANAGED, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => l.split('=')[0]);
  assert.ok(keys.length, 'it is not empty');
  for (const k of keys) {
    assert.ok(!/KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|DATABASE_URL|DSN/.test(k),
      `${k} is secret-shaped and must not be deploy-managed`);
  }
  assert.ok(keys.includes('AI_MODEL'), 'the model is the reason this exists');
});

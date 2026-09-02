// Malformed uuid path params must be rejected with 400 before reaching a
// query — see core/http.js for the failure this came from.
//
// Regression for a live finding: GET /consent/status matched
// /consent/:employeeId (no /status route exists), "status" was passed
// straight into a query against a uuid column, and Postgres threw. The
// response was HTTP 500 with the raw driver text
// ("invalid input syntax for type uuid: \"status\""), which both
// misreported a bad request as a server fault and disclosed the backing
// store and column type. Every route taking a uuid param behaved this way.
//
// Exercised through a real express router rather than by calling the
// regex, because the thing worth protecting is the router.param() wiring:
// a router.use() middleware cannot do this job at all (req.params is
// empty until a route matches), so the mechanism is the part that can
// silently regress.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { guardUuidParams, UUID_RE, UUID_PARAMS } = require('../core/http');

test('UUID_RE accepts real uuids and rejects everything else', () => {
  assert.ok(UUID_RE.test('e1f6b9dd-dae0-4f01-b833-5ef6b218e24a'));
  assert.ok(UUID_RE.test('E1F6B9DD-DAE0-4F01-B833-5EF6B218E24A'), 'case-insensitive');
  assert.ok(!UUID_RE.test('status'));
  assert.ok(!UUID_RE.test('123'));
  assert.ok(!UUID_RE.test(''));
  assert.ok(!UUID_RE.test('e1f6b9dd-dae0-4f01-b833'), 'too short');
  assert.ok(!UUID_RE.test('e1f6b9dd-dae0-4f01-b833-5ef6b218e24a-extra'), 'too long');
  assert.ok(!UUID_RE.test('g1f6b9dd-dae0-4f01-b833-5ef6b218e24a'), 'non-hex');
});

test(':department is deliberately NOT uuid-guarded', () => {
  // /department-heads/:department carries a name like "Engineering".
  // Guarding it would 400 every valid call to that route.
  assert.ok(!UUID_PARAMS.includes('department'));
});

test('guardUuidParams rejects malformed ids with 400 and passes valid ones', async () => {
  const app = express();
  const router = express.Router();
  guardUuidParams(router);
  router.get('/thing/:id', (req, res) => res.json({ ok: true, id: req.params.id }));
  router.get('/emp/:employeeId', (req, res) => res.json({ ok: true }));
  // same router, a param that is a name — must stay reachable
  router.get('/dept/:department', (req, res) => res.json({ ok: true, dept: req.params.department }));
  app.use('/api', router);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    assert.equal((await get('/thing/e1f6b9dd-dae0-4f01-b833-5ef6b218e24a')).status, 200);
    assert.equal((await get('/emp/e1f6b9dd-dae0-4f01-b833-5ef6b218e24a')).status, 200);

    const bad = await get('/thing/status');
    assert.equal(bad.status, 400, 'malformed uuid must be 400, not 500');
    assert.match(bad.body.error, /not a valid id/);
    assert.ok(!/uuid|syntax|postgres/i.test(bad.body.error),
      'error must not disclose the backing store or column type');
    assert.ok(!bad.body.error.includes('status'),
      'error must not reflect the caller-supplied value back');

    assert.equal((await get('/thing/123')).status, 400, 'integer id rejected');
    assert.equal((await get("/thing/'%20OR%201=1")).status, 400, 'injection-shaped id rejected');

    // the name-carrying param is untouched by the guard
    assert.equal((await get('/dept/Engineering')).status, 200);
    assert.equal((await get('/dept/R%26D')).status, 200);
  } finally {
    server.close();
    await new Promise((r) => server.once('close', r));
  }
});

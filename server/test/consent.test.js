// node --test — employee consent capture (core/consent.js).
//
// hasConsent()/requireConsent() are DB-backed by design (consent is
// standing state, not a pure computation), so this file needs a real
// Postgres to mean anything — unlike the rest of the suite, which is
// deliberately DB-free. It SKIPS (not fails) when DATABASE_URL is unset,
// so `npm test` still needs zero setup for everyone; run with a Postgres
// attached (see deploy/docker-compose.yml) to exercise it for real.
const { test, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
if (HAS_DB) after(async () => { await require('../core/db').pool.end(); });

test('consent: grant → hasConsent true; revoke → hasConsent false; requireConsent throws 403 when absent', { skip: !HAS_DB && 'DATABASE_URL not set — see file header' }, async () => {
  const db = require('../core/db');
  const { hasConsent, requireConsent, DEFAULT_TYPE } = require('../core/consent');

  // Isolated tenant + employee so this test can run repeatedly without clashing.
  const tenant = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('consent-test','consent-test-' || gen_random_uuid()) RETURNING id`)).rows[0];
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Consent Test','consent-test@x.com','active') RETURNING id`,
    [tenant.id])).rows[0];

  assert.equal(await hasConsent(tenant.id, emp.id), false, 'no row yet → false, not an error');
  await assert.rejects(() => requireConsent(tenant.id, emp.id), (e) => e.status === 403 && /has not given consent/.test(e.message));

  await db.query(
    `INSERT INTO core.employee_consents (tenant_id, employee_id, consent_type, granted, granted_at, updated_by)
     VALUES ($1,$2,$3,true,now(),'consent-test@x.com')`, [tenant.id, emp.id, DEFAULT_TYPE]);
  assert.equal(await hasConsent(tenant.id, emp.id), true);
  await assert.doesNotReject(() => requireConsent(tenant.id, emp.id));

  await db.query(
    `UPDATE core.employee_consents SET granted=false, revoked_at=now() WHERE tenant_id=$1 AND employee_id=$2 AND consent_type=$3`,
    [tenant.id, emp.id, DEFAULT_TYPE]);
  assert.equal(await hasConsent(tenant.id, emp.id), false, 'revoked → false again');
  await assert.rejects(() => requireConsent(tenant.id, emp.id));

  // Cleanup.
  await db.query(`DELETE FROM core.employee_consents WHERE tenant_id=$1`, [tenant.id]);
  await db.query(`DELETE FROM core.employees WHERE tenant_id=$1`, [tenant.id]);
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenant.id]);
});

test('consent: hasConsent for a different consent_type than the one granted is unaffected (per-type isolation)', { skip: !HAS_DB && 'DATABASE_URL not set — see file header' }, async () => {
  const db = require('../core/db');
  const { hasConsent } = require('../core/consent');
  const tenant = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('consent-test2','consent-test2-' || gen_random_uuid()) RETURNING id`)).rows[0];
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Consent Test 2','consent-test2@x.com','active') RETURNING id`,
    [tenant.id])).rows[0];
  await db.query(
    `INSERT INTO core.employee_consents (tenant_id, employee_id, consent_type, granted, granted_at, updated_by)
     VALUES ($1,$2,'meeting_ai_insights',true,now(),'consent-test2@x.com')`, [tenant.id, emp.id]);

  assert.equal(await hasConsent(tenant.id, emp.id, 'meeting_ai_insights'), true);
  assert.equal(await hasConsent(tenant.id, emp.id, 'some_future_type'), false);

  await db.query(`DELETE FROM core.employee_consents WHERE tenant_id=$1`, [tenant.id]);
  await db.query(`DELETE FROM core.employees WHERE tenant_id=$1`, [tenant.id]);
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenant.id]);
});

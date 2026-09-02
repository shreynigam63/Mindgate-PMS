// Agentic PMS — server entrypoint.
// Boot order: env check → migrations (FAIL boot on error — a schema the code
// expects but doesn't have is a broken deploy, not a degraded state) →
// tenant resolution → routes.

const express = require('express');
const cors = require('cors');
const db = require('./core/db');
const logger = require('./core/logger');
const { runMigrations } = require('./core/migrate');
const { authenticate, devLogin } = require('./core/auth');
const employees = require('./core/employees');

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'TENANT_SLUG'];

async function main() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) { logger.error('Missing required env', { missing }); process.exit(1); }

  await db.waitForDatabase(); // tolerates the DB still provisioning on a fresh Blueprint sync — see core/db.js
  await runMigrations(); // throws → process exits nonzero → deploy fails loudly

  // Single-tenant instance: resolve (or create) the tenant for this deployment.
  const slug = process.env.TENANT_SLUG;
  let t = (await db.query(`SELECT id FROM core.tenants WHERE slug=$1`, [slug])).rows[0];
  if (!t) {
    t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [slug])).rows[0];
    logger.info('tenant created', { slug });
  }
  const TENANT_ID = t.id;
  // New tenants created after migration 002 ran (i.e. every normal boot of a
  // fresh deploy, since the tenant row above is created AFTER migrations)
  // otherwise get zero role_permissions rows and every route 403s — this
  // was found by actually running the app against a real Postgres for the
  // first time. Idempotent (ON CONFLICT DO NOTHING), safe on every boot.
  await require('./migrations/002-default-permission-bundles').ensureTenantSeeds(db, TENANT_ID);
  await require('./migrations/008-review-parameters').ensureDefaultParameters(db, TENANT_ID);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.tenantId = TENANT_ID; next(); });

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'agentic-pms' }));
  app.post('/api/v1/auth/dev-login', devLogin);
  app.get('/api/v1/me', authenticate, (req, res) => res.json({ user: req.user }));

  app.use('/api/v1/employees', employees.router);
  app.use('/api/v1/setup', require('./core/setup').router);
  app.use('/api/v1/consent', require('./core/consent').router);
  app.use('/api/v1/gdpr', require('./core/gdpr').router);
  app.use('/api/v1/notifications', require('./core/notifications').router);
  app.use('/api/v1/pms', require('./modules/performance').router);
  app.use('/api/v1/engagement', require('./modules/engagement').router);
  app.use('/api/v1/people', require('./modules/people').router);
  app.use('/api/v1/agentic', require('./modules/agentic').router);

  const port = process.env.PORT || 8080;
  app.listen(port, () => logger.info('agentic-pms up', { port, tenant: slug }));

  // BR-4.4: Quarterly Connect reminders. No separate worker/cron service
  // in this deploy (render.yaml defines only api + frontend), so
  // this runs in-process. Checked once at boot (catches anything overdue
  // since the last restart) and then daily. checkAndSendConnectReminders
  // itself is idempotent per employee (cooldown-gated via
  // pms.connect_reminders_log), so overlapping/frequent calls are safe —
  // this interval is deliberately conservative rather than clever.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const { checkAndSendConnectReminders } = require('./modules/performance');
  const runReminderCheck = () => checkAndSendConnectReminders(TENANT_ID)
    .then((n) => n && logger.info('connect reminders sent', { count: n }))
    .catch((e) => logger.warn('connect reminder check failed', { error: e.message }));
  runReminderCheck();
  setInterval(runReminderCheck, ONE_DAY_MS);
}

main().catch(e => { logger.error('boot failed', { error: e.message }); process.exit(1); });

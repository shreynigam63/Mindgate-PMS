// One-time admin bootstrap — core/setup.js
//
// Problem this solves: a fresh deployment has an empty tenant (zero
// employees) and, right now, no real SSO/OIDC integration (core/auth.js's
// only login route, dev-login, is gated behind AUTH_DEV=true — real
// production auth was never actually built). Without this, there is
// LITERALLY no way to create the first account: nobody can log in to
// create a user, and nobody should be handed a password chosen (and
// therefore known) by anyone other than themselves.
//
// SAFETY MODEL: this route requires no authentication (nobody can be
// authenticated yet on a fresh tenant), so its safety comes entirely from
// one guard — it only works when this tenant currently has ZERO
// employees. The moment one exists (including the admin this route just
// created), the route permanently locks itself out for that tenant. This
// is the same "first user becomes admin" pattern used by many self-hosted
// apps (e.g. GitLab's first-login sets the root password); it is not a
// standing admin-creation backdoor.
//
// The caller chooses their own password — this server only ever sees it
// long enough to bcrypt-hash it before responding; it is never logged,
// stored in plaintext, or returned in any response.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const logger = require('./logger');

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [req.tenantId]);
    res.json({ bootstrap_available: r.rows[0].n === 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bootstrap-admin', async (req, res) => {
  const client = await db.getClient();
  try {
    const { name, email, password } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'a valid email is required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    await client.query('BEGIN');
    // Row-level lock for the duration of this transaction — makes the
    // zero-employees check safe even against two bootstrap calls arriving
    // at the same instant, not just against calls arriving after an admin
    // already exists.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bootstrap:${req.tenantId}`]);
    const existing = await client.query(`SELECT COUNT(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [req.tenantId]);
    if (existing.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This tenant already has employees — bootstrap is only available on a completely fresh deployment. Ask an existing admin for access instead.' });
    }

    const emp = (await client.query(
      `INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,$2,$3,'active') RETURNING id`,
      [req.tenantId, name.trim(), email.toLowerCase()])).rows[0];
    await client.query(
      `INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,'admin')`, [req.tenantId, email.toLowerCase()]);
    const hash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`,
      [req.tenantId, email.toLowerCase(), hash]);
    await client.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'ADMIN_BOOTSTRAPPED','employees',$3,$4)`,
      [req.tenantId, email.toLowerCase(), emp.id, JSON.stringify({ name: name.trim() })]);
    await client.query('COMMIT');

    logger.info('admin bootstrapped', { tenantId: req.tenantId, email: email.toLowerCase() });
    res.json({ ok: true, message: 'Admin account created. Log in with POST /api/v1/auth/dev-login using the email and password you just chose (requires AUTH_DEV=true on this deployment).' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('bootstrap-admin failed', { error: e.message });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = { router };

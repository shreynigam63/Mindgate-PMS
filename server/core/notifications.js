// In-app notifications: create (used by modules), list, mark read.
const express = require('express');
const db = require('./db');
const { authenticate } = require('./auth');
const { guardUuidParams } = require('./http');

async function notify(tenantId, employeeId, kind, title, body, link) {
  await db.query(`INSERT INTO core.notifications (tenant_id, employee_id, kind, title, body, link)
                  VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, employeeId, kind, title, body || null, link || null]);
}

const router = express.Router();
router.use(authenticate);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);
router.get('/', async (req, res) => {
  const r = await db.query(
    `SELECT id, kind, title, body, link, read_at, created_at FROM core.notifications
      WHERE tenant_id=$1 AND employee_id=$2 ORDER BY created_at DESC LIMIT 50`,
    [req.user.tenant_id, req.user.id]);
  res.json({ notifications: r.rows });
});
router.post('/:id/read', async (req, res) => {
  await db.query(`UPDATE core.notifications SET read_at=now() WHERE id=$1 AND tenant_id=$2 AND employee_id=$3`,
    [req.params.id, req.user.tenant_id, req.user.id]);
  res.json({ ok: true });
});

module.exports = { notify, router };

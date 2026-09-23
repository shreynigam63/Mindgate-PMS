// In-app notifications: create (used by modules), list, mark read.
const express = require('express');
const db = require('./db');
const logger = require('./logger');
const { sendMail } = require('./mail');
const { authenticate } = require('./auth');
const { guardUuidParams } = require('./http');

// Asked for on 23 Sep: "every KRA submission, my growth submission or any
// submission to Manager and above role should initiate auto mails so they
// are aware of requests initiated."
//
// OPT-IN, not automatic for every notification. The in-app bell carries
// plenty that nobody needs an email about ("you have been recognised as a
// top performer"); mailing all of it would train people to filter the
// address, and then the submissions would be missed too. The submission
// events pass { email: true }.
//
// A MAIL FAILURE NEVER FAILS THE SUBMISSION. The employee's KRA sheet is
// already saved and the in-app notification already written by the time
// this runs; throwing here would roll back an action the user completed
// and show them an error for something that did work. It is logged, and
// core.notif_log carries the per-send outcome either way.
const APP_URL = () => (process.env.APP_URL || '').replace(/\/$/, '');

async function emailNotification(tenantId, employeeId, kind, title, body, link) {
  const to = (await db.query(
    `SELECT email, name FROM core.employees WHERE id=$1 AND tenant_id=$2 AND status='active'`,
    [employeeId, tenantId])).rows[0];
  if (!to || !to.email) return;
  // The employee master carries generated placeholder addresses for people
  // with no real email (see core/employees.js). Mailing those bounces on
  // every send and tells nobody anything.
  if (/@no-email\./i.test(to.email) || /^noemail/i.test(to.email)) return;
  const url = APP_URL() && link ? `${APP_URL()}${link}` : null;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101f3d">
    <p style="font-size:16px;font-weight:bold;margin:0 0 8px">${esc(title)}</p>
    ${body ? `<p style="margin:0 0 12px;color:#2c4b7c">${esc(body)}</p>` : ''}
    ${url ? `<p style="margin:0 0 12px"><a href="${esc(url)}" style="color:#1b3b6f;font-weight:bold">Open it in the Performance Management System</a></p>` : ''}
    <p style="margin:16px 0 0;font-size:12px;color:#7d95bb">Sent by the Performance Management System. You are receiving this because it is waiting on you.</p>
  </div>`;
  await sendMail(tenantId, { to: to.email, subject: title, html, kind });
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function notify(tenantId, employeeId, kind, title, body, link, opts = {}) {
  await db.query(`INSERT INTO core.notifications (tenant_id, employee_id, kind, title, body, link)
                  VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, employeeId, kind, title, body || null, link || null]);
  if (opts.email) {
    try {
      await emailNotification(tenantId, employeeId, kind, title, body, link);
    } catch (e) {
      logger.warn('notification email failed', { kind, employeeId, error: e.message });
    }
  }
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

module.exports = { notify, emailNotification, router };

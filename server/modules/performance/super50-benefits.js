// Super 50 benefits (15 Oct, from the client's policy sheet).
//
// super50.js decides who is Super 50 in a year. This is what it brings:
//
// TIERS, BY CONSECUTIVE YEARS. Super 50 for the policy's appraisal year
// alone is "Super 50"; that year and the one before is "Super 50 Twice";
// three or more in a row is "Super 50 Elite". A year counts when the
// Super 50 rule held for it, judged on the ratings up to that year —
// published cycles and the imported pre-PMS years alike (super50History).
// A gap ends the run: Super 50 this year and two years ago, but not last
// year, is a run of one.
//
// THE HIGHER TIER REPLACES THE LOWER ONE. A person holds exactly one tier
// per policy year, so an Elite does not also collect the Super 50 amount.
//
// ONE BUDGET. The certification amount and the hub reimbursements are the
// same money: INR 30,000 for Super 50 and Twice, 50,000 for Elite, claimed
// against bills under the Knowledge, Health, Personal and Tech hubs. HR
// alone approves a claim. Whatever is not claimed by the policy's end
// (30 Jun 2027 for the FY25-26 appraisal) lapses; a reminder goes out
// before it does.
//
// The tiers, amounts, benefits, hubs and dates are the policy row's DATA,
// seeded from the sheet (DEFAULT_POLICY) and edited by HR on the Super 50
// Benefits page. Nothing about the policy is in a handler.
const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { guardUuidParams } = require('../../core/http');
const { hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { super50Check } = require('./rating-rules');
const { super50Rule, super50Scale, super50History } = require('./super50');

const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const LINK = '/my/super50';
const HR_LINK = '/admin/super50-benefits';
const TIER_KEYS = ['super50', 'twice', 'elite'];
const BILL_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BILL_MAX = 5 * 1024 * 1024;

// ------------------------------------------------------------ the sheet

// The client's policy sheet, as data. HR edits a policy's copy of this.
const ALL_TIERS = [
  'Grand celebration with the Senior Management Team',
  'Felicitation',
  'Fast-track promotion',
];
const DEFAULT_POLICY = {
  name: 'Super 50 benefits 2026-27',
  basis_fiscal_year: 'FY25-26',
  starts_on: '2026-07-01',
  ends_on: '2027-06-30',
  lapse_reminder_days: 30,
  tiers: [
    { key: 'super50', label: 'Super 50', min_streak: 1, amount: 30000,
      benefits: [...ALL_TIERS],
      entitlements: { single_punch: false, mandatory_el_days: 0, variable_pct: null, fast_track: true, programme: null } },
    { key: 'twice', label: 'Super 50 Twice', min_streak: 2, amount: 30000,
      benefits: [...ALL_TIERS, 'Single-punch full attendance', '10 days EL mandatory', 'An IIT/IIM programme from the curated catalogue'],
      entitlements: { single_punch: true, mandatory_el_days: 10, variable_pct: null, fast_track: true, programme: 'course' } },
    { key: 'elite', label: 'Super 50 Elite', min_streak: 3, amount: 50000,
      benefits: [...ALL_TIERS, 'Single-punch full attendance', '10 days EL mandatory', 'IIT/IIM 2-day refresher', "125% of last year's variable component"],
      entitlements: { single_punch: true, mandatory_el_days: 10, variable_pct: 125, fast_track: true, programme: 'refresher' } },
  ],
  hubs: [
    { key: 'knowledge', label: 'Knowledge Hub', items: ['Books', 'Library membership'] },
    { key: 'health', label: 'Health Hub', items: ['Gym membership', 'Sports club membership'] },
    { key: 'personal', label: 'Personal Hub', items: ['Hobby membership'] },
    { key: 'tech', label: 'Tech Hub', items: ['Claude certification', 'Mobile', 'Laptop'] },
  ],
};

// ------------------------------------------------------------ pure rules

// "FY25-26" → 2025, "2025-26" → 2025: the first run of digits, read the
// way super50History reads a cycle's fiscal year, so a policy and the
// cycle it is based on agree on which year that is.
function basisYearOf(label) {
  const m = String(label || '').match(/\d+/);
  if (!m) return null;
  if (m[0].length >= 4) return Number(m[0].slice(0, 4));
  if (m[0].length === 2) return 2000 + Number(m[0]);
  return null;
}

// How many years in a row, ending at the basis year, the person was
// Super 50. Each year is judged on the ratings up to and including it,
// so last year's verdict is the one the rule gave last year.
function streakAt(listDesc, scale, rule, basisYear) {
  const list = Array.isArray(listDesc) ? listDesc : [];
  let n = 0;
  for (let y = basisYear; n < 50; y--) {
    const i = list.findIndex((x) => Number(x.sort_year) === y);
    if (i < 0) break;
    if (!super50Check(list.slice(i).map((x) => x.rating), scale, rule).eligible) break;
    n++;
  }
  return n;
}

// The highest tier the run reaches. One tier only: it replaces the lower.
function tierFor(tiers, streak) {
  let best = null;
  for (const t of tiers || []) {
    if (streak >= Number(t.min_streak) && (!best || Number(t.min_streak) > Number(best.min_streak))) best = t;
  }
  return best;
}

const money = (v) => Math.round(Number(v) * 100) / 100;
const inr = (v) => `INR ${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const cleanText = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

// A policy as HR sent it, checked whole. Returns { policy } or { error }.
function validatePolicy(body, base) {
  const p = { ...(base || {}), ...(body || {}) };
  const out = {};
  out.name = cleanText(p.name, 120);
  if (!out.name) return { error: 'Give the policy a name.' };
  out.basis_fiscal_year = cleanText(p.basis_fiscal_year, 20);
  out.basis_year = basisYearOf(out.basis_fiscal_year);
  if (!out.basis_year) return { error: 'The appraisal year must name a year, like FY25-26.' };
  if (!isDate(p.starts_on) || !isDate(p.ends_on)) return { error: 'Give the start and end dates as YYYY-MM-DD.' };
  out.starts_on = String(p.starts_on); out.ends_on = String(p.ends_on);
  if (out.ends_on < out.starts_on) return { error: 'The policy ends before it starts.' };
  const days = Number(p.lapse_reminder_days == null ? 30 : p.lapse_reminder_days);
  if (!Number.isInteger(days) || days < 0 || days > 180) return { error: 'The lapse reminder is a whole number of days, 0 to 180.' };
  out.lapse_reminder_days = days;
  if (p.status != null) {
    if (!['active', 'closed'].includes(p.status)) return { error: 'Status is active or closed.' };
    out.status = p.status;
  }

  if (!Array.isArray(p.tiers) || p.tiers.length !== TIER_KEYS.length) return { error: 'The policy has the three tiers: Super 50, Twice and Elite.' };
  const tiers = [];
  for (const key of TIER_KEYS) {
    const t = p.tiers.find((x) => x && x.key === key);
    if (!t) return { error: `The ${key} tier is missing.` };
    const label = cleanText(t.label, 60);
    const min = Number(t.min_streak);
    const amount = Number(t.amount);
    if (!label) return { error: 'Every tier needs a name.' };
    if (!Number.isInteger(min) || min < 1 || min > 20) return { error: `${label}: consecutive years is a whole number from 1.` };
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) return { error: `${label}: the amount is not a valid number.` };
    const benefits = (Array.isArray(t.benefits) ? t.benefits : []).map((b) => cleanText(b, 200)).filter(Boolean);
    const e = t.entitlements || {};
    const el = Number(e.mandatory_el_days || 0);
    const vp = e.variable_pct == null || e.variable_pct === '' ? null : Number(e.variable_pct);
    if (!Number.isInteger(el) || el < 0 || el > 60) return { error: `${label}: mandatory EL is a whole number of days.` };
    if (vp != null && (!Number.isFinite(vp) || vp < 0 || vp > 500)) return { error: `${label}: the variable percentage is not valid.` };
    if (e.programme != null && !['course', 'refresher'].includes(e.programme)) return { error: `${label}: the programme is a course or a refresher.` };
    tiers.push({ key, label, min_streak: min, amount: money(amount), benefits,
      entitlements: { single_punch: !!e.single_punch, mandatory_el_days: el, variable_pct: vp,
        fast_track: e.fast_track !== false, programme: e.programme || null } });
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].min_streak <= tiers[i - 1].min_streak) return { error: 'Each tier needs more consecutive years than the one before it.' };
  }
  out.tiers = tiers;

  if (!Array.isArray(p.hubs) || !p.hubs.length) return { error: 'Add at least one hub to claim under.' };
  const hubs = []; const seen = new Set();
  for (const h of p.hubs) {
    const label = cleanText(h && h.label, 60);
    const key = cleanText((h && h.key) || label, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!label || !key) return { error: 'Every hub needs a name.' };
    if (seen.has(key)) return { error: `Two hubs are called ${label}.` };
    seen.add(key);
    hubs.push({ key, label, items: (Array.isArray(h.items) ? h.items : []).map((x) => cleanText(x, 80)).filter(Boolean) });
  }
  out.hubs = hubs;
  return { policy: out };
}

// What a claim may be for, and how much. Pure, so the rules are tested
// without a database. `remaining` already takes off approved claims and
// those still waiting on HR, so two claims cannot spend the same rupee.
function claimProblem({ policy, award, today, hub, amount, remaining, bill }) {
  if (!award || award.status !== 'active') return 'You do not hold a Super 50 tier this year.';
  if (policy.status !== 'active') return 'This benefits year is closed.';
  if (today < policy.starts_on) return `Claims open on ${policy.starts_on}.`;
  if (today > policy.ends_on) return `Claims closed on ${policy.ends_on}. The unused balance has lapsed.`;
  if (!(policy.hubs || []).some((h) => h.key === hub)) return 'Pick the hub this claim is for.';
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return 'Enter the amount on the bill.';
  if (Math.abs(money(a) - a) > 1e-9) return 'Enter the amount in rupees and paise at most.';
  if (money(a) > money(remaining)) return `That is more than your remaining balance of ${inr(remaining)}.`;
  if (!bill) return 'Attach the bill or invoice.';
  if (!BILL_TYPES[bill.mimetype]) return 'The bill must be a PDF, JPG, PNG or WEBP file.';
  if (bill.size > BILL_MAX) return 'The bill must be 5 MB or smaller.';
  return null;
}

// ------------------------------------------------------------ data helpers

const T = (req) => req.user.tenant_id;
const todayIn = async () => (await db.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [APP_TZ])).rows[0].d;
const policyCols = (p = '') => `${p}id, ${p}tenant_id, ${p}name, ${p}basis_fiscal_year, ${p}basis_year,
  to_char(${p}starts_on,'YYYY-MM-DD') AS starts_on, to_char(${p}ends_on,'YYYY-MM-DD') AS ends_on, ${p}tiers, ${p}hubs, ${p}status,
  ${p}lapse_reminder_days, ${p}assigned_at, ${p}created_by, ${p}created_at, ${p}updated_at`;
const POLICY_COLS = policyCols();

async function policyById(tenantId, id) {
  return (await db.query(`SELECT ${POLICY_COLS} FROM pms.super50_policies WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0] || null;
}

const audit = (req, action, employeeId, details) => db.query(
  `INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details) VALUES ($1,$2,$3,NULL,$4,$5)`,
  [T(req), req.user.email, action, employeeId || null, details ? JSON.stringify(details) : null])
  .catch((e) => logger.warn('super50 audit failed', { error: e.message }));

// Awards with what has been used, what is waiting on HR and what is left.
async function awardsWithBalance(tenantId, where, params) {
  return (await db.query(
    `SELECT a.*, e.name, e.email, e.emp_code, e.department, e.designation,
            coalesce(sum(c.amount) FILTER (WHERE c.status='approved'), 0)::numeric AS used,
            coalesce(sum(c.amount) FILTER (WHERE c.status='submitted'), 0)::numeric AS pending,
            count(c.id) FILTER (WHERE c.status='submitted')::int AS claims_waiting,
            pr.name AS programme_name, pr.provider AS programme_provider
       FROM pms.super50_awards a
       JOIN core.employees e ON e.id = a.employee_id
       LEFT JOIN pms.super50_claims c ON c.award_id = a.id
       LEFT JOIN pms.super50_programmes pr ON pr.id = a.programme_id
      WHERE a.tenant_id=$1 AND ${where}
      GROUP BY a.id, e.id, pr.id
      ORDER BY CASE a.tier WHEN 'elite' THEN 0 WHEN 'twice' THEN 1 ELSE 2 END, e.name`,
    [tenantId, ...params])).rows.map(balanceOut);
}
function balanceOut(a) {
  const amount = Number(a.amount); const used = Number(a.used || 0); const pending = Number(a.pending || 0);
  return { ...a, amount, used, pending, remaining: money(Math.max(0, amount - used - pending)) };
}
const tierOf = (policy, key) => (policy.tiers || []).find((t) => t.key === key) || null;

// ------------------------------------------------------------ assigning tiers

// Works out every active employee's tier for one policy and writes it.
// A new or higher tier is told to the person, in the app and by email.
// Someone who no longer qualifies (a corrected rating) loses the tier
// unless HR has already paid them against it; those are reported, not
// changed, so a reversal is HR's decision.
async function assignTiers(tenantId, policyId, by) {
  const policy = await policyById(tenantId, policyId);
  if (!policy) throw Object.assign(new Error('No such policy.'), { status: 404 });
  if (policy.status !== 'active') throw Object.assign(new Error('This benefits year is closed.'), { status: 409 });
  const [rule, scale] = await Promise.all([super50Rule(tenantId), super50Scale(tenantId)]);
  const people = (await db.query(
    `SELECT id FROM core.employees WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL`, [tenantId])).rows;
  const hist = await super50History(tenantId, people.map((p) => p.id));
  const existing = new Map((await db.query(
    `SELECT a.id, a.employee_id, a.tier, a.status, a.amount, a.streak,
            count(c.id) FILTER (WHERE c.status='approved')::int AS approved
       FROM pms.super50_awards a LEFT JOIN pms.super50_claims c ON c.award_id=a.id
      WHERE a.tenant_id=$1 AND a.policy_id=$2 GROUP BY a.id`, [tenantId, policyId])).rows.map((r) => [r.employee_id, r]));
  const rank = (k) => TIER_KEYS.indexOf(k);
  const out = { awarded: 0, upgraded: 0, changed: 0, withdrawn: 0, kept_with_claims: 0, unchanged: 0, notified: 0,
    by_tier: Object.fromEntries(TIER_KEYS.map((k) => [k, 0])), rated_for_year: 0, problem: null };
  // Why a run can award nobody, said rather than left as a row of zeros:
  // the rule's grades are not on the annual scale, or nobody has a
  // rating for the appraisal year yet.
  const probe = super50Check([], scale, rule);
  if (probe.reason === 'scale_mismatch') out.problem = `${probe.detail} Change the Super 50 grades in Settings.`;
  const tell = [];
  for (const p of people) {
    const list = (hist.get(p.id) || { list: [] }).list;
    if (list.some((x) => Number(x.sort_year) === policy.basis_year)) out.rated_for_year++;
    const streak = streakAt(list, scale, rule, policy.basis_year);
    const tier = tierFor(policy.tiers, streak);
    const had = existing.get(p.id);
    if (tier) {
      out.by_tier[tier.key] += 1;
      if (!had) {
        const r = await db.query(
          `INSERT INTO pms.super50_awards (tenant_id, policy_id, employee_id, tier, streak, amount, assigned_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [tenantId, policyId, p.id, tier.key, streak, tier.amount, by]);
        out.awarded++; tell.push({ id: r.rows[0].id, employee_id: p.id, tier, kind: 'new' });
      } else if (had.status !== 'active' || had.tier !== tier.key || Number(had.amount) !== Number(tier.amount) || had.streak !== streak) {
        await db.query(
          `UPDATE pms.super50_awards SET tier=$2, streak=$3, amount=$4, status='active', assigned_at=now(), assigned_by=$5 WHERE id=$1`,
          [had.id, tier.key, streak, tier.amount, by]);
        if (had.status !== 'active') { out.awarded++; tell.push({ id: had.id, employee_id: p.id, tier, kind: 'new' }); }
        else if (rank(tier.key) > rank(had.tier)) { out.upgraded++; tell.push({ id: had.id, employee_id: p.id, tier, kind: 'up' }); }
        else if (had.tier !== tier.key || Number(had.amount) !== Number(tier.amount)) { out.changed++; tell.push({ id: had.id, employee_id: p.id, tier, kind: 'changed' }); }
        else out.unchanged++;
      } else out.unchanged++;
    } else if (had && had.status === 'active') {
      if (had.approved > 0) { out.kept_with_claims++; continue; }
      await db.query(`UPDATE pms.super50_awards SET status='withdrawn', assigned_at=now(), assigned_by=$2 WHERE id=$1`, [had.id, by]);
      out.withdrawn++;
    }
  }
  if (!out.problem && !out.rated_for_year) {
    out.problem = `Nobody has an annual rating for ${policy.basis_fiscal_year} yet. Publish that annual cycle, or import the year on Super 50.`;
  }
  await db.query(`UPDATE pms.super50_policies SET assigned_at=now(), updated_at=now() WHERE id=$1`, [policyId]);
  for (const t of tell) {
    const title = t.kind === 'up' ? `You are now ${t.tier.label}` : t.kind === 'changed' ? `Your Super 50 benefits are updated: ${t.tier.label}`
      : `You are ${t.tier.label} for ${policy.name}`;
    const body = `You can claim up to ${inr(t.tier.amount)} against bills by ${policy.ends_on}. Open My Super 50 to see your benefits.`;
    try {
      await notify(tenantId, t.employee_id, 'super50_tier', title, body, LINK, { email: true });
      await db.query(`UPDATE pms.super50_awards SET notified_at=now() WHERE id=$1`, [t.id]);
      out.notified++;
    } catch (e) { logger.warn('super50 tier notice failed', { employee_id: t.employee_id, error: e.message }); }
  }
  return out;
}

// Publishing an annual cycle sets the tiers of the policy based on it. A
// policy is based on a cycle when their fiscal years are the same year.
async function afterAnnualPublish(req, cycle) {
  const year = basisYearOf(cycle && cycle.fiscal_year);
  if (!year) return null;
  const policies = (await db.query(
    `SELECT id, name FROM pms.super50_policies WHERE tenant_id=$1 AND status='active' AND basis_year=$2`, [T(req), year])).rows;
  const done = [];
  for (const p of policies) {
    const r = await assignTiers(T(req), p.id, req.user.email);
    await audit(req, 'SUPER50_TIERS_ASSIGNED', null, { policy_id: p.id, via: 'publish', cycle_id: cycle.id, ...r });
    done.push({ policy_id: p.id, name: p.name, ...r });
  }
  return done;
}

// ------------------------------------------------------------ the daily sweep

// Closes a policy whose year is over, and reminds everyone with money
// left, once, the policy's lapse_reminder_days before it lapses.
async function tick(tenantId) {
  const today = await todayIn();
  const closed = (await db.query(
    `UPDATE pms.super50_policies SET status='closed', updated_at=now()
      WHERE tenant_id=$1 AND status='active' AND ends_on < $2::date RETURNING id`, [tenantId, today])).rowCount;
  const due = (await db.query(
    `SELECT ${POLICY_COLS} FROM pms.super50_policies
      WHERE tenant_id=$1 AND status='active' AND $2::date BETWEEN ends_on - lapse_reminder_days AND ends_on`, [tenantId, today])).rows;
  let reminded = 0;
  for (const policy of due) {
    const awards = await awardsWithBalance(tenantId, `a.policy_id=$2 AND a.status='active' AND a.lapse_reminded_at IS NULL`, [policy.id]);
    for (const a of awards) {
      if (a.remaining <= 0) continue;
      try {
        await notify(tenantId, a.employee_id, 'super50_lapse', `${inr(a.remaining)} of your Super 50 balance lapses on ${policy.ends_on}`,
          'Claim it against a bill under the Knowledge, Health, Personal or Tech hub before then. What is not claimed by that date lapses.', LINK, { email: true });
        await db.query(`UPDATE pms.super50_awards SET lapse_reminded_at=now() WHERE id=$1`, [a.id]);
        reminded++;
      } catch (e) { logger.warn('super50 lapse reminder failed', { award: a.id, error: e.message }); }
    }
  }
  return { closed, reminded };
}

function startScheduler(tenantId) {
  const run = () => tick(tenantId).then((r) => { if (r.closed || r.reminded) logger.info('super50 benefits sweep', r); })
    .catch((e) => logger.warn('super50 benefits sweep failed', { error: e.message }));
  run();
  const h = setInterval(run, 6 * 60 * 60 * 1000);
  if (h.unref) h.unref();
  return h;
}

// ------------------------------------------------------------ the certificate

async function certificate(tenantId, awardId) {
  const a = (await db.query(
    `SELECT a.tier, a.streak, a.status, e.name, e.designation, p.name AS policy_name, p.basis_fiscal_year, p.tiers, t.name AS company
       FROM pms.super50_awards a JOIN core.employees e ON e.id=a.employee_id
       JOIN pms.super50_policies p ON p.id=a.policy_id JOIN core.tenants t ON t.id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.id=$2`, [tenantId, awardId])).rows[0];
  if (!a || a.status !== 'active') return null;
  const tier = (a.tiers || []).find((t) => t.key === a.tier) || { label: 'Super 50' };
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((ok) => doc.on('end', ok));
  const W = doc.page.width; const H = doc.page.height;
  doc.lineWidth(3).strokeColor('#1b3b6f').rect(25, 25, W - 50, H - 50).stroke();
  doc.lineWidth(1).strokeColor('#c9a227').rect(35, 35, W - 70, H - 70).stroke();
  doc.moveDown(2).fillColor('#1b3b6f').font('Helvetica-Bold').fontSize(16).text(a.company, { align: 'center' });
  doc.moveDown(1.2).fontSize(34).text('Certificate of Recognition', { align: 'center' });
  doc.moveDown(0.8).font('Helvetica').fontSize(14).fillColor('#2c4b7c').text('This is presented to', { align: 'center' });
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(28).fillColor('#101f3d').text(a.name, { align: 'center' });
  if (a.designation) doc.font('Helvetica').fontSize(13).fillColor('#2c4b7c').text(a.designation, { align: 'center' });
  doc.moveDown(0.8).font('Helvetica').fontSize(14).fillColor('#101f3d')
    .text(`in recognition of being ${tier.label}`, { align: 'center' });
  doc.moveDown(0.3).fontSize(12).fillColor('#2c4b7c')
    .text(`${a.streak} consecutive year${a.streak === 1 ? '' : 's'} among the company's top performers, up to the ${a.basis_fiscal_year} annual appraisal`, { align: 'center' });
  doc.moveDown(0.3).text(a.policy_name, { align: 'center' });
  const issued = new Date().toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: APP_TZ });
  doc.font('Helvetica').fontSize(11).fillColor('#101f3d');
  doc.text(`Issued ${issued}`, 80, H - 110, { width: 250 });
  doc.text('Senior Management Team', W - 330, H - 110, { width: 250, align: 'right' });
  doc.end();
  await done;
  return { pdf: Buffer.concat(chunks), name: a.name };
}

function sendPdf(res, out) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="super50-certificate-${out.name.replace(/[^A-Za-z0-9]+/g, '-')}.pdf"`);
  res.send(out.pdf);
}

// ------------------------------------------------------------ routes

const router = express.Router();
guardUuidParams(router);
const billUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: BILL_MAX } });
const withBill = (req, res, next) => billUpload.single('bill')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The bill must be 5 MB or smaller.' : err.message });
  next();
});
const fail = (res, e, what) => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  logger.error(`super50 benefits: ${what}`, { error: e.message });
  res.status(500).json({ error: `Could not ${what}. Try again in a minute.` });
};
const hrOnly = async (req, res) => {
  if (await hasPermission(req.user, 'pms_admin')) return true;
  res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
  return false;
};
const CLAIM_COLS = `c.id, c.award_id, c.employee_id, c.hub, c.item, c.description, c.amount::float AS amount, c.bill_name, c.bill_mime, c.bill_size,
  c.status, c.decided_by, c.decided_at, c.decision_note, c.created_at`;

// The person's own award in the current benefits year: the latest one
// that has not ended, else the latest one.
async function myAward(tenantId, employeeId) {
  const rows = await awardsWithBalance(tenantId,
    `a.employee_id=$2 AND a.status='active' AND a.policy_id IN (SELECT id FROM pms.super50_policies WHERE tenant_id=$1)`, [employeeId]);
  if (!rows.length) return null;
  const policies = new Map((await db.query(`SELECT ${POLICY_COLS} FROM pms.super50_policies WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
    [tenantId, rows.map((r) => r.policy_id)])).rows.map((p) => [p.id, p]));
  const today = await todayIn();
  const sorted = rows.map((a) => ({ a, p: policies.get(a.policy_id) }))
    .sort((x, y) => ((y.p.ends_on >= today) - (x.p.ends_on >= today)) || y.p.starts_on.localeCompare(x.p.starts_on));
  return { ...sorted[0], today };
}

router.get('/me', async (req, res) => {
  try {
    const mine = await myAward(T(req), req.user.id);
    if (!mine) return res.json({ award: null });
    const { a, p, today } = mine;
    const tier = tierOf(p, a.tier) || {};
    const claims = (await db.query(`SELECT ${CLAIM_COLS} FROM pms.super50_claims c WHERE c.tenant_id=$1 AND c.award_id=$2 ORDER BY c.created_at DESC`,
      [T(req), a.id])).rows;
    const programmes = tier.entitlements && tier.entitlements.programme
      ? (await db.query(`SELECT id, name, provider, kind FROM pms.super50_programmes WHERE tenant_id=$1 AND policy_id=$2 AND kind=$3 AND active ORDER BY name`,
        [T(req), p.id, tier.entitlements.programme])).rows : [];
    const period = p.status !== 'active' ? 'This benefits year is closed.'
      : today < p.starts_on ? `Claims open on ${p.starts_on}.`
        : today > p.ends_on ? `Claims closed on ${p.ends_on}. The unused balance has lapsed.` : null;
    res.json({
      policy: { id: p.id, name: p.name, basis_fiscal_year: p.basis_fiscal_year, starts_on: p.starts_on, ends_on: p.ends_on, hubs: p.hubs, status: p.status },
      award: { id: a.id, tier: a.tier, label: tier.label, streak: a.streak, amount: a.amount, used: a.used, pending: a.pending, remaining: a.remaining,
        benefits: tier.benefits || [], programme: tier.entitlements ? tier.entitlements.programme : null,
        programme_id: a.programme_id, programme_name: a.programme_name, programme_provider: a.programme_provider, programme_status: a.programme_status },
      claims, programmes, today,
      claims_open: !period && a.remaining > 0,
      claims_note: period || (a.remaining <= 0 ? 'Your whole amount is approved or waiting on HR.' : null),
    });
  } catch (e) { fail(res, e, 'load your Super 50 benefits'); }
});

router.post('/me/claims', withBill, async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const mine = await myAward(T(req), req.user.id);
    if (!mine) throw Object.assign(new Error('You do not hold a Super 50 tier this year.'), { status: 403 });
    const { a, p, today } = mine;
    // Locked, so two claims sent together are counted one after the other.
    await client.query(`SELECT id FROM pms.super50_awards WHERE id=$1 FOR UPDATE`, [a.id]);
    const bal = (await client.query(
      `SELECT coalesce(sum(amount) FILTER (WHERE status IN ('approved','submitted')),0)::float AS spent FROM pms.super50_claims WHERE award_id=$1`, [a.id])).rows[0];
    const remaining = money(Math.max(0, a.amount - bal.spent));
    const b = req.body || {};
    const problem = claimProblem({ policy: p, award: a, today, hub: b.hub, amount: Number(b.amount), remaining, bill: req.file });
    if (problem) throw Object.assign(new Error(problem), { status: 422 });
    const r = (await client.query(
      `INSERT INTO pms.super50_claims (tenant_id, award_id, employee_id, hub, item, description, amount, bill_name, bill_mime, bill_size, bill_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [T(req), a.id, req.user.id, b.hub, cleanText(b.item, 80) || null, cleanText(b.description, 500) || null, money(Number(b.amount)),
        cleanText(req.file.originalname, 200) || `bill.${BILL_TYPES[req.file.mimetype]}`, req.file.mimetype, req.file.size, req.file.buffer])).rows[0];
    await client.query('COMMIT');
    await audit(req, 'SUPER50_CLAIM_SUBMITTED', req.user.id, { claim_id: r.id, hub: b.hub, amount: money(Number(b.amount)) });
    res.json({ ok: true, id: r.id, message: 'Claim sent to HR. Your balance holds this amount until HR decides.' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e, 'send the claim');
  } finally { client.release(); }
});

router.post('/me/claims/:id/withdraw', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE pms.super50_claims SET status='withdrawn' WHERE tenant_id=$1 AND id=$2 AND employee_id=$3 AND status='submitted' RETURNING id`,
      [T(req), req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'Only a claim still waiting on HR can be withdrawn.' });
    await audit(req, 'SUPER50_CLAIM_WITHDRAWN', req.user.id, { claim_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'withdraw the claim'); }
});

router.get('/me/claims/:id/bill', async (req, res) => {
  try {
    const c = (await db.query(`SELECT bill_name, bill_mime, bill_data FROM pms.super50_claims WHERE tenant_id=$1 AND id=$2 AND employee_id=$3`,
      [T(req), req.params.id, req.user.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'No such claim.' });
    res.setHeader('Content-Type', c.bill_mime);
    res.setHeader('Content-Disposition', `inline; filename="${c.bill_name.replace(/["\r\n]/g, '')}"`);
    res.send(c.bill_data);
  } catch (e) { fail(res, e, 'open the bill'); }
});

router.post('/me/programme', async (req, res) => {
  try {
    const mine = await myAward(T(req), req.user.id);
    if (!mine) return res.status(403).json({ error: 'You do not hold a Super 50 tier this year.' });
    const { a, p } = mine;
    const tier = tierOf(p, a.tier);
    const kind = tier && tier.entitlements && tier.entitlements.programme;
    if (!kind) return res.status(409).json({ error: 'Your tier does not include an IIT/IIM programme.' });
    if (a.programme_status === 'completed') return res.status(409).json({ error: 'Your programme is already marked completed.' });
    const prog = (await db.query(`SELECT id, name FROM pms.super50_programmes WHERE tenant_id=$1 AND policy_id=$2 AND id=$3 AND kind=$4 AND active`,
      [T(req), p.id, (req.body || {}).programme_id, kind])).rows[0];
    if (!prog) return res.status(422).json({ error: 'Pick a programme from the list.' });
    await db.query(`UPDATE pms.super50_awards SET programme_id=$2, programme_status='chosen', programme_chosen_at=now() WHERE id=$1`, [a.id, prog.id]);
    await audit(req, 'SUPER50_PROGRAMME_CHOSEN', req.user.id, { award_id: a.id, programme: prog.name });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'save your programme'); }
});

router.get('/me/certificate.pdf', async (req, res) => {
  try {
    const mine = await myAward(T(req), req.user.id);
    const out = mine && await certificate(T(req), mine.a.id);
    if (!out) return res.status(404).json({ error: 'You do not hold a Super 50 tier this year.' });
    sendPdf(res, out);
  } catch (e) { fail(res, e, 'make the certificate'); }
});

// ---- HR

router.get('/policies/default', async (req, res) => {
  if (!(await hrOnly(req, res))) return;
  res.json({ policy: DEFAULT_POLICY });
});

router.get('/policies', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const rows = (await db.query(
      `SELECT ${policyCols('p.')},
              (SELECT count(*)::int FROM pms.super50_awards a WHERE a.policy_id=p.id AND a.status='active') AS awardees,
              (SELECT count(*)::int FROM pms.super50_claims c JOIN pms.super50_awards a ON a.id=c.award_id WHERE a.policy_id=p.id AND c.status='submitted') AS claims_waiting
         FROM pms.super50_policies p WHERE p.tenant_id=$1 ORDER BY p.starts_on DESC`, [T(req)])).rows;
    res.json({ policies: rows, today: await todayIn() });
  } catch (e) { fail(res, e, 'load the benefits years'); }
});

router.post('/policies', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const body = req.body && req.body.from_default ? DEFAULT_POLICY : req.body;
    const { policy, error } = validatePolicy(body);
    if (error) return res.status(422).json({ error });
    const clash = (await db.query(`SELECT name FROM pms.super50_policies WHERE tenant_id=$1 AND basis_year=$2 AND status='active'`,
      [T(req), policy.basis_year])).rows[0];
    if (clash) return res.status(409).json({ error: `"${clash.name}" is already the benefits year for that appraisal.` });
    const r = (await db.query(
      `INSERT INTO pms.super50_policies (tenant_id, name, basis_fiscal_year, basis_year, starts_on, ends_on, tiers, hubs, lapse_reminder_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [T(req), policy.name, policy.basis_fiscal_year, policy.basis_year, policy.starts_on, policy.ends_on,
        JSON.stringify(policy.tiers), JSON.stringify(policy.hubs), policy.lapse_reminder_days, req.user.email])).rows[0];
    await audit(req, 'SUPER50_POLICY_CREATED', null, { policy_id: r.id, name: policy.name });
    res.json({ ok: true, policy: await policyById(T(req), r.id) });
  } catch (e) { fail(res, e, 'create the benefits year'); }
});

router.put('/policies/:id', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const cur = await policyById(T(req), req.params.id);
    if (!cur) return res.status(404).json({ error: 'No such policy.' });
    const { policy, error } = validatePolicy(req.body, cur);
    if (error) return res.status(422).json({ error });
    await db.query(
      `UPDATE pms.super50_policies SET name=$3, basis_fiscal_year=$4, basis_year=$5, starts_on=$6, ends_on=$7, tiers=$8, hubs=$9,
              lapse_reminder_days=$10, status=coalesce($11, status), updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [T(req), cur.id, policy.name, policy.basis_fiscal_year, policy.basis_year, policy.starts_on, policy.ends_on,
        JSON.stringify(policy.tiers), JSON.stringify(policy.hubs), policy.lapse_reminder_days, policy.status || null]);
    await audit(req, 'SUPER50_POLICY_UPDATED', null, { policy_id: cur.id, before: { tiers: cur.tiers, hubs: cur.hubs, starts_on: cur.starts_on, ends_on: cur.ends_on }, after: policy });
    res.json({ ok: true, policy: await policyById(T(req), cur.id),
      note: cur.assigned_at ? 'Saved. Set the tiers again for a changed amount to reach people already awarded.' : 'Saved.' });
  } catch (e) { fail(res, e, 'save the benefits year'); }
});

router.post('/policies/:id/assign', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const r = await assignTiers(T(req), req.params.id, req.user.email);
    await audit(req, 'SUPER50_TIERS_ASSIGNED', null, { policy_id: req.params.id, via: 'hr', ...r });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e, 'set the tiers'); }
});

router.get('/policies/:id/awards', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const p = await policyById(T(req), req.params.id);
    if (!p) return res.status(404).json({ error: 'No such policy.' });
    const awards = await awardsWithBalance(T(req), `a.policy_id=$2`, [p.id]);
    res.json({ awards: awards.map((a) => ({ ...a, label: (tierOf(p, a.tier) || {}).label })) });
  } catch (e) { fail(res, e, 'load the awardees'); }
});

router.get('/policies/:id/claims', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const status = ['submitted', 'approved', 'returned', 'withdrawn'].includes(req.query.status) ? req.query.status : null;
    const rows = (await db.query(
      `SELECT ${CLAIM_COLS}, e.name, e.emp_code, e.department, a.tier
         FROM pms.super50_claims c JOIN pms.super50_awards a ON a.id=c.award_id JOIN core.employees e ON e.id=c.employee_id
        WHERE c.tenant_id=$1 AND a.policy_id=$2 ${status ? 'AND c.status=$3' : ''}
        ORDER BY (c.status='submitted') DESC, c.created_at DESC`, status ? [T(req), req.params.id, status] : [T(req), req.params.id])).rows;
    res.json({ claims: rows });
  } catch (e) { fail(res, e, 'load the claims'); }
});

router.get('/claims/:id/bill', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const c = (await db.query(`SELECT bill_name, bill_mime, bill_data FROM pms.super50_claims WHERE tenant_id=$1 AND id=$2`,
      [T(req), req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'No such claim.' });
    res.setHeader('Content-Type', c.bill_mime);
    res.setHeader('Content-Disposition', `inline; filename="${c.bill_name.replace(/["\r\n]/g, '')}"`);
    res.send(c.bill_data);
  } catch (e) { fail(res, e, 'open the bill'); }
});

// HR alone decides. Approving re-checks the balance: an HR change to the
// tier amount after the claim was sent must not let it overspend.
router.post('/claims/:id/decide', async (req, res) => {
  let hr = false;
  try { hr = await hrOnly(req, res); } catch (e) { return fail(res, e, 'decide the claim'); }
  if (!hr) return;
  const client = await db.getClient();
  try {
    const b = req.body || {};
    if (!['approve', 'return'].includes(b.decision)) throw Object.assign(new Error('Approve or return the claim.'), { status: 422 });
    const note = cleanText(b.note, 500);
    if (b.decision === 'return' && !note) throw Object.assign(new Error('Say why the claim is returned. The employee sees this.'), { status: 422 });
    await client.query('BEGIN');
    const c = (await client.query(
      `SELECT c.*, a.amount AS award_amount, a.status AS award_status FROM pms.super50_claims c JOIN pms.super50_awards a ON a.id=c.award_id
        WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE OF c, a`, [T(req), req.params.id])).rows[0];
    if (!c) throw Object.assign(new Error('No such claim.'), { status: 404 });
    if (c.employee_id === req.user.id) throw Object.assign(new Error('Your own claim is decided by another HR.'), { status: 403 });
    if (c.status !== 'submitted') throw Object.assign(new Error(`This claim is already ${c.status}.`), { status: 409 });
    if (b.decision === 'approve') {
      if (c.award_status !== 'active') throw Object.assign(new Error('This person no longer holds the tier. Return the claim instead.'), { status: 409 });
      const used = (await client.query(`SELECT coalesce(sum(amount),0)::float AS v FROM pms.super50_claims WHERE award_id=$1 AND status='approved'`, [c.award_id])).rows[0].v;
      if (money(used + Number(c.amount)) > money(Number(c.award_amount))) {
        throw Object.assign(new Error(`Approving this would pass the ${inr(c.award_amount)} limit (${inr(used)} already approved).`), { status: 409 });
      }
    }
    const status = b.decision === 'approve' ? 'approved' : 'returned';
    await client.query(`UPDATE pms.super50_claims SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`,
      [c.id, status, req.user.email, note || null]);
    await client.query('COMMIT');
    await audit(req, b.decision === 'approve' ? 'SUPER50_CLAIM_APPROVED' : 'SUPER50_CLAIM_RETURNED', c.employee_id,
      { claim_id: c.id, amount: Number(c.amount), note: note || null });
    const title = status === 'approved' ? `Your Super 50 claim of ${inr(c.amount)} is approved` : `Your Super 50 claim of ${inr(c.amount)} is returned`;
    await notify(T(req), c.employee_id, `super50_claim_${status}`, title, status === 'returned' ? `HR's reason: ${note}` : note || null, LINK, { email: true })
      .catch((e) => logger.warn('super50 claim notice failed', { error: e.message }));
    res.json({ ok: true, status });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e, 'decide the claim');
  } finally { client.release(); }
});

router.get('/policies/:id/programmes', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    res.json({ programmes: (await db.query(
      `SELECT pr.*, (SELECT count(*)::int FROM pms.super50_awards a WHERE a.programme_id=pr.id) AS chosen_by
         FROM pms.super50_programmes pr WHERE pr.tenant_id=$1 AND pr.policy_id=$2 ORDER BY pr.kind, pr.name`, [T(req), req.params.id])).rows });
  } catch (e) { fail(res, e, 'load the programmes'); }
});

router.post('/policies/:id/programmes', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const b = req.body || {};
    const name = cleanText(b.name, 160);
    if (!name) return res.status(422).json({ error: 'Name the programme.' });
    if (!['course', 'refresher'].includes(b.kind)) return res.status(422).json({ error: 'A programme is a course (Twice) or a 2-day refresher (Elite).' });
    if (!(await policyById(T(req), req.params.id))) return res.status(404).json({ error: 'No such policy.' });
    const r = (await db.query(`INSERT INTO pms.super50_programmes (tenant_id, policy_id, name, provider, kind) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [T(req), req.params.id, name, cleanText(b.provider, 120) || null, b.kind])).rows[0];
    await audit(req, 'SUPER50_PROGRAMME_ADDED', null, { programme_id: r.id, name });
    res.json({ ok: true, programme: r });
  } catch (e) { fail(res, e, 'add the programme'); }
});

router.put('/programmes/:id', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const b = req.body || {};
    const name = b.name == null ? null : cleanText(b.name, 160);
    if (b.name != null && !name) return res.status(422).json({ error: 'Name the programme.' });
    const r = await db.query(
      `UPDATE pms.super50_programmes SET name=coalesce($3,name), provider=CASE WHEN $4::boolean THEN $5 ELSE provider END,
              active=coalesce($6, active) WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [T(req), req.params.id, name, b.provider !== undefined, cleanText(b.provider, 120) || null, typeof b.active === 'boolean' ? b.active : null]);
    if (!r.rowCount) return res.status(404).json({ error: 'No such programme.' });
    res.json({ ok: true, programme: r.rows[0] });
  } catch (e) { fail(res, e, 'save the programme'); }
});

// HR records the programme as done (or picks it for the person).
router.put('/awards/:id/programme', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const b = req.body || {};
    const a = (await db.query(`SELECT a.*, p.tiers FROM pms.super50_awards a JOIN pms.super50_policies p ON p.id=a.policy_id WHERE a.tenant_id=$1 AND a.id=$2`,
      [T(req), req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'No such award.' });
    let programmeId = a.programme_id;
    if (b.programme_id) {
      const tier = (a.tiers || []).find((t) => t.key === a.tier);
      const kind = tier && tier.entitlements && tier.entitlements.programme;
      const ok = kind && (await db.query(`SELECT 1 FROM pms.super50_programmes WHERE tenant_id=$1 AND policy_id=$2 AND id=$3 AND kind=$4`,
        [T(req), a.policy_id, b.programme_id, kind])).rowCount;
      if (!ok) return res.status(422).json({ error: 'That programme is not one this tier picks from.' });
      programmeId = b.programme_id;
    }
    if (!['chosen', 'completed'].includes(b.status)) return res.status(422).json({ error: 'Mark the programme chosen or completed.' });
    if (!programmeId) return res.status(422).json({ error: 'Pick the programme first.' });
    await db.query(
      `UPDATE pms.super50_awards SET programme_id=$2, programme_status=$3,
              programme_chosen_at=coalesce(programme_chosen_at, now()),
              programme_completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END WHERE id=$1`, [a.id, programmeId, b.status]);
    await audit(req, 'SUPER50_PROGRAMME_STATUS', a.employee_id, { award_id: a.id, status: b.status });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'save the programme'); }
});

router.get('/awards/:id/certificate.pdf', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const out = await certificate(T(req), req.params.id);
    if (!out) return res.status(404).json({ error: 'No active award with that id.' });
    sendPdf(res, out);
  } catch (e) { fail(res, e, 'make the certificate'); }
});

// Two sheets for whoever acts on them outside the PMS: the entitlements
// (attendance applies single punch and the EL; payroll the variable) and
// the approved claims (finance reimburses them). The variable column is
// pay, so it is there only for someone who may see pay.
router.get('/policies/:id/export.xlsx', async (req, res) => {
  try {
    if (!(await hrOnly(req, res))) return;
    const p = await policyById(T(req), req.params.id);
    if (!p) return res.status(404).json({ error: 'No such policy.' });
    const kind = req.query.kind === 'claims' ? 'claims' : 'entitlements';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(kind === 'claims' ? 'Approved claims' : 'Entitlements');
    const bold = (row) => { ws.getRow(row).font = { bold: true, name: 'Arial' }; };
    if (kind === 'claims') {
      ws.columns = [
        { header: 'Employee code', key: 'emp_code', width: 14 }, { header: 'Name', key: 'name', width: 26 },
        { header: 'Department', key: 'department', width: 20 }, { header: 'Tier', key: 'tier', width: 16 },
        { header: 'Hub', key: 'hub', width: 16 }, { header: 'Item', key: 'item', width: 20 }, { header: 'Description', key: 'description', width: 30 },
        { header: 'Amount (INR)', key: 'amount', width: 14 }, { header: 'Submitted', key: 'created_at', width: 14 },
        { header: 'Approved on', key: 'decided_at', width: 14 }, { header: 'Approved by', key: 'decided_by', width: 24 },
      ];
      const rows = (await db.query(
        `SELECT c.*, e.name, e.emp_code, e.department, a.tier FROM pms.super50_claims c
           JOIN pms.super50_awards a ON a.id=c.award_id JOIN core.employees e ON e.id=c.employee_id
          WHERE c.tenant_id=$1 AND a.policy_id=$2 AND c.status='approved' ORDER BY e.name, c.decided_at`, [T(req), p.id])).rows;
      const hub = new Map(p.hubs.map((h) => [h.key, h.label]));
      for (const r of rows) {
        ws.addRow({ ...r, tier: (tierOf(p, r.tier) || {}).label, hub: hub.get(r.hub) || r.hub, amount: Number(r.amount),
          created_at: new Date(r.created_at), decided_at: r.decided_at ? new Date(r.decided_at) : null });
      }
      ws.getColumn('amount').numFmt = '#,##0.00';
      ws.getColumn('created_at').numFmt = 'dd-mmm-yyyy'; ws.getColumn('decided_at').numFmt = 'dd-mmm-yyyy';
      if (rows.length) {
        const total = ws.addRow({ name: 'Total', amount: { formula: `SUM(H2:H${rows.length + 1})` } });
        total.font = { bold: true, name: 'Arial' };
      }
    } else {
      const pay = await hasPermission(req.user, 'pms_compensation');
      ws.columns = [
        { header: 'Employee code', key: 'emp_code', width: 14 }, { header: 'Name', key: 'name', width: 26 },
        { header: 'Department', key: 'department', width: 20 }, { header: 'Designation', key: 'designation', width: 22 },
        { header: 'Tier', key: 'label', width: 16 }, { header: 'Consecutive years', key: 'streak', width: 12 },
        { header: 'Amount (INR)', key: 'amount', width: 14 }, { header: 'Approved (INR)', key: 'used', width: 14 },
        { header: 'Waiting on HR (INR)', key: 'pending', width: 16 }, { header: 'Remaining (INR)', key: 'remaining', width: 14 },
        { header: 'Single punch', key: 'single_punch', width: 12 }, { header: 'Mandatory EL days', key: 'el', width: 12 },
        { header: 'Fast-track promotion', key: 'fast_track', width: 14 }, { header: 'IIT/IIM programme', key: 'programme', width: 30 },
        { header: 'Programme status', key: 'programme_status', width: 14 },
        ...(pay ? [{ header: 'Variable (% of last year)', key: 'variable_pct', width: 14 }] : []),
      ];
      const awards = await awardsWithBalance(T(req), `a.policy_id=$2 AND a.status='active'`, [p.id]);
      for (const a of awards) {
        const t = tierOf(p, a.tier) || { entitlements: {} };
        const e = t.entitlements || {};
        ws.addRow({ ...a, label: t.label, single_punch: e.single_punch ? 'Yes' : 'No', el: e.mandatory_el_days || 0,
          fast_track: e.fast_track ? 'Yes' : 'No', programme: a.programme_name || (e.programme ? 'Not chosen yet' : '—'),
          programme_status: a.programme_status || '', variable_pct: e.variable_pct == null ? '' : e.variable_pct });
      }
      ['amount', 'used', 'pending', 'remaining'].forEach((k) => { ws.getColumn(k).numFmt = '#,##0.00'; });
    }
    bold(1);
    ws.eachRow((row, n) => { if (n > 1) row.font = { ...(row.font || {}), name: 'Arial' }; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="super50-${kind}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { fail(res, e, 'export the sheet'); }
});

// For Calibration: the fast-track flag. Each person's tier in the policy
// year that is running now.
async function tiersNow(tenantId) {
  const rows = (await db.query(
    `SELECT a.employee_id, a.tier, p.tiers FROM pms.super50_awards a JOIN pms.super50_policies p ON p.id=a.policy_id
      WHERE a.tenant_id=$1 AND a.status='active' AND p.status='active' ORDER BY p.starts_on DESC`, [tenantId])).rows;
  const out = new Map();
  for (const r of rows) {
    if (out.has(r.employee_id)) continue;
    const t = (r.tiers || []).find((x) => x.key === r.tier) || {};
    out.set(r.employee_id, { tier: r.tier, label: t.label || r.tier, fast_track: !!(t.entitlements && t.entitlements.fast_track) });
  }
  return out;
}

module.exports = {
  router, tick, startScheduler, afterAnnualPublish, assignTiers, tiersNow,
  basisYearOf, streakAt, tierFor, validatePolicy, claimProblem, DEFAULT_POLICY, TIER_KEYS, HR_LINK,
};

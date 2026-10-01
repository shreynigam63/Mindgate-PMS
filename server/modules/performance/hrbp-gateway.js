// The HRBP gateway.
//
// Asked for: "HRBP should have all tabs available in HR but with
// conditions we have mentioned" — HR's own screens, acting on their own
// people only.
//
// There are 104 `pms_admin` guards across this module, each sitting on a
// handler that writes its own SQL over the whole company. Editing all of
// them would be slow, and — worse — it would be impossible to prove I had
// not missed one. A missed guard on a scoped feature is not a cosmetic
// bug: it hands one partner the whole organisation's ratings, and it
// looks exactly like a working screen while it does it.
//
// So the scoping happens HERE, in one place, where it can be read in full
// and tested in one pass:
//
//   1. A caller holding pms_hrbp but NOT pms_admin is lent pms_admin for
//      the life of the request, so HR's handlers run unchanged.
//   2. Tenant-wide WRITES are refused outright — a setting, a cycle, a
//      published library or framework applies to everybody, so there is
//      no honest way to scope one. Those pages stay readable.
//   3. Every other write must name a person, and that person must be in
//      the remit. A write whose target cannot be resolved is REFUSED, not
//      allowed: an unrecognised shape is a gap in this file, and the safe
//      reading of a gap is "no".
//   4. Every response is narrowed on the way out to the people in the
//      remit, and any total printed beside a narrowed list is recomputed,
//      with the organisation-wide figure kept beside it under `org_*` so
//      a screen can say "3 of 6" rather than silently disagreeing with HR.
//
// The guarantee this file exists to keep, and the one the tests pin:
// NO RECORD BELONGING TO SOMEBODY OUTSIDE THE REMIT REACHES AN HRBP.

const { hasPermission } = require('../../core/permissions');
const db = require('../../core/db');
const logger = require('../../core/logger');
const hrbpScope = require('../people').hrbpScope;

// Tenant-wide. None of these can be narrowed to a remit, because what
// they change applies to everybody — so an HRBP reads them and cannot
// write them. Matched as a prefix against the path inside this router.
// Not lent at all, in either direction: these decide who sees what.
const HR_ONLY = ['/hrbp/admin'];

// What an HRBP is lent for the life of one request. Named rather than a
// wildcard so that adding one is a decision somebody has to write down.
const LENT = ['pms_admin', 'people_admin', 'engagement_admin'];

const TENANT_WIDE = [
  '/settings',
  '/hr/settings',
  '/cycles',
  '/kra-library',
  '/hr/kra-library',
  '/competencies/framework',
  '/competency-framework',
  '/competencies/master',
  '/department-heads',
  '/hrbp/admin',
  '/calibration/bands',
  '/increment-matrix',
];

// The keys a payload uses to name whose record a row is. Checked in this
// order; the first one present decides.
const EMPLOYEE_KEYS = ['employee_id', 'employeeId', 'subject_employee_id', 'person_id'];

const isUuid = (v) => typeof v === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Who this request may see. Resolved once and cached on the request —
 * every list on a page would otherwise re-run the same query.
 */
async function remitFor(req) {
  if (!req._hrbpRemit) {
    req._hrbpRemit = {
      remit: await hrbpScope.remitFor(req.user.tenant_id, req.user.email),
      ids: new Set(await hrbpScope.employeeIdsFor(req.user.tenant_id, req.user.email, { includeInactive: true })),
    };
  }
  return req._hrbpRemit;
}

/**
 * Does this object name somebody, and is that somebody outside the remit?
 * Returns null when the object names nobody — such a row is not a person's
 * record and is left alone (a cycle, a band, a KRA library entry).
 */
function outsideRemit(ids, o) {
  if (!o || typeof o !== 'object') return null;
  for (const k of EMPLOYEE_KEYS) {
    if (isUuid(o[k])) return !ids.has(o[k]);
  }
  if (o.employee && typeof o.employee === 'object' && isUuid(o.employee.id)) {
    return !ids.has(o.employee.id);
  }
  // A row that IS an employee: an id beside an address. Checked last,
  // because plenty of rows carry an `id` of their own.
  if (isUuid(o.id) && typeof o.email === 'string') return !ids.has(o.id);
  return null;
}

/**
 * Narrow a payload in place. Walks the whole tree: a page that nests its
 * people two levels down inside `report.team[]` is as common here as a
 * flat list, and a filter that only knew about the top level would be the
 * kind of near-miss this file exists to avoid.
 *
 * Returns the number of rows removed, so the caller can tell whether
 * anything was scoped at all.
 */
function narrow(node, ids, depth = 0) {
  if (depth > 8 || !node || typeof node !== 'object') return 0;
  let removed = 0;
  if (Array.isArray(node)) {
    for (const el of node) removed += narrow(el, ids, depth + 1);
    return removed;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      const before = v.length;
      const kept = v.filter((el) => outsideRemit(ids, el) !== true);
      removed += before - kept.length;
      node[key] = kept;
      for (const el of kept) removed += narrow(el, ids, depth + 1);
      if (kept.length !== before) rewriteTotals(node, key, before, kept);
    } else if (v && typeof v === 'object') {
      // An object that is itself somebody else's record — `report.employee`
      // on a page opened for a person outside the remit — is removed
      // rather than emptied, so the page's own "nothing here" state runs
      // instead of it rendering a half-blank record.
      if (outsideRemit(ids, v) === true) { node[key] = null; removed += 1; } else {
        removed += narrow(v, ids, depth + 1);
      }
    }
  }
  return removed;
}

/**
 * A count printed beside a list that has just been narrowed is now wrong,
 * and a wrong count is worse than no count: it is the "HR says 6 and I see
 * 3" support call, with nothing on screen to explain it. The real figure
 * is kept under org_* so the page can print both.
 */
function rewriteTotals(parent, arrayKey, before, kept) {
  const candidates = ['total', 'count', `${arrayKey}_total`, `${arrayKey}_count`, 'total_count'];
  for (const c of candidates) {
    if (typeof parent[c] === 'number') {
      if (parent[`org_${c}`] === undefined) parent[`org_${c}`] = parent[c];
      parent[c] = kept.length;
    }
  }
  // `counts` / `summary` are per-category tallies over the list that was
  // just narrowed. Recomputed from the rows that survived where the
  // category is on the row; where it is not, the tally is dropped rather
  // than left stale, because a stale one cannot be told from a real one.
  for (const blockKey of ['counts', 'summary']) {
    const block = parent[blockKey];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const next = {};
    let recomputed = true;
    for (const cat of Object.keys(block)) {
      if (typeof block[cat] !== 'number') { next[cat] = block[cat]; continue; }
      const n = kept.filter((r) => r && typeof r === 'object'
        && Object.values(r).some((val) => val === cat)).length;
      if (n === 0 && block[cat] > 0 && !kept.length) { next[cat] = 0; continue; }
      if (n === 0 && block[cat] > 0) { recomputed = false; break; }
      next[cat] = n;
    }
    if (recomputed) {
      if (parent[`org_${blockKey}`] === undefined) parent[`org_${blockKey}`] = block;
      parent[blockKey] = next;
    }
  }
  if (before !== kept.length) parent.scoped_to_remit = true;
}

/**
 * Which people a write is about.
 *
 * WRITTEN TWICE. The first version read `req.params.employeeId`, which is
 * always empty here: Express fills params per MATCHED ROUTE, and this
 * runs as router-level middleware before any route matches. Every write
 * therefore resolved to nobody and was refused — the gateway failed
 * closed, which is the right direction to fail, but it meant "HRBP can
 * act" did not work at all.
 *
 * So the path is read directly. Every uuid in it, and every uuid in the
 * body, is looked up: as an employee, and as a record that belongs to
 * one. ALL of the people found must be in the remit — a request that
 * names two people is only allowed if both are covered.
 */
async function targetEmployeeIds(req) {
  const found = new Set();
  const candidates = new Set();
  for (const seg of String(req.path || '').split('/')) if (isUuid(seg)) candidates.add(seg);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  for (const k of [...EMPLOYEE_KEYS, 'id', 'sheet_id', 'plan_id', 'assessment_id']) {
    if (isUuid(b[k])) candidates.add(b[k]);
  }

  // A record id resolves to the one person it belongs to. Tried in turn
  // because the path says which id it is only by position, and position
  // is exactly what a router-level middleware cannot read.
  const OWNED = [
    'SELECT id AS employee_id FROM core.employees WHERE tenant_id=$1 AND id=$2',
    'SELECT employee_id FROM pms.kra_sheets WHERE tenant_id=$1 AND id=$2',
    'SELECT employee_id FROM pms.development_plans WHERE tenant_id=$1 AND id=$2',
    'SELECT employee_id FROM pms.competency_assessments WHERE tenant_id=$1 AND id=$2',
    'SELECT employee_id FROM pms.midyear_checkins WHERE tenant_id=$1 AND id=$2',
    'SELECT employee_id FROM pms.manager_evaluations WHERE tenant_id=$1 AND id=$2',
    'SELECT employee_id FROM pms.connects WHERE tenant_id=$1 AND id=$2',
    // An RnR nomination names the person it is about. Without this the
    // gateway could not resolve a nomination id to anybody and refused
    // every HRBP approval — failing closed, which is the right direction,
    // but it meant an HRBP could not take their own step in the RnR
    // workflow. Found by walking a nomination through all four stages.
    'SELECT employee_id FROM rnr.nominations WHERE tenant_id=$1 AND id=$2',
  ];
  for (const id of candidates) {
    for (const sql of OWNED) {
      try {
        const r = await db.query(sql, [req.user.tenant_id, id]);
        if (r.rows.length) { found.add(r.rows[0].employee_id); break; }
      } catch (e) { logger.warn('hrbp gateway: owner lookup failed', { error: e.message }); }
    }
  }

  for (const k of ['employee_email', 'email']) {
    if (typeof b[k] !== 'string' || !b[k].includes('@')) continue;
    const r = await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [req.user.tenant_id, b[k]]);
    if (r.rows.length) found.add(r.rows[0].id);
  }
  return [...found];
}

/**
 * The middleware. Mount once, directly after authenticate/parity and
 * before any route in the performance module.
 */
function gateway() {
  return async function hrbpGateway(req, res, next) {
    try {
      if (!(await hasPermission(req.user, 'pms_hrbp'))) return next();
      if (await hasPermission(req.user, 'pms_admin')) return next();   // real HR, nothing to do

      const { remit, ids } = await remitFor(req);
      const write = req.method !== 'GET' && req.method !== 'HEAD';

      // HR'S OWN, read as well as written. Lending pms_admin would
      // otherwise hand an HRBP the screen that decides remits — including
      // their own, which is the obvious abuse of this whole feature. The
      // browser sweep caught this: a read is not automatically safe just
      // because it changes nothing.
      if (HR_ONLY.some((pfx) => String(req.path || '').startsWith(pfx))) {
        return res.status(403).json({
          error: "Remits are set by HR.", needs: 'pms_admin',
        });
      }

      if (write) {
        const path = req.path || '';
        if (TENANT_WIDE.some((p) => path.startsWith(p))) {
          return res.status(403).json({
            error: 'This setting applies to the whole company, so it stays with HR. '
                 + 'You can read it here, but not change it.',
            needs: 'pms_admin',
          });
        }
        if (remit.empty) {
          return res.status(403).json({
            error: hrbpScope.emptyRemitReason(remit), needs: 'an assigned remit',
          });
        }
        const targets = await targetEmployeeIds(req);
        if (!targets.length) {
          return res.status(403).json({
            error: 'This action does not name whose record it changes, so it cannot be '
                 + 'checked against your remit. HR can do it.',
            needs: 'pms_admin',
          });
        }
        const strangers = targets.filter((id) => !ids.has(id));
        if (strangers.length) {
          return res.status(403).json({
            error: strangers.length === targets.length
              ? 'That person is not in your remit.'
              : 'Some of those people are not in your remit, so none of it was done.',
            needs: 'a remit that covers them',
          });
        }
      }

      // Lent for this request only — see core/permissions.js.
      //
      // people_admin is here because the employee directory is an HR page
      // served by core, behind its own permission rather than pms_admin.
      // Lending only pms_admin left the Employees tab 403ing while every
      // other tab worked — the browser sweep found it, which is the whole
      // reason that sweep walks all nineteen rather than a sample.
      req.user = Object.assign(Object.create(Object.getPrototypeOf(req.user)), req.user, {
        grantedForRequest: LENT,
      });

      const json = res.json.bind(res);
      res.json = (body) => {
        try {
          if (body && typeof body === 'object') {
            narrow(body, ids);
            if (!Array.isArray(body)) {
              body.remit = { locations: remit.locations, hods: remit.hods, empty: remit.empty };
              body.scoped_to_remit = true;
            }
          }
        } catch (e) {
          // A filter that throws must not return the unfiltered body.
          logger.error('hrbp gateway: narrowing failed', { path: req.originalUrl, error: e.message });
          return res.status(500).json({ error: 'Could not scope this page to your remit.' });
        }
        return json(body);
      };
      return next();
    } catch (e) {
      logger.error('hrbp gateway failed', { error: e.message });
      return res.status(500).json({ error: 'Could not establish your remit.' });
    }
  };
}

// Registered so it also narrows the CORE routers — the employee
// directory above all, which is an HR page served outside this module.
// Without this the Employees tab would be the one HRBP page the gateway
// never saw, which is exactly the near-miss this design exists to avoid:
// the browser sweep found it.
require('../../core/scope-hooks').register(gateway());

module.exports = { gateway, narrow, outsideRemit, rewriteTotals, targetEmployeeIds, TENANT_WIDE, HR_ONLY, LENT };

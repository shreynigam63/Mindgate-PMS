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
// '/hr/mail' too: the SMTP account the whole product sends through is not
// a remit's to read or change.
const HR_ONLY = ['/hrbp/admin', '/hr/mail'];

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
  // The 9-box band limits, box names, actions and potential questions.
  '/nine-box/settings',
  '/increment-matrix',
  // The onboarding calendar and activity matrix plan every joiner's week.
  '/onboarding/holidays',
  '/onboarding/activities',
  '/onboarding/spocs',
  // The timesheet calendar and the KRA rating bands apply to everybody.
  '/timesheet/settings',
  '/timesheet/kra/scoring',
];

// Decisions HR keeps even inside a remit. All Approvals decides through
// one bulk route whose items[] the target check cannot see, so a single
// in-remit employee_id beside the items let an HRBP decide anybody's
// sheet (found 10 Oct). The page is read-only for an HRBP; this makes the
// server agree with it.
const HR_DECIDES = ['/approvals/bulk'];

// An HRBP's OWN appraisal, used exactly as any employee uses it (10 Oct).
//
// Until now the gateway treated these like HR's pages: a save that named
// nobody was refused ("HR can do it"), so an HRBP could not save their own
// KRAs, reviews, timesheet or survey; and a read was narrowed, so their own
// sheet vanished whenever they sat outside their own remit.
//
// On these routes the gateway steps aside completely: nothing is lent and
// nothing is narrowed, so the handler sees an ordinary employee plus what
// the HRBP role HOLDS. A route belongs here only if its handler acts on
// req.user (or on records the caller is a party to) and widens only on
// permissions an HRBP never holds unlent — pms_admin, people_admin,
// pms_team_eval, pms_hod. Exact templates, never prefixes, keyed on the
// router's mount, so a route added later stays behind the gateway until
// somebody reads it and adds it here. ':me' must be the caller's own id;
// any other ':name' matches one segment. A third element is a further test
// on the request.
//
// /meetings serves more than the HRBP's own reviews: a connect that asked
// HR to join lists its meetings for the HRBP named on it, under the
// employee's id. Those stay on the gateway's lent, remit-checked path, as
// before; a meeting the HRBP is a party to unlent — about them, or about
// one of their own reports — is self-service. The gateway works out which
// before it reads this table (see meetingParty below), because a meeting
// addressed by id says whose it is only in the database (13 Oct: until
// then deleting one, or adding its transcript, was always self-service,
// so an HRBP named on a remit employee's connect could add a link and
// not take it down again).
const partyToMeeting = (req) => req._hrbpMeetingParty === true;
const ownNineBox = (req) => !!req.query && ['team', 'departments', 'reporting'].includes(String(req.query.view));

const SELF_SERVICE = {
  '/api/v1/pms': [
    ['GET', '/home'],
    ['GET', '/my/kra-sheet'], ['PUT', '/my/kra-sheet/kras'], ['POST', '/my/kra-sheet/submit'],
    ['GET', '/my/kra-library'],
    ['GET', '/my/development-plan'], ['PUT', '/my/development-plan/goals'],
    ['POST', '/my/development-plan/submit'], ['PUT', '/my/development-plan/goals/:goal/progress'],
    ['GET', '/my/midyear-review'], ['PUT', '/my/midyear-review'], ['PUT', '/my/midyear-review/form'],
    ['POST', '/my/midyear-review/submit'],
    ['GET', '/my/self-appraisal'], ['PUT', '/my/self-appraisal'], ['POST', '/my/self-appraisal/submit'],
    ['GET', '/my/self-appraisal/evidence'], ['POST', '/my/self-appraisal/evidence'],
    ['DELETE', '/my/self-appraisal/evidence/:id'], ['GET', '/evidence/:id/download'],
    ['GET', '/my/annual-review'], ['GET', '/my/rating'], ['GET', '/my/rating/status'], ['GET', '/my/history'],
    ['GET', '/closure-letters/me/:cycle/download'],
    ['GET', '/review/kras/:me'], ['PUT', '/review/kras/:me'],
    ['GET', '/competencies/me'], ['PUT', '/competencies/me'], ['POST', '/competencies/me/submit'],
    // The template and the upload stay here so the gateway steps aside and
    // the route's own answer reaches an HRBP: since 22 Oct only HR and
    // Super Admin load timesheets (timesheet.js mayUpload).
    ['GET', '/timesheet/me'], ['GET', '/timesheet/template.xlsx'], ['POST', '/timesheet/upload'],
    // Timesheet approvals (26 Oct): the routes decide who may see and
    // approve — manager, upper manager, an HRBP for their remit, HR — so
    // an HRBP who manages people approves their own reportees here too.
    ['GET', '/timesheet/approvals'], ['GET', '/timesheet/approvals/:id'], ['POST', '/timesheet/approvals/:id/approve'],
    ['GET', '/timesheet/kra/me'], ['GET', '/timesheet/kra/months/me'],
    ['GET', '/connects'], ['GET', '/connects/questions'], ['GET', '/connects/people'],
    ['GET', '/connects/kra-options/:me'], ['GET', '/connects/cadence/:me'],
    ['POST', '/connects'], ['PUT', '/connects/:id'], ['POST', '/connects/:id/sign-off'],
    ['POST', '/connects/:id/categorise'], ['POST', '/connects/training-suggestions'],
    ['GET', '/meetings/providers'],
    ['GET', '/meetings', partyToMeeting], ['POST', '/meetings', partyToMeeting],
    ['DELETE', '/meetings/:id', partyToMeeting], ['PUT', '/meetings/:id/transcript', partyToMeeting],
    // The 9-box of the HRBP's own team or departments, as a manager or
    // Delivery Head (held, never lent). Their company view stays on HR's
    // terms: lent, and cut to the remit before it is counted.
    ['GET', '/nine-box', ownNineBox], ['GET', '/nine-box/movement', ownNineBox], ['GET', '/nine-box/reports', ownNineBox],
    ['GET', '/nine-box/export.xlsx', ownNineBox], ['GET', '/nine-box/actions', ownNineBox],
    ['PUT', '/nine-box/actions/:id'],
    // HOD Review → Team analysis: the HRBP's own reporting line as a HOD.
    ['GET', '/hod/team/analysis'],
    // My Super 50: the caller's own tier, claims, bills, programme and
    // certificate. Every handler reads req.user only.
    ['GET', '/super50/me'], ['POST', '/super50/me/claims'], ['POST', '/super50/me/claims/:id/withdraw'],
    ['GET', '/super50/me/claims/:id/bill'], ['POST', '/super50/me/programme'], ['GET', '/super50/me/certificate.pdf'],
    // The MoM tab (mom.js): the HRBP's own daily connects, minutes and
    // action items, on what they hold. Nothing is lent here, so an HRBP
    // without pms_admin sees their own team, not every team.
    ['GET', '/mom/teams'], ['GET', '/mom/teams/:id/reports'], ['PUT', '/mom/teams/:id'],
    ['GET', '/mom/today'], ['GET', '/mom/meetings'], ['GET', '/mom/meetings/:id'],
    ['GET', '/mom/meetings/:id/versions/:v'], ['PUT', '/mom/meetings/:id/minutes'],
    ['POST', '/mom/meetings/:id/publish'], ['POST', '/mom/meetings/:id/revise'],
    ['POST', '/mom/meetings/:id/cancel'], ['POST', '/mom/meetings/:id/acknowledge'],
    ['GET', '/mom/action-items'], ['PUT', '/mom/action-items/:id'], ['GET', '/mom/compliance'],
    ['GET', '/mom/consent'], ['POST', '/mom/consent'], ['GET', '/mom/settings'], ['PUT', '/mom/settings'],
    ['POST', '/mom/meetings/:id/recording/start'], ['PUT', '/mom/meetings/:id/recording/:u/chunks/:n'],
    ['POST', '/mom/meetings/:id/recording/:u/finish'], ['DELETE', '/mom/meetings/:id/recording/:u'],
    ['GET', '/mom/meetings/:id/recording'], ['POST', '/mom/meetings/:id/transcript'], ['POST', '/mom/meetings/:id/redraft'],
    ['POST', '/mom/meetings/:id/suggestion/discard'],
  ],
  '/api/v1/agentic': [
    ['POST', '/kra-suggest'], ['POST', '/devplan-suggest'], ['POST', '/career-suggest'], ['POST', '/career-plan'],
    ['POST', '/review-assist'], ['POST', '/midyear-draft'], ['POST', '/justification-review'],
    ['POST', '/appraisal-summary'], ['POST', '/meeting-summary'],
    ['POST', '/connect-insights'], ['POST', '/connect-autotag'],
    ['GET', '/recommendations'], ['POST', '/recommendations'], ['PUT', '/recommendations/:id'],
  ],
  '/api/v1/people': [
    ['GET', '/career/my-path'], ['PUT', '/career/my-path'], ['POST', '/career/my-path/move-to-long-term'],
    ['PUT', '/career/my-milestones'], ['PUT', '/career/my-milestones/:id/progress'],
    ['GET', '/career/target-departments'],
    ['GET', '/events'], ['POST', '/events/:id/rsvp'],
    ['GET', '/awards'], ['POST', '/awards/cycles/:cycle/nominate'],
    ['GET', '/csr'], ['POST', '/csr/:id/participate'],
    ['GET', '/queries'], ['POST', '/queries'], ['GET', '/queries/:id/messages'], ['POST', '/queries/:id/reply'],
    // Queries raised by or to the caller (queries.js checks which); whom to
    // raise one to is a colleague search.
    ['GET', '/queries/people'], ['POST', '/queries/:id/close'],
    // Nominating for RnR is a manager's own work, open only to someone who
    // holds pms_team_eval (never lent), and the pool is their own team.
    ['GET', '/rnr/nominate/options'], ['GET', '/rnr/nominate/eligible'], ['POST', '/rnr/nominations'],
    // People Hub → Awards: the same company-wide winners wall as anyone's.
    ['GET', '/rnr/hub'],
    ['GET', '/rnr/nominations', (req) => req.query && req.query.mine === 'true'],
  ],
  '/api/v1/engagement': [
    ['GET', '/my/invitations'], ['GET', '/my/submissions'],
    ['GET', '/surveys/:id/questions'], ['POST', '/surveys/:id/respond'],
  ],
};

// Reads that stay on HR's terms but keep the caller's own records. The
// Improvement Plan page lists an HRBP's remit (lent), and must still show
// the HRBP their own plan when they sit outside their own remit.
const KEEP_SELF = { '/api/v1/pms': [['GET', '/pip'], ['GET', '/pip/:id']] };

// The writes an HRBP's pages make, and nothing else (13 Oct). Until then
// any write that named one in-remit person went through with HR's powers,
// and a handler that ignores its body (publishing a whole cycle, a month
// override) did HR's company-wide job with a decoy employee_id beside it.
// Each of these names its subject in the path or the body, so the remit
// check below sees exactly whom it changes. A route an HRBP page starts to
// use has to be read and added here, or it is refused.
const HRBP_WRITES = {
  '/api/v1/pms': [
    ['POST', '/hr/kra-sheet/:id/reopen'], ['PUT', '/hr/kra-sheet/:id/kras'], ['POST', '/hr/kra-sheet/:id/submit'],
    ['POST', '/hr/development-plan/:id/reopen'],
    ['POST', '/calibration/adjust'], ['POST', '/nine-box/override'], ['PUT', '/calibration/allocation/:id'],
    ['PUT', '/timesheet/kra/employee/:id/map'], ['POST', '/timesheet/kra/employee/:id/map/bulk'],
    ['DELETE', '/timesheet/kra/employee/:id/map/:item'],
    ['PUT', '/pip/:id'], ['POST', '/pip/:id/entries'], ['POST', '/pip/:id/gates/:gate/review'],
    // A meeting link on a connect that asked HR to join, for a remit
    // employee: added, taken down again, or given its transcript.
    ['POST', '/meetings'], ['DELETE', '/meetings/:id'], ['PUT', '/meetings/:id/transcript'],
  ],
  '/api/v1/people': [
    ['POST', '/rnr/nominations/:id/decide'],
    // The First-Week Journey (hidden since 8 Oct, data kept): a joiner's
    // SPOC work, one joiner at a time.
    ['POST', '/onboarding/joiners'], ['PATCH', '/onboarding/joiners/:id'], ['DELETE', '/onboarding/joiners/:id'],
    ['POST', '/onboarding/joiners/:id/complete'], ['PUT', '/onboarding/joiners/:id/feedback'],
    ['PATCH', '/onboarding/tasks/:id'], ['POST', '/onboarding/tasks/:id/mark-sent'], ['POST', '/onboarding/tasks/:id/email'],
  ],
  '/api/v1/employees': [
    ['PUT', '/:id'], ['DELETE', '/:id'], ['POST', '/:id/restore'],
    // Refused by the routes themselves, which hold these for HR and Super
    // Admin; listed so that refusal, and its wording, is the one shown.
    ['PUT', '/:id/role'], ['POST', '/:id/credentials'],
  ],
};

const NOT_AN_HRBP_CHANGE = {
  error: 'Only HR and Super Admin can make this change. It is not one of the changes an HRBP makes.',
  needs: 'pms_admin',
};

// Lists that may name somebody outside the remit in the query, because
// every row carries its employee_id and narrowing removes the rest. A
// connect that asked HR to join shows its meetings this way.
const READ_NARROWED = { '/api/v1/pms': [['GET', '/meetings']] };

/** Does this request match one of the [method, template] pairs for its router? */
function matchesRoute(table, req, routePath) {
  const rows = table[String(req.baseUrl || '').toLowerCase()];
  if (!rows) return false;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const segs = routePath.replace(/\/+$/, '').split('/');
  const me = String(req.user.id || '').toLowerCase();
  return rows.some(([m, template, also]) => {
    if (m !== method) return false;
    const t = template.split('/');
    if (t.length !== segs.length) return false;
    return t.every((part, i) => {
      if (part === ':me') return !!me && segs[i] === me;
      if (part.startsWith(':')) return segs[i] !== '';
      return part === segs[i];
    }) && (!also || also(req));
  });
}

// Refused when an HRBP's write through HR's pages names their own record.
// Their own appraisal is changed on the Self pages like anyone's; HR's
// powers over it stay with HR. Worded as the core people routes word it.
const OWN_RECORD = {
  error: 'Only HR and Super Admin can change your own record here. Your own appraisal is on your Self pages.',
  needs: 'pms_admin',
};

// The keys a payload uses to name whose record a row is. Checked in this
// order; the first one present decides.
const EMPLOYEE_KEYS = ['employee_id', 'employeeId', 'subject_employee_id', 'person_id'];

// An id in every spelling Postgres reads as one — upper case, braces,
// hyphens left out or moved — returned in the one form the database hands
// back, or null. Until 13 Oct this file knew only the canonical spelling,
// so '{<id>}' or the id without its hyphens was no id at all here, yet the
// same row to the handler's SQL: a decoy key beside it was all the gateway
// checked, and a read named that way was not checked at all.
function uuidOf(v) {
  if (typeof v !== 'string') return null;
  let s = v;
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  s = s.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(s)) return null;
  s = s.toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const isUuid = (v) => uuidOf(v) !== null;

/** The ids a value names: one, or a list of them (?employee_id=a&employee_id=b). */
const idsIn = (v) => (Array.isArray(v) ? v : [v]).map(uuidOf).filter(Boolean);

/**
 * Path segments as the route will read them. Express hands a route its
 * params percent-decoded, but req.path is not: '%36' for a '6' hid an id
 * from this file and not from the handler (13 Oct). null when a segment
 * cannot be decoded — Express refuses such a param too.
 */
function pathSegments(req) {
  const out = [];
  for (const raw of String(req.path || '').split('/')) {
    try { out.push(decodeURIComponent(raw)); } catch { return null; }
  }
  return out;
}
const pathIds = (req) => (pathSegments(req) || []).map(uuidOf).filter(Boolean);

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
    if (isUuid(o[k])) return !ids.has(uuidOf(o[k]));
  }
  if (o.employee && typeof o.employee === 'object' && isUuid(o.employee.id)) {
    return !ids.has(uuidOf(o.employee.id));
  }
  // A row that IS an employee: an id beside an address. Checked last,
  // because plenty of rows carry an `id` of their own.
  if (isUuid(o.id) && typeof o.email === 'string') return !ids.has(uuidOf(o.id));
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
function narrow(node, ids, depth = 0, people = null) {
  if (depth > 8 || !node || typeof node !== 'object') return 0;
  let removed = 0;
  if (Array.isArray(node)) {
    for (const el of node) removed += narrow(el, ids, depth + 1, people);
    return removed;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      const before = v.length;
      const kept = v.filter((el) => {
        const out = outsideRemit(ids, el);
        if (out !== null) return !out;
        // A list row that names a person by `id` alone — a 9-box cell is
        // {id, name}. Known for one because the id is on the employee
        // master: a uuid names one row in the whole database (13 Oct).
        const pid = el && typeof el === 'object' && !Array.isArray(el) ? uuidOf(el.id) : null;
        return !(pid && people && people.has(pid) && !ids.has(pid));
      });
      removed += before - kept.length;
      node[key] = kept;
      for (const el of kept) removed += narrow(el, ids, depth + 1, people);
      if (kept.length !== before) rewriteTotals(node, key, before, kept);
    } else if (v && typeof v === 'object') {
      // An object that is itself somebody else's record — `report.employee`
      // on a page opened for a person outside the remit — is removed
      // rather than emptied, so the page's own "nothing here" state runs
      // instead of it rendering a half-blank record.
      if (outsideRemit(ids, v) === true) { node[key] = null; removed += 1; } else {
        removed += narrow(v, ids, depth + 1, people);
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
  // An improvement plan, and one of its gates.
  'SELECT employee_id FROM pms.pip_records WHERE tenant_id=$1 AND id=$2',
  `SELECT p.employee_id FROM pms.pip_gates g JOIN pms.pip_records p ON p.id = g.pip_id
    WHERE g.tenant_id=$1 AND g.id=$2`,
  // An RnR nomination names the person it is about. Without this the
  // gateway could not resolve a nomination id to anybody and refused
  // every HRBP approval — failing closed, which is the right direction,
  // but it meant an HRBP could not take their own step in the RnR
  // workflow. Found by walking a nomination through all four stages.
  // A team award names nobody, so it resolves to the manager who
  // raised it — the HRBP covering that manager decides it (8 Oct).
  'SELECT COALESCE(employee_id, nominated_by) AS employee_id FROM rnr.nominations WHERE tenant_id=$1 AND id=$2',
  // The First-Week Journey: a joiner, and one of their tasks.
  'SELECT employee_id FROM people.onboarding_joiners WHERE tenant_id=$1 AND id=$2',
  `SELECT j.employee_id FROM people.onboarding_tasks t JOIN people.onboarding_joiners j ON j.id = t.joiner_id
    WHERE t.tenant_id=$1 AND t.id=$2`,
  // A review meeting belongs to the employee it was held about. Until
  // 13 Oct a meeting id resolved to nobody, so HR's transcript read let an
  // HRBP open anybody's meeting by id.
  'SELECT employee_id FROM pms.review_meetings WHERE tenant_id=$1 AND id=$2',
];

/** Each id's owner, and the ids that belong to nobody this file knows. */
async function ownersOf(req, candidates) {
  const found = new Set();
  const unresolved = [];
  for (const id of candidates) {
    let owner = null;
    for (const sql of OWNED) {
      try {
        const r = await db.query(sql, [req.user.tenant_id, id]);
        if (r.rows.length) { owner = r.rows[0].employee_id; break; }
      } catch (e) { logger.warn('hrbp gateway: owner lookup failed', { error: e.message }); }
    }
    if (owner) found.add(owner); else unresolved.push(id);
  }
  return { found, unresolved };
}

/**
 * Whose records a READ names, by id: the path, and the query keys that
 * name a person. Until 13 Oct reads were never checked, only narrowed,
 * and a summary addressed by employee id (a manager's rating before
 * publish, an AI reading) carries no key narrowing can see, so an HRBP
 * could read anybody's, their own included. Ids that resolve to nobody
 * (a cycle id) are left to narrowing.
 */
async function readTargetIds(req) {
  const candidates = new Set(pathIds(req));
  const q = req.query && typeof req.query === 'object' ? req.query : {};
  for (const k of [...EMPLOYEE_KEYS, 'about_employee_id']) for (const id of idsIn(q[k])) candidates.add(id);
  return [...(await ownersOf(req, candidates)).found];
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
  const candidates = new Set(pathIds(req));
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  for (const k of [...EMPLOYEE_KEYS, 'id', 'sheet_id', 'plan_id', 'assessment_id']) {
    for (const id of idsIn(b[k])) candidates.add(id);
  }
  // Lists of people are people too. A bulk action names them in an array,
  // and until 8 Oct those were not read: one in-remit employee_id beside
  // an `ids` list of anybody let the whole list through.
  for (const k of ['ids', 'employee_ids', 'employeeIds']) {
    if (Array.isArray(b[k])) for (const id of idsIn(b[k])) candidates.add(id);
  }

  const { found, unresolved } = await ownersOf(req, candidates);
  // Kept for the gateway: an id that resolves to nobody is a shape this
  // file does not know, and the safe reading of that is "no" (13 Oct).
  req._hrbpUnresolved = unresolved;

  for (const k of ['employee_email', 'email']) {
    if (typeof b[k] !== 'string' || !b[k].includes('@')) continue;
    const r = await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [req.user.tenant_id, b[k]]);
    if (r.rows.length) found.add(r.rows[0].id);
  }
  return [...found];
}

/**
 * Is the HRBP a party to this meeting request without HR's powers — is it
 * about them, or about one of their own reports? The same test the
 * meetings routes make (meetingParty in index.js) before pms_admin, so a
 * yes here is a request those routes allow an ordinary manager anyway.
 */
const MEETINGS = { '/api/v1/pms': [
  ['GET', '/meetings'], ['POST', '/meetings'], ['DELETE', '/meetings/:id'], ['PUT', '/meetings/:id/transcript'],
] };
async function meetingParty(req) {
  const me = req.user.id;
  const segs = (pathSegments(req) || []).filter(Boolean);   // ['meetings', id?, 'transcript'?]
  let employeeId;
  if (segs.length > 1) {
    const id = uuidOf(segs[1]);
    if (!id) return false;
    const r = await db.query(`SELECT employee_id FROM pms.review_meetings WHERE tenant_id=$1 AND id=$2`,
      [req.user.tenant_id, id]);
    if (!r.rows.length) return false;
    employeeId = r.rows[0].employee_id;
  } else {
    const v = ((req.method === 'GET' || req.method === 'HEAD' ? req.query : req.body) || {}).employee_id;
    if (v == null || v === '') return true;   // the routes read a blank as the caller
    employeeId = uuidOf(v);
    if (!employeeId) return false;
  }
  if (employeeId === me) return true;
  const r = await db.query(`SELECT 1 FROM core.employees WHERE tenant_id=$1 AND id=$2 AND manager_id=$3`,
    [req.user.tenant_id, employeeId, me]);
  return r.rows.length > 0;
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

      const write = req.method !== 'GET' && req.method !== 'HEAD';
      // Express routes match regardless of letter case ('/HRBP/admin' reaches
      // the '/hrbp/admin' router), so the prefix checks below compare a
      // lower-cased path with runs of slashes folded. Until 8 Oct they did
      // not, and '/HRBP/admin/partners' let an HRBP widen their own remit.
      const routePath = String(req.path || '').toLowerCase().replace(/\/{2,}/g, '/');

      // HR'S OWN, read as well as written. Lending pms_admin would
      // otherwise hand an HRBP the screen that decides remits — including
      // their own, which is the obvious abuse of this whole feature. The
      // browser sweep caught this: a read is not automatically safe just
      // because it changes nothing.
      if (HR_ONLY.some((pfx) => routePath.startsWith(pfx))) {
        return res.status(403).json({
          error: "Remits are set by HR.", needs: 'pms_admin',
        });
      }

      // An address with a segment that cannot be decoded names nobody this
      // file can check; Express refuses such a param anyway.
      if (!pathSegments(req)) return res.status(400).json({ error: 'This address is not valid.' });

      // The HRBP's own appraisal: an ordinary employee's request, so the
      // gateway steps aside before the remit is even looked up — an empty
      // remit, or one that leaves the HRBP out, must not touch their own
      // pages. Nothing lent, nothing narrowed. See SELF_SERVICE.
      if (matchesRoute(MEETINGS, req, routePath)) req._hrbpMeetingParty = await meetingParty(req);
      if (matchesRoute(SELF_SERVICE, req, routePath)) return next();

      const { remit, ids } = await remitFor(req);

      if (write) {
        if (TENANT_WIDE.some((p) => routePath.startsWith(p))) {
          return res.status(403).json({
            error: 'This setting applies to the whole company, so it stays with HR. '
                 + 'You can read it here, but not change it.',
            needs: 'pms_admin',
          });
        }
        if (HR_DECIDES.some((p) => routePath.startsWith(p))) {
          return res.status(403).json({
            error: 'Approvals are decided by the manager or by HR. You can read them here.',
            needs: 'pms_admin',
          });
        }
        if (!matchesRoute(HRBP_WRITES, req, routePath)) return res.status(403).json(NOT_AN_HRBP_CHANGE);
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
        if ((req._hrbpUnresolved || []).length) {
          return res.status(403).json({
            error: 'This action names a record that cannot be checked against your remit. HR can do it.',
            needs: 'pms_admin',
          });
        }
        // Never HR's powers over their own record: a calibration rating, a
        // reopened sheet, their own increment. Until 10 Oct an HRBP inside
        // their own remit could do all three through HR's pages.
        if (targets.includes(req.user.id)) return res.status(403).json(OWN_RECORD);
        const strangers = targets.filter((id) => !ids.has(id));
        if (strangers.length) {
          return res.status(403).json({
            error: strangers.length === targets.length
              ? 'That person is not in your remit.'
              : 'Some of those people are not in your remit, so none of it was done.',
            needs: 'a remit that covers them',
          });
        }
      } else if (!matchesRoute(READ_NARROWED, req, routePath)) {
        // A read addressed to a person by id: the same remit rule as a
        // write, checked before the handler runs (13 Oct).
        const named = await readTargetIds(req);
        if (named.includes(req.user.id) && !matchesRoute(KEEP_SELF, req, routePath)) {
          return res.status(403).json({
            error: 'Your own record is on your Self pages, not on HR\'s.', needs: 'pms_admin',
          });
        }
        if (named.some((id) => id !== req.user.id && !ids.has(id))) {
          return res.status(403).json({ error: 'That person is not in your remit.', needs: 'a remit that covers them' });
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

      // HR's pages never show an HRBP their own record, in or out of their
      // remit: what HR sees of them (a calibration row, a HOD rating before
      // publish) is not theirs to read early. Their own appraisal is on the
      // Self pages. KEEP_SELF reads are the exception.
      const visible = new Set(ids);
      visible.delete(req.user.id);
      if (matchesRoute(KEEP_SELF, req, routePath)) visible.add(req.user.id);
      // The same people, for a file download — see core/scope-hooks.
      req.remitVisible = visible;
      // Everybody on the employee master, so narrowing knows a list row
      // that names a person by `id` alone (see narrow).
      const people = new Set((await db.query(
        `SELECT id FROM core.employees WHERE tenant_id=$1`, [req.user.tenant_id])).rows.map((r) => r.id));

      const json = res.json.bind(res);
      res.json = (body) => {
        try {
          if (body && typeof body === 'object') {
            narrow(body, visible, 0, people);
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

module.exports = {
  gateway, narrow, outsideRemit, rewriteTotals, targetEmployeeIds, matchesRoute, uuidOf,
  TENANT_WIDE, HR_ONLY, HR_DECIDES, LENT, SELF_SERVICE, KEEP_SELF, HRBP_WRITES, READ_NARROWED,
};

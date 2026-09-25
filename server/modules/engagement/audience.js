// Who a survey goes to. Pure — no db, no express — so the rule logic
// can be tested directly, which is where the bugs in this kind of code
// live.
//
// A rule is a plain object. Every key is OPTIONAL and an absent or
// empty key means "no constraint on this", so {} is the whole company —
// which is exactly what the old target_audience='all' meant.
//
//   {
//     departments:     ['Development', 'Cloud'],
//     designations:    ['Software Developer'],
//     role_bands:      ['E3'],
//     manager_ids:     ['<uuid>'],
//     tenure_min_days: 30,      // joined at least 30 days ago
//     tenure_max_days: 36,      // and at most 36 days ago
//   }
//
// Lists are OR within a key and AND across keys: two departments and
// one designation means "a Software Developer in Development or Cloud".
//
// THE TENURE RULE IS A WINDOW, NEVER AN EXACT DAY. Asked for as "Day
// 30", implemented as 30..36, because on the real Mindgate master the
// recent joiners sit at 15, 17, 18, 23, 24, 29, 32, 38 days — a
// `= 30` test matches almost nobody, and a single missed daily sweep
// would drop a whole day's intake for good.

const MAX_LIST = 200;          // a rule naming 200 departments is a bug, not a rule

const list = (v) => {
  if (v == null) return [];
  const arr = (Array.isArray(v) ? v : [v])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean);
  return [...new Set(arr)].slice(0, MAX_LIST);
};

const whole = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i < 0 ? 0 : i;
};

// Accepts anything an HR form or an old row can hand over and returns a
// rule with exactly the keys below, so every reader sees one shape.
function normaliseRule(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let min = whole(r.tenure_min_days);
  let max = whole(r.tenure_max_days);
  // A window typed backwards is a typo, not an empty audience. Swapping
  // beats returning nobody and letting HR wonder where the cohort went.
  if (min != null && max != null && min > max) { const t = min; min = max; max = t; }
  return {
    departments: list(r.departments),
    designations: list(r.designations),
    role_bands: list(r.role_bands),
    manager_ids: list(r.manager_ids),
    tenure_min_days: min,
    tenure_max_days: max,
  };
}

const isEveryone = (rule) => {
  const r = normaliseRule(rule);
  return !r.departments.length && !r.designations.length && !r.role_bands.length
    && !r.manager_ids.length && r.tenure_min_days == null && r.tenure_max_days == null;
};

// A rule needs a date of joining only when it constrains tenure.
const needsJoiningDate = (rule) => {
  const r = normaliseRule(rule);
  return r.tenure_min_days != null || r.tenure_max_days != null;
};

// Builds the WHERE for core.employees. Every value is a bound
// parameter — a department name is HR's free text and goes nowhere near
// the SQL string. `start` is the number of parameters already used by
// the caller, so this can be appended to an existing query.
//
// Returns { where, params } where params are the NEW ones, in order.
function audienceSql(rule, { start = 1 } = {}) {
  const r = normaliseRule(rule);
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${start + params.length - 1}`; };

  if (r.departments.length) where.push(`department = ANY(${p(r.departments)})`);
  if (r.designations.length) where.push(`designation = ANY(${p(r.designations)})`);
  if (r.role_bands.length) where.push(`role_band = ANY(${p(r.role_bands)})`);
  if (r.manager_ids.length) where.push(`manager_id = ANY(${p(r.manager_ids)}::uuid[])`);

  // tenure = current_date - date_of_joining, so a MINIMUM tenure is an
  // EARLIER joining date. Getting this backwards silently inverts the
  // cohort, which is why the test asserts the direction on real dates
  // rather than on the string.
  if (r.tenure_min_days != null) {
    where.push(`date_of_joining <= current_date - ${p(r.tenure_min_days)}::int`);
  }
  if (r.tenure_max_days != null) {
    where.push(`date_of_joining >= current_date - ${p(r.tenure_max_days)}::int`);
  }
  // Somebody with no joining date has no tenure. Postgres would drop
  // them on the comparison anyway; saying it out loud keeps the reason
  // visible, and the preview reports how many were dropped rather than
  // letting a short cohort look like the honest answer.
  if (needsJoiningDate(r)) where.push('date_of_joining IS NOT NULL');

  return { where: where.length ? where.join(' AND ') : 'true', params };
}

// The audience in words, for the release confirmation and the audit
// entry. HR presses a button that says who it is about to write to.
function describeRule(rule) {
  const r = normaliseRule(rule);
  if (isEveryone(r)) return 'everyone on the employee list';
  const bits = [];
  const many = (arr, one, more) => (arr.length === 1 ? `${one} ${arr[0]}` : `${more} ${arr.join(', ')}`);
  if (r.designations.length) bits.push(many(r.designations, 'with the designation', 'with any of the designations'));
  if (r.departments.length) bits.push(many(r.departments, 'in', 'in any of'));
  if (r.role_bands.length) bits.push(many(r.role_bands, 'on role band', 'on any of the role bands'));
  if (r.manager_ids.length) {
    bits.push(r.manager_ids.length === 1 ? 'reporting to the chosen manager'
      : `reporting to any of the ${r.manager_ids.length} chosen managers`);
  }
  if (r.tenure_min_days != null && r.tenure_max_days != null) {
    bits.push(`who joined between ${r.tenure_min_days} and ${r.tenure_max_days} days ago`);
  } else if (r.tenure_min_days != null) {
    bits.push(`who joined at least ${r.tenure_min_days} days ago`);
  } else if (r.tenure_max_days != null) {
    bits.push(`who joined within the last ${r.tenure_max_days} days`);
  }
  return `everyone ${bits.join(', ')}`;
}

// ---- lifecycle triggers -----------------------------------------------
//
// The milestones the spec asks for, as days since joining. Day 1 is the
// joining day itself, so its window opens at 0.
const MILESTONES = [
  { day: 0, window: 2, key: 'day_1', label: 'Day 1 Check-in' },
  { day: 5, window: 4, key: 'week_1', label: 'Week 1 Onboarding' },
  { day: 30, window: 7, key: 'day_30', label: 'Day 30 Connect' },
  { day: 60, window: 7, key: 'day_60', label: 'Day 60 Connect' },
  { day: 90, window: 7, key: 'day_90', label: 'Day 90 Connect' },
];

// A tenure-triggered survey's audience is its own rule AND the window
// its milestone defines. Built here rather than at the two call sites
// (preview and sweep) so the screen HR reads and the invitations the
// sweep writes can never describe different people.
function triggerRule(survey) {
  const base = normaliseRule(survey && survey.audience_rule);
  if (!survey || survey.trigger_type !== 'tenure' || survey.trigger_day == null) return base;
  const day = whole(survey.trigger_day) ?? 0;
  const win = whole(survey.trigger_window_days);
  return { ...base, tenure_min_days: day, tenure_max_days: day + (win == null ? 7 : win) };
}

module.exports = { normaliseRule, audienceSql, describeRule, isEveryone,
                   needsJoiningDate, triggerRule, MILESTONES };

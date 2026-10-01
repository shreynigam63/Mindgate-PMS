// The eight scenarios the brief asks for, and the engines behind them.
//
// These are the client's own acceptance tests, written out verbatim from
// section 29. They run against the pure engines rather than the HTTP
// layer, because that is where the decisions are — and because a rule
// that needs a database and four approvers to test is a rule nobody will
// re-test when HR edits it.
//
// The ninth test is mine, not theirs: the 3-year boundary. The brief
// defines Rising Star as 1–3 years and Buddy Star as 3+, which overlap at
// exactly 3.0, and the client flagged it themselves. Half-open windows
// resolve it, and this pins that they stay resolved.

const { test, after } = require('node:test');
const assert = require('node:assert');
const db = require('../core/db');
const elig = require('../modules/people/rnr-eligibility');
const quota = require('../modules/people/rnr-quota');
const wf = require('../modules/people/rnr-workflow');
const { AWARDS, BANDS, STATUSES, SETTINGS } = require('../migrations/077-rnr');

const bandLevels = BANDS.map(([band, level]) => ({ band, level }));
const statuses = STATUSES.map(([status, is_active]) => ({ status, is_active }));
const settings = { ...SETTINGS };
const AS_OF = '2026-10-01';

after(async () => { await db.pool.end().catch(() => {}); });

// The award master as the migration seeds it, so the tests exercise the
// shipped rules rather than a convenient copy of them.
const award = (key) => {
  const a = AWARDS.find((x) => x[0] === key);
  return { id: key, key, name: a[1], level: a[2], frequency: a[3],
    min_experience_years: a[4], max_experience_years: a[5], experience_basis: a[6],
    bands: a[7], is_team: a[8], active: true };
};
const emp = (o) => ({ status: 'Active', role_band: 'Band 5', total_experience_years: 5, ...o });
const ctx = { asOf: AS_OF, settings, bandLevels, statuses };

test('SCENARIO 1 — joined four months ago: not eligible, and told how long is left', () => {
  const r = elig.check(emp({ date_of_joining: '2026-06-01' }), award('wow_machine'), ctx);
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => /completed only 4 months/.test(x)),
    `expected the actual figure, got: ${r.reasons.join(' | ')}`);
  assert.ok(r.reasons.some((x) => /Minimum required service is 6 months/.test(x)));
  assert.ok(r.reasons.some((x) => /2 more months to go/.test(x)),
    'a refusal that does not say when it changes sends the manager to HR');
});

test('SCENARIO 2 — six months and Band 5: eligible, subject to the award’s own criteria', () => {
  const e = emp({ date_of_joining: '2026-04-01', total_experience_years: 4 });
  assert.equal(elig.check(e, award('wow_machine'), ctx).eligible, true, 'WOW Machine wants 2+ years');
  assert.equal(elig.check(e, award('buddy_star'), ctx).eligible, true, 'Buddy Star wants 3+');
  // ...and NOT eligible for the one whose window they are outside.
  const rising = elig.check(e, award('rising_star'), ctx);
  assert.equal(rising.eligible, false, 'Rising Star is 1 to under 3 years; this person has 4');
  assert.ok(rising.reasons.some((x) => /above the window/.test(x)));
});

test('SCENARIO 3 — Band 4: the mid-level categories, and not the junior ones', () => {
  const e = emp({ date_of_joining: '2020-01-01', role_band: 'Band 4' });
  for (const k of ['mountain_mover', 'torchbearer', 'future_leader']) {
    assert.equal(elig.check(e, award(k), ctx).eligible, true, `${k} should be open to Band 4`);
  }
  const r = elig.check(e, award('rising_star'), ctx);
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => /junior-level award, and this employee is mid-level/.test(x)));
});

test('SCENARIO 4 — Band 2: senior, and out of the quarterly cycle unless HR says otherwise', () => {
  const e = emp({ date_of_joining: '2015-01-01', role_band: 'Band 2' });
  assert.equal(elig.levelOf('Band 2', bandLevels), 'senior');
  const r = elig.check(e, award('mountain_mover'), ctx);
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => /recognised through the annual and special awards/.test(x)));
  // HR can change exactly that, which is the point of it being a setting.
  const opened = elig.check(e, award('mountain_mover'),
    { ...ctx, settings: { ...settings, senior_in_quarterly: true } });
  assert.ok(opened.reasons.every((x) => !/annual and special awards/.test(x)));
});

test('SCENARIO 5 — five years of service: identified automatically, with no nomination', () => {
  const five = emp({ date_of_joining: '2021-09-01', role_band: 'Band 5' });
  const four = emp({ date_of_joining: '2023-01-01' });
  const awards = ['loyalty_5', 'loyalty_10', 'loyalty_15'].map(award);
  const due = elig.loyaltyDue([five, four], awards, ctx);
  assert.equal(due.length, 1, 'exactly one person, for exactly one milestone');
  assert.equal(due[0].award.key, 'loyalty_5');
  assert.equal(due[0].employee.date_of_joining, '2021-09-01');
});

test('and a ten-year employee gets the ten-year award, not the five-year one too', () => {
  // The windows are half-open, so the milestones do not stack: somebody
  // at 11 years is a 10-year award, not a 5 AND a 10.
  const ten = emp({ date_of_joining: '2015-06-01' });
  const due = elig.loyaltyDue([ten], ['loyalty_5', 'loyalty_10', 'loyalty_15'].map(award), ctx);
  assert.deepEqual(due.map((d) => d.award.key), ['loyalty_10']);
});

test('SCENARIO 6 — 1,000 active employees at 3%: thirty awards', () => {
  assert.equal(quota.capacity(1000, 3), 30);
  const st = quota.standing({ activeCount: 1000, pct: 3, rounding: 'down', approved: 24 });
  assert.deepEqual(
    { maximum: st.maximum, approved: st.approved, balance: st.balance },
    { maximum: 30, approved: 24, balance: 6 },
    'the figures the brief asks to be shown on screen');
});

test('the rounding rule is HR’s, and down is the default', () => {
  // 1,427 × 3% = 42.81 — the three rules give three different caps, and
  // rounding a ceiling up is how a 3% policy becomes 3.1%.
  assert.equal(quota.capacity(1427, 3, 'down'), 42);
  assert.equal(quota.capacity(1427, 3, 'up'), 43);
  assert.equal(quota.capacity(1427, 3, 'nearest'), 43);
  assert.equal(quota.capacity(1427, 3), 42, 'the default has to be the safe one');
});

test('SCENARIO 7 — thirty approved of thirty: blocked until HR overrides', () => {
  const st = quota.standing({ activeCount: 1000, pct: 3, rounding: 'down', approved: 30 });
  const no = quota.mayApprove({ standing: st, level: 'junior' });
  assert.equal(no.ok, false);
  assert.match(no.error, /quota exhausted for this cycle/i);
  assert.match(no.error, /requires an HR override/i);

  const withReason = quota.mayApprove({ standing: st, level: 'junior',
    override: { reason: 'Board-approved additional award for the payments migration' } });
  assert.equal(withReason.ok, true);
  assert.equal(withReason.via, 'override');
  // An override with no reason is not an override.
  assert.equal(quota.mayApprove({ standing: st, level: 'junior', override: { reason: '  ' } }).ok, false);
});

test('SCENARIO 8 — nominating somebody ineligible is refused, with the reason named', () => {
  const r = elig.check(emp({ date_of_joining: '2026-08-01' }), award('rising_star'), ctx);
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.length, 'a refusal with no reason is the manual process with extra steps');
  assert.ok(r.reasons.every((x) => x.length > 20), 'each reason is a sentence, not a code');
});

test('THE 3-YEAR BOUNDARY IS NOT AMBIGUOUS — exactly 3.0 years is Buddy Star, never Rising Star', () => {
  // The client raised this themselves: Rising Star is 1–3 and Buddy Star
  // is 3+, which as two closed intervals means whoever nominates first
  // decides which award somebody gets. The windows are half-open — [1,3)
  // and [3,∞) — so the answer does not depend on who is quicker.
  const e = emp({ date_of_joining: '2020-01-01', total_experience_years: 3 });
  assert.equal(elig.check(e, award('rising_star'), ctx).eligible, false);
  assert.equal(elig.check(e, award('buddy_star'), ctx).eligible, true);
  // And just under three is the other way round.
  const just = emp({ date_of_joining: '2020-01-01', total_experience_years: 2.99 });
  assert.equal(elig.check(just, award('rising_star'), ctx).eligible, true);
  assert.equal(elig.check(just, award('buddy_star'), ctx).eligible, false);
});

test('a resigned employee is nominated by nobody, whatever their service', () => {
  const r = elig.check(emp({ date_of_joining: '2015-01-01', status: 'Resigned' }), award('buddy_star'), ctx);
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => /not marked as active/.test(x)));
});

test('MISSING DATA IS A REASON, not a silent exclusion', () => {
  // This is the live state of the master: 4,583 of 4,622 people have no
  // band and nobody has total experience. The engine has to say so, or
  // "0 eligible employees" reads as a broken screen.
  const noBand = elig.check(emp({ date_of_joining: '2020-01-01', role_band: null }), award('rising_star'), ctx);
  assert.ok(noBand.reasons.some((x) => /No band on record/.test(x)));
  assert.ok(noBand.reasons.some((x) => /HRMS import/.test(x)), 'and says where it comes from');

  const noExp = elig.check(emp({ date_of_joining: '2020-01-01', total_experience_years: null }), award('rising_star'), ctx);
  assert.ok(noExp.reasons.some((x) => /No total professional experience on record/.test(x)));
});

test('an unmapped band maps to no level, and says which band', () => {
  const r = elig.check(emp({ date_of_joining: '2020-01-01', role_band: 'E2' }), award('rising_star'), ctx);
  assert.ok(r.reasons.some((x) => /Band "E2" is not in the band master/.test(x)),
    'the live master uses E2, which the seeded mapping does not know');
});

// ---- the workflow --------------------------------------------------------

test('THE FOUR STAGES RUN IN ORDER, and only in order', () => {
  let s = 'draft';
  for (const next of ['pending_delivery_head', 'pending_hrbp', 'pending_hr', 'final_approved']) {
    const t = wf.transition(s, s === 'draft' ? 'submit' : 'approve');
    assert.equal(t.ok, true, `${s} -> ${next}: ${t.error}`);
    assert.equal(t.next, next);
    s = t.next;
  }
  assert.equal(wf.transition('final_approved', 'approve').ok, false, 'it cannot be approved a fifth time');
});

test('A REJECTION OR A SEND-BACK WITHOUT A REASON IS REFUSED', () => {
  for (const action of ['reject', 'send_back']) {
    assert.equal(wf.transition('pending_hrbp', action).ok, false);
    assert.match(wf.transition('pending_hrbp', action).error, /reason/i);
    assert.equal(wf.transition('pending_hrbp', action, { reason: 'Impact is not quantified' }).ok, true);
  }
});

test('a sent-back nomination can be resubmitted; a rejected one cannot', () => {
  assert.equal(wf.transition('sent_back', 'submit').ok, true);
  assert.equal(wf.transition('rejected', 'submit').ok, false);
});

test('A LOYALTY MILESTONE DOES NOT CONSUME AN AWARD SLOT', async () => {
  // Decided after the first build: 3% stays per quarter, and loyalty
  // comes out of the pool. A 10-year award is a fact about a date, not
  // something won against competition — and the fifty-first person to
  // reach ten years in a cycle of forty-two would otherwise be refused
  // recognition for having worked here, with "quota exhausted" as the
  // only explanation.
  const rows = (await db.query(
    `SELECT key, counts_towards_quota FROM rnr.awards WHERE key LIKE 'loyalty%' OR key='rising_star'`)).rows;
  assert.ok(rows.length, 'the award master has to be seeded for this to mean anything');
  for (const r of rows) {
    assert.equal(r.counts_towards_quota, !r.key.startsWith('loyalty'),
      `${r.key}: loyalty sits outside the cap, everything else inside it`);
  }
});

test('3% IS PER CYCLE, so four quarterly cycles allow four times it', () => {
  // Confirmed as the intent rather than inferred: each cycle freezes its
  // own cap when it opens, so a year of quarterly cycles permits 12% of
  // the company. Written down because it is the kind of number that
  // surprises somebody in month nine.
  const perQuarter = quota.capacity(1427, 3, 'down');
  assert.equal(perQuarter, 42);
  assert.equal(perQuarter * 4, 168, 'four quarters at 3% each');
});

test('A CYCLE CAN BE HALF-YEARLY, and an award can belong to one', async () => {
  // The brief asked for quarterly, half-yearly and annual; the first
  // build shipped two of three. BOTH constraints move together: a
  // half-yearly cycle whose awards are all quarterly would open happily
  // and then show a manager an empty award picker, which reads as a bug
  // in the eligibility engine rather than a gap in the master.
  const { KINDS } = require('../migrations/080-half-yearly-cycles');
  assert.deepEqual(KINDS, ['quarterly', 'half_yearly', 'annual']);
  const t = (await db.query(`SELECT id FROM core.tenants LIMIT 1`)).rows[0].id;
  const c = (await db.query(
    `INSERT INTO rnr.cycles (tenant_id,name,kind,nominations_open,nominations_close)
     VALUES ($1,$2,'half_yearly','2026-10-01','2026-10-20') RETURNING id, kind`,
    [t, `half-yearly probe ${Date.now()}`])).rows[0];
  assert.equal(c.kind, 'half_yearly');
  const a = (await db.query(
    `INSERT INTO rnr.awards (tenant_id,key,name,level,frequency)
     VALUES ($1,$2,'Probe','mid','half_yearly') RETURNING frequency`,
    [t, `probe_${Date.now()}`])).rows[0];
  assert.equal(a.frequency, 'half_yearly', 'an award has to be able to belong to the new cycle kind');
  await db.query(`DELETE FROM rnr.cycles WHERE id=$1`, [c.id]);
  await db.query(`DELETE FROM rnr.awards WHERE tenant_id=$1 AND name='Probe'`, [t]);
});

test('the allocation cannot exceed the one pool it is split from', () => {
  // The whole reason for a single consolidated quota: the parts must not
  // silently add up to more than the whole.
  const bad = quota.validateAllocation({ junior: 20, mid: 15 }, 30);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /allocates 35 awards out of a cycle quota of 30/);
  assert.match(bad.error, /Reduce one of the levels by 5/);
  const ok = quota.validateAllocation({ junior: 18, mid: 10 }, 30);
  assert.equal(ok.ok, true);
  assert.equal(ok.unallocated, 2, 'under-allocating is a decision, not an error');
});

// node --test — the HRBP remit, and the one way it must never fail.
//
// A scoping rule that fails OPEN hands an HR business partner the whole
// organisation's ratings while looking exactly like a working screen.
// Most of this file is about that single property.
//
// The other thing pinned here is that `matches` and `remitSql` agree.
// They express the same rule twice — once in JavaScript for a row in
// hand, once as SQL for a query — and a rule enforced one way in code and
// another way in a query is a rule that will drift. Every case below is
// run through both.
const { test } = require('node:test');
const assert = require('node:assert');
const { matches, remitSql, norm } = require('../modules/people/hrbp-scope');

// The SQL half, evaluated in JavaScript: the same predicate `remitSql`
// builds, applied to a row, so the two can be compared on identical
// input without a database.
function sqlWouldMatch(remit, employee) {
  const { where, params } = remitSql(remit, 2);
  if (where === ' AND false') return false;
  // params are the lowercased arrays, in the order the clause names them.
  let p = 0;
  const locs = /e\.location/.test(where) ? params[p++] : null;
  const hods = /e\.hod_name/.test(where) ? params[p++] : null;
  const l = norm(employee.location);
  const h = norm(employee.hod_name);
  return !!((locs && l && locs.includes(l)) || (hods && h && hods.includes(h)));
}

const both = (remit, employee) => {
  const a = matches(remit, employee);
  const b = sqlWouldMatch(remit, employee);
  assert.equal(a, b, `matches() said ${a} and the SQL clause said ${b} for ${JSON.stringify(employee)}`);
  return a;
};

const EMPTY = { locations: [], hods: [] };

test('AN EMPTY REMIT MATCHES NOBODY — not everybody', () => {
  // The whole reason this module exists. Fail open here and an HRBP with
  // no assignment sees all 1,427 people.
  assert.equal(both(EMPTY, { location: 'Pune', hod_name: 'Rajesh Kulkarni' }), false);
  assert.equal(both(EMPTY, { location: null, hod_name: null }), false);
  assert.equal(both({}, { location: 'Pune' }), false);
  assert.equal(both({ locations: [], hods: [] }, { location: 'Pune' }), false);
});

test('an empty remit produces "AND false", not an empty WHERE', () => {
  // WRITTEN TWICE. The first version asserted only that matches() was
  // false, which passed while remitSql returned '' — and an empty string
  // ANDed into a query removes the filter entirely, turning the scoped
  // page into the unscoped one. The JavaScript was right and the SQL was
  // the dangerous half.
  const { where, params } = remitSql(EMPTY, 2);
  assert.equal(where, ' AND false');
  assert.deepEqual(params, []);
});

test('a location remit matches on location, and nothing else', () => {
  const r = { locations: ['Pune'], hods: [] };
  assert.equal(both(r, { location: 'Pune', hod_name: 'Anyone' }), true);
  assert.equal(both(r, { location: 'Mumbai', hod_name: 'Anyone' }), false);
  assert.equal(both(r, { location: null, hod_name: 'Anyone' }), false);
});

test('a HOD remit matches on HOD, and nothing else', () => {
  const r = { locations: [], hods: ['Rajesh Kulkarni'] };
  assert.equal(both(r, { location: 'Anywhere', hod_name: 'Rajesh Kulkarni' }), true);
  assert.equal(both(r, { location: 'Anywhere', hod_name: 'Someone Else' }), false);
  assert.equal(both(r, { location: 'Anywhere', hod_name: null }), false);
});

test('THE TWO ARE A UNION, NOT AN INTERSECTION', () => {
  // On the live master 26 of 34 departments have no head set. An
  // intersection would resolve to nobody for most HRBPs and read as a
  // broken screen rather than as a configuration choice.
  const r = { locations: ['Pune'], hods: ['Rajesh Kulkarni'] };
  assert.equal(both(r, { location: 'Pune', hod_name: 'Someone Else' }), true, 'location alone is enough');
  assert.equal(both(r, { location: 'Mumbai', hod_name: 'Rajesh Kulkarni' }), true, 'HOD alone is enough');
  assert.equal(both(r, { location: 'Pune', hod_name: 'Rajesh Kulkarni' }), true);
  assert.equal(both(r, { location: 'Mumbai', hod_name: 'Someone Else' }), false);
});

test('somebody with no location and no HOD is in NOBODY’s remit', () => {
  // The honest answer while the master has not been re-imported. The
  // tempting alternative — treat a blank as "everyone's" — would put
  // every unimported person into the first HRBP's screens.
  const r = { locations: ['Pune'], hods: ['Rajesh Kulkarni'] };
  assert.equal(both(r, { location: null, hod_name: null }), false);
  assert.equal(both(r, { location: '', hod_name: '  ' }), false);
});

test('matching folds case and surrounding space, because the HRMS does not', () => {
  const r = { locations: ['Pune'], hods: ['Rajesh Kulkarni'] };
  assert.equal(both(r, { location: 'pune' }), true);
  assert.equal(both(r, { location: '  PUNE  ' }), true);
  assert.equal(both(r, { hod_name: 'rajesh kulkarni' }), true);
  // But it is not fuzzy: a different site is a different site.
  assert.equal(both(r, { location: 'Pune - Kharadi' }), false,
    'two spellings the client may run as separate sites must not be merged');
});

test('a blank assignment cannot widen a remit', () => {
  // A row of whitespace in core.hrbp_scope is blocked by a CHECK, but
  // the resolver must not depend on that: a blank entry that reached
  // the list would otherwise match every employee whose field is blank.
  const r = { locations: ['', '   '], hods: [] };
  assert.equal(both(r, { location: '' }), false);
  assert.equal(both(r, { location: 'Pune' }), false);
  assert.equal(remitSql(r, 2).where, ' AND false', 'and it collapses to no access, not to no filter');
});

test('the SQL clause parameterises its values and names the right columns', () => {
  const { where, params } = remitSql({ locations: ['Pune', 'Mumbai'], hods: ['Rajesh Kulkarni'] }, 5);
  assert.match(where, /^ AND \(/);
  assert.match(where, /lower\(btrim\(e\.location\)\) = ANY\(\$5::text\[\]\)/);
  assert.match(where, /lower\(btrim\(e\.hod_name\)\) = ANY\(\$6::text\[\]\)/);
  assert.match(where, / OR /, 'union');
  assert.deepEqual(params, [['pune', 'mumbai'], ['rajesh kulkarni']]);
  // No value is ever interpolated into the string.
  assert.ok(!/Pune/i.test(where), 'values belong in params, not in the SQL');
});

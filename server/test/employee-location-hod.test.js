// node --test — location and HOD are KEPT, per employee.
//
// Both were in the HRMS export and both were being discarded: `location`
// and its spellings sat in IGNORED_COLUMNS, and `hod_name` was parsed only
// to vote for a department head and then dropped. The HRBP tab filters on
// exactly those two, so these tests pin that they survive the parse — and
// pin the places the importer deliberately stays strict.
//
// Pure: no database, no HTTP.
const { test } = require('node:test');
const assert = require('node:assert');
const { validateEmployeeCsv, TEMPLATE_COLUMNS } = require('../core/employees');

const H = 'Employee Code,Full Name,Office Email,Department,Designation,Reporting Manager,HOD,Location,Date of Joining';
const csv = (...lines) => validateEmployeeCsv([H, ...lines].join('\n'));
const row = (r, i = 0) => r.rows[i];

test('LOCATION IS KEPT ON THE ROW, not discarded as an unused column', () => {
  const r = csv('MGS1,Priya Menon,priya@x.com,Delivery,Manager,,Rajesh Kulkarni,Pune,01/04/2020');
  assert.equal(r.fatal, null);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // WRITTEN TWICE. The first version of this asserted only that the parse
  // succeeded, which passed just as happily while location was still being
  // thrown away — the row came back without the field and nothing noticed.
  assert.equal(row(r).location, 'Pune');
});

test('HOD IS KEPT ON THE ROW, not just used for the department-head vote', () => {
  const r = csv('MGS1,Priya Menon,priya@x.com,Delivery,Manager,,Rajesh Kulkarni,Pune,01/04/2020');
  assert.equal(row(r).hod_name, 'Rajesh Kulkarni');
});

test('the HRMS spellings of location all land on the same field', () => {
  for (const header of ['Branch', 'Site Location', 'Work Location', 'Base Location', 'Branch Name']) {
    const h = `Full Name,Office Email,${header}`;
    const r = validateEmployeeCsv([h, 'Priya Menon,priya@x.com,Mumbai'].join('\n'));
    assert.equal(r.fatal, null, `${header}: ${r.fatal}`);
    assert.equal(row(r).location, 'Mumbai', `${header} should be read as Location`);
  }
});

test('a branch CODE is still ignored — a code and a name in one column match neither', () => {
  const r = validateEmployeeCsv(['Full Name,Office Email,Branch Code', 'Priya Menon,priya@x.com,BR-114'].join('\n'));
  assert.equal(r.fatal, null);
  assert.equal(row(r).location, null, 'BR-114 is not a location anybody would filter on');
  assert.equal(r.warnings.filter((w) => /unknown column/i.test(w.warning)).length, 0,
    'and it stays silent rather than nagging about a column nobody needs to act on');
});

test('a blank location stays blank — it is never guessed from the department', () => {
  const r = csv('MGS1,Priya Menon,priya@x.com,Delivery,Manager,,Rajesh Kulkarni,,01/04/2020');
  assert.equal(row(r).location, null);
});

test('location is trimmed but NOT normalised — two spellings stay two locations', () => {
  const r = csv(
    'MGS1,A One,a@x.com,Delivery,Manager,,H,  Pune  ,01/04/2020',
    'MGS2,B Two,b@x.com,Delivery,Manager,,H,pune,01/04/2020',
  );
  assert.equal(row(r, 0).location, 'Pune', 'surrounding whitespace is not data');
  assert.equal(row(r, 1).location, 'pune',
    'case is left alone: silently folding it would merge sites the client may run separately');
});

test('the downloadable template offers Location, so HR is asked for it', () => {
  const names = TEMPLATE_COLUMNS.map((c) => c[0]);
  assert.ok(names.includes('Location'), `template columns were ${names.join(', ')}`);
  assert.ok(names.includes('HOD'));
  // The note has to say why it matters, or it gets filled in inconsistently
  // and every HRBP remit quietly misses people.
  const note = TEMPLATE_COLUMNS.find((c) => c[0] === 'Location')[2];
  assert.match(note, /HRBP|consistent/i);
});

test('the department-head vote still works, and is still unanimous-or-nothing', () => {
  // Unchanged behaviour, pinned here because storing hod_name per row is
  // exactly the kind of change that could have been "simplified" into
  // replacing the vote.
  const agree = csv(
    'MGS1,A One,a@x.com,Delivery,Eng,,Rajesh Kulkarni,Pune,01/04/2020',
    'MGS2,B Two,b@x.com,Delivery,Eng,,Rajesh Kulkarni,Pune,01/04/2020',
    'MGS3,Rajesh Kulkarni,rk@x.com,Delivery,Head,,,Pune,01/04/2015',
  );
  assert.equal(agree.department_heads.length, 1, JSON.stringify(agree.warnings));
  assert.equal(agree.department_heads[0].department, 'Delivery');

  const disagree = csv(
    'MGS1,A One,a@x.com,Delivery,Eng,,Rajesh Kulkarni,Pune,01/04/2020',
    'MGS2,B Two,b@x.com,Delivery,Eng,,Someone Else,Pune,01/04/2020',
  );
  assert.equal(disagree.department_heads.length, 0,
    'two different HODs in one department must not elect either of them');
  assert.ok(disagree.warnings.some((w) => /different HODs/.test(w.warning)));
  // And the per-person answer survives the disagreement — which is the
  // whole reason to store it: the vote can fail and an HRBP remit still
  // resolves.
  assert.equal(row(disagree, 0).hod_name, 'Rajesh Kulkarni');
  assert.equal(row(disagree, 1).hod_name, 'Someone Else');
});

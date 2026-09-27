// Working out WHO gets a login and WHAT password, with no database and no
// express in sight — so the rules can be tested by stating the right
// answer rather than by watching a batch run.
//
// Asked for on 27 Sep: "please build create bulk credentials option for
// Admin/HR login so they can create bulk credentials for employees from
// front end."
//
// There is no self-service signup and no SSO in this product yet (see
// core/auth.js), so HR setting a password on somebody's behalf is the
// only way anyone gets a login at all. Doing that 1,427 times through the
// per-person Manage panel is the thing being replaced.
const crypto = require('crypto');

// AN ALPHABET SOMEBODY CAN READ OUT LOUD. These passwords are going to be
// pasted into a spreadsheet, mailed, and in some cases dictated over a
// desk — so no 0/O and no 1/l/I, which is where "it says my password is
// wrong" comes from. Four groups of four, hyphenated, for the same
// reason: it survives being read in chunks.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';   // no l, no o
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I, no O
const DIGIT = '23456789';                   // no 0, no 1
const POOL = LOWER + UPPER + DIGIT;

const pick = (s) => s[crypto.randomInt(s.length)];

// 16 characters from a 57-character pool is about 93 bits, and one
// character of each class is forced so the result cannot come out as
// sixteen lower-case letters. crypto.randomInt, never Math.random: these
// are real credentials, and Math.random is predictable from its own
// output.
function generatePassword() {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT)];
  while (chars.length < 16) chars.push(pick(POOL));
  // Fisher-Yates, so the forced characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const s = chars.join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
}

// WHY A ROW IS OR IS NOT GETTING A PASSWORD. Every row comes back with an
// answer — this file's whole reason for existing is that "1,401 done" is
// not a report. HR has to be able to see which twenty-six people were
// passed over and why, or they will assume the run half-failed.
//
// `replaceExisting` is off by default and has to be asked for: quietly
// resetting a working login is how somebody gets locked out of a session
// they were in the middle of, and the person doing the bulk run would
// never know.
const OUTCOMES = {
  create: 'A new login',
  reset: 'Password replaced',
  skip_self: 'This is you — your own password is not changed by a bulk run',
  skip_archived: 'Off the employee list, so they cannot sign in anyway',
  skip_inactive: 'Marked inactive — sign-in is refused for inactive employees',
  skip_has_login: 'Already has a login (tick "replace existing" to reset it)',
};

function decide(emp, { replaceExisting = false, actorId = null } = {}) {
  if (actorId && emp.id === actorId) return 'skip_self';
  if (emp.archived_at) return 'skip_archived';
  if (emp.status && emp.status !== 'active') return 'skip_inactive';
  if (emp.has_login) return replaceExisting ? 'reset' : 'skip_has_login';
  return 'create';
}

// The whole run, decided before anything is written. `employees` is the
// candidate set the caller has already scoped (a selection, or everybody).
//
// A placeholder address is NOT a reason to skip. Those people are real and
// a login works for them; what does not work is telling them the password
// by email, so the row is flagged instead and HR decides how to hand it
// over. Skipping them silently would leave HR wondering why their count
// was short.
function plan(employees, opts = {}) {
  const rows = (employees || []).map((e) => {
    const outcome = decide(e, opts);
    return {
      id: e.id, emp_code: e.emp_code || '', name: e.name, email: e.email,
      department: e.department || '', outcome, reason: OUTCOMES[outcome],
      placeholder_email: !!e.email_is_placeholder,
    };
  });
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
  return {
    rows,
    counts,
    will_write: rows.filter((r) => r.outcome === 'create' || r.outcome === 'reset').length,
    no_email_on_record: rows.filter((r) => r.placeholder_email
      && (r.outcome === 'create' || r.outcome === 'reset')).length,
  };
}

module.exports = { generatePassword, decide, plan, OUTCOMES };

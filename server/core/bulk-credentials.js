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

// THE PATTERN PASSWORD. Asked for on 27 Sep: "the password for all
// employees will be their name@123", and confirmed as the first name
// exactly as asked when the alternatives were put to the client.
//
// "Akshay Raut" becomes akshay@123. Lower-cased and stripped of
// punctuation, because a password nobody can type from the rule is not a
// rule — "M. Harikrishnan" must not become `M.@123`.
//
// TWO FALLBACKS, in order, and neither is a silent correction: the
// preview reports every password this produces, so HR can see the odd
// ones before they go out.
//   - a first token with no letters at all ("R.", "&") would leave
//     `@123`, which is not a password. The whole name, compacted, is
//     used instead.
//   - a name with no letters anywhere falls back to the address, which
//     every employee has (a placeholder one if nothing else).
//
// It is deliberately NOT made unique or lengthened. 23 people on this
// master share the first name Akshay and will share akshay@123; 20 have
// a first name of three letters or fewer. That is what was asked for,
// and it is safe only because must_change_password is set with it — the
// password survives exactly one sign-in.
const letters = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

function derivedPassword(emp, suffix = '@123') {
  const name = String(emp && emp.name || '').trim();
  const first = letters(name.split(/\s+/)[0] || '');
  if (first) return first.toLowerCase() + suffix;
  const whole = letters(name);
  if (whole) return whole.toLowerCase() + suffix;
  const local = String(emp && emp.email || '').split('@')[0];
  return (letters(local) || 'employee').toLowerCase() + suffix;
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
      // What the pattern would produce for this person. Shown in the
      // preview, because "akshay@123" is the thing HR is about to hand
      // out and the only way to notice a name the rule reads badly is to
      // see it. Only for the mode that uses it — the others have nothing
      // to show until the run has happened.
      ...(opts.mode === 'name' ? { would_be: derivedPassword(e) } : {}),
    };
  });
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
  return {
    rows,
    counts,
    will_write: rows.filter((r) => r.outcome === 'create' || r.outcome === 'reset').length,
    // Counted and surfaced rather than quietly padded. On this master it
    // is the twenty people whose first name is an initial or three
    // letters; HR should know before, not find out from a support call.
    short_passwords: rows.filter((r) => r.would_be && r.would_be.length < 8
      && (r.outcome === 'create' || r.outcome === 'reset')).length,
    no_email_on_record: rows.filter((r) => r.placeholder_email
      && (r.outcome === 'create' || r.outcome === 'reset')).length,
  };
}

module.exports = { generatePassword, derivedPassword, decide, plan, OUTCOMES };

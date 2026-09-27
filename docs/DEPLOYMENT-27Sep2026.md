# Deployment note — 27 September 2026

Three changes, already live on the Mindgate PoC. This note is for anyone
applying the same release to another environment, or reviewing what went
out.

| | |
|---|---|
| Branch | `claude/push-code-github-2rhnnq`, merged to `main` |
| Commit range | `d031d4e..12610a1` |
| Head after deploy | `12610a1` |
| New migration | **059** `must-change-password` (58 → 59) |
| Tests at release | server **926/926**, frontend **61/61** |
| Deployed to PoC | 27 Sep 2026, `sudo /opt/agentic-pms/deploy/service/update.sh` |

---

## 1. My Rating is closed until a rating is published — `4bbb0ee`

**Asked for:** *"my rating option should be visible to employee only when
appraisal is published or it can be unclickable until appraisal is
published."*

Unclickable, not hidden — the rule this product already follows for
anything a phase has not opened yet. A tab that vanishes makes people ask
whether they have lost access; a greyed one that says when it opens
answers the question before it is asked.

Three surfaces close together, all reading one figure:

- the **My Rating** tab in the Self menu (greyed, padlocked, tooltip)
- the **My rating** stat card on Home
- the **My Rating** tile in *My performance*

**The figure is the count of published ratings across every cycle**, not
the current one. My Rating is a history, so gating on this year would
take last year's rating away from somebody the moment HR opened a new
cycle. It is also read before the no-cycle branch, so a company sitting
between cycles is not locked out of its own history.

Typing `/my/rating` still reaches the page and its "No published ratings
yet" note — this is a *nothing here yet*, not a permission.
`core.page_permission` still leaves the page open to everyone, because it
is the employee's own data.

New endpoint: `GET /api/v1/pms/my/rating/status` → `{count, has_published}`.

---

## 2. Bulk login creation — `0147f87`

**Asked for:** *"please build create bulk credentials option for Admin/HR
login so they can create bulk credentials for employees from front end."*

A **Create logins in bulk** panel on HR → Employees. Scope is the ticked
rows, or everyone on the list.

**Two steps.** Preview writes nothing and returns the plan; the commit
then names its people explicitly, so what was previewed is what is
written even if the list changes in between.

**Nobody is passed over in silence.** Every row comes back with a
sentence: already has a login · off the list · marked inactive (sign-in
is refused anyway) · *this is you* — a bulk run never changes the
password of the person running it. An existing login is untouched unless
**replace existing** is ticked.

**Someone with no email on record is flagged, not skipped.** They are a
real employee and a login works; what does not work is mailing them the
password.

**Capped at 200 per request, sent in batches of 100.** bcryptjs measures
at ~90 ms a hash on the PoC box, so 1,427 in one call would hold a
connection for over two minutes.

Passwords are returned once and then unreadable (bcrypt), so they are
absent from the audit row and the log, and the page offers the `.csv`.
Audited as `EMPLOYEE_CREDENTIALS_BULK` with counts and addresses only.

New endpoint: `POST /api/v1/employees/credentials/bulk`.

---

## 3. `name@123`, spent at first sign-in — `12610a1`

**Asked for:** *"the password for all employees will be their name@123
and during login everyone should get change password option during first
login."* First name exactly as asked, and compulsory — both confirmed by
Mindgate when the alternatives were put to them.

### The rule

`Akshay Raut` → `akshay@123`. Lower-cased, punctuation stripped, because
a password nobody can type from the rule is not a rule and
`M. Harikrishnan` must not become `M.@123`. Two fallbacks so it can never
produce a bare `@123`: a first token with no letters uses the whole name;
a name with no letters uses the address.

It is deliberately **not** made unique or lengthened. Against the real
master, 23 people share `akshay@123` and **20 get a password under eight
characters** (`e@123`, `al@123`, `jay@123` — the initials cases). The
preview names every one of them and counts the short ones before
anything is written.

### Why that is safe

Every password survives **exactly one sign-in**. Migration 059 adds
`core.local_credentials.must_change_password`; every place HR sets a
password on somebody else's behalf — the bulk run *and* the per-person
Manage panel — sets it.

**The lock is in the API, not in a screen.** A change-password page is a
suggestion anyone with `curl` can decline. `authenticate()` refuses every
route except two while a change is owed:

- `GET /api/v1/me` — so the page can learn that it is locked
- `POST /api/v1/auth/password` — the change itself

The flag rides in the JWT (`pwc`), so the check costs no query, and the
change hands back a fresh token — the old one still carries the lock and
would keep somebody out of the app they just unlocked.

### Not backfilled

Migration 059 defaults to `false`. Existing credentials — including the
PoC admin — are untouched. Flipping them all would have locked the client
out at the moment of the deploy. **Verified after deploy: 0 of 1 existing
credential locked.**

### Also added

A **Password** button in the header, so a password can be changed more
than once. Not asked for, and flagged as such: a product where that is
possible only at first sign-in has no way to change a password. Icon-only
below the `sm` breakpoint, because with the word beside it the header
pushed the page sideways at 390 px.

---

## Files in this release

### Frontend (`.jsx`)

| File | Change |
|---|---|
| `frontend/src/App.jsx` | `ChangePassword` screen (forced + voluntary), the `pwc` gate before the router, the header **Password** button, and the `gate`/`gateHint` nav mechanism used by My Rating |
| `frontend/src/pages/DirectoryPage.jsx` | The `BulkCredentials` panel — scope, three password modes, preview, batched commit, `.csv` download |
| `frontend/src/pages/HomePage.jsx` | `hasRating` gating of the My rating stat card and tile |

### Server — **required**; the JSX alone will not work

| File | Change |
|---|---|
| `server/migrations/059-must-change-password.js` | **new** — the column. Runs at boot; boot fails loudly if it cannot |
| `server/core/bulk-credentials.js` | **new** — pure: the `name@123` rule, the generated-password rule, and who is or is not getting one |
| `server/core/auth.js` | `pwc` in the token, the first-login lock, `POST /auth/password` |
| `server/core/employees.js` | `POST /employees/credentials/bulk`; the per-person route now marks its password one-use |
| `server/index.js` | mounts `/api/v1/auth/password` |
| `server/modules/performance/home.js` | `publishedRatingCount()`, `me.published_count` |
| `server/modules/performance/index.js` | `GET /pms/my/rating/status` |

### Tests

`server/test/bulk-credentials.test.js` (18) ·
`server/test/first-login-password.test.js` (8) ·
`server/test/my-rating-gate.test.js` (5) ·
`frontend/test/bulk-credentials.test.mjs` (4) ·
`frontend/test/first-login-password.test.mjs` (4) ·
`frontend/test/my-rating-gate.test.mjs` (4)

Three existing tests were also corrected — see *Known interactions*.

---

## Deploying it

The PoC pulls from the repo, so the whole release is:

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

That pulls, builds the frontend, runs migrations and restarts
`agentic-pms-api`. **Migration 059 runs automatically.** Boot fails loudly
on a migration error by design — a refusing boot is a working safety, not
an outage to patch around.

No new environment variables. No new dependencies.

### Verifying it landed

Behaviour, not a version string:

```bash
# head and migration count
cd /opt/agentic-pms && git log --oneline -1
sudo -u postgres psql -d apms -At -c "SELECT count(*) FROM core.migrations_log"   # 59

# the admin is NOT locked out
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"<admin>","password":"<pw>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["must_change_password"])'   # False

# the rule, read-only — writes nothing
curl -s -X POST http://127.0.0.1:8080/api/v1/employees/credentials/bulk \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"dry_run":true,"mode":"name"}'
```

### Rolling back

```bash
cd /opt/agentic-pms && git checkout d031d4e && sudo deploy/service/update.sh
```

Migration 059 is additive and the column is harmless to an older build,
so it does not need reversing. If it must be:

```sql
ALTER TABLE core.local_credentials DROP COLUMN must_change_password;
```

Any password already issued stays valid — only the forced change goes.

---

## What HR does next

1. **Nothing has been issued yet.** The 1,426 logins on the PoC are a
   preview only.
2. Employees → **Create logins in bulk** → Preview → read the counts →
   Create. Batches of 100 with a progress count.
3. **Download the `.csv` before leaving the page.** Passwords are stored
   hashed; that file is the only readable copy.
4. Tell people the rule: *your password is your first name in lower case
   followed by `@123`, and you choose your own when you sign in.*
5. The 20 people whose first name is an initial get a short password —
   the preview lists them by name. Hand those over directly.

---

## Known interactions

- **Every password HR sets from now on is one-use**, including the
  per-person Manage panel. A test login created after this deploy lands
  on the change screen at first sign-in.
- **`GET /employees` for a non-HR user** now answers with the first-login
  lock before the permission check, if that user still owes a password
  change. The existing regression test was updated to walk the change
  first, so it still tests the permission it was written for.
- **The header grew a button.** It is icon-only below `sm`; with the word
  it pushed the page past 390 px and a phone scrolled sideways.
- **`audit()` in the performance module is not awaited** — pre-existing,
  not introduced here. The handler replies before the audit row lands,
  which surfaced as a flaky test (now polled). It means "every rating
  change is audited" is best-effort. Worth a decision before ratings
  carry money.

---

## Still outstanding on the PoC

Not part of this release, listed so the deployment is not mistaken for
completeness:

- **SMTP is not configured** — no email of any kind. The `.csv` is the
  only delivery channel for these passwords.
- **42,165 unread in-app notifications**, 33,619 of them `phase_change`
  fired at all 1,427 people. Once SMTP is wired that becomes email.
- 26 of 34 departments have no head; 18 employees have no manager.
- 0 prior-year ratings, 0 CTC rows, 0 increment-matrix bands — Super 50,
  the 9-box and Increment Simulation have no inputs.
- The nine employee department corrections
  (`docs/employee-department-corrections-25Sep2026.xlsx`) are unapplied.
- The Anthropic API key on the box still wants rotating.

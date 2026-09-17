# HR Admin — Career Pathing Matrix: bulk upload

**Screen:** Career Pathing Matrix (`/admin/career-transitions`) — sidebar, under HR ADMIN
**Who sees it:** `admin` and `hr` roles; every endpoint additionally requires
the `people_admin` permission
**Shipped as:** commit `a2725d2` on `main` · live on pms.agentichumans.in since
17 Sep

Asked for directly: *"can we have template upload option so HR can upload
template for next defined roles."*

The matrix was built one transition at a time through the **New transition**
modal. For a company with 90 job titles on file that is an afternoon of
clicking, and it gives nobody a way to review the whole ladder before
committing it.

---

## 1. What HR sees

The card sits directly above the search box, and uses **the same three
controls, in the same order, as the KRA Library screen** — Download template ·
Validate · Publish. That is deliberate: HR has learnt that shape once, and a
second importer that behaved differently would be a second thing to learn.

![The upload card on the Career Pathing Matrix](images/career-matrix-01-upload-card.png)

**Validate on a file with a bad row.** Every problem is named by its
spreadsheet line, all at once — not one per attempt.

![A rejected file](images/career-matrix-02-validate-rejected.png)

**The same file with the bad row removed.** `VALID — publish to go live`, and
the counts say what Publish will do before it does it.

![A valid file](images/career-matrix-03-validate-ok.png)

**After Publish.** The transitions appear on the matrix below, competencies as
chips.

![Published](images/career-matrix-04-published.png)

> Every shot is the deployed build driven in a browser against a copy of the
> live database — download, fill, reject, fix, validate, publish. Nothing is a
> mock-up.

---

## 2. The file

| Column | Required | Notes |
|---|---|---|
| **From Role** | **yes** | should match a designation on the employee master |
| From Level | no | blank = "any level" |
| **To Role** | **yes** | |
| To Level | no | |
| Expected Level Change | no | whole number; `+1` next level, `+2` skip |
| Min Time In Current Role (Months) | no | advisory, **not enforced** |
| Typical Time In Current Role (Months) | no | advisory, used for ETA display |
| Required Competencies | no | one per line, or separated by `;` or `\|` |
| Notes | no | |

`.xlsx` and `.csv` both work. Every worksheet in a workbook is read, so a file
split by job family publishes in one go.

**Header matching is forgiving.** Case and punctuation are ignored, and common
alternatives are accepted — `Current Role`, `Target Role`, `From Band`, `Min
Months`, `Skills`, `Comments` and others all map correctly. HR re-saves these
files through Excel and Google Sheets, which rewrite spacing; a file rejected
wholesale for "Min Time in Role (months)" teaches nobody anything.

**The header row is found, not assumed.** The template carries an instruction
banner above the table, and so do most files HR sends.

**Competencies accept three separators** — newline, `;`, `|` — because a CSV
round-trip usually flattens newlines and HR should not have to know which of
the three their tool survived.

---

## 3. The rules — what is refused, and what is only warned about

### Refused (the row, and with it the whole file)

| Rule | Message |
|---|---|
| From Role or To Role missing | `From Role and To Role are both required` |
| A role moves to itself (same role **and** level) | `"Manager" moves to itself — a transition needs a different role or level` |
| The same transition twice in one file | `duplicate of line 3 — the same transition twice in one file` |
| A months / level field that is not a whole number | `Expected Level Change must be a whole number — got "soon"` |

> A level change **within** one role is a real transition and is allowed —
> `Executive L1 → Executive L2` is a promotion, not a self-reference.

### Warned about (published anyway)

| Rule | Why it is not an error |
|---|---|
| A role no active employee holds | The point of a career matrix is roles people grow **into**. Rejecting a target with no incumbent would make the feature useless on day one. Same judgement the KRA importer makes. |
| Typical time is less than the minimum | Probably a typo, but HR may know something the app does not. |

---

## 4. Three behaviours worth knowing before you demo it

1. **Validate writes nothing.** Ever. It is the same endpoint with `?commit=1`
   omitted. Proven against the live database at deploy time: a dry run ran, the
   transition count was 0 before and 0 after.

2. **A commit on a file with ANY error writes nothing either.** The good rows
   above a bad one do not sneak in. HR fixes the file and uploads again.

3. **RE-UPLOADING UPDATES, IT DOES NOT DUPLICATE.** Transitions are matched on
   `(from_role, from_level, to_role, to_level)`, case- and space-insensitively,
   so `executive` and `Executive  ` are the same rung. Without this a corrected
   file silently doubles the matrix, and the second copy is indistinguishable
   from the first on screen. The dry run reports `N new · M updated` so HR knows
   which it will be.

**Not covered by the upload:** there is no way to deactivate or delete a
transition from a file. The upload only adds and updates; removing one still
goes through that row's own **Deactivate** or bin button. Say if that should
change.

**No Department column here**, unlike the KRA Library template — transitions
are role-to-role, not department-scoped.

---

## 5. Where the code is

| Piece | File |
|---|---|
| Row rules (pure, no db, no express) | `server/modules/people/career-transitions-import.js` |
| Template `.xlsx` | `server/modules/people/index.js:453` |
| Template `.csv` | `:473` |
| Upload (validate + publish) | `:492` |
| Column list and header aliases | `career-transitions-import.js`, `COLUMNS` / `ALIASES` |
| The card on screen | `frontend/src/pages/CareerTransitionsPage.jsx:79–110` |
| `send(commit)` — the one call both buttons make | `CareerTransitionsPage.jsx:43` |
| Tests | `server/test/career-transitions-upload.test.js` (15) |

**Routes** (all `people_admin`):

| Method | Path | Does |
|---|---|---|
| GET | `/api/v1/people/career/transitions/template.xlsx` | download template |
| GET | `/api/v1/people/career/transitions/template.csv` | download template |
| POST | `/api/v1/people/career/transitions/upload` | validate (default) |
| POST | `/api/v1/people/career/transitions/upload?commit=1` | publish |

**Table:** `people.career_transitions` (migration `022-career-transitions.js`).
**No new migration** — this feature writes to the table the modal already used,
so there is no schema change in this deploy.

**Upload limit:** 2 MB. A career matrix is tens of rows, not tens of thousands;
a low limit turns "somebody uploaded the wrong file" into a clear error rather
than a slow request.

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Match transitions on `id` or on exact string equality | re-uploading then duplicates the matrix instead of updating it |
| Make an unknown role an error | the matrix exists to describe roles nobody holds yet |
| Let a commit write the rows that passed | a half-applied file HR has not seen the verdict on is what the two-step prevents |
| Move the template routes below `/career/transitions/:id` | Express matches in order; a `:id` route would swallow `template.xlsx` |

---

## 6. Deploying to a client PoC

```bash
# on the host
sudo /opt/agentic-pms/deploy/service/update.sh
```

Pulls `main`, installs, builds the frontend into `/var/www/agentic-pms`,
restarts `agentic-pms-api`, waits for health. Migrations run in-process at boot
and **fail the boot** if one throws, so a bad migration stops the deploy rather
than half-applying. This particular change adds none.

> `VITE_API_URL` must stay **unset** on the host — it is baked in at build time
> and the frontend is served from the same origin as the API.

### Verify

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'     # expect a2725d2 or later
systemctl is-active agentic-pms-api nginx           # active active
curl -fsS http://127.0.0.1/api/v1/health            # {"ok":true,…}

# the new routes must answer, and must be guarded
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1/api/v1/people/career/transitions/template.xlsx   # 401 without a token
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

To check as HR without a password, mint a short-lived token with the service's
own secret **on the host**:

```bash
cd /opt/agentic-pms/server
TOK=$(sudo env $(sudo grep -E '^(JWT_SECRET|DATABASE_URL|DATABASE_SSL)=' \
      /etc/agentic-pms/api.env | xargs) node -e "
const jwt=require('jsonwebtoken'), db=require('./core/db');
(async()=>{const e=(await db.query(\"SELECT id,email,name,tenant_id FROM core.employees WHERE lower(email)='hr.admin@mindgate.com' LIMIT 1\")).rows[0];
console.log(jwt.sign({sub:e.id,email:e.email,name:e.name,role:'admin',tenant_id:e.tenant_id},process.env.JWT_SECRET,{expiresIn:'5m'}));await db.pool.end();})()")

curl -s -H "Authorization: Bearer $TOK" \
  http://127.0.0.1/api/v1/people/career/transitions/template.csv | head -1
```

Expected header line:

```
From Role,From Level,To Role,To Level,Expected Level Change,Min Time In Current Role (Months),Typical Time In Current Role (Months),Required Competencies,Notes
```

**The one check worth running on real data** — that Validate writes nothing:

```bash
DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
BEFORE=$(sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM people.career_transitions")
printf 'From Role,To Role\nExecutive,Senior Executive\n' > /tmp/dry.csv
curl -s -H "Authorization: Bearer $TOK" -F "file=@/tmp/dry.csv" \
  http://127.0.0.1/api/v1/people/career/transitions/upload
AFTER=$(sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM people.career_transitions")
echo "before=$BEFORE after=$AFTER"        # must be equal
rm -f /tmp/dry.csv
```

The response should read `"ok": true, "committed": false`, and the two counts
must match. That is the guarantee worth proving against live data rather than
trusting.

---

## 7. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

483 pass, 0 fail. `server/test/career-transitions-upload.test.js` holds the 15
for this feature. Two carry the weight:

- **`THE APP'S OWN TEMPLATE IMPORTS`** — downloads the real `.xlsx` from the
  route and feeds it to the real parser, so the two cannot drift apart. The
  failure being guarded against is HR filling in the app's own official file
  and having every row rejected.
- **`RE-UPLOADING UPDATES, IT DOES NOT DUPLICATE`** — uploads twice and asserts
  the matrix did not grow.

> **Run against a fresh database every time.** Re-running against a used one
> produces four phantom failures in `self-appraisal-rating.test.js` from
> leftover rows. They are not real.

Re-shoot the screenshots after any change to this page, against a restored copy
of the live database — never against production.

---

## 8. State at the time of writing

| | |
|---|---|
| Transitions on the client PoC | **0** — the matrix is empty, so HR can seed the whole ladder from one file |
| Audit action for a bulk change | `CAREER_TRANSITIONS_UPLOADED`, with created / updated counts and the actor |

A career matrix decides which moves the product will accept, so changing it in
bulk is a configuration change and is audited as one.

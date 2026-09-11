# Adding the designation-wise KRA Library to a client instance

**Audience:** the developer or DevOps engineer deploying this to a Mindgate
environment (PoC, UAT or production).
**Time:** about 20 minutes, most of it waiting for a build.
**Risk:** low — one additive migration, no existing table altered, no data rewritten.

---

## 1. What this feature is

HR publishes a shelf of suggested KRAs **per job title**, once. Every employee
holding that title then picks from their own role's shelf when writing their
KRAs, instead of receiving a spreadsheet by email.

It sits alongside the KRA importer that already exists — it does not replace it.
**The difference matters and is the most common source of confusion:**

| | **KRA Overview** (existed already) | **KRA Library** (this feature) |
|---|---|---|
| Screen | HR Admin → KRA Overview | HR Admin → KRA Library |
| Keyed on | `employee_email` | `Designation` |
| Means | "these KRAs, on this named person's sheet, now" | "these KRAs are available to anyone with this job title" |
| Scales with | headcount (~1,400 rows) | roles (~265 rows) |
| Lifetime | one cycle | carries into the next cycle |
| Must total 100 | **yes** — it is somebody's scorecard | **no** — it is a menu; the employee picks 100 points' worth from it |
| Table | `pms.kras` (via `pms.kra_sheets`) | `pms.kra_library` |

Uploading a designation-keyed file on the employee-keyed screen is refused with
a message naming the correct screen, and vice versa. That check is in
`validateKraBulkRows`.

---

## 2. What ships

Everything is on `main` as of commit `1e57582`. Nothing needs writing.

### Database

One migration, `server/migrations/033-kra-library.js`. It creates one table and
one index and touches nothing else:

```sql
CREATE TABLE IF NOT EXISTS pms.kra_library (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  designation      text NOT NULL,
  category         text,              -- the sheet's "Parameters" column
  title            text NOT NULL,     -- the KRA
  measures         text,              -- the KPIs
  description      text,              -- Comments
  suggested_weight numeric(6,2),
  sort_order       integer NOT NULL DEFAULT 0,
  uploaded_by      text,
  uploaded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kra_library_designation_idx
  ON pms.kra_library (tenant_id, lower(btrim(designation)), sort_order);
```

Three design decisions worth knowing before you touch this table:

- **No `cycle_id`.** The library is reference data about *roles*, not about a
  year. Tying it to a cycle would mean re-uploading every shelf each time HR
  opens one, which is most of the work this removes.
- **No unique constraint, no `ON CONFLICT`.** A re-upload is a
  delete-then-insert *per designation* inside one transaction. That is the only
  way to express "this designation now has exactly these six KRAs, and the
  seventh is gone", and it is why re-uploading one role never disturbs another.
- **The index is on `lower(btrim(designation))`** because the designation on an
  employee record and the one typed into a spreadsheet differ by case and stray
  spaces. A shelf that silently fails to match is indistinguishable, to the
  employee, from a shelf that is empty.

Migrations run **inside the application at boot**, in order, recorded in
`core.migrations_log`. A migration that fails stops the boot rather than letting
the app run against a schema it does not have. You do not run anything by hand.

### API — `server/modules/performance/index.js`

| Method | Path (under `/api/v1/pms`) | Permission |
|---|---|---|
| GET | `/hr/kra-library/template.xlsx` | `pms_admin` |
| GET | `/hr/kra-library/template.csv` | `pms_admin` |
| GET | `/hr/kra-library` | `pms_admin` |
| GET | `/hr/kra-library/:designation` | `pms_admin` |
| DELETE | `/hr/kra-library/:designation` | `pms_admin` |
| POST | `/hr/kra-library/upload` (`?commit=1`) | `pms_admin` |
| GET | `/my/kra-library` | any authenticated user — returns **only their own** designation's shelf |
| GET | `/team/kra-library/:employeeId` | the employee's manager, or `pms_admin` — 403 otherwise |

`/team/kra-library/:employeeId` resolves the **report's** designation, never the
caller's. A manager filling a sheet on someone's behalf must see that person's
shelf; getting this backwards would be a quiet, plausible-looking bug.

### Frontend

| File | What it is |
|---|---|
| `frontend/src/pages/KraLibraryPage.jsx` | new — the HR admin screen (upload, published shelves, uncovered designations) |
| `frontend/src/pages/KraLibraryPicker.jsx` | new — the employee's pick list, reused by the HR/manager path |
| `frontend/src/App.jsx` | nav entry + route, gated to `admin` and `hr` |
| `frontend/src/pages/MyKRASheetPage.jsx` | mounts the picker on the employee's own sheet |
| `frontend/src/pages/KraOrgOverviewPage.jsx` | mounts the picker for HR entering on someone's behalf |
| `frontend/src/pages/AiDraftPanel.jsx` | `AiModal` gained a `badge` prop so the picker can reuse the modal without the AI badge |

### Tests

`server/test/kra-library.test.js` — 14 tests, pure (no database, no HTTP). They
build real `.xlsx` buffers and drive the parser directly. The two that matter
most if you change anything here:

- *"A SHELF DOES NOT HAVE TO TOTAL 100"* — if this ever starts failing, the
  library has been made to behave like an assignment and the feature is pointless.
- *"the same file keyed by employee_email still enforces 100"* — the control. If
  this stops failing, the library's leniency has leaked into the importer that
  must not have it.

Run the whole suite against a real database before deploying:

```bash
createdb apms_check
cd server
DATABASE_URL="postgres://USER:PASS@127.0.0.1:5432/apms_check" \
  DATABASE_SSL=false JWT_SECRET=x TENANT_SLUG=x npm test
# expect: # pass 411 / # fail 0
```

`DATABASE_SSL=false` is required for a local PostgreSQL. Without it the pool
tries TLS and the whole suite fails to connect.

---

## 3. Deploying

Pick the section matching how the client instance runs. In all three the
migration runs itself on the next boot.

### 3a. Render (the PoC)

Render auto-deploys `main`. Merging is the deploy.

```bash
git fetch origin
git checkout main
git merge --ff-only origin/<feature-branch>
git push origin main
```

Then watch both services in the Render dashboard:

- **`agentic-pms-api`** — the migration runs during boot. The log line to look
  for is `migration 033-kra-library.js: done`. If the service crash-loops,
  read the migration error: boot failure *is* the safety mechanism.
- **`agentic-pms-frontend`** — a static rebuild. The asset hash changes; that
  is how you know it landed.

> **Free-tier caveats on this plan.** The API sleeps after 15 minutes idle and
> takes 30–60s to wake. The database is **not durable** — Render removes free
> databases at the end of the trial window with no backup and no restore path.
> Fine for a PoC on disposable data; move to a paid tier before any real
> employee record goes in.

Confirm the frontend actually shipped the feature, rather than assuming:

```bash
BUNDLE=$(curl -s https://<frontend-host>/ | grep -oP 'src="\K/assets/[^"]+\.js' | head -1)
curl -s "https://<frontend-host>$BUNDLE" | grep -c "Choose from library"
# 0 means the old bundle is still being served — the build has not finished
```

### 3b. EC2, as a systemd service

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

That pulls, installs, rebuilds the frontend and restarts the units. The
migration runs when `agentic-pms-api` restarts:

```bash
sudo journalctl -u agentic-pms-api -n 50 --no-pager | grep migration
```

### 3c. EC2, with Docker

```bash
cd /opt/agentic-pms/deploy/docker
git -C /opt/agentic-pms pull
docker compose build && docker compose up -d
docker compose logs api | grep migration
```

### Verifying the migration landed

```sql
SELECT name, run_at FROM core.migrations_log WHERE name LIKE '033%';
SELECT count(*) FROM pms.kra_library;          -- 0 on a fresh deploy
\d pms.kra_library
```

---

## 4. Publishing the library

Once the code is live, **no developer action is needed** — this is HR's job,
through the screen. Document it for them rather than doing it for them:

1. **HR Admin → KRA Library**
2. **Choose File** → the designation-keyed workbook
3. **Validate** — a dry run. Nothing is written. Read the report.
4. **Publish** — only enabled once the dry run passes.

### The upload format

One row per KRA. Every worksheet in the workbook is read, so a multi-tab
role workbook publishes in one go.

| Column | Required | Notes |
|---|---|---|
| `Designation` | **yes** | `Designations`, `Job Title`, `Role` and their plurals are also accepted. Written once above a block of its KRAs is fine — it carries down. |
| `Parameters` | no | Financial / Project / Process / Customer / People. Also carries down. Stored as `category`. |
| `KRA (S.M.A.R.T GOALS)` | **yes** | Stored as `title`. |
| `KPIs (Measuring Metrics & Data Source)` | no | Stored as `measures`. |
| `Suggested Weightage` | **yes** | `Weightage` and `Weight` also accepted. Must be a positive number. |
| `Comments` | no | Stored as `description`. |

Header matching ignores case, punctuation and parenthesised qualifiers, so
`KRA \n(S.M.A.R.T GOALS)` and `kra` both resolve. A column the parser does not
recognise is reported as an ignored-column warning, not an error.

**A shelf is not required to total 100.** That is the point — it is a menu that
deliberately offers more than one person needs. The total is reported for
information. The 100 rule still applies where it belongs: at submit time, on the
employee's own sheet.

### What the report tells you

- **errors** block the publish and name the sheet and row.
- **a designation nobody currently holds** is a *warning*, not an error — HR
  builds shelves ahead of hiring.
- **`employees` per shelf** is the number that decides whether a shelf is doing
  anything. **Zero means published and unreachable** — almost always the
  designation is spelt differently here than on the employee records. Shown in
  amber for exactly that reason.
- **"Designations with no shelf yet"** lists what is left, ordered by how many
  employees it affects.

### Re-uploading

Publishing **replaces** the shelf for each designation present in the file and
leaves every other designation untouched. So Engineering can be corrected
without disturbing Sales.

KRAs employees have already picked are **copies** on their own sheets. Revising
the library never rewrites a KRA somebody has already agreed with their manager.

---

## 5. Verifying it works, end to end

```bash
B=https://<host>/api/v1
TOK=$(curl -s -X POST $B/auth/dev-login -H 'Content-Type: application/json' \
  -d '{"email":"<hr-admin>","password":"<password>"}' | jq -r .token)

# 1. Dry run. Expect "ok": true and errors 0.
curl -s -X POST "$B/pms/hr/kra-library/upload" -H "Authorization: Bearer $TOK" \
  -F "file=@Mindgate_KRA_Library.xlsx" | jq '{ok, summary}'

# 2. Publish.
curl -s -X POST "$B/pms/hr/kra-library/upload?commit=1" -H "Authorization: Bearer $TOK" \
  -F "file=@Mindgate_KRA_Library.xlsx" | jq '{ok, committed, summary}'

# 3. Coverage — how many employees will actually see a dropdown.
curl -s "$B/pms/hr/kra-library" -H "Authorization: Bearer $TOK" | jq '{
  shelves: (.shelves | length),
  reaching_someone: ([.shelves[] | select(.employees > 0)] | length),
  employees_covered: ([.shelves[].employees] | add),
  uncovered: [.uncovered[] | {designation, employees}]
}'
```

Then sign in as an ordinary employee and confirm the last mile:

```bash
ET=$(curl -s -X POST $B/auth/dev-login -H 'Content-Type: application/json' \
  -d '{"email":"<an employee>","password":"<password>"}' | jq -r .token)
curl -s "$B/pms/my/kra-library" -H "Authorization: Bearer $ET" | jq '{designation, offered: (.entries|length)}'
```

**Expected against the Mindgate master** (1,397 employees, the 265-designation
consolidated library): 265 shelves published, 86 reaching a real employee,
**1,381 of 1,397 employees covered**. The 16 not covered are
`Vice President I` (11), `Senior Vice President II` (3),
`Senior Vice President I` (1) and
`Senior Administrator - Network and System` (1) — they need shelves adding.

In the UI, the employee should see a banner reading *"Start from the
&lt;designation&gt; KRA library"* on **My KRAs**, and **Choose from library**
should open a pick list grouped by Parameter with a running total in the footer.

### Two honest empty states — neither is a bug

| Employee sees | Means | Fix |
|---|---|---|
| *"Your record has no designation set"* | `core.employees.designation` is NULL | HR sets it on the Employees screen or re-imports |
| *"No KRA library has been published for X yet"* | no shelf for that designation | publish one, or accept they write from scratch |

If the banner does not appear at all, the shelf exists but the designation
strings do not match. Check with:

```sql
SELECT e.designation, count(*) AS employees,
       EXISTS (SELECT 1 FROM pms.kra_library l
                WHERE l.tenant_id = e.tenant_id
                  AND lower(btrim(l.designation)) = lower(btrim(e.designation))) AS has_shelf
  FROM core.employees e
 WHERE e.tenant_id = '<tenant uuid>' AND e.status = 'active'
 GROUP BY 1, 3 ORDER BY has_shelf, employees DESC;
```

---

## 6. Rolling back

The feature is additive, so rolling back the code is enough and the table can
be left in place — nothing else reads it.

```bash
# Newest first, or the two reverts conflict with each other.
git revert --no-commit 1e57582 07fcd01 && git commit && git push origin main
```

(Verified to apply cleanly in that order at `1e57582`.)

There is **no down migration**, by design: this codebase's migrations only ever
go forward, and a failed boot is the safety net. If you genuinely need the table
gone:

```sql
DROP TABLE IF EXISTS pms.kra_library;
DELETE FROM core.migrations_log WHERE name = '033-kra-library.js';
```

Dropping the table **does not** affect any KRA an employee has already picked —
those are copies in `pms.kras`.

---

## 7. Things that have already bitten us

Listed because each one cost real time and none of them is obvious.

- **`DATABASE_SSL=false` is required for a local or same-host PostgreSQL.**
  Without it every connection attempts TLS and fails.
- **`VITE_API_URL` must stay UNSET on a single-host deployment.** The frontend
  builds `https://${VITE_API_URL}/api/v1` when it is set and a plain `/api/v1`
  when it is not. On EC2 behind nginx the relative path is what you want. It is
  also **build-time** — changing it needs a frontend rebuild, not a restart.
- **`AUTH_DEV=true` is currently the only working sign-in path.** OIDC is
  scaffolded, not implemented. Set it to `false` and nobody can log in.
- **Legacy `.xls` is rejected**, deliberately — the only maintained parser for it
  ships unpatched high-severity advisories. Re-save as `.xlsx`.
- **A `.xlsx` containing cell comments can fail the import.** Known, not yet
  fixed. Save a copy without comments as a workaround.
- **`npm test` must run serially.** The suite shares one database; running it in
  parallel produces a different set of phantom failures each time. The `test`
  script already sets `--test-concurrency=1` — do not remove it.
- **Adding `title` as an alias for the designation column would be a disaster.**
  In these sheets that word means the KRA's own title far more often than the
  job title, so it would silently file every KRA under a designation named after
  itself. There is a test pinning this.

---

## 8. Reference

| | |
|---|---|
| Feature commit | `07fcd01` — *Add a KRA library employees pick from, keyed on designation* |
| Follow-up | `1e57582` — plural headers + the wrong-screen message |
| Migration | `server/migrations/033-kra-library.js` |
| API | `server/modules/performance/index.js` |
| Tests | `server/test/kra-library.test.js` (14) |
| Full suite | 411 tests, all passing at `1e57582` |
| Deployment runbook (general) | `DEPLOY.md` |
| House rules for this codebase | `.claude/skills/apms-conventions`, `.claude/skills/apms-migrations` |

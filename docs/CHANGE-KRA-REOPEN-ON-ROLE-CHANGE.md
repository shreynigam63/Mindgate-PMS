# Change — a submitted KRA sheet reopens when the job changes

**Screens:** My KRAs (`/my/kras`) · Employees (`/admin/employees`) · the HRMS re-import
**Shipped as:** `67b75d4` + `759a08c`, merged in `0ac242d` · live on pms.agentichumans.in
**Schema change:** **YES** — migration `037-kra-sheet-reopened-reason.js`
**Type:** behaviour change, visible to employees and to HR

Asked for directly:

> *"If employee has submitted his KRA to manager and his department,
> designation or role is changed, his KRAs should be opened again for refilling
> as it gets locked after submission to manager."*

This is the **corollary** of the submission lock (see
`CHANGE-KRA-OPEN-ALL-CYCLE.md`). Submitting hands the sheet to the manager and
closes it to the employee, which is right — but the sheet describes the job
they were hired to do. Move them from Executive to Senior Executive, or Admin
to Finance, and it no longer applies. Without this the lock **traps** them
holding objectives for a job they no longer have, and the only way out is HR
noticing and reopening it by hand.

---

## 1. What it looks like

**Before — submitted and locked, as Executive.**

![Submitted as Executive](images/kra-reopen-01-submitted-as-executive.png)

**After HR changes the designation — the sheet is back with the employee by
itself**, and the library beneath has already switched to the **new** role, so
they refill against the job they now hold.

![Reopened after the role change](images/kra-reopen-02-reopened.png)

---

## 2. The two reasons a sheet comes back, kept apart

Both land on `status = 'returned'` — deliberately, because `returned` is the
one state the whole product already reads as *"yours again, with a reason
attached"*, so the employee's page, the manager's queue and the reminder sweep
all behave correctly with no new state to teach them.

But they must never be confused, and the client asked for exactly this:

> *"reopened - role change will be for department, designation and role change.
> returned by manager will be when manager has not approved and returned with
> feedback. please make sure this both are two different updates."*

The same employee, the same sheet, minutes apart:

![Returned by the manager](images/kra-reopen-03-manager-returned.png)

![Reopened after a role change](images/kra-reopen-04-role-changed.png)

| | Chip | Banner |
|---|---|---|
| Manager returned it | `sheet: returned by manager` | **Returned by your manager:** … |
| Job changed | `sheet: reopened — role changed` | **Reopened after a change to your role:** Your Department: Admin → Finance… |

`pms.kra_sheets.reopened_reason` is what keeps them apart — a **stored column**
(migration 037), not a guess at the comment text, because this is the first
line an employee reads after an unexpected change and a wording tweak elsewhere
must not be able to start misattributing it.

Each of the four writers sets exactly one thing:

| Who | `reopened_reason` | Reads as |
|---|---|---|
| a profile change | `'profile_change'` | "Reopened after a change to your role" |
| the manager decides | `NULL` | "Returned by your manager" |
| HR reopens by hand | `NULL` | a person decided, so it reads as one |
| the employee submits | `NULL` | not reopened at all any more |

> That last one matters. The flag survived a resubmission at first, so a sheet
> the manager returned **weeks later** would still have worn the "role changed"
> label from a job change months earlier. Submitting now clears it.

---

## 3. What counts as a job change

| Reopens the sheet | Does **not** reopen it |
|---|---|
| Department | Name correction |
| Designation | Date of joining backfilled |
| Role band | **Manager reassignment** |
| Permission role (`employee` → `manager`) | Re-import of unchanged values |

A **manager change already propagates** onto the sheet without reopening it,
which is the right treatment: the objectives are the same, only the reviewer
moved.

Comparison is on **trimmed text**, so `null` → `''` on a re-import is not a
change, and a nightly sync of unchanged designations reopens nothing. There is
a test for exactly that — getting it wrong would reopen every submitted sheet
in the company every night.

**Which sheets:** `submitted` **and** `approved`, on any cycle that is not
`draft`, `closed` or `cancelled`. An approved sheet is just as wrong for the
new job, and just as locked. A `draft` or `returned` sheet is already theirs,
so nothing happens and no notification is spent.

---

## 4. Where it fires

All three paths a profile can actually change on:

| Path | Route | Reports |
|---|---|---|
| HR quick-edit form | `PUT /api/v1/employees/:employeeId` | `reopened_kra_sheets`, `changes` |
| Role assignment | `PUT /api/v1/employees/:employeeId/role` | `reopened_kra_sheets` |
| **HRMS re-import** | `POST /api/v1/employees/import` | `kra_sheets_reopened[]` in the import report |

The re-import is the path most of these arrive on. It collects what to reopen
**inside** the transaction and acts **after** the commit, so a rolled-back
import reopens nothing, and one employee's failure cannot lose an import that
is already durable.

**Both sides are notified** — the employee, because their sheet came back and
nobody pressed a button they can see; the manager, because a sheet they had
approved (or were about to) has left their queue.

**Audited** as `KRA_REOPENED_PROFILE_CHANGE` in `core.audit_log`, per sheet,
with the before/after that caused it and who did it. This is upstream of a
rating, so "why did my objectives change" has a queryable answer.

---

## 5. Where the code is

| Piece | File |
|---|---|
| The rule, and the only place it is implemented | `server/modules/performance/profile-change.js` |
| Which fields are watched | same file — `WATCHED` |
| Which statuses reopen | same file — `LOCKED` |
| HR edit + role routes | `server/core/employees.js` |
| HRMS import (pass 0 snapshot, pass 4 detection, post-commit reopen) | `server/core/employees.js`, `loadEmployees()` |
| Banner and chip | `frontend/src/pages/MyKRASheetPage.jsx`, `frontend/src/utils/api.jsx` |
| Migration | `server/migrations/037-kra-sheet-reopened-reason.js` |
| Tests | `server/test/kra-reopen-on-profile-change.test.js` (16) |

> **Why `profile-change.js` lives in the performance module but is called from
> core:** the rule is entirely about `pms.kra_sheets`. `core/employees.js`
> requires it **lazily**, at call time, so core still loads without the product
> modules. The alternative was a third and fourth copy of this SQL inline in
> core, beside the manager propagation that is already there.

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Add `manager_id` to `WATCHED` | every manager reassignment throws away a submitted sheet |
| Compare fields without trimming | a nightly HRMS sync reopens every submitted sheet in the company |
| Sniff the comment text instead of reading `reopened_reason` | a wording change starts blaming the manager for HR's edit |
| Stop clearing `reopened_reason` on submit | a manager's return months later still reads "role changed" |
| Call the reopen inside the import transaction | it writes through the pool — it would not see the import's work, or would block on its own locks |

---

## 6. Deploy

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

**This change carries migration 037.** Migrations run in-process at boot and
**fail the boot** if one throws, so a bad migration stops the deploy rather
than half-applying it. `037` is `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, which
is safe on a populated table and idempotent.

### Before deploying, snapshot the state

```bash
DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
sudo -u postgres psql -d "$DB" -tAc "SELECT filename FROM core.migrations_log ORDER BY ran_at DESC LIMIT 3"
sudo -u postgres psql -d "$DB" -tAc "SELECT status, count(*) FROM pms.kra_sheets GROUP BY status ORDER BY 1"
```

### After

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx

# the migration applied, and the column exists
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT filename, ran_at FROM core.migrations_log WHERE filename LIKE '037%'"
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='pms' AND table_name='kra_sheets' AND column_name='reopened_reason'"

# no existing row should be flagged — it is a fresh column
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT count(*) FROM pms.kra_sheets WHERE reopened_reason IS NOT NULL"     # expect 0

# the sheet counts must match the snapshot above
sudo -u postgres psql -d "$DB" -tAc "SELECT status, count(*) FROM pms.kra_sheets GROUP BY status ORDER BY 1"

curl -fsS http://127.0.0.1/api/v1/health
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

Read the rule off the box without touching data:

```bash
cd /opt/agentic-pms/server
node -e "
const pc=require('./modules/performance/profile-change');
console.log('  watched:', pc.WATCHED.map(w=>w[1]).join(', '));
console.log('  reopens statuses:', pc.LOCKED.join(', '));
console.log('  a name-only edit:', JSON.stringify(pc.watchedChanges({department:'Admin'},{department:'Admin'})));
console.log('  a dept change   :', JSON.stringify(pc.watchedChanges({department:'Admin'},{department:'Finance'})));"
```

> **Do not demo this by editing a real employee on a client PoC** unless you
> mean it — it genuinely reopens their submitted sheet and notifies them and
> their manager. Nothing is lost (the KRAs are untouched and can be resubmitted
> as-is), but it is a real event with real notifications. Use a restored copy.

---

## 7. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

`server/test/kra-reopen-on-profile-change.test.js`. The ones that carry weight:

- **a full round trip** — job change → resubmit → manager return — asserting the
  label at each step. This is the test that caught the surviving-flag bug.
- **re-importing the same file twice reopens nothing.**
- **a department-less employee added mid-run changes no totals.**

---

## 8. Rollback

Revert `759a08c` and `67b75d4`. **Leave the column** — `reopened_reason` is
nullable and unread by the old code, so dropping it buys nothing and risks a
lock on a populated table. Any sheet already reopened stays `returned`, which
the old code understands; it will simply be labelled "Returned by your manager"
again.

---

## 9. Related

- **`CHANGE-KRA-OPEN-ALL-CYCLE.md`** — the lock this exists to make survivable.
  Deploy them together; the lock without this one traps people.

# PoC account — what to do, in order

Written against `main` at **`a470222`**. Everything here has been run against
the live instance (pms.agentichumans.in) except where it says otherwise.

**The order matters.** Each step unblocks the next. Doing 6 before 5 publishes
the wrong shelves; doing 5 before 3 imports into a schema that cannot hold it.

| # | Step | Who | Blocks |
|---|---|---|---|
| 0 | Back up, and diff two hand-edited files | dev | everything |
| 1 | Bring the code up to date | dev | 2–6 |
| 2 | Verify the deploy | dev | — |
| 3 | Load the employee master | HR | 4, 5, 6, 7 |
| 4 | Check the Department dropdown fills | HR | 5 |
| 5 | Re-upload the KRA library **with Department** | HR | 6 |
| 6 | Turn the Department dimension on (optional) | HR | — |
| 7 | Fix the manager who cannot approve | HR | KRA approvals |
| 8 | Load the Career Pathing Matrix | HR | Aspiring Career |
| 9 | End-to-end check | both | — |

---

## 0 · Back up first, and diff two files

Your PoC has **local modifications**. I compared your directory listing against
the repo:

| File | Yours | Repo | Verdict |
|---|---|---|---|
| `DirectoryPage.jsx` | 23,158 | 22,164 | **994 bytes larger.** Unchanged in the repo since `c852c5a`, so this is a local edit, not a newer release |
| `KraLibraryPage.jsx` | 22,605 | 22,604 | **1 byte different.** One byte is a hand edit |

Overwriting either **deletes that work.** Before anything else:

```bash
cd /opt/agentic-pms
sudo tar czf ~/poc-backup-$(date +%F-%H%M).tar.gz frontend/src server
git status --short            # anything listed is a local change you will lose
git stash list
```

Then diff the two against the bundle I sent:

```bash
diff -u frontend/src/pages/DirectoryPage.jsx   /path/to/bundle/pages/DirectoryPage.jsx
diff -u frontend/src/pages/KraLibraryPage.jsx  /path/to/bundle/pages/KraLibraryPage.jsx
```

If the diff shows something you need, **tell me what it is** — it should go
into the repo properly rather than being re-applied by hand after every
deploy. If it is leftover debugging, discard it and carry on.

Also move your two backup files out of `src/`:

```bash
mkdir -p ~/poc-bkp && mv frontend/src/pages/*_[Bb][Kk][Pp]_* ~/poc-bkp/
```

They are inside the build tree; a wildcard import would pick them up, and they
confuse the next person reading the directory.

---

## 1 · Bring the code up to date

### Route A — the PoC is on this git remote (**strongly preferred**)

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

One command: pulls `main`, `npm ci`, builds the frontend into
`/var/www/agentic-pms`, restarts `agentic-pms-api`, waits for health.
Migrations run **in-process at boot** and **fail the boot** if one throws, so a
bad migration stops the deploy rather than half-applying it.

### Route B — it is not on the remote

Copy the 35 files from `frontend-pages-a470222.zip` into
`frontend/src/pages/`, then:

```bash
cd /opt/agentic-pms/frontend && npm ci && npm run build
sudo systemctl restart agentic-pms-api
```

> **Route B alone is not enough.** These pages call server routes that must
> exist. `KraLibraryPicker.jsx` needs the department-aware shelf endpoints;
> `KraLibraryPage.jsx` needs `PUT`/`DELETE /hr/kra-library/entry/:id`;
> `CareerTransitionsPage.jsx` needs the transitions upload. Copy the JSX alone
> and you get pages whose buttons return **404**. You must bring
> `server/` to the same commit as well.

`VITE_API_URL` must stay **unset** on the host — it is baked in at build time
and the frontend is served from the same origin as the API.

### What you are missing right now

Seven files differ and one is absent entirely:

| File | Carries |
|---|---|
| `KraLibraryPicker.jsx` | Department/Designation dropdowns, Select all |
| `MyGrowthPage.jsx` | Select all, KRA-linked goals |
| `CareerTransitionsPage.jsx` | Career Pathing Matrix bulk upload + template |
| `MyKRASheetPage.jsx` | submission lock, reopened-reason banner |
| `AiDraftPanel.jsx` | Select all on the suggestion list |
| `KraLibraryPage.jsx` | in-place KRA/weightage editing |
| `DirectoryPage.jsx` | (see §0 — yours is ahead) |
| **`SettingsPage.jsx`** | **absent on your PoC** — HR Admin → Settings, including the KRA Library scope toggle |

---

## 2 · Verify the deploy

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
git -C /opt/agentic-pms rev-parse HEAD^{tree} origin/main^{tree}   # must match
systemctl is-active agentic-pms-api nginx                          # active active
curl -fsS http://127.0.0.1/api/v1/health
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

> The host's `HEAD` may read a feature commit rather than the merge commit,
> because the deploy pulls with a rebase. **Compare the trees, not the subject
> line.**

Migrations applied — there should be **37**:

```bash
DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM core.migrations_log"
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT filename FROM core.migrations_log WHERE filename ~ '^03[34567]-' ORDER BY filename"
```

Key routes alive and guarded — `401`, never `404`, never `500`:

```bash
for R in hr/kra-library hr/kra-library/template.csv my/kra-library; do
  printf '  %-32s ' "$R"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1/api/v1/pms/$R"
done
```

A `404` here means the server did not come up to date — go back to §1.

---

## 3 · Load the employee master ← **the main blocker on your PoC**

This is why your Department dropdown shows only *All departments* and
*Fallback shelves only*, and why every shelf reads **0 employees**.

The dropdown is built from the employee master, **not** from the library:

```sql
SELECT DISTINCT btrim(department) FROM core.employees
 WHERE status='active' AND coalesce(btrim(department),'') <> ''
```

On your PoC that returns **nothing**. On the live instance it returns **34**
departments, which is why the dropdown is full there.

**In the UI:** HR Admin → **Employees** → *Download template (.xlsx)* → fill
in → **Validate** → **Publish**.

Validate writes nothing; it shows exactly what would happen. A file with any
error writes nothing at all.

**Every row needs `department` and `designation` filled in.** Those two columns
are what the whole KRA Library matches on. A blank department is not fatal but
that person falls outside every department view.

Check afterwards:

```bash
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT 'active=' || count(*) ||
         '  with department=' || count(*) FILTER (WHERE coalesce(btrim(department),'')<>'') ||
         '  with designation=' || count(*) FILTER (WHERE coalesce(btrim(designation),'')<>'')
    FROM core.employees WHERE status='active'"
```

All three numbers should match. If department is 0, the dropdown will still be
empty.

---

## 4 · Confirm the dropdown now fills

HR Admin → **KRA Library**. The Department dropdown should list your real
departments, not just the two built-in options.

```bash
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT count(DISTINCT btrim(department)) FROM core.employees
   WHERE status='active' AND coalesce(btrim(department),'')<>''"
```

Whatever number that prints is how many options you should see. **Do not go to
§5 until this is non-zero** — until employees exist there is no way to know
which departments a shelf should name.

---

## 5 · Re-upload the KRA library with the Department column

**In the UI:** HR Admin → KRA Library → *Download template (.xlsx)* →
fill in → **Validate** → **Publish**.

The template's first column is now **Department**. Delete the three sample rows
before uploading — the banner says so.

### The rule that silently publishes the wrong shelf

Department forward-fills **exactly like Designation**. Written once it carries
**down** the rows beneath it, and **a new Designation clears it**.

```
Admin | Manager        -> Admin
      |                -> Admin      carries down the block
      | Senior Manager -> null       a new Designation clears it
Sales |                -> Sales
      |                -> Sales
```

So a blank cell means **company-wide only on a designation's FIRST row**.
Inside a block it means "same as above". Get this wrong and one role's
department leaks onto the next role's KRAs.

### Two things to fix while you are in the file

Measured on the live library — your PoC uses the same upload, so expect the
same:

1. **Designations that match nobody.** 267 designations exist on shelves but
   only 90 are held by anyone — **181 shelves are for job titles nobody has.**
   They are harmless but they fill the top of the alphabetical list, which is
   exactly what made your screenshot look empty.
2. **Designations nobody covers.** 16 employees hold a title no shelf matches,
   so their library is empty: `Vice President I` (11), `Senior Vice President
   II` (3), `Senior Vice President I` (1), `Senior Administrator - Network and
   System` (1).

Make the library's designation strings match the employee master's. Matching is
exact on trimmed, lowercased text.

> **⚠ There is no export route.** You cannot download what is currently
> published, add a Department column and re-upload — I checked, that route does
> not exist. You must work from the **original source file** the library was
> built from. If that file is not to hand, say so: I can add a *"Download
> current library"* button that emits the published rows in template format
> with Department blank and ready to fill. Small change, and it turns this step
> from "find the original 49 workbooks" into "download, fill one column,
> upload."

Check afterwards:

```bash
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT 'rows=' || count(*) || '  with a department=' || count(department) FROM pms.kra_library"
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT 'shelf designations=' || count(*) FROM (SELECT DISTINCT lower(btrim(designation)) d FROM pms.kra_library) s"
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT 'of those, matching >=1 active employee=' || count(*)
    FROM (SELECT DISTINCT lower(btrim(designation)) d FROM pms.kra_library) s
   WHERE EXISTS (SELECT 1 FROM core.employees e WHERE e.status='active'
                  AND lower(btrim(coalesce(e.designation,'')))=s.d)"
```

`with a department` must now be greater than 0, and the last two numbers should
be close together.

---

## 6 · Turn the Department dimension on (only if you want it)

**In the UI:** HR Admin → **Settings** → *KRA Library scope*.
(This is the page missing from your PoC — §1 restores it.)

Or directly:

```sql
-- ON
INSERT INTO core.admin_settings (tenant_id, key, value)
SELECT id, 'kra_library_scope', '{"mode":"department+designation"}'::jsonb
  FROM core.tenants
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;

-- OFF (the default) — one shelf per job title, no Department dropdown at all
UPDATE core.admin_settings SET value = '{"mode":"designation"}'::jsonb
 WHERE key = 'kra_library_scope';
```

**If departments are not going to be used, leave it OFF.** Switching it on
before §5 is done gives every employee two controls that do nothing.

---

## 7 · Fix the manager who cannot approve

A Reporting Manager with **no role assigned** has no `pms_team_eval`
permission, so the team queue and the approve/return buttons return **403**.
On live this is exactly one person, and it is blocking three submitted sheets:

```
Bhawana Maheshwari <bhawana.m@mindgate.in>  — no role, 1 active report
```

**In the UI:** HR Admin → Employees → find them → assign the **manager** role.

Find any others on your PoC:

```bash
sudo -u postgres psql -d "$DB" -tAc "
SELECT me.name || ' <' || me.email || '>  reports=' ||
       (SELECT count(*) FROM core.employees r WHERE r.manager_id=me.id AND r.status='active')
  FROM (SELECT DISTINCT e.manager_id mid FROM core.employees e
         WHERE e.status='active' AND e.manager_id IS NOT NULL) m
  JOIN core.employees me ON me.id=m.mid
 WHERE NOT EXISTS (SELECT 1 FROM core.user_roles ur JOIN core.role_permissions rp ON rp.role=ur.role
                    WHERE lower(ur.email)=lower(me.email) AND rp.permission='pms_team_eval')
   AND NOT EXISTS (SELECT 1 FROM core.user_permissions up
                    WHERE lower(up.email)=lower(me.email) AND up.permission='pms_team_eval')"
```

Anyone listed cannot approve their reports' KRAs. The roles that grant it are
`manager`, `hod` and `hr`.

Also check nobody is left without a manager at all:

```bash
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT count(*) FROM core.employees WHERE status='active' AND manager_id IS NULL"
```

On live that is 61 people — each one has nobody who can approve their KRAs.

---

## 8 · Load the Career Pathing Matrix

Both tables are empty on live (`people.career_transitions` = 0,
`people.career_matrix` = 0), so *Aspiring Career* has no paths to suggest.

**In the UI:** HR Admin → **Career Pathing Matrix** → *Download template* →
fill in → **Validate** → **Publish**. Same two-step contract.

```bash
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM people.career_transitions"
```

---

## 9 · End-to-end check

Sign in as a real employee and walk it:

| Check | Expect |
|---|---|
| **My KRAs** → *Choose from library* | their own designation's KRAs, not an empty list |
| the Department dropdown | real department names (if §6 is on) |
| **Select all** | ticks everything; the total turns amber past 100% |
| Add, then Submit | the sheet locks and says the manager has it |
| Sign in as their **manager** → Team KRA Sheets | the sheet is there, Approve/Return work |
| **My Growth** | opens once the KRAs are submitted; *Suggest goals* returns something |
| **HR Admin → KRA Library** | shelves show real employee counts, not 0 |

If *Suggest goals* says **"Agentic features are not configured on this
instance"**, the PoC has no `ANTHROPIC_API_KEY` in `/etc/agentic-pms/api.env`.
On live the key is present and working (verified — a real draft came back).

---

## What I cannot check for you

I have access to **pms.agentichumans.in only**. Everything above about your PoC
is inferred from the directory listing and screenshots you sent — the numbers
quoted are from the live instance, which uses the same library upload.

If you want me to verify the PoC directly, I need either access to it or the
output of the check commands in §2–§4 run on that host.

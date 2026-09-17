# HR Admin — KRA Library

**Screen:** KRA Library (`/admin/kra-library`) — sidebar, under HR ADMIN
**Who sees it:** `admin` and `hr` roles only; every endpoint additionally
requires the `pms_admin` permission
**Deployed as of:** commit `528c2e9` on `main`, live on pms.agentichumans.in

This is where HR publishes the shelves that the *My KRAs* picker offers. One
row per KRA, keyed on **Designation** (and optionally **Department**).

> **A shelf does not need to total 100.** It is a menu, and employees pick a
> hundred points' worth from it. The assignment importer is the one that must
> total 100, because that is somebody's actual scorecard. Getting these two
> backwards makes the feature pointless.

---

## 1. The page, top to bottom

**Default — every published shelf, 265 of them.**

![HR KRA Library, the default view](images/hr-kra-library-01-overview.png)

**View KRAs — one shelf expanded, grouped by Parameter with weights.**

![A shelf expanded](images/hr-kra-library-05-shelf-expanded.png)

**Designations with no shelf yet — the actionable to-do list, at the foot of
the page.**

![Designations with no shelf yet](images/hr-kra-library-04-uncovered.png)

> All shots are the deployed build against a copy of the live database,
> signed in as HR. Every number in them is real.

| Section | Rendered at | Fed by |
|---|---|---|
| **Publish a shelf** — template links, file picker, Validate, Publish | `KraLibraryPage.jsx` 86–115 | `POST /pms/hr/kra-library/upload` |
| **Titles held in more than one department** | 119–137 | `ambiguous[]` — **only when `scope === 'designation'`**, so hidden on live today |
| **Department** filter | 144–153 | `departments[]` |
| **Designation** filter — the cascade, appears only after a department | 158–171 | `department_view[]` |
| **Department view** — one row per title that department employs | 173–220 | `department_view[]` |
| **Published shelves** list | 226–260 | `shelves[]` |
| **Designations nobody has published for** | 262–280 | `uncovered[]` |
| Expanded shelf (View KRAs) | `ShelfDetail()`, 282–314 | `GET /pms/hr/kra-library/:designation` |

**Main endpoint:** `GET /api/v1/pms/hr/kra-library`
(`server/modules/performance/index.js:1456`). It returns `shelves`,
`departments`, `ambiguous`, `uncovered`, `department_view`, `department`,
`scope` in one response.

**All routes** (all `pms_admin`):

| Method | Path | Line | Does |
|---|---|---|---|
| GET | `/pms/hr/kra-library` | 1456 | the whole page; `?department=X` adds the department view |
| GET | `/pms/hr/kra-library/template.xlsx` | 1418 | download template |
| GET | `/pms/hr/kra-library/template.csv` | 1438 | download template |
| GET | `/pms/hr/kra-library/:designation` | 1587 | one shelf's KRAs (`?department=` for a department shelf) |
| DELETE | `/pms/hr/kra-library/:designation` | 1606 | delete a shelf |
| POST | `/pms/hr/kra-library/upload` | 1631 | validate (default) or publish (`?commit=1`) |

---

## 2. Publishing — always two steps

**Validate → Publish.** The same endpoint, same file; `?commit=1` is the only
difference. Validate writes nothing and reports every problem row by row, so
HR sees the whole set of errors at once rather than one per attempt.

Columns the template uses:

```
Designation | Parameters | KRA (S.M.A.R.T GOALS) | KPIs (Measuring Metrics & Data Source) | Suggested Weightage | Comments
```

`Department` is optional and recognised under `Department`, `Dept`,
`Departments` or `Business Unit`.

Behaviour worth knowing before someone uploads to production:

- **Every worksheet in the workbook is read**, so a multi-tab role workbook
  publishes in one go.
- **Publishing REPLACES the shelf** for each (department, designation) pair in
  the file, and leaves every other shelf untouched. It is not a merge.
- **A designation nobody holds is a warning, not an error.** HR may legitimately
  publish ahead of a hire.
- **Department does not forward-fill.** A blank Department on a row means
  *company-wide*, even when the row above it named one. Inheriting it down the
  column would silently publish a Sales shelf under Development — the same
  boundary rule Parameters follows, and it was broken there first.
- **Legacy `.xls` is rejected** with a message telling HR to re-save as `.xlsx`.

---

## 3. The Department filter is a different view, not a filter

This trips people up, so it is worth stating plainly.

Choosing a real department **does not filter the published-shelves list**. It
replaces the card with a server-side **department view**: one row per job title
that department actually employs, saying which shelf lands on those people's
screens.

That is deliberate. Filtering the flat list by department was the original
implementation and it looked broken: with no department shelves published,
every shelf is a fallback, so every department showed the identical 265 rows
and the control appeared dead. Fixed in `05c1b12`.

**Choosing Admin — the card is replaced by the department view.**

![HR KRA Library, the department view](images/hr-kra-library-02-department-view.png)

Every row here reads `company-wide`, and the footer says *0 of 10 titles have a
shelf written for Admin*. That is the live state, not a fault: no library row
carries a department yet.

**The cascade — Designation narrows the department view to one title.**

![The designation cascade](images/hr-kra-library-03-designation-cascade.png)

The dropdown has three kinds of entry:

| Choice | Shows |
|---|---|
| `All departments` | every published shelf, unfiltered |
| `Fallback shelves only` | only shelves with no department (client-side filter) |
| a real department | the **department view** (server round-trip, `?department=X`) |

Each row in the department view carries a source chip:

| Chip | `source` | Means |
|---|---|---|
| `N KRAs · own shelf` | `own` | somebody wrote a shelf for this title **in this department** |
| `N KRAs · company-wide` | `fallback` | no department shelf; these people get the company-wide one |
| `no shelf at all` | `none` | nobody is served anything — the to-do list |

and the footer totals the three. **View KRAs** opens the shelf those people are
actually served — the department's own if it has one, otherwise the fallback.

**The Designation filter appears only once a department is chosen.** Without
one it would be 265 options, which is the designation bottleneck this cascade
exists to remove.

---

## 4. How a shelf is counted

`kra_library` rows are grouped by **(designation, department)** — that pair is
the key, not designation alone, which is why "Manager" in Development and
"Manager" in Human Resources can coexist as separate shelves.

The employee count beside a shelf is asymmetric on purpose
(`index.js:1467–1472`):

- on a **department** shelf it counts only that department's people;
- on a **department-blank** shelf it counts everyone holding the title,
  because that is who the fallback reaches.

In the department view (`:1512`) each title's count is `own_kras` if it has its
own shelf, **else** `fallback_kras` — never the sum. Adding them double-counts
any title with both.

> The same rule appears in three places: the HR department view (`:1512`), the
> department rollup (`:1804`) and the designation roster (`:1888`). If you
> change the resolution rule, change all three, or the same title reports
> different numbers on different screens.

---

## 5. Current live state

| | |
|---|---|
| Published shelves | 265 |
| Library rows | 2,145 |
| Active employees | 1,398 |
| Distinct titles held | 90 across 34 departments |
| Titles held but **not** published for | 4 |
| Rows carrying a Department | **0** |
| `kra_library_scope` | `department+designation` (ON) |

**The department dimension is switched on but no data uses it.** Every
employee is on the company-wide fallback path. Until HR re-uploads with a
Department column — or adds one only where a title genuinely differs between
departments — the department controls are structurally live and functionally
inert. That is the correct behaviour, not a bug.

---

## 6. Making a change

| To change | Where |
|---|---|
| Upload help text, column list | `KraLibraryPage.jsx` 87–113 |
| Department / Designation filters | 144–171 |
| Department-view rows and chips | 184–207 |
| Department-view footer totals | 208–218 |
| Published-shelf row and its chips | 226–260 |
| The uncovered list | 262–280 |
| Which shelves are counted, and how | `index.js` 1456–1536 |
| Upload validation rules | `validateKraBulkRows()` in `index.js` |

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Make the Department control filter `shelves` client-side | that is the dead-looking filter this replaced |
| Replace `own_kras \|\| fallback_kras` with `own + fallback` | titles with both shelves double-count |
| Forward-fill Department down the column in the parser | publishes one department's KRAs under another |
| Make an unheld designation a hard error | blocks HR from publishing ahead of a hire |
| Force a shelf to total 100 | it is a menu, not a scorecard |

### Schema

`pms.kra_library` — `server/migrations/033-kra-library.js`, department column
added in `034-kra-library-department.js`.

```
id · tenant_id · department · designation · category · title · measures
description · suggested_weight · sort_order · uploaded_by · uploaded_at
```

Migrations run in-process at boot, are idempotent, and **fail the boot** if one
throws — a bad migration stops the deploy rather than half-applying. Add a new
one as `server/migrations/NNN-name.js` exporting `up(db)`; never edit a
migration that has already run in production.

---

## 7. Deploy

```bash
# on the EC2 host (i-0b15f364a2f4cf09a, ap-south-1)
sudo /opt/agentic-pms/deploy/service/update.sh
```

Pulls `main`, installs, builds the frontend into `/var/www/agentic-pms`,
restarts `agentic-pms-api`, waits for health.

> `VITE_API_URL` must stay **unset** on the host — it is baked in at build time
> and the frontend is served from the same origin as the API.

### Verify

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'        # expect your commit
systemctl is-active agentic-pms-api nginx              # active active
curl -fsS http://127.0.0.1/api/v1/health               # {"ok":true,…}
curl -s -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1/api/v1/pms/hr/kra-library        # 401 = alive and guarded, never 500
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

Frontend-only change — confirm the served bundle is the one you built (Vite
hashes on content, so a matching filename means a matching bundle):

```bash
sha256sum /var/www/agentic-pms/assets/index-*.js
curl -s https://pms.agentichumans.in/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
```

Read the real payload without a password by minting a short-lived HR token with
the service's own secret on the host:

```bash
cd /opt/agentic-pms/server
TOK=$(sudo env $(sudo grep -E '^(JWT_SECRET|DATABASE_URL|DATABASE_SSL)=' \
      /etc/agentic-pms/api.env | xargs) node -e "
const jwt=require('jsonwebtoken'), db=require('./core/db');
(async()=>{const e=(await db.query(\"SELECT id,email,name,tenant_id FROM core.employees WHERE lower(email)='hr.admin@mindgate.com' LIMIT 1\")).rows[0];
console.log(jwt.sign({sub:e.id,email:e.email,name:e.name,role:'hr',tenant_id:e.tenant_id},process.env.JWT_SECRET,{expiresIn:'5m'}));await db.pool.end();})()")
curl -s -H "Authorization: Bearer $TOK" \
     'http://127.0.0.1/api/v1/pms/hr/kra-library?department=Admin' | python3 -m json.tool | head -40
```

---

## 8. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

436 tests, 0 failures. Relevant files: `test/kra-library.test.js` (the parser
and the menu-not-scorecard rule), `test/change-requests.test.js` (the
department boundary rules), `test/kra-shelf-department-total.test.js` (the
counting rules shared with the employee picker).

> **Run against a fresh database every time.** Re-running against a used one
> produces four phantom failures in `self-appraisal-rating.test.js` from
> leftover rows. They are not real.

---

## 9. Open decisions for HR (not code)

1. **Re-upload the library with Departments**, or add them only where a title
   genuinely differs between departments? Until one of these happens the
   department dimension is inert.
2. **Four titles held by employees have no shelf at all.** They appear in the
   "Designations nobody has published for" list, ordered by how many people
   they affect.
3. **`kra_library_scope` is ON in production.** If the department dimension is
   not going to be used, turning it back to `designation` removes two controls
   from every employee's My KRAs page. The SQL is in
   `docs/PAGE-MY-KRAS-LIBRARY-PICKER.md` §4.

# KRA Library — code bundle for deploying to a PoC account

Everything that makes the **HR Admin → KRA Library** screen work: the two
migrations that create the table, the server section that owns the routes,
both frontend pages, and the tests.

**Current on `main`:** `1bcbecd`. This bundle is cut from that commit.
**Schema:** migrations `033` and `034`. Both idempotent.

---

## The screen this bundle is for

![The department view — one row per job title the department employs](images/hr-kra-library-02-department-view.png)

That page is `GET /api/v1/pms/hr/kra-library?department=…`, rendered by
`frontend/src/pages/KraLibraryPage.jsx`. Every number on it comes off the
server; nothing is computed in the browser.

Its response, taken from the live host for the department in the screenshot:

```json
{
  "scope": "department+designation",
  "department": "Application Support",
  "department_view": [
    {"designation": "Senior Software Analyst", "employees": 114,
     "own_kras": 0, "fallback_kras": 8, "source": "fallback", "kras": 8},
    {"designation": "Software Analyst", "employees": 33,
     "own_kras": 0, "fallback_kras": 8, "source": "fallback", "kras": 8}
  ],
  "departments": [ "Accounts", "Admin", "…34 in total" ],
  "shelves":     [ { "designation": "…", "department": null, "kras": 12, "…": "" } ],
  "uncovered":   [ {"designation": "Vice President I", "employees": 11} ],
  "ambiguous":   [ {"designation": "Manager", "departments": 15, "employees": 60} ]
}
```

| On screen | Comes from |
|---|---|
| `Application Support` in the Department dropdown | `departments[]` — every department with at least one active employee (34 here) |
| `All 11 titles in Application Support` | the length of `department_view[]` |
| one row per job title | one entry in `department_view[]` |
| `Senior Software Analyst · 114 employees` | `employees` — a live count from `core.employees`, **not** from the library |
| `8 KRAs` | `kras` — what that title would actually load |
| `company-wide` | `source: "fallback"` |
| `View KRAs` | `GET /hr/kra-library/:designation?department=…` |

> **`company-wide` on every row is meaningful, not a placeholder.** `source`
> is `"fallback"` because `own_kras` is `0` — no shelf names that
> department, so the title falls back to the company-wide shelf. On the
> current live data that is true for **every** row in **every** department,
> because no published row carries a Department yet. See §G.

Two fields the screenshot does not show, further down the page, both worth
knowing about:

- **`uncovered[]`** — titles employees hold that **no** shelf matches, so
  those people open an empty library. Live today: `Vice President I` (11
  people), `Senior Vice President II` (3), `Senior Vice President I` (1),
  `Senior Administrator - Network and System` (1).
- **`ambiguous[]`** — titles held across many departments, where one
  company-wide shelf is probably wrong. Live today: `Manager` across 15
  departments (60 people), `Senior Manager` across 15 (28).

---

## A · The normal way: pull and deploy

If the PoC host is the standard build, you do not need these files at all:

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

That pulls `main`, `npm ci`, builds the frontend into `/var/www/agentic-pms`,
restarts `agentic-pms-api` and waits for health. Migrations run **in-process
at boot** and **fail the boot** if one throws, so a bad migration stops the
deploy rather than half-applying it.

> `VITE_API_URL` must stay **unset** on the host — it is baked in at build
> time and the frontend is served from the same origin as the API.

**Use this bundle instead when** the PoC is not on this git remote, or you
are porting the feature into a different checkout.

---

## B · Manual install

### What is verbatim and what is not

| File | |
|---|---|
| `server/migrations/033-kra-library.js` | **verbatim** — copy as-is |
| `server/migrations/034-kra-library-department.js` | **verbatim** — copy as-is |
| `frontend/src/pages/KraLibraryPage.jsx` | **verbatim** — copy as-is |
| `frontend/src/pages/KraLibraryPicker.jsx` | **verbatim** — copy as-is |
| `server/test/*.test.js` (3 files) | **verbatim** — copy as-is |
| `server/modules/performance/kra-library.section.js` | **EXCERPT — do NOT copy** |

That last one is lines **1429–2139** of
`server/modules/performance/index.js`, lifted out so the feature can be read
in one place. `index.js` is a single Express router shared by the whole
performance module; the section cannot be split out without splitting the
router, which is a refactor and not a deployment. **Read it, then take the
whole `index.js` from the repo.** Its own header lists everything it depends
on from the rest of that file.

### Steps

1. **Copy the two migrations** into `server/migrations/`. They run
   automatically on the next API boot, in filename order, and are recorded
   in `core.migrations_log`. Do not run them by hand.

2. **Take `server/modules/performance/index.js`** whole from the repo at
   `1bcbecd`. If you are merging into a modified copy, the KRA Library
   section is the block between these two markers:

   ```
   // ====...====
   // KRA LIBRARY — a shelf of suggested KRAs per designation (migration 033)
   ```
   …up to, but not including:
   ```
   // ---------------- Development Plan (Org IDP) — BR-2.1/2.2/2.3 ---------
   ```

3. **Copy both frontend pages** into `frontend/src/pages/`.

4. **Wire the page up** in `frontend/src/App.jsx` — three lines, all of
   which already exist in the repo copy:

   ```jsx
   import KraLibraryPage from './pages/KraLibraryPage';

   // in the nav list:
   { to: '/admin/kra-library', label: 'KRA Library', icon: Library, roles: ['admin', 'hr'] },

   // in the routes:
   <Route path="/admin/kra-library"
          element={<RequireRole user={user} roles={['admin','hr']}><KraLibraryPage /></RequireRole>} />
   ```

   `KraLibraryPicker.jsx` needs no route — it is imported by
   `MyKRASheetPage.jsx` and `TeamKraSheetsPage.jsx`.

5. **Build and restart.**

   ```bash
   cd server   && npm ci
   cd frontend && npm ci && npm run build
   sudo systemctl restart agentic-pms-api
   ```

**No new npm dependency.** `exceljs` and `multer` are already in
`server/package.json`; `lucide-react` is already in the frontend's.

---

## C · Turn the Department dimension on

The screenshot shows the Department dropdown, which only appears when the
scope setting is on. It is **off by default**.

**Setting:** `core.admin_settings.kra_library_scope`
**Values:** `designation` (default) · `department+designation`
**UI:** HR Admin → Settings → *KRA Library scope*

```sql
-- ON — what the screenshot shows
INSERT INTO core.admin_settings (tenant_id, key, value)
SELECT id, 'kra_library_scope', '{"mode":"department+designation"}'::jsonb
  FROM core.tenants
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;

-- OFF — one shelf per job title, no Department or Designation dropdown
UPDATE core.admin_settings SET value = '{"mode":"designation"}'::jsonb
 WHERE key = 'kra_library_scope';
```

Switching it on is safe but **pointless until at least one published row
names a department** — until then every employee correctly falls back to the
company-wide shelf, which is why the screenshot reads `company-wide` on all
eleven rows.

---

## D · Verify

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx        # active active
curl -fsS http://127.0.0.1/api/v1/health
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

Migrations applied, table shaped correctly:

```bash
DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
# NOTE: a regex, not LIKE — SQL LIKE has no [34] character class and
# would match nothing, which reads exactly like a failed migration.
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT filename FROM core.migrations_log WHERE filename ~ '^03[34]-' ORDER BY filename"
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT column_name FROM information_schema.columns
    WHERE table_schema='pms' AND table_name='kra_library' ORDER BY ordinal_position"
```

Expect `033-kra-library.js`, `034-kra-library-department.js`, and a column
list ending in `department`.

Routes alive and guarded — `401` unauthenticated, never `404`, never `500`:

```bash
for R in "hr/kra-library" "hr/kra-library/template.csv" "my/kra-library"; do
  printf '%-32s ' "$R"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1/api/v1/pms/$R"
done
```

Read the real payload as HR without a password, by minting a short-lived
token with the service's own secret on the host:

```bash
cd /opt/agentic-pms/server
TOK=$(sudo env $(sudo grep -E '^(JWT_SECRET|DATABASE_URL|DATABASE_SSL)=' \
      /etc/agentic-pms/api.env | xargs) node -e "
const jwt=require('jsonwebtoken'), db=require('./core/db');
(async()=>{const e=(await db.query(\"SELECT id,email,name,tenant_id FROM core.employees WHERE lower(email)='hr.admin@mindgate.com' LIMIT 1\")).rows[0];
console.log(jwt.sign({sub:e.id,email:e.email,name:e.name,role:'admin',tenant_id:e.tenant_id},process.env.JWT_SECRET,{expiresIn:'5m'}));await db.pool.end();})()")

# the screenshot's own call
curl -s -H "Authorization: Bearer $TOK" \
  "http://127.0.0.1/api/v1/pms/hr/kra-library?department=Application%20Support" \
  | python3 -m json.tool | head -40

# the template, first line
curl -s -H "Authorization: Bearer $TOK" \
  http://127.0.0.1/api/v1/pms/hr/kra-library/template.csv | head -1
```

The template's header must read exactly:

```
Department,Designation,Parameters,KRA (S.M.A.R.T GOALS),KPIs (Measuring Metrics & Data Source),Suggested Weightage,Comments
```

If `Department` is missing, the build predates `7ad57be` and HR will not be
able to publish departmental shelves.

---

## E · Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

Three files in this bundle cover the library:

| File | Covers |
|---|---|
| `kra-shelf-department-total.test.js` (7) | the counts on the screenshot, including *"THE TOP LINE IS THE SUM OF THE LINES BELOW IT"* |
| `kra-library-template.test.js` (6) | the template the route emits actually imports; Department fills down a block and resets on a new designation |
| `kra-library-edit.test.js` (8) | in-place edit and remove, permissions, and *"EDITING THE SHELF DOES NOT TOUCH WHAT SOMEBODY ALREADY PICKED"* |

**Run against a fresh database every time.** Re-running against a used one
produces four phantom failures in `self-appraisal-rating.test.js` from
leftover rows. They are not real.

---

## F · The five things a new developer gets wrong

| Don't | Because |
|---|---|
| Register `/hr/kra-library/:designation` before `/template.xlsx` or `/entry/:id` | Express matches in order — `:designation` swallows both, and the template download starts 404ing |
| Replace `COALESCE(NULLIF(own,0), fallback)` with `own + fallback` or an `OR` | every title holding both a department shelf and a company-wide one double-counts. This shipped once and was fixed in `06d077c` |
| Treat `department === ''` as "nothing selected" | `''` **is** All departments — a real value. The Designation row would never appear again |
| Drop `department` from the employee `SELECT` | department matching silently stops working; the column reads `undefined` on every request and nobody sees an error |
| Assume editing a shelf updates KRAs people already picked | it does not, deliberately — picking **copies** the row. See `kra-library-edit.test.js` |
| Query `core.audit_log` for `KRA_LIBRARY_*` | this module writes to `pms.audit_log`. You will find nothing and conclude the audit is missing |

---

## G · After the deploy — what is HR's, not the developer's

The code being live does not make the screen useful. Two data steps:

1. **Publish the library**, using the template from
   `GET /pms/hr/kra-library/template.xlsx`. Upload is two-step: validate
   (writes nothing) then publish with `?commit=1`. A commit on a file with
   any error writes nothing at all.

2. **Fill in the Department column** if departmental shelves are wanted.
   On the current live data **0 of 2,155 published rows carry a
   department**, which is exactly why every row in the screenshot says
   `company-wide`. That is correct fallback behaviour, not a bug — it is
   also the first thing a new developer will raise a ticket about.

Forward-fill rule, worth knowing before HR fills the file in: **Department
behaves exactly like Designation.** Written once, it carries down the rows
beneath it, and a new Designation clears it.

```
Admin | Manager        -> Admin
      |                -> Admin      carries down the block
      | Senior Manager -> null       a new Designation clears it
Sales |                -> Sales
```

So a blank cell means "company-wide" **only on a designation's first row**;
inside a block it means "same as above".

---

## H · Rollback

Revert the frontend and route changes and rebuild. **Leave both migrations
in place** — `pms.kra_library` is a standalone table nothing else joins to,
and `department` is a nullable column. Dropping either buys nothing and
risks a lock on a populated table. Any published rows simply stop being
read.

---

## I · Reference docs in the repo

| `docs/…` | |
|---|---|
| `PAGE-HR-KRA-LIBRARY.md` | this screen in full — filters, counts, department view |
| `PAGE-MY-KRAS-LIBRARY-PICKER.md` | the employee end, and the scope setting |
| `CHANGE-KRA-LIBRARY-TEMPLATE-DEPARTMENT.md` | the Department column in the template |
| `CHANGE-KRA-LIBRARY-EDIT.md` | in-place editing of a published KRA |
| `KRA-LIBRARY-DEPLOYMENT.md` | the original first deployment |

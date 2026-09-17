# My KRAs — the "Start from the … KRA library" banner

**Screen:** My KRAs (`/my/kras`) — the lagoon-coloured panel above *Add KRA*
**Who sees it:** every employee, on their own sheet; managers and HR see the same
component on a report's sheet
**Deployed as of:** commit `528c2e9` on `main`, live on pms.agentichumans.in

This is the panel that offers an employee the KRAs HR published for their role.
It is a **menu**, not an instruction: it deliberately offers more than 100
points' worth, and which hundred applies is the employee's call with their
manager. Everything added from it stays fully editable.

---

## 1. What is on screen, and where each piece comes from

```
┌────────────────────────────────────────────────────────────────────────┐
│ Start from the Executive KRA library                 [Choose from      │
│ HR has published 8 KRAs for this role. Pick what…     library]         │
│                                                                        │
│ DEPARTMENT   [ All departments · 1,656 KRAs across 34 departments  ▾ ] │
│ DESIGNATION  [ Executive · 8 KRAs ▾ ]  Your designation in Admin — …   │
│                                                                        │
│ These are the company-wide Executive KRAs. Admin has none of its own   │
│ yet, so this is the list that applies to you.                          │
└────────────────────────────────────────────────────────────────────────┘
```

| Element | Rendered at | Value comes from |
|---|---|---|
| Heading + "HR has published **N** KRAs" | `KraLibraryPicker.jsx` 123–134 | `entries.length` — the shelf actually loaded |
| **Department** dropdown | `KraLibraryPicker.jsx` 140–180 | `shelves[]` |
| → `All departments · 1,656 KRAs across 34 departments` | 169–174 | `all_kras`, `all_departments` |
| → `Admin · 70 KRAs across 10 titles` | 156–161 | `department_kras`, `department_titles` |
| **Designation** dropdown | `KraLibraryPicker.jsx` 200–214 | the `mine: true` row of `department_designations[]` |
| "Browsing another department's shelf." | 177–179 | `chosen_by_hand` **and** the choice differs from your own department |
| "These are the company-wide … KRAs." | 215–226 | `scope === 'department+designation'` and no department shelf matched |
| The pick-list popup | `Shelf()`, 269–310 | `entries[]`, grouped by Parameter in HR's published order |

**One endpoint feeds all of it:** `GET /api/v1/pms/my/kra-library`
(`server/modules/performance/index.js:1961`), or
`GET /api/v1/pms/team/kra-library/:employeeId` (`:1985`) when a manager or HR
is filling somebody else's sheet. Both call the same builder,
`kraLibraryFor()` at `:1746`.

> The `source` prop decides **whose** shelf this is. A manager opening a
> report's sheet must see the *report's* designation. Passing the wrong
> endpoint silently offers a Delivery Manager's KRAs to an engineer — it looks
> like a working feature and is wrong.

---

## 2. The three numbers, and why they are different on purpose

This is the part that generates questions. All three are correct and none is
a copy of another.

| Reads | Counts | On live data |
|---|---|---|
| `All departments · 1,656 KRAs across 34 departments` | every KRA served to every job title in **every** department | 1,656 |
| `Admin · 70 KRAs across 10 titles` | every KRA served to every job title **Admin** employs | 70 |
| `Executive · 8 KRAs` | the KRAs published for **this employee's own title** | 8 |

**The invariant that holds them together:** the "All departments" figure is
exactly the sum of the 34 department figures. Pick any department and you are
picking a part of 1,656. There is a test on this
(`server/test/kra-shelf-department-total.test.js`, *"THE TOP LINE IS THE SUM OF
THE LINES BELOW IT"*) because it is the only thing that makes the two kinds of
option belong in one list.

Two rules inside the count:

- **Per title it is the department's own shelf where one exists, else the
  company-wide shelf — never both.** In SQL that is `COALESCE(NULLIF(own, 0),
  fallback)`. An `OR` that unions the two double-counts any title with both,
  which is a bug that already shipped once and was fixed in `06d077c`.
- **Employees with no department are in neither total.** They belong to no
  department, so they cannot be part of "all departments", and counting them
  would break the sum-of-parts rule. *One active employee on live data has no
  department* — an HR record to fix, not a code issue.

### What the label does NOT mean

Selecting an option still loads **this one job title's** shelf — 8 KRAs,
whichever option you pick. The counts describe the department; they do not
predict what the picker will show. That was a deliberate client decision (the
Designation row reports what you actually get). If it ever needs to change,
change the labels, not `entries`.

---

## 3. The rule that decides which shelf loads

`kraLibraryFor()` at `server/modules/performance/index.js:1746`:

1. No designation on the employee record → `reason: 'no_designation'`, the
   banner asks them to have HR set it.
2. Scope is `designation` (the default) → match on designation alone. The
   Department dropdown is not rendered at all.
3. Scope is `department+designation` → look for a shelf matching
   **(department, designation)**; if there is none, fall back to the
   **company-wide** shelf for that designation (`department` blank).
4. `?department=X` overrides the automatic match — `''` is a **real** value
   meaning the company-wide shelf, so the test is for `undefined`/`null`, not
   falsiness.
5. Still nothing → `reason: 'no_library'`.

> Step 3's fallback must never be suppressed because the employee made an
> explicit choice. It was once gated on `!askedValid`, and picking a
> department with no shelf of its own emptied the picker. Fixed in `05c1b12`;
> an option that promises a count has to deliver it.

---

## 4. The setting that turns the Department dimension on

**Key:** `core.admin_settings.kra_library_scope`
**Values:** `designation` (default) · `department+designation`
**Route:** `GET`/`PUT /api/v1/pms/hr/settings` (`:1552`), needs `pms_admin`

```sql
-- switch department matching ON
INSERT INTO core.admin_settings (tenant_id, key, value)
SELECT id, 'kra_library_scope', '{"mode":"department+designation"}'::jsonb
  FROM core.tenants
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;

-- switch it back OFF
UPDATE core.admin_settings SET value = '{"mode":"designation"}'::jsonb
 WHERE key = 'kra_library_scope';
```

With it **off**, no Department dropdown, no Designation dropdown, one shelf per
title — exactly the behaviour that existed before any of this. Switching it on
is safe but pointless until HR publishes at least one shelf that names a
department; until then every employee correctly falls back to the company-wide
list.

**Current live state:** ON. It was switched on in production by
`hr.admin@mindgate.com`, and **no library row carries a department yet**, so
every employee is on the fallback path.

---

## 5. Making a change

Nearly every request against this panel is **wording or visibility**, and lands
in one file: `frontend/src/pages/KraLibraryPicker.jsx`. No server change, no
migration, no rebuild of the API.

| To change | Edit | Line |
|---|---|---|
| The "All departments" label | the `: \`All departments · …\`` branch | 169–174 |
| A department's label | the `sh.department ? …` branch | 156–161 |
| The Designation label | the single `<option>` | 205–207 |
| When Designation appears at all | the `{mine && selectedDept && (` gate | 200 |
| When the Department dropdown appears | `scope === 'department+designation' && shelves.length > 1` | 140 |
| The fallback explanation | the `onFallback` paragraph | 215–226 |

Changing a **number** rather than a label means the server:
`kraLibraryFor()` — the rollup query at `:1804`, the per-shelf assignment at
`:1825–1836`, the designation roster at `:1888`.

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Replace `COALESCE(NULLIF(own,0), fallback)` with `own + fallback` or an `OR` | every title with both shelves double-counts |
| Treat `dept === ''` as "nothing selected" | `''` **is** All departments; the Designation row would never appear again |
| Drop `department` from the employee `SELECT` | department matching silently stops working — the column reads `undefined` on every request, and nobody sees an error |
| Scope the rollup to the menu's departments | the company total stops being the sum of all of them |
| Add `?designation=` to the roster query | it takes `[tenantId, department]` only; an extra parameter 500s the whole endpoint |

---

## 6. Deploy

```bash
# on the EC2 host (i-0b15f364a2f4cf09a, ap-south-1)
sudo /opt/agentic-pms/deploy/service/update.sh
```

Pulls `main`, `npm ci`, builds the frontend into `/var/www/agentic-pms`,
restarts `agentic-pms-api`, waits for health. Migrations run in-process on boot
and **fail the boot** if one throws, so a bad migration stops the deploy rather
than half-applying.

> `VITE_API_URL` must stay **unset** on the host. It is baked in at build time
> and the frontend is served from the same origin as the API.

### Verify

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'        # expect your commit
systemctl is-active agentic-pms-api nginx              # active active
curl -fsS http://127.0.0.1/api/v1/health               # {"ok":true,…}
curl -s -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1/api/v1/pms/my/kra-library        # 401 = alive and guarded, never 500
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

For a frontend-only change, confirm the served bundle is the one you built:

```bash
sha256sum /var/www/agentic-pms/assets/index-*.js       # compare with your local dist/
curl -s https://pms.agentichumans.in/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
```

Vite hashes on content, so a matching filename already means a matching bundle.

To read the real payload without a password, mint a short-lived token with the
service's own secret on the host:

```bash
cd /opt/agentic-pms/server
TOK=$(sudo env $(sudo grep -E '^(JWT_SECRET|DATABASE_URL|DATABASE_SSL)=' \
      /etc/agentic-pms/api.env | xargs) node -e "
const jwt=require('jsonwebtoken'), db=require('./core/db');
(async()=>{const e=(await db.query(\"SELECT id,email,name,tenant_id FROM core.employees WHERE status='active' AND department='Admin' LIMIT 1\")).rows[0];
console.log(jwt.sign({sub:e.id,email:e.email,name:e.name,role:'employee',tenant_id:e.tenant_id},process.env.JWT_SECRET,{expiresIn:'5m'}));await db.pool.end();})()")
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1/api/v1/pms/my/kra-library | python3 -m json.tool
```

Expected shape today:

```json
"shelves": [
  {"department": null,    "kras": 8, "all_kras": 1656, "all_departments": 34},
  {"department": "Admin", "kras": 8, "inherited": true,
   "department_kras": 70, "department_titles": 10}
]
```

---

## 7. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

436 tests, 0 failures. `server/test/kra-shelf-department-total.test.js` is the
one that covers this panel's numbers.

> **Run against a fresh database every time.** Re-running against a used one
> produces four phantom failures in `self-appraisal-rating.test.js` from
> leftover rows. They are not real, and chasing them wastes an afternoon.

---

## 8. Change history

| Commit | What |
|---|---|
| `cc71ae5` | Department dimension added (migration `034`) |
| `3d1ce31` | Fixed: shelf routes never selected `department`, so matching could not fire |
| `05c1b12` | HR department filter rebuilt as a server-side department view |
| `03bf458` | Fixed: picking a department with no shelf emptied the picker |
| `603a11b` | Department's other titles listed, locked |
| `06d077c` | Department option counts the whole department; fixed the roster double-count |
| `9992a77` | `(yours)` removed from the department option |
| `39547fb` | Only the employee's own designation shown; the other titles hidden |
| `0f0fe0c` | "All departments" counts every department, added up |
| `528c2e9` | Designation appears only once a department is chosen |

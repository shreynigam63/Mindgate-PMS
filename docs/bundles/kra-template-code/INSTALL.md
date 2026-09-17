# KRA Library template — code bundle for a PoC account

The code that produces the file HR downloads from **HR Admin → KRA Library →
*Download template (.xlsx)* / *.csv***, and the code that reads it back.

**Cut from `main` at `b15595d`** · **No migration** · **HR-only** (`pms_admin`)

![The upload card and its column list](images/kra-template-01-upload-card.png)

---

## 1. What is in here

| File | |
|---|---|
| `server/modules/performance/kra-template.section.js` | the generator — **excerpt, read only** |
| `server/modules/performance/kra-parser-department.section.js` | how the file is read back — **excerpt, read only** |
| `server/test/kra-library-template.test.js` | 6 tests — **verbatim, copy as-is** |
| `files/KRA-Library-Template.xlsx` | the generated file, pulled from the live server |

**Neither `.section.js` is a module.** Each is a verbatim slice of
`server/modules/performance/index.js`, lifted out so the template can be read
in one place. That file is a single Express router shared by the whole
performance module, so the slices cannot be split out without splitting the
router — a refactor, not a deployment. Each file's header gives its exact line
range and everything it needs from the rest of `index.js`.

**To deploy: `git pull` and run the deploy script, or take `index.js` whole.**

---

## 2. The template itself

Three constants and two routes.

```js
KRA_LIBRARY_BANNER    // row 1, italic, merged across all columns — the fill rules
KRA_LIBRARY_HEADERS   // row 2, bold, wrapped — seven columns, Department FIRST
KRA_LIBRARY_SAMPLE    // rows 3-5 — the client's own example, kept as sent
```

```
Department | Designation | Parameters | KRA (S.M.A.R.T GOALS) |
KPIs (Measuring Metrics & Data Source) | Suggested Weightage | Comments
```

| Route | Emits |
|---|---|
| `GET /pms/hr/kra-library/template.xlsx` | banner + headers + samples, column widths set |
| `GET /pms/hr/kra-library/template.csv` | the same, newlines in headers flattened to spaces |

The `.csv` writer flattens `KRA \n(S.M.A.R.T GOALS)` to one line and quotes any
cell containing a comma or a quote. Without the flattening the header row
would break across lines and the file would not parse as CSV at all.

---

## 3. The rule that silently publishes the wrong shelf

**Department forward-fills exactly like Designation.** Written once it carries
**down** the rows beneath it, and **a new Designation clears it**.

```
Admin | Manager        -> Admin
      |                -> Admin      carries down the block
      | Senior Manager -> null       a new Designation clears it
Sales |                -> Sales
      |                -> Sales
```

So a blank cell means **company-wide only on a designation's FIRST row**.
Inside a block it means "same as above".

The reset is the load-bearing half. Without it one role's department leaks
onto the next role's KRAs. That exact bug already happened to the
**Parameters** column in the client's own file: Parameters was carried across
a designation boundary and **235 KRAs were filed under a heading nobody
chose** — 14 designations whose source workbooks had no Parameters column at
all inherited the last value from whichever role happened to sit above them.
Nothing in the file said so and nothing in the report warned. The comment at
(B) in `kra-parser-department.section.js` records it.

Both halves of the rule are stated in the banner and in the page's help text,
because this is the one thing about the column that fails silently.

---

## 4. Template and parser are one contract

Every header the template prints must map through `KRA_HEADER_ALIASES`, or HR
fills in the app's **own official file** and every row is rejected.

Department is accepted as any of:

```
Department · Departments · Dept · Function · Business Unit
```

Two aliases exist purely because of this template:

```js
suggested_weightage: 'weight',  suggested_weight: 'weight',
```

The template heads that column *"Suggested Weightage"* — on a shelf the number
really is only a suggestion. Without those two aliases the header scan finds no
weight column, concludes the file has no KRA table at all, and **rejects the
app's own template**. The tests caught that.

One more, from the field: the client returned our template with the header
**`Designations`** (plural) and it was rejected with *"missing required
column(s): designation"* against a file that was otherwise perfect — 2,145 KRAs
across 265 designations, no other error. One letter. Plurals are now aliased.

> **`title` is deliberately NOT an alias for designation.** In a KRA sheet that
> word means the KRA's own title far more often than a job title, and mapping
> it would file every KRA under a designation named after itself.

---

## 5. Deploy

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

**No migration. No data touched.** The template is generated per request —
nothing is stored.

### Verify the deployed route emits the right header

```bash
cd /opt/agentic-pms/server
TOK=$(sudo env $(sudo grep -E '^(JWT_SECRET|DATABASE_URL|DATABASE_SSL)=' \
      /etc/agentic-pms/api.env | xargs) node -e "
const jwt=require('jsonwebtoken'), db=require('./core/db');
(async()=>{const e=(await db.query(\"SELECT id,email,name,tenant_id FROM core.employees WHERE lower(email)='hr.admin@mindgate.com' LIMIT 1\")).rows[0];
console.log(jwt.sign({sub:e.id,email:e.email,name:e.name,role:'admin',tenant_id:e.tenant_id},process.env.JWT_SECRET,{expiresIn:'5m'}));await db.pool.end();})()")

curl -s -H "Authorization: Bearer $TOK" \
  http://127.0.0.1/api/v1/pms/hr/kra-library/template.csv | head -1
```

Must be exactly:

```
Department,Designation,Parameters,KRA (S.M.A.R.T GOALS),KPIs (Measuring Metrics & Data Source),Suggested Weightage,Comments
```

If `Department` is missing, the build predates `7ad57be` and HR cannot publish
departmental shelves.

And the `.xlsx`, including that the banner carries the fill rule:

```bash
curl -s -H "Authorization: Bearer $TOK" -o /tmp/t.xlsx \
  http://127.0.0.1/api/v1/pms/hr/kra-library/template.xlsx
node -e "
const ExcelJS=require('exceljs');
(async()=>{const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile('/tmp/t.xlsx');
const ws=wb.getWorksheet('KRA Library');
console.log(JSON.stringify(ws.getRow(2).values.slice(1).map(v=>v&&v.richText?v.richText.map(t=>t.text).join(''):v)));
console.log('banner states the fill rule:', /carries down/i.test(String(ws.getRow(1).getCell(1).value||'')));})()"
rm -f /tmp/t.xlsx
```

Unauthenticated probes — `401`, never `404`, never `500`:

```bash
for R in template.xlsx template.csv; do
  printf '  %-16s ' "$R"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1/api/v1/pms/hr/kra-library/$R"
done
```

---

## 6. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

`server/test/kra-library-template.test.js` — 6 tests. Two carry the weight:

- **`THE TEMPLATE THE ROUTE EMITS ACTUALLY IMPORTS`** — downloads the real
  `.xlsx` and feeds it to the real parser, so §4's contract cannot quietly
  break.
- **`DEPARTMENT FILLS DOWN A BLOCK AND RESETS ON A NEW DESIGNATION`** — pins
  both halves of §3. It exists because the opposite was documented for a day:
  an earlier note claimed Department did *not* forward-fill. It does.

> **A fresh database every time.** Re-running against a used one produces four
> phantom failures in `self-appraisal-rating.test.js` from leftover rows.

---

## 7. Things that will break if "tidied"

| Don't | Because |
|---|---|
| Register `/hr/kra-library/:designation` before the two template routes | Express matches in order — the param route swallows the literal filename and the download 404s |
| Rename a header without adding the alias to the parser | HR fills in the app's own official file and every row is rejected |
| Drop `suggested_weightage` / `suggested_weight` from the aliases | the header scan finds no weight column and rejects our own template |
| Add a bare `title` alias for designation | every KRA gets filed under a designation named after itself |
| Change the banner to say Department does not fill down | it does — the file would then lie about the rule that matters |
| Drop the sample rows | they are the only worked example of the column, and the banner tells HR to delete them |
| Stop clearing the carry on a new designation | one role's department leaks onto the next role's KRAs — see §3 |

---

## 8. Rollback

Revert `7ad57be`. **Nothing persists** — the template is generated per request.
Library rows already published **with** a department stay valid; the parser has
understood that column since migration `034`.

---

## 9. What this does NOT do

Shipping this changes nothing an employee sees. It makes an existing capability
**discoverable**: the parser has accepted Department since `034`, but the
template never offered the column, so it was reachable only by somebody who had
read the source.

The remaining step is HR's: **re-upload the library with Department filled in.**
Until then every shelf is a company-wide fallback and the department dropdowns
on *My KRAs* are structurally live but functionally inert. **That is correct
behaviour, not a bug** — and it is the first thing a new developer will raise a
ticket about.

> There is currently **no route to export the published rows**, so HR cannot
> download what is live, add a column and re-upload. They must work from the
> original source file.

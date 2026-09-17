# Change — Department added to the KRA Library template

**Screen:** KRA Library (`/admin/kra-library`) — the *Publish a shelf* card
**Shipped as:** `7ad57be` · live on pms.agentichumans.in
**Schema change:** none
**Type:** template + help text. No parser change — see §2, which is the point.

Asked for with a filled-in example of the sheet wanted. The only difference
from the template the app produced was a **Department** column, first.

---

## 1. Before and after

```
before   Designation | Parameters | KRA (S.M.A.R.T GOALS) | KPIs (…) | Suggested Weightage | Comments
after    Department | Designation | Parameters | KRA (S.M.A.R.T GOALS) | KPIs (…) | Suggested Weightage | Comments
```

Both `.xlsx` and `.csv` emit it, and the page's column list matches.

![The upload card with the new column list](images/kra-template-01-upload-card.png)

---

## 2. Why the column was missing — worth understanding before you demo

**The parser has accepted `Department` since migration `034`.** It is
recognised under `Department`, `Dept`, `Departments` or `Business Unit`. What
never had it was the template HR downloads.

So the column was reachable only by somebody who had read the source. That is
the whole reason **not one published row on the client PoC carries a
department** while the department dimension is switched on: nobody was ignoring
the feature — they could not see it.

Nothing about matching, storage or the employee-facing picker changed here.
This change makes an existing capability **discoverable**.

---

## 3. The forward-fill rule — the one thing to get right

`Department` behaves **exactly like `Designation`**:

```
Admin | Manager        → Admin
      |                → Admin     carries down the block
      | Senior Manager → null      a new Designation clears it
Sales |                → Sales
      |                → Sales
```

Which is how HR actually writes these files: "Development" once above forty
rows, not on all forty — the same way Parameters is written.

**So a blank cell means "company-wide" only on a designation's FIRST row.**
Inside a block it means "same as above". The reset at a new designation is the
load-bearing half: without it one role's department leaks onto the next role's
KRAs.

Both halves are stated in the template banner and in the page's help text,
because this is the rule that silently publishes the wrong shelf.

> **Correction on record.** `PAGE-HR-KRA-LIBRARY.md` previously said Department
> did *not* forward-fill. That was wrong, and it contradicted a test that was
> already passing — the claim came from reading a test that only exercised a
> blank Department across a designation **change**, which is the resetting
> case. Corrected after checking the parser against a real file.
> `kra-library-template.test.js` now pins both halves.

---

## 4. Where the code is

| Piece | File |
|---|---|
| Headers, banner, sample rows | `server/modules/performance/index.js` — `KRA_LIBRARY_HEADERS`, `KRA_LIBRARY_BANNER`, `KRA_LIBRARY_SAMPLE` |
| Template `.xlsx` route | `GET /pms/hr/kra-library/template.xlsx` |
| Template `.csv` route | `GET /pms/hr/kra-library/template.csv` |
| The forward-fill itself (unchanged) | `parseKraSheet()`, `carriedDepartment` |
| Page help text | `frontend/src/pages/KraLibraryPage.jsx` |
| Tests | `server/test/kra-library-template.test.js` (6) |

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Rename a header in the template without adding the alias to the parser | HR fills in the app's own official file and every row is rejected |
| Change the banner to say Department does not fill down | it does; the page would then be lying about the rule that matters |
| Drop the sample rows | they are the only worked example of the column, and the banner tells HR to delete them |

---

## 5. Deploy

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

**No migration.** No data is touched — this is a generated file and some help
text.

### Verify

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx
curl -fsS http://127.0.0.1/api/v1/health
```

Download the template from the live route as HR and read the header back:

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

Expected:

```
Department,Designation,Parameters,KRA (S.M.A.R.T GOALS),KPIs (Measuring Metrics & Data Source),Suggested Weightage,Comments
```

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

---

## 6. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

`server/test/kra-library-template.test.js`. Two matter:

- **`THE TEMPLATE THE ROUTE EMITS ACTUALLY IMPORTS`** — downloads the real
  `.xlsx` and feeds it to the real parser, so the template and the parser
  cannot drift apart again.
- **`DEPARTMENT FILLS DOWN A BLOCK AND RESETS ON A NEW DESIGNATION`** — pins
  both halves of §3, written because the opposite was documented for a day.

---

## 7. Rollback

Revert `7ad57be`. Nothing persists — the template is generated per request.
Any library rows HR published **with** a department stay valid; the parser has
always understood them.

---

## 8. What this unblocks, and what HR still has to do

This change alone changes nothing an employee sees. It makes the next step
possible:

1. HR downloads the new template.
2. HR re-uploads the library **with the Department column filled in** — either
   everywhere, or only where a job title genuinely differs between departments.
3. Only then do the Department controls on *My KRAs* stop being inert.

Until step 2, every employee correctly falls back to the company-wide shelf,
and the department dropdowns are structurally live but functionally empty.
**That is correct behaviour, not a bug** — the first thing a new developer
would otherwise raise a ticket about.

State on the client PoC at the time of writing: 2,155 library rows, **0 with a
department**, `kra_library_scope` set to `department+designation`.

> If departments are not going to be used at all, turning the setting back to
> `designation` removes two controls from every employee's My KRAs page. The
> SQL is in `PAGE-MY-KRAS-LIBRARY-PICKER.md` §4.

---

## 9. Related

- **`PAGE-HR-KRA-LIBRARY.md`** — the full page reference: filters, department
  view, how shelves are counted.
- **`PAGE-MY-KRAS-LIBRARY-PICKER.md`** — what the employee sees, and the
  setting that turns the whole dimension on.

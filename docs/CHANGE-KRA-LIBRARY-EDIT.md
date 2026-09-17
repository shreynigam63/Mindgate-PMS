# Change — HR can edit a published KRA and its weightage in place

**Screen:** KRA Library (`/admin/kra-library`) — inside an expanded shelf
**Shipped as:** `51bc6b4`, merged in `f3f1e80` · live on pms.agentichumans.in
**Schema change:** none — still 37 migrations
**Type:** new capability, **HR and Admin only**. No employee sees anything change.

Asked for directly:

> *"KRAs and weightage should be editable for HR and admin login under KRA
> library."*

Until now the KRA Library was **publish-only**. The only way to fix a typo in
a published KRA, or nudge a suggested weight from 15 to 20, was to re-upload
the entire designation's shelf from a spreadsheet. Nobody does that for one
word, so the typo stays — in front of every employee who holds that job title.

---

## 1. What it looks like

**A · The shelf as it stands.** Each line now carries a pencil. This is the
Admin » Executive shelf, totalling **100%**.

![The shelf, read-only, with an edit control per row](images/kra-edit-01-shelf-readonly.png)

**B · A row opened.** Parameter, the KRA text, weightage, KPIs and Comments
become fields **in place** — no modal, no separate page, so the rest of the
shelf stays on screen while HR types.

![A row opened for editing](images/kra-edit-02-row-open.png)

**C · Saved.** The weight moved 15 → 22.5, and the shelf's total chip moved
**100% → 107.5%** immediately.

![Saved, and the shelf total has moved](images/kra-edit-03-saved.png)

> **The chip is the feature, not decoration.** A shelf is a menu that has to
> add up to something an employee can build 100% out of. HR needs to see the
> shelf cross 100% *as they type*, not discover it after a reload. That is why
> `save()` calls `onChanged()` and the parent re-fetches the counts.

**D · After a full page reload.** The edited row and 22.5% are still there —
the write is real, not optimistic UI.

![After a reload, the edit persisted](images/kra-edit-04-after-reload.png)

**E · A refusal.** Clearing the KRA text gives *"The KRA text cannot be
empty"* and writes nothing.

![An empty KRA text is refused](images/kra-edit-05-refused.png)

> Captured in a browser against a **restored copy** of the live database,
> never production. Re-shoot after any change to this panel.

---

## 2. The one rule that matters — editing the shelf changes nothing already picked

**When an employee picks a KRA from the library, the row is COPIED onto their
sheet.** It is not a reference. Fixing a typo on the shelf will not rewrite a
sheet somebody has already filled in, submitted, or had approved.

| | |
|---|---|
| Editing a shelf row changes | what the **next** person is offered |
| Editing a shelf row does **not** change | anything already on anybody's appraisal |

This is deliberate, and it is the thing to explain when a client asks why
their correction "didn't apply everywhere". The alternative — edits
propagating — would silently rewrite the objectives an employee agreed with
their manager, mid-cycle, after submission, with no notification. That is a
much larger change and should never happen by accident.

There is a test named for it so the behaviour cannot be "tidied" away:
`EDITING THE SHELF DOES NOT TOUCH WHAT SOMEBODY ALREADY PICKED`.

---

## 3. What is editable, and who may do it

| Field | Editable | Note |
|---|---|---|
| KRA text (S.M.A.R.T goal) | yes | **required** — empty is refused |
| Suggested weightage | yes | 0–100, blank allowed |
| Parameter | yes | the grouping chip |
| KPIs / measures | yes | |
| Comments | yes | |
| Designation | **no** | moving a KRA between shelves is a re-upload |
| Department | **no** | same |

**Permission:** `pms_admin` — HR and Admin logins. An ordinary employee gets
`403` on both routes, verified on the live host (§6).

> The ask was "KRAs and weightage". Parameter, KPIs and Comments came with
> them because they sit in the same row and the shelf was otherwise
> publish-only: a wrong Parameter puts the KRA under the wrong heading in
> every employee's picker, and it would be strange to fix the text but not
> that. **Remove from shelf** was added for the same reason — a duplicated
> line otherwise still needs a full re-upload.

### Blank weightage is not zero

A blank weight stores `NULL`, not `0`, and the shelf renders it as `—`.
`0%` and *"no suggested weight"* are different statements to the employee
reading the menu, and the field's helper text says `blank = no suggested
weight`.

---

## 4. Refusals — stated, never silent

House rule: a refused write says what was wrong and writes nothing.

| Input | Answer | Status |
|---|---|---|
| Empty or whitespace-only KRA text | `The KRA text cannot be empty` | `422` |
| `abc` in weightage | `Weightage must be a number — got "abc"` | `422` |
| `250` in weightage | `Weightage must be between 0 and 100 — got 250` | `422` |
| `-5` in weightage | `Weightage must be between 0 and 100 — got -5` | `422` |
| A row id that does not exist | `KRA not found` | `404` |
| An ordinary employee | `Requires 'pms_admin'` | `403` |
| No token | — | `401` |

Weightage is rounded to two places **in the route** (`Math.round(w*100)/100`)
rather than being handed to Postgres to truncate against `numeric(6,2)`, so
`22.456` is stored as `22.46` and what HR sees back is what was saved.

A weight over 100 on a single KRA is refused because it cannot be part of any
sheet that totals 100. Note this is a **per-KRA** bound — the **shelf** total
is deliberately allowed past 100% (it is a menu offering more than one
person's worth), which is why C above sits happily at 107.5%.

---

## 5. Everything is audited

Weightage feeds ratings, so every change to a published shelf is on the
record in `pms.audit_log`:

| Action | Carries |
|---|---|
| `KRA_LIBRARY_ENTRY_EDITED` | the row id, designation, department, and the **full before and after** of every field |
| `KRA_LIBRARY_ENTRY_REMOVED` | the row id, designation, department, and the title that was removed |

"Who changed the weighting on this objective, and what was it before" has a
queryable answer:

```sql
SELECT at, actor_email, details->>'designation' AS shelf,
       details->'before'->>'suggested_weight' AS was,
       details->'after' ->>'suggested_weight' AS now,
       left(details->'after'->>'title', 60) AS kra
  FROM pms.audit_log
 WHERE action = 'KRA_LIBRARY_ENTRY_EDITED'
 ORDER BY at DESC LIMIT 20;
```

> Note the table: `pms.audit_log`, **not** `core.audit_log`. The performance
> module has its own. Querying the wrong one returns zero rows and looks like
> the audit is missing.

---

## 6. Deploy

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

**No migration.** No data is touched by deploying — this adds two routes and
an editing surface.

> `VITE_API_URL` must stay **unset** on the host.

### Before — snapshot, so you can prove nothing moved

```bash
DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM pms.kra_library"
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM pms.kras"
```

### After

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx        # active active
curl -fsS http://127.0.0.1/api/v1/health
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

The deployed tree is the one you tested — compare the hashes, not the commit
subject (the host's pull rebases, so its HEAD may read the feature commit
rather than the merge commit; the tree is what matters):

```bash
git -C /opt/agentic-pms rev-parse HEAD^{tree} origin/main^{tree}   # must match
```

Both routes registered and guarded:

```bash
DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
ID=$(sudo -u postgres psql -d "$DB" -tAc "SELECT id FROM pms.kra_library LIMIT 1" | tr -d ' ')
curl -s -o /dev/null -w 'PUT    unauth %{http_code}\n' -X PUT -H 'Content-Type: application/json' \
     -d '{}' "http://127.0.0.1/api/v1/pms/hr/kra-library/entry/$ID"
curl -s -o /dev/null -w 'DELETE unauth %{http_code}\n' -X DELETE \
     "http://127.0.0.1/api/v1/pms/hr/kra-library/entry/$ID"
```

Expect `401` from both. A `404` means the build did not land.

### Prove it end to end without writing to a live shelf

Mint a short-lived HR token on the host and exercise only the **refusal**
paths — they prove routing, permission and validation, and write nothing:

```bash
cd /opt/agentic-pms/server
TOK=$(sudo env $(sudo grep -E '^(JWT_SECRET|DATABASE_URL|DATABASE_SSL)=' \
      /etc/agentic-pms/api.env | xargs) node -e "
const jwt=require('jsonwebtoken'), db=require('./core/db');
(async()=>{const e=(await db.query(\"SELECT id,email,name,tenant_id FROM core.employees WHERE lower(email)='hr.admin@mindgate.com' LIMIT 1\")).rows[0];
console.log(jwt.sign({sub:e.id,email:e.email,name:e.name,role:'admin',tenant_id:e.tenant_id},process.env.JWT_SECRET,{expiresIn:'5m'}));await db.pool.end();})()")

for BODY in '{"title":"   "}' '{"title":"x","suggested_weight":"250"}' '{"title":"x","suggested_weight":"abc"}'; do
  curl -s -X PUT -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
       -d "$BODY" "http://127.0.0.1/api/v1/pms/hr/kra-library/entry/$ID"; echo
done
```

Expected, verified on the live host at deploy time:

```
{"error":"The KRA text cannot be empty"}
{"error":"Weightage must be between 0 and 100 — got 250"}
{"error":"Weightage must be a number — got \"abc\""}
```

Then confirm nothing moved:

```bash
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM pms.kra_library"     # same as before
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT count(*) FROM pms.audit_log WHERE action LIKE 'KRA_LIBRARY_ENTRY_%'" # 0 if nobody has edited
```

> **Do not demo the successful save on a client PoC shelf** unless you mean
> it. It is a real edit to real configuration and it is audited under your
> name. Use a restored copy — that is what the screenshots above are.

---

## 7. Where the code is

| Piece | File |
|---|---|
| Edit one row | `server/modules/performance/index.js:1673` — `PUT /hr/kra-library/entry/:id` |
| Remove one row | `server/modules/performance/index.js:1724` — `DELETE /hr/kra-library/entry/:id` |
| Clear a whole shelf (pre-existing) | `DELETE /hr/kra-library/:designation` |
| The editing surface | `frontend/src/pages/KraLibraryPage.jsx` — `ShelfDetail()` |
| Both call sites pass the refresh | same file, lines 207–209 and 259–260 — `onChanged={() => load(dept)}` |
| Tests | `server/test/kra-library-edit.test.js` (8) |

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Replace the two row routes with one whole-shelf `PUT` | two people tidying different KRAs on the same shelf overwrite each other, and a partial payload silently deletes the rows it did not send |
| Store a blank weightage as `0` | `0%` and "no suggested weight" read differently to the employee; the shelf total also silently becomes wrong |
| Drop `tenant_id` from the `WHERE` on either route | one tenant edits another's library — both routes are scoped, keep them scoped |
| Drop the `onChanged` callback | the count and total chips above the shelf go stale the moment a weight changes, and HR cannot see the shelf cross 100% |
| Make edits propagate to already-picked KRAs | it rewrites submitted objectives under employees with no notification — see §2 |
| Cap the **shelf** total at 100% | the shelf is a menu and is meant to offer more than one person's worth |
| Query `core.audit_log` for these actions | this module writes to `pms.audit_log`; you will find nothing and conclude the audit is missing |

---

## 8. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

**491 tests, 0 failures** at `f3f1e80`. `server/test/kra-library-edit.test.js`
is the file for this change. The ones that carry weight:

- **`EDITING THE SHELF DOES NOT TOUCH WHAT SOMEBODY ALREADY PICKED`** — picks a
  KRA onto an employee's sheet, edits the shelf row underneath it, asserts the
  employee's KRA is byte-for-byte unchanged. This is §2, pinned.
- **`an ordinary employee cannot edit or remove`** — `403` on both routes.
- **`the edit is audited`** — reads the before/after back out of
  `pms.audit_log`. Note the deliberate wait: `audit()` is fire-and-forget.
- **`a decimal weight is kept to two places`** — pins the rounding in §4.

> **A fresh database every time.** Re-running against a used one produces four
> phantom failures in `self-appraisal-rating.test.js` from leftover rows.

---

## 9. Rollback

Revert `51bc6b4`. **Nothing persists** — no column, no new status, no
migration. Any edit HR already made stays exactly as it is: the rows are
ordinary library rows the old code reads without knowing they were touched.
The audit rows stay too, which is the point of them.

The shelf simply goes back to being publish-only.

---

## 10. Related

- **`PAGE-HR-KRA-LIBRARY.md`** — the full page reference: filters, the
  department view, how shelves are counted, and the upload this now
  supplements.
- **`CHANGE-KRA-LIBRARY-TEMPLATE-DEPARTMENT.md`** — the template HR uploads,
  and why no live row carries a department yet.
- **`PAGE-MY-KRAS-LIBRARY-PICKER.md`** — the employee end: the picker that
  makes the **copy** described in §2.

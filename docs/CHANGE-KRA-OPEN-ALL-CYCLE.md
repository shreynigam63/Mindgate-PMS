# Change — the KRA sheet is open all cycle, and locks when the employee submits

**Screen:** My KRAs (`/my/kras`)
**Shipped as:** `6c2018e`, merged in `0ac242d` · live on pms.agentichumans.in
**Schema change:** none
**Type:** behaviour change — this one is visible to **every employee**

Asked for directly:

> *"KRA should be open for all in entire cycle. But once KRA is submitted by
> employee it should be locked for him unless manager returns the KRA with any
> feedback."*

---

## 1. What changed, in one line

**The lock moved off the CYCLE and onto the SHEET.**

| | Before | After |
|---|---|---|
| Who may edit a KRA sheet | anyone, but **only** while the cycle sits in *KRA Setting and Growth Planning* | anyone whose own sheet is `draft` or `returned`, **in any running phase** |
| What stops an employee editing | the phase moving on | **their own submission** |
| How HR let one late joiner write their KRAs | roll the **whole tenant** back to `kra_open` | nothing — their sheet was never shut |

The old rollback was the real problem: rolling the cycle back to let one person
write their KRAs **reopened everybody else's sheet as a side effect**, which is
the opposite of locking.

---

## 2. What the employee sees

All three screenshots are the **Self-Appraisal** phase — three phases past KRA
Setting, where the page previously just said *"KRA editing opens in the KRA
Setting and Growth Planning phase."*

**A · sheet `draft` — editable. This was impossible before.**

![A draft sheet, three phases past KRA Setting](images/kra-lock-01-draft-late-phase.png)

**B · sheet `submitted` — read-only.**

> *Your manager has this sheet. It is locked until they approve it or return it
> with feedback.*

![A submitted sheet, locked](images/kra-lock-02-submitted-locked.png)

**C · sheet `returned` — editable again, with the manager's feedback in red.**

![A returned sheet, unlocked](images/kra-lock-03-returned-unlocked.png)

---

## 3. The rule

`server/modules/performance/phase-machine.js` — `phaseAllows()`:

```
kra_edit / kra_submit / kra_decide are allowed in EVERY phase except
draft and closed.
```

| Phase | `kra_edit` | `kra_submit` | `kra_decide` |
|---|---|---|---|
| `draft` | ✗ | ✗ | ✗ |
| `kra_open` → `publish` (7 phases) | ✓ | ✓ | ✓ |
| `closed` | ✗ | ✗ | ✗ |

`draft` and `closed` stay shut because there is no cycle to write into — a
draft cycle has not been shown to employees at all, and a closed one is
history.

Then the **sheet's own status** decides who may write:

| `pms.kra_sheets.status` | Employee | Manager |
|---|---|---|
| `draft` | edits, submits | — |
| `submitted` | **locked** | approves or returns |
| `approved` | **locked** | — (HR reopens) |
| `returned` | edits, submits | — |

> `kra_decide` had to open too. Without it a sheet submitted during *KRA
> Setting* and read during *Calibration* could never be returned.

---

## 4. A security hole this closed — worth knowing before you demo

`PUT /my/kra-sheet/kras` refused only an **approved** sheet. A **submitted**
one was accepted — and the same transaction then set the status back to
`draft`, silently **un-submitting** the sheet and dropping it out of the
manager's pending queue.

The page hid the editor, so nobody hit it by hand. But the route was open, and
it becomes reachable the moment editing is open all year. It now answers:

```
409  sheet is submitted — your manager has it.
     Ask them to return it if you need to change something.
```

Submitting twice is refused for the same reason: it would move `decided_at`
and, on an approved sheet, undo the manager's decision.

**HR's reopen no longer demands a cycle rollback**, so reopening one sheet now
reopens exactly one sheet.

---

## 5. Where the code is

| Piece | File |
|---|---|
| The phase rule | `server/modules/performance/phase-machine.js` — `KRA_ACTIONS`, `KRA_SHUT`, `phaseAllows()` |
| Employee save — the lock | `server/modules/performance/index.js`, `PUT /my/kra-sheet/kras` |
| Employee submit — refuse a second submission | `POST /my/kra-sheet/submit` |
| HR reopen — no rollback needed | `POST /hr/kra-sheet/:employeeId/reopen` |
| The page | `frontend/src/pages/MyKRASheetPage.jsx` — `locked` / `editable` |
| Tests | `server/test/kra-sheet-lock.test.js` (7) |

### Things that will break if "tidied"

| Don't | Because |
|---|---|
| Put `kra_edit` back in the per-phase `ALLOWS` table | the sheet closes again when the cycle moves on, and HR is back to tenant-wide rollbacks |
| Remove the `submitted` guard on the save route | the hole in §4 reopens — a submitted sheet silently un-submits |
| Open `kra_edit` in `closed` | last year's sheets become editable |
| Add `devplan_*` / `career_edit` to `kra_open`'s ALLOWS | the growth plan is per-employee, not per-cycle — `growthEditable()` carries that rule |

---

## 6. Deploy

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

**No migration in this change.** Pulls `main`, builds the frontend, restarts
the API, waits for health.

> `VITE_API_URL` must stay **unset** on the host.

### Verify

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx        # active active
curl -fsS http://127.0.0.1/api/v1/health
sudo journalctl -u agentic-pms-api --since '-5 min' -p err
```

Read the deployed rule straight off the box — this is the whole change, and it
is a pure function, so it can be checked without touching any data:

```bash
cd /opt/agentic-pms/server
node -e "
const pm=require('./modules/performance/phase-machine');
const ph=['draft','kra_open','mid_year_review','self_appraisal','manager_eval','hod_eval','calibration','publish','closed'];
console.log('  phase'.padEnd(20),'kra_edit  kra_submit  kra_decide');
for (const p of ph) console.log('  '+p.padEnd(18),
  String(pm.phaseAllows(p,'kra_edit')).padEnd(9),
  String(pm.phaseAllows(p,'kra_submit')).padEnd(11),
  String(pm.phaseAllows(p,'kra_decide')));"
```

Expect `false` for `draft` and `closed`, `true` for the seven in between.

> **Do not test the lock by driving a real employee's sheet on a client PoC.**
> A refused save writes nothing, but if the guard were broken the test itself
> would write to somebody's live sheet — which is the exact bug this prevents.
> Use a restored copy of the database.

---

## 7. Tests

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

`server/test/kra-sheet-lock.test.js` drives the real HTTP surface through every
state, including the sneaky-rewrite case and a late return in Calibration.

> Run against a fresh database every time — re-running against a used one
> produces four phantom failures in `self-appraisal-rating.test.js`.

---

## 8. Rollback

Revert `6c2018e`. Nothing persists from this change: no column, no new status,
no data written that the old code cannot read. Sheets go back to being
editable only in `kra_open`, and any sheet currently `returned` stays
`returned` — a state the old code already understood.

---

## 9. Related

- **`CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md`** — the corollary shipped the same
  day: a submitted sheet reopens automatically when the employee's department,
  designation or role changes. Without it this lock traps somebody holding
  objectives for a job they no longer have.

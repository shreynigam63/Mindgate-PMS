# Agentic PMS — End-to-End Testing Guide

**Product:** Agentic PMS · **Environment:** https://pms.agentichumans.in
**Written for:** UAT testers, HR reviewers, and anyone signing off a release
**As of:** 22 September 2026 · covers everything through commit `6e4913b`,
plus the Quarterly Connects menu move (pending deploy at the time of writing)

This guide walks the product the way a real appraisal year runs, in order.
Work top to bottom and each section leaves the data the next one needs.

Every test case has an ID (`KRA-03`), the role that performs it, what to do,
and what should happen. Record PASS / FAIL against the ID.

---

## 0. Before you start

### 0.1 The five things that will block testing if you skip them

These are **data and configuration on your side**, not product defects. Each
one stops a whole section of this guide dead. Fix them first.

| # | Blocker | What it blocks | Who fixes it |
|---|---|---|---|
| 1 | **No user holds the `hr` role.** One `admin` account exists (`hr.admin@mindgate.com`); 0 `hr`, 5 `hod`, 239 `manager`. | Everything in §2, §9 and §10. You cannot test "HR does X" with no HR user. | HR/IT |
| 2 | **The KRA library has no Department values** — 0 of 2,155 rows. | Department-based shelves (§3.2). Every employee falls back to the designation-only shelf. | HR |
| 3 | **`Senior Software Engineer` shelf totals 105%.** | Anyone on that shelf cannot submit (weights must total 100). Either fix the shelf or avoid that designation in testing. | HR |
| 4 | **4 designations have no shelf at all** — Vice President I (×11), Senior Vice President II (×3), Senior Vice President I (×1), Senior Administrator - Network and System (×1). | Those 16 people get an empty sheet. Expected, not a bug — but don't pick them as test subjects. | HR |
| 5 | **61 active employees have no reporting manager.** | Their KRAs can be submitted but never approved. Pick test employees who **have** a manager. | HR |

### 0.2 Accounts you need

Create or nominate one real person per row. **Test with real logins, not by
impersonating** — permissions are the thing under test.

| Role | Needed for | Minimum |
|---|---|---|
| `employee` | §3–§7, §11 | 2 (one reporting to your test manager) |
| `manager` | §3.5, §5, §6, §8, §9 | 1 (must be the manager of the employees above) |
| `hod` | §8 | 1 (must be head of the test employee's department) |
| `hr` | §2, §5, §9, §10 | 1 |
| `admin` | §12 | 1 (already exists) |

**To grant a role:** Employees tab → the person → **Role** dropdown → Save.
Set a password on the same panel if they have never signed in.

> ⚠️ **Changing someone's role reopens their submitted KRA sheet, growth plan
> and mid-year review**, and notifies them and their manager. Nothing is lost,
> but it is a real event. Set your test users' roles up **before** they submit
> anything, or you will spend §4 chasing a reopen you caused yourself.

### 0.3 The one concept to understand first

**The cycle has 9 phases, and they run in a fixed order:**

```
draft → kra_open → mid_year_review → self_appraisal → manager_eval
      → hod_eval → calibration → publish → closed
```

HR moves the cycle one step at a time (Cycles tab). You can only advance to
the **next** phase, and roll back to the **previous** one.

**But KRAs are deliberately NOT locked to a phase.** A KRA sheet can be
edited, submitted and decided in **every phase except `draft` and `closed`**.
What locks a KRA is **the sheet's own status**, not the cycle:

| Sheet status | Who can edit |
|---|---|
| `draft` | the employee |
| `returned` | the employee (with a reason shown) |
| `submitted` | nobody — it is with the manager |
| `approved` | nobody, until HR reopens it |

If you expect "KRAs should be locked now that we're in Mid-Year", **that
expectation is wrong** — it was changed on request. See `KRA-07`.

---

## 1. Smoke test — is the environment alive?

| ID | Role | Steps | Expected |
|---|---|---|---|
| `SMK-01` | any | Open https://pms.agentichumans.in | Login page renders |
| `SMK-02` | any | Sign in | Lands on My KRAs; your name and role show bottom-left |
| `SMK-03` | any | Open every nav item visible to you | No blank screens, no error banners |
| `SMK-04` | employee | Sign in as a plain employee | **HR Admin** items (Employees, KRA Library, Settings, Increment Simulation, Review Analysis, Department Heads, Career Pathing Matrix, Completion Report) are **not visible** |
| `SMK-05` | employee | Type `/admin/directory` directly in the URL bar | Blocked — not rendered. Hiding a link is not access control; this checks the guard |
| `SMK-06` | any | Read the **My Performance** group top to bottom | Order is **My KRAs · My Growth · Quarterly Connects · Mid-Year Review · Annual Review · Final Rating · My Rating · Past Cycles**. Quarterly Connects is **no longer** under Team |
| `SMK-07` | any | Open an old bookmark or notification link to `/team/connects` | Still opens Quarterly Connects. Only the menu position moved, not the URL |

> **Expected, not a defect:** an employee's nav still lists **Cycles, KRA
> Overview, Calibration, 9-Box Grid, Closure Letters and Super 50**. Those
> items carry no role gate on the menu, and the API refuses them with a 403
> when opened. Access is correctly denied; only the menu is untidy. Raise it
> as cosmetic if you want it changed — do not log it as a security defect.

---

## 2. HR setup (phase: `draft`)

| ID | Role | Steps | Expected |
|---|---|---|---|
| `SET-01` | hr | Cycles → create a cycle (name, fiscal year, type `annual`) | Created in phase `draft` |
| `SET-02` | hr | Employees → Download template → upload a small CSV → **Validate** | Dry run report. Nothing saved yet |
| `SET-03` | hr | Read the dry-run report | Shows rows, errors, warnings, reporting lines matched, and **how many new hires would get KRAs** |
| `SET-04` | hr | Upload a file with a bad row (missing email) | That row is reported by line number; the rest still validate |
| `SET-05` | hr | **Commit load** | Employees created/updated; report says what changed |
| `SET-06` | hr | Department Heads → add a department, assign a head | Department appears; the head gains `hod` |
| `SET-07` | hr | KRA Library → upload the library workbook (with **Department**) → Validate → Commit | Shelves published per designation |
| `SET-08` | hr | KRA Library → edit one KRA's title and weight inline | Saves. **Employees who already picked that KRA are unaffected** (see `LIB-03`) |
| `SET-09` | hr | Settings → confirm KRA library scope | `department+designation` is already set on this instance |
| `SET-10` | hr | Cycles → advance `draft` → `kra_open` | Advances. Employees can now see My KRAs |
| `SET-11` | hr | Try to advance `kra_open` → `manager_eval` (skipping two) | **Refused** — one step at a time |

### 2.1 Auto-assign to new hires

| ID | Role | Steps | Expected |
|---|---|---|---|
| `NEW-01` | hr | Import a file containing **one brand-new employee** with a designation that has a shelf → Validate | Report says that person **will get N KRAs**, names the matched scope and the weight total |
| `NEW-02` | hr | Commit the same file | The new hire's sheet is created with the shelf's KRAs, in **`draft`** |
| `NEW-03` | employee (new hire) | Sign in → My KRAs | The KRAs are there, editable, **not yet submitted**. Manager approval still required |
| `NEW-04` | hr | **Re-import the exact same file** | **Nothing is assigned.** `new_hires: 0`. This is the most important case — a nightly HRMS sync must not overwrite anybody |
| `NEW-05` | hr | Import a new hire whose designation has **no shelf** (e.g. Vice President I) | Reported under "no library shelf for their designation", not silently skipped |
| `NEW-06` | hr | Import a new hire on the 105% shelf | Assigned, and **flagged**: weights do not total 100. The employee's notification says so |
| `NEW-07` | hr | Import an update to an **existing** employee with KRAs already on their sheet | Their KRAs are **untouched** |

---

## 3. KRA setting (phase: `kra_open`)

### 3.1 The employee's own sheet

| ID | Role | Steps | Expected |
|---|---|---|---|
| `KRA-01` | employee | My KRAs → add a KRA manually (title, measures, weight) → Save | Saved |
| `KRA-02` | employee | Set weights totalling 90 → Submit | **Refused** — "weights must total 100" |
| `KRA-03` | employee | Fix to exactly 100 → Submit | Submitted. Sheet locks. Manager notified |
| `KRA-04` | employee | Try to edit after submitting | **Read-only** |
| `KRA-05` | employee | Submit twice (browser back, re-click) | Refused — already submitted |
| `KRA-06` | employee | Submit with **no manager set** | Submits, **with a warning** that nobody was notified. Not a silent failure |
| `KRA-07` | hr, then employee | Advance the cycle to `mid_year_review` (or any later phase). Then, as an employee whose sheet is `draft` or `returned`, open My KRAs | **Still editable and submittable.** The cycle phase does not lock KRAs — only the sheet's own status does. This is the behaviour changed on request; verify it in at least two later phases |
| `KRA-08` | hr | Roll the cycle back one phase | Allowed, one step. **Nobody's sheet is reopened as a side effect** — the rollback used to unlock everybody |

### 3.2 Choose from library

| ID | Role | Steps | Expected |
|---|---|---|---|
| `LIB-01` | employee | My KRAs → **Choose from library** | Shelf for **your designation** opens |
| `LIB-02` | employee | Use **Select all KRAs** | All addable KRAs tick at once |
| `LIB-03` | employee | Add some, save. Then have HR edit that library entry (`SET-08`) | **Your copy does not change.** The library is a menu; what you picked is yours |
| `LIB-04` | employee | Pick enough KRAs to exceed 100% | Total shows **amber**; submit refused until corrected |
| `LIB-05` | employee | Open the library when every KRA is already added | Button reads **View library** rather than being dead |
| `LIB-06` | employee | Check the department chooser | Shows your department and the others. *Currently every shelf resolves by designation only — see blocker #2* |
| `LIB-07` | employee (no shelf) | Open the library as e.g. Vice President I | Honest empty state naming the designation. Not a crash, not a fake shelf |

### 3.3 HR acting on someone's behalf

| ID | Role | Steps | Expected |
|---|---|---|---|
| `HRB-01` | hr | KRA Overview → search an employee → enter KRAs for them | Saved to that employee's sheet |
| `HRB-02` | hr | Submit on their behalf | Submitted; **their manager is notified** |
| `HRB-03` | hr | KRA Overview | Every employee listed with status, searchable |
| `HRB-04` | hr | Bulk KRA upload for many employees | Per-row result; failures named by row, not one flat error |

### 3.4 Manager approval

| ID | Role | Steps | Expected |
|---|---|---|---|
| `MGR-01` | manager | Team KRA Sheets | Your reports listed — **including those who have not started**, showing `not_started` |
| `MGR-02` | manager | Open a submitted sheet | The actual KRA lines, not just a count |
| `MGR-03` | manager | **Return** with no comment | **Refused** — a return needs a reason |
| `MGR-04` | manager | Return with a comment | Employee's sheet reopens; banner reads **"Returned by your manager"** with the comment |
| `MGR-05` | employee | Edit and resubmit | Works; the return label clears |
| `MGR-06` | manager | Approve | Status `approved`; locked to the employee |
| `MGR-07` | manager | Try to open a sheet belonging to **someone else's** report (edit the URL) | **403 — Not your report** |

### 3.5 Reopen on a job change — the four reasons a sheet comes back

This is the area with the most subtle behaviour. **The label must always be
correct** — telling an employee their manager returned something when HR
changed their department is a real-world complaint.

| ID | Role | Steps | Expected |
|---|---|---|---|
| `RE-01` | hr | With the employee's sheet **submitted**, change their **department** | Sheet reopens. Banner: **"Reopened after a change to your role"** with `Department: X → Y`. Employee **and** manager notified |
| `RE-02` | employee | Look at My Growth and Mid-Year too | **Both also reopened**, same reason |
| `RE-03` | hr | Change their **designation** | Same as `RE-01`; library beneath now shows the **new** designation's shelf |
| `RE-04` | hr | Change their **role** (employee → manager) | Same |
| `RE-05` | hr | Correct a **name** only | **Nothing reopens.** Only department, designation and role band count |
| `RE-06` | hr | Change their **reporting manager** | **Nothing reopens** — the objectives are the same, only the reviewer moved. The sheet moves to the new manager's queue |
| `RE-07` | hr | Re-import the same HRMS file unchanged | **Nothing reopens.** Getting this wrong reopens every sheet in the company nightly |
| `RE-08` | hr | KRA Overview → **reopen** an approved sheet | Banner reads **"Reopened by HR"** — *not* "returned by your manager" |
| `RE-09` | employee | After `RE-01`, resubmit. Then have the manager return it | Banner now reads **"Returned by your manager"**. The old label must not survive |
| `RE-10` | employee | After a role change, check **Choose from library** | Enabled, showing the new shelf. Old KRAs can be cleared with one button |
| `RE-11` | employee | Change KRAs, resubmit, then open **My Growth** | If any goal now serves a KRA no longer on your sheet, the plan **reopens by itself**, labelled **"Reopened because your KRAs changed"**, and the affected goals are marked |

---

## 4. My Growth — development goals and career (phase: `kra_open` onward)

Growth opens **per employee, on their own KRA submission** — not on a phase.

| ID | Role | Steps | Expected |
|---|---|---|---|
| `GRW-01` | employee | Open My Growth **before** submitting KRAs | Shut, with the reason: submit your KRAs first, *"this opens the moment you do"* |
| `GRW-02` | employee | Submit KRAs → reopen My Growth | **Now editable** |
| `GRW-03` | employee | Add a goal with no target date → Save | **Refused**, naming which goals lack a date |
| `GRW-04` | employee | Add goals, set **Serves KRA** from the dropdown | Saved and grouped by KRA |
| `GRW-05` | employee | **Suggest goals** (AI) → **Select all** → add | Suggestions arrive grouped by KRA, as editable goals |
| `GRW-06` | employee | Submit the plan | Locked; manager notified |
| `GRW-07` | manager | Team Development Plans → return it with a comment | Reopens for the employee |
| `GRW-08` | hr | Reopen a submitted plan from HR | Reopens, labelled **"Reopened by HR"** |
| `GRW-09` | employee | Aspiring Career → **Suggest a path** | Reads your designation/department against the Career Pathing Matrix. *Currently the matrix is empty — expect an honest "no career path configured" message, not a crash* |
| `GRW-10` | employee | Set target role, timeline, plan → Save | Saved |

---

## 5. Quarterly Connects — through the year

**Moved on request (22 Sep):** this tab now sits in the **My Performance**
group, between **My Growth** and **Mid-Year Review** — in the menu and in
this guide. It follows the year as people live it: set your KRAs, plan your
growth, hold your quarterly conversations, then review at the halfway point.

The page is two-sided: a manager logs and signs off connects with their
reports, and an employee sees their own. The URL is unchanged
(`/team/connects`), so existing bookmarks and notification links still work.

| ID | Role | Steps | Expected |
|---|---|---|---|
| `CON-01` | manager | Quarterly Connects → log a connect with a report | Saved with date and notes |
| `CON-02` | manager | Add a **meeting link and date** | Accepted here (this is the tab that owns scheduling) |
| `CON-03` | manager | **AI assist** on connect notes | Draft summary, editable |
| `CON-04` | manager | Sign off a connect | Recorded |
| `CON-05` | hr | Review Analysis (HR) | 7-parameter meeting analysis. **HR/admin only** |
| `CON-06` | employee | Try `/admin/parameter-analysis` by URL | Blocked |
| `CON-07` | — | Email invitations for connects | **Not available** — no mail transport is configured. Links must be shared manually |

---

## 6. Mid-Year Review (phase: `mid_year_review`)

| ID | Role | Steps | Expected |
|---|---|---|---|
| `MID-01` | hr | Advance the cycle to `mid_year_review` | Employees see the tab open |
| `MID-02` | employee | Mid-Year → rate each KRA, write a narrative | Overall computes from the per-KRA ratings |
| `MID-03` | employee | **AI assist** on the narrative | Draft appears, labelled as a draft, editable before saving |
| `MID-04` | employee | Save & sign | Locked to you |
| `MID-05` | manager | Team → the report's mid-year → rate and sign | Requires a narrative before signing |
| `MID-06` | employee | Look at the **From the manager** panel | **"Not shared yet"** — the manager's rating is withheld until HR publishes. You still see *whether* they have completed theirs |
| `MID-07` | employee | Check My KRAs | The mid-year strip per KRA shows **your** rating only |
| `MID-08` | hr | Change the employee's department now | Mid-Year reopens too, back to `in_progress`, with the reason |
| `MID-09` | any | Look for meeting links / dates on Mid-Year | **Not here.** Meeting scheduling lives in Quarterly Connects |

---

## 7. Annual Review — the employee's self-appraisal (phase: `self_appraisal`)

> **Naming:** the tab called **Annual Review** is the employee's own
> self-appraisal. The tab called **Final Rating** shows consolidated ratings.
> These were renamed on request; the URLs are unchanged.

| ID | Role | Steps | Expected |
|---|---|---|---|
| `ANN-01` | hr | Advance to `self_appraisal` | Tab opens |
| `ANN-02` | employee | Write your self-appraisal per KRA | Saved |
| `ANN-03` | employee | **AI assist** | Draft bullets grouped by KRA, editable |
| `ANN-04` | employee | Submit | Locked |
| `ANN-05` | employee | Look for the manager's rating anywhere on the page | **Withheld** — "not shown yet … after publish" |

---

## 8. Manager evaluation → Delivery Head → Calibration

| ID | Role | Steps | Expected |
|---|---|---|---|
| `EVL-01` | hr | Advance to `manager_eval` | Team Evaluation opens |
| `EVL-02` | manager | Score the **7 organisational parameters** for a report | Overall rating is **computed**, not typed. On an annual cycle a directly-set rating is refused — this is correct |
| `EVL-03` | manager | Submit the evaluation | Locked |
| `EVL-04` | manager | Try to submit without scoring | Refused |
| `EVL-05` | employee | Check Final Rating / My Rating | **Nothing from the manager is visible** |
| `HOD-01` | hr | Advance to `hod_eval` | Delivery Head Review opens |
| `HOD-02` | hod | Open the queue | Only **your departments'** employees |
| `HOD-03` | hod | Change a manager's rating and submit | Recorded as the HOD rating; the manager's original is kept |
| `HOD-04` | employee | Check your rating | **Still nothing visible** |
| `CAL-01` | hr | Advance to `calibration` | Calibration opens |
| `CAL-02` | hr | Adjust a rating with a reason | Adjustment recorded with who and why |
| `CAL-03` | hr | 9-Box Grid | Employees placed by performance × potential |
| `CAL-04` | hr | Super 50 watchlist | Flagged employees listed |
| `CAL-05` | hr | Increment Simulation | Recommended increments by rating band |
| `CAL-06` | manager | Try to open Increment Simulation | **Not in nav, and blocked by URL.** Pay is HR/admin only |

---

## 9. Publish (phase: `publish`) — the rating visibility rule

**This is the single most important behaviour to verify.** Before publish an
employee sees **only their own self-rating**. After publish they see
everything. The data is withheld **at the source**, not hidden with CSS —
check the network response, not just the screen.

| ID | Role | Steps | Expected |
|---|---|---|---|
| `PUB-01` | hr | Advance to `publish` | Publish action available |
| `PUB-02` | manager | Try to publish | **403.** Publishing is HR and Super Admin only |
| `PUB-03` | employee | **Before** publishing: My KRAs, Mid-Year, Annual Review, Final Rating, My Rating | Only **your own** ratings. Manager / HOD / calibration ratings absent everywhere, each with an explanation rather than a blank dash |
| `PUB-04` | hr | Publish | Ratings written to history; letters created; employees notified |
| `PUB-05` | employee | Re-open the same five tabs | **Everything now visible** — manager, Delivery Head and final rating |
| `PUB-06` | employee | Final Rating tab | Consolidated view of all levels |
| `PUB-07` | hr | Closure Letters | Letter per employee, downloadable |
| `PUB-08` | hr | Advance to `closed` | Cycle closed; Past Cycles shows it |
| `PUB-09` | employee | Past Cycles | Your published history |

---

## 10. HR reporting

| ID | Role | Steps | Expected |
|---|---|---|---|
| `RPT-01` | hr | PMS Completion Report | Who has completed which stage |
| `RPT-02` | hr | KRA Overview counters | Counts match the rows listed |
| `RPT-03` | hr | Cycles → cycle activity | Audit of what happened in the cycle |
| `RPT-04` | hr | Export any report offered | Downloads and opens |

---

## 11. Employee self-service

| ID | Role | Steps | Expected |
|---|---|---|---|
| `EMP-01` | employee | My Rating | Your own rating only, respecting the publish rule |
| `EMP-02` | employee | Past Cycles | Previous published cycles |
| `EMP-03` | employee | People Hub / Engagement | Loads; surveys can be taken |
| `EMP-04` | employee | Upload evidence against a KRA | Attached; visible to you and your manager |

---

## 12. Super Admin

| ID | Role | Steps | Expected |
|---|---|---|---|
| `ADM-01` | admin | Sign in | **All 29 nav items** visible |
| `ADM-02` | admin | Team KRA Sheets, Team Evaluation, Team Overview, Team Development Plans | **Every employee** listed, not just your reports. A **`all employees · super admin`** chip appears on the page |
| `ADM-03` | admin | Find **yourself** in those lists | **You are there** |
| `ADM-04` | admin | Submit your own KRAs, then approve your own sheet | Allowed |
| `ADM-05` | admin | Approve at manager level for someone who is not your report | Allowed |
| `ADM-06` | admin | Delivery Head Review | All departments, not just yours |
| `ADM-07` | **manager** | Open the same four team tabs | **Only your own reports.** No chip. This is the leak test — it matters more than `ADM-02` |
| `ADM-08` | employee | Open the same four tabs | **403** |
| `ADM-09` | hr | Ask your DBA to run the query below after `ADM-04` | Your self-approval is listed |

```sql
-- every action where the actor approved their own record
SELECT at, actor_email, action, employee_id
  FROM pms.audit_log
 WHERE details->>'self_action' = 'true'
 ORDER BY at DESC;
```

---

## 13. Negative and security tests

Run these as a **plain employee** unless stated. All should be refused.

| ID | Attempt | Expected |
|---|---|---|
| `SEC-01` | Open `/admin/directory`, `/admin/kra-library`, `/admin/increments` by URL | Blocked |
| `SEC-02` | Open another employee's KRA sheet by editing the id in the URL | 403 |
| `SEC-03` | Approve your own KRA sheet as a plain employee | 403 |
| `SEC-04` | As a manager, open a sheet belonging to another manager's report | 403 — Not your report |
| `SEC-05` | As a manager, reach Increment Simulation or Review Analysis | Blocked — pay and the confidential analysis are HR/admin only |
| `SEC-06` | Submit a KRA sheet with weights ≠ 100 | 422 with the actual total named |
| `SEC-07` | Submit a growth plan with a goal missing a target date | 422 naming the goals |
| `SEC-08` | Put a malformed id in any URL (`/team/kra-sheets/not-a-uuid/kras`) | Clean 400 — never a 500 with a database message |
| `SEC-09` | Read a rating before publish via the API directly | Absent from the response body, not merely hidden on screen |
| `SEC-10` | Sign in as a deactivated employee | Refused |

---

## 14. Automated test suite

**586 automated tests across 79 files**, run against a real Postgres and the
real HTTP surface. Run these before signing off any release — they cover far
more edge cases than manual testing reasonably can.

```bash
cd server
createdb apms_check            # MUST be a fresh database every run
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

**Expected: `# pass 586`, `# fail 0`.**

> ⚠️ **A fresh database each run is not optional.** Re-running against a used
> database produces four phantom failures in `self-appraisal-rating.test.js`
> that are artefacts of leftover state, not real defects.

The files worth knowing by name when a manual test fails — read the header
comment, it states what the rule is and why:

| Area | File |
|---|---|
| Phase rules, KRA lock | `phase-machine.test.js`, `kra-sheet-lock.test.js` |
| Reopen on a job change | `kra-reopen-on-profile-change.test.js`, `growth-reopen-on-profile-change.test.js`, `midyear-reopen-on-profile-change.test.js` |
| Reopen when KRAs change | `growth-reopen-on-kra-change.test.js` |
| Rating visibility before publish | `manager-rating-visibility.test.js` |
| Super admin + self-approval | `super-admin-access.test.js` |
| New-hire auto-assign | `kra-autoassign-on-joining.test.js` |
| Draft-cycle lockout | `active-cycle-draft-lockout.test.js` |
| Library | `kra-library.test.js`, `kra-library-edit.test.js` |
| Permissions | `uuid-params.test.js`, `employees.test.js` |

---

## 15. Deploy verification

After any deploy, confirm on the server:

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx
curl -fsS http://127.0.0.1/api/v1/health            # {"ok":true}
sudo journalctl -u agentic-pms-api --since '-5 min' -p err

DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM core.migrations_log"
```

Migrations run in-process at boot and **fail the boot** if one throws, so a
bad migration stops a deploy rather than half-applying it.

---

## 16. Known limitations — do not raise these as defects

| Area | Status |
|---|---|
| **Google Meet integration** | Framework present, no credentials. Manual links only |
| **Email / calendar invitations** | No mail transport configured. Nothing is emailed by the product |
| **Career Pathing Matrix** | Screen and upload work; **no data loaded**, so suggestions have nothing to read |
| **Department-based KRA shelves** | Working, but inert until the library is re-uploaded with a Department column |
| **KRA unique ID by department + designation** | Not built — awaiting four design decisions |
| **Auto-assign for existing employees** | By design, new hires only. Existing staff pick from the library |

---

## 17. Reporting a defect

Please include all six. Most of the round-trips on this project have been
spent establishing items 4 and 5.

1. **Test ID** from this guide (`RE-09`), or a description if it is not covered
2. **Role and account** you were signed in as
3. **The cycle's current phase** — visible on the Cycles tab
4. **The record's own status** — sheet `submitted`/`approved`, plan `returned`, etc.
5. **What you expected vs what happened**, in those words
6. **A screenshot** showing the whole page, including the nav and any banner

If a rating is missing, state **whether the cycle has been published** before
raising it — withheld-before-publish is the designed behaviour (§9), and it is
the single most common false report.

---

## 18. Sign-off

| Section | Cases | Tester | Date | Pass / Fail |
|---|---|---|---|---|
| 1 Smoke | 7 | | | |
| 2 HR setup + auto-assign | 18 | | | |
| 3 KRA setting | 37 | | | |
| 4 My Growth | 10 | | | |
| 5 Quarterly Connects | 7 | | | |
| 6 Mid-Year | 9 | | | |
| 7 Annual Review | 5 | | | |
| 8 Evaluation → Calibration | 15 | | | |
| 9 Publish + visibility | 9 | | | |
| 10 HR reporting | 4 | | | |
| 11 Employee self-service | 4 | | | |
| 12 Super Admin | 9 | | | |
| 13 Negative / security | 10 | | | |
| 14 Automated suite | 586 | | | |

**Total: 144 manual cases + 586 automated.**

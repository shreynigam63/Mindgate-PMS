# Changes shipped — 17 to 22 September 2026

**Environment:** https://pms.agentichumans.in · **Live through** `0b88536`
**Covers:** the 12 deploys since the last change note
(`CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md`, which ended at `0ac242d`)
**Schema:** 4 new migrations — `038`, `039`, `040`, `041`. Total now **41**.
**Test suite:** **586 pass, 0 fail** on a fresh database (**124** of them in 12 test files added across this set)

Every item below is **live and verified on production**. Each names the
commit that carries it, so it can be found, reviewed or reverted.

---

## At a glance

| # | Change | Commit | Migration |
|---|---|---|---|
| 1 | HR can add and remove departments | `1fab035` | `038` |
| 2 | Department names no longer truncated | `183102d` | — |
| 3 | Growth plan and mid-year reopen on a job change | `f25583f` | `039`, `040` |
| 4 | Meeting panel restored on Mid-Year Review | `8ecf734` | — |
| 5 | KRA ids survive a save; clear the old role's KRAs in one action | `e4b7dd1` | — |
| 6 | Stale-goal warning, HR growth-plan reopen, honest reopen labels | `c9729b5` | — |
| 7 | **An employee sees only their own ratings until HR publishes** | `890902d` | — |
| 8 | **Growth plan reopens when the KRAs under it change** | `1cae2e6` | `041` |
| 9 | **New hires are assigned KRAs from the library on arrival** | `07e2b24` | — |
| 10 | **A draft cycle no longer shuts KRAs for the whole company** | `5a7b56b` | — |
| 11 | **Super admin sees everyone and can approve their own** | `6e4913b` | — |
| 12 | Quarterly Connects menu position; end-to-end testing guide | `0b88536` | — |

Items 7–12 are the most recent stretch and are described in full below.
Items 1–6 shipped earlier in the week and are summarised at the end.

---

## 7. An employee sees only their own ratings until HR publishes

**Asked for:** *"Rating provided by Manager and upper management should not be
visible to employees until it is published by HR or Super Admin as it is
changed at HOD stage"*, then refined to *"only self rating should be visible
to employees before publish. all ratings should be visible only after
publish."*

Before publish an employee sees **their own self-rating and nothing else**.
After publish, everything.

| Screen | Before publish | After publish |
|---|---|---|
| My KRAs — the mid-year strip on each KRA | self only | everything |
| Mid-Year Review | self rating + narrative; the manager's half blank | everything |
| Annual Review | self only; no `manager_evaluation`, no per-KRA manager column | everything |

**Withheld at source, not hidden on screen.** The values are absent from the
API response, so devtools or a direct API call shows nothing either. One
shared helper, `publishedFor()`, gates all three routes — not three separate
rules that can drift.

**Manager *status* stays visible** ("your manager has completed theirs").
Status is not a rating, and hiding it would make the employee think nothing
was happening. Each page explains the absence rather than rendering a dash.

**Publish rights** remain with HR and Super Admin only.

> Three existing tests asserted the old behaviour. They were updated to the
> new rule rather than weakened — the mid-year pair now publishes first, so
> they still prove the shape and mapping they exist to check.

---

## 8. The growth plan reopens when the KRAs under it change

**Reported against a screenshot:** *"Edit option is not available on My
Growth even after KRAs are reopened on changing department, designation or
role. Please check the exact issue as to why it is not fetched directly from
My KRAs."*

Two defects sat behind that report.

### 8.1 The reopen fired on the cause, not the effect

A profile change reopens the sheet, the growth plan and the mid-year review
at the moment HR edits the job. **But the KRAs do not change at that moment.**

| Step | What happens | The plan |
|---|---|---|
| 1 | HR changes department / designation / role | sheet **and** plan reopen ✅ |
| 2 | Employee refills and submits their KRAs | **← the KRAs actually change here** |
| 3 | — | **nothing reopened the plan at step 2** ❌ |

`growthEditable()` checks the plan's status *first*, so a plan resubmitted
between steps 1 and 2 was locked shut holding goals aimed at KRAs that no
longer existed. Exactly the reported state.

Now, on **every** KRA submission — the employee's own and HR's on-behalf —
any goal that names a KRA no longer on the sheet reopens the plan, labelled
**"Reopened because your KRAs changed"** (`reopened_reason = 'kra_changed'`,
the fourth value that column carries). Audited as
`DEVPLAN_REOPENED_KRA_CHANGED`; both sides notified.

Deliberately narrow, because the blast radius runs the other way: a goal
whose KRA is still present does **not** reopen the plan, a goal tied to no
KRA never does, and an empty sheet means "nothing to compare" rather than
"everything is stale".

### 8.2 The real link was being destroyed

A goal carries two references to its KRA: `kra_id`, a real foreign key
declared `ON DELETE SET NULL`, and `serves_kra`, the title frozen as text.

Until the id-preserving save (item 5), every write of a KRA sheet deleted and
re-inserted every KRA row — so the FK nulled `kra_id` on every goal pointing
at them. **The link was destroyed on every single save.** That is why My
Growth compares titles, and why a merely reworded KRA read as "no longer on
your sheet".

**Migration `041`** repairs the rows already damaged, unambiguous matches
only. On production it found exactly what the diagnosis predicted:

| | Before | After |
|---|---|---|
| Development goals | 5 | 5 *(none lost)* |
| Goals with a working `kra_id` | **0** | **3** |
| Genuine orphans | 5 | **2** |

The two that remained were *the exact two headings in the reported
screenshot*. The migration repaired everything repairable and correctly
refused to guess at the two whose KRAs had genuinely gone.

**Also fixed:** the editable view showed no staleness at all — so a plan
reopened for this reason opened into an editor with nothing marked. Each
affected goal now reads *"Previously served **X**, which is no longer on your
KRA sheet. Pick the KRA it serves now"*, beside the dropdown that fixes it.

---

## 9. New hires are assigned KRAs from the library on arrival

**Asked for:** *"new hires should be assigned KRAs directly as per their
department and designation once their details are added in system."*

| Aspect | Behaviour |
|---|---|
| **Trigger** | `POST /employees/import`, after the commit — the only way an employee can be created |
| **Shelf** | their own department's shelf for their designation; falls back to the company-wide shelf. Never both |
| **Lands as** | **`draft`** — theirs to review and submit |
| **Guards** | never a sheet that already has KRAs; never one past `draft`/`returned`; never an inactive employee; nothing if no cycle is open |

**Lands in `draft`, not `submitted`** — a judgment call, stated openly. Your
own framing was *"manager approval is still required"*; approval implies a
submission, and an employee who has never seen their objectives cannot have
asked for them to be approved. One line to change if you want otherwise.

**A re-import assigns nothing.** "New hire" means *not on file*, never *in
the file* — otherwise a nightly HRMS sync would overwrite all 1,398 sheets
every night. It reuses the same signal the importer already uses to tell a
real designation change from a re-import.

**The dry run previews it.** Validate now reports how many new hires would
get KRAs, which designations have **no shelf**, and which shelves **don't
total 100%** — before committing.

**Weights are reported, never normalised.** `Senior Software Engineer` totals
105% on your library. Rescaling would invent a split nobody approved, so the
employee's notification says *"their weights total 105% and must come to
100% before you can submit"*, and the import report flags the shelf for HR.

---

## 10. A draft cycle no longer shuts KRAs for the whole company

Found while reviewing item 9, **not reported** — but it would have bitten
hard the first time HR drafted next year's cycle.

"The active cycle" was, in **six places across four modules**, the most
recently *created* cycle whose phase is not closed or cancelled. A cycle
starts life in `draft`, and `draft` is one of the two phases that shut KRAs.
So the day HR created FY27-28, that brand-new draft would have become "the"
active cycle for everyone — and every employee still working in FY26-27
would have been told **"KRA submission is not open"**, with no error that
explained why, and nothing HR could do but delete the draft.

It reached past My KRAs:

| Module | What a draft cycle would have broken |
|---|---|
| performance | My KRAs locked |
| agentic | AI drafts scoping against the wrong cycle |
| people | Aspiring Career gated on the wrong cycle's phase |
| **reminders** | **the whole nightly sweep scheduling against a cycle nobody was working in** |

**The fix:** prefer a cycle that has actually *started* over one still in
draft; fall back to a draft only when there is nothing else. Among started
cycles the tie-break is unchanged, so **nothing about existing behaviour
moves** until a draft exists beside a live cycle.

Proven on live data with a hypothetical draft injected read-only:

```
OLD ordering picks: FY27-28 (hypothetical draft)  /  draft     ← the lockout
NEW ordering picks: Annual Appraisal FY26-27      /  kra_open  ← correct
draft rows created: 0
```

One resolver now, in `performance/active-cycle.js`. Net **−41 lines**: six
copies became one, and a test fails if anyone writes a seventh.

**You can now create the FY27-28 draft cycle whenever you like.**

---

## 11. Super admin sees everyone and can approve their own

**Asked for:** *"there should be a super admin access where they should be
able to access all tabs and can be able to approve at all levels for any
employees including their own as well."*

Most of this already worked, which is worth stating plainly:

| Requirement | Before |
|---|---|
| Access all tabs | ✅ already true — every nav gate is `['admin','hr']` |
| Approve anyone, at any level | ✅ already true at the API — every guard reads `manager_id !== me && !pms_admin` |
| **See** the record to act on it | ❌ broken |
| **Approve their own** | ❌ impossible |

Four list queries — Team KRA Sheets, Team Evaluation, Team Overview, Team
Development Plans — were hard-scoped to the caller's own reports with no
widening. An admin could act on anyone via the API but could only *see* their
direct reports. And their own row could never appear anywhere, because
**nobody is their own manager**.

Those four lists now widen for `pms_admin`. **No write guard was touched** —
this shows an admin rows they were already permitted to act on.

Verified on live, read-only, as real users:

| Account | Rows in each team list | Sees self |
|---|---|---|
| admin | **1,398** (`scope: all_employees`) | ✅ |
| manager | **1** (`scope: my_reports`) | ❌ |

**Self-approvals are marked.** `audit()` stamps `self_action: true` whenever
the actor is the subject, so:

```sql
SELECT * FROM pms.audit_log WHERE details->>'self_action' = 'true';
```

**To grant it:** Employees → the person → **Role** → `admin` → Save.

> ⚠️ **A role change reopens that person's submitted KRA sheet, growth plan
> and mid-year review**, and notifies them and their manager. Nothing is
> lost, but it is a real event. Grant super admin *before* they submit.

---

## 12. Quarterly Connects menu position, and the testing guide

**Asked for:** *"quarterly connect should be between my growth and mid-year."*

Quarterly Connects **already existed** — page, API and tests all shipped with
the original application. This change moved **one line**: the menu entry
went from the **Team** group to **My Performance**, between My Growth and
Mid-Year Review.

> My KRAs → My Growth → **Quarterly Connects** → Mid-Year Review → Annual
> Review → Final Rating → My Rating → Past Cycles

It belongs there on its own merits: `GET /pms/connects` returns rows where
the caller is the employee **or** the manager, so the page has always been
two-sided. **The route is unchanged** (`/team/connects`) — existing bookmarks
and notification links still resolve.

Also shipped: **`docs/E2E-TESTING-GUIDE.md`** — 144 manual test cases across
18 sections, walked in the order a real appraisal year runs, plus a 23-page
PDF and the tooling in `docs/tools/` to regenerate it.

---

## Items 1–6, earlier in the week

| # | Change | What it does |
|---|---|---|
| 1 | **Department add/remove** (`1fab035`, migration `038`) | HR can add and remove departments on the Department Heads page, backed by a `core.departments` registry seeded from the employee master |
| 2 | **Truncated department names** (`183102d`) | A regression from item 1 — names were clipped beside a fixed-width select. Fixed by stacking; verified at 1280, 820 and 390 px |
| 3 | **Growth plan + mid-year reopen on a job change** (`f25583f`, migrations `039`, `040`) | The reopen-on-role-change rule extended from the KRA sheet to My Growth and Mid-Year. A reopened mid-year lands on `in_progress`, since it has no `returned` state |
| 4 | **Meeting panel on Mid-Year** (`8ecf734`) | Restored after being removed in item 3 — meeting *scheduling* belongs on Quarterly Connects, but the read-only panel was wanted on Mid-Year too |
| 5 | **KRA ids survive a save** (`e4b7dd1`) | Saving a sheet used to delete and re-insert every KRA, regenerating its uuid. That destroyed mid-year ratings and growth-goal links on every save. Also: a one-click "clear the previous role's KRAs" button after a job change |
| 6 | **Honest reopen labels** (`c9729b5`) | An HR reopen used to read *"Returned by your manager"* — both HR routes left `reopened_reason` NULL, which is the manager fallback. Added `'hr_reopen'`. Plus the stale-goal warning on My Growth, and an HR route to reopen a growth plan |

Item 5 was the most consequential: a latent data-integrity bug that was
about to destroy mid-year ratings, found while investigating a report that
*"KRAs are not updated in My Growth and Mid Year after they are changed."*

---

## Still open — all data or credentials, no code

None of these are product defects. Each blocks something real.

| # | Item | Blocks | Owner |
|---|---|---|---|
| 1 | **No user holds the `hr` role** — 1 `admin`, 0 `hr`, 5 `hod`, 239 `manager` | Only one account can publish final ratings. With item 7 live, that account is the only thing between every employee and their rating | HR |
| 2 | **KRA library has no Department values** — 0 of 2,155 rows | Department-based shelves and the department dropdown. Flips on by itself once re-uploaded; no deploy needed | HR |
| 3 | **`Senior Software Engineer` totals 105%** | Anyone auto-assigned that shelf cannot submit | HR |
| 4 | **4 designations have no shelf** — 16 employees | Those people get an empty sheet on joining | HR |
| 5 | **61 active employees have no reporting manager** | Their KRAs can be submitted but never approved | HR |
| 6 | **Career Pathing Matrix is empty** | Aspiring Career suggestions have nothing to read. Template is ready | HR |
| 7 | **Google Meet + email transport** | Meeting invitations and Quarterly Connect scheduling by email | Mindgate IT |
| 8 | **KRA unique ID by department + designation** | Not built — awaiting four design decisions | Mindgate |
| 9 | **The Anthropic API key has not been rotated** | Security | Mindgate IT |

Items 1–5 are also §0.1 of the testing guide, because each one stops a
section of UAT dead.

---

## Deploy verification

Every deploy in this set was verified on the server the same way:

```bash
git -C /opt/agentic-pms log -1 --format='%h %s'
systemctl is-active agentic-pms-api nginx
curl -fsS http://127.0.0.1/api/v1/health            # {"ok":true}
sudo journalctl -u agentic-pms-api --since '-5 min' -p err

DB=$(sudo grep -oP '^DATABASE_URL=.*/\K[A-Za-z0-9_]+' /etc/agentic-pms/api.env | head -1)
sudo -u postgres psql -d "$DB" -tAc "SELECT count(*) FROM core.migrations_log"   # 41
```

Plus, on each one: a **before/after data snapshot** (employees, sheets, KRA
rows, published ratings) to prove nothing moved that should not have, and a
**SHA-256 comparison** of the served frontend bundle against the local build.

Migrations run in-process at boot and **fail the boot** if one throws, so a
bad migration stops a deploy rather than half-applying it.

---

## Rollback

Each item is a separate merge and reverts independently. **Leave the
migrations in place** — `038`–`041` are additive (`ADD COLUMN IF NOT EXISTS`,
a new table, one idempotent data repair) and unread by older code, so
dropping them buys nothing and risks a lock on a populated table.

`041` is the one exception worth understanding: it *wrote data* (restored 3
`kra_id` values). Reverting the code leaves those values in place, which is
correct — they are the right values, and the older code simply ignores them.

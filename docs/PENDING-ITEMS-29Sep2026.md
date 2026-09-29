# Agentic PMS — pending items

**29 September 2026.** Everything below was checked against the running
system or the repository on the day of writing. Where a number is
recalled from earlier in the week rather than re-measured, it says so.

Deployed build: **`d1d06cc`** on branch `claude/push-code-github-2rhnnq`.
The PoC instance is **stopped** between deployments; it needs starting
before anyone can open it.

---

## Where things stand

Four phases of the Zoho timesheet rating engine shipped this week, along
with an editable grade-band table on Calibration and three live defect
fixes. All of it is deployed and verified on the client box.

**One fact gates the rest: the PoC has no timesheet data.** Zero rows.
Every screen across all four phases is therefore showing its empty state
correctly, and none of it can be demonstrated to Mindgate until one Zoho
Sprints export is uploaded. That single file is the cheapest unblock on
this list.

A second fact gates the appraisal side: **nobody has a submitted manager
evaluation in the active cycle**, so Calibration lists zero people and
every grade count reads zero.

---

## A. Code gaps — ours to build, nothing blocking them

| # | Item | Estimate |
|---|---|---|
| A1 | **Phase 4 has no operator screens.** HR cannot close a month and a manager cannot override one from the application; both require a direct API call today. The engine, the guards, the audit trail and the tests are complete and deployed — only the screens are missing. Verified by search: no frontend code calls `/close`, `/month/:id/override` or `/rollup`. | ~1 day |
| A2 | **Engagement Phase 5** — the red/amber/green engine, the per-person 30/60/90 trend, the onboarding-failure dashboard, and the correlation to KRA achievement and attrition. Needs no new schema; everything it reads already exists. | ~2 days |
| A3 | **A manager survey's development-plan answer does not create a Development Plan.** Section 19 asked for this. It was deliberately left out because development plans live in the performance module and modules do not reach into each other's internals — doing it properly needs an exported interface on that module. The answer is captured and reported today, so nothing is lost. | ~half day |

Suggested order: A1 first. It is the smallest, and it is the one that
stops a real person doing a real job in the product.

---

## B. Data on the PoC

Measured on 29 September through an SSM tunnel to the running instance:

| | |
|---|---|
| Timesheet rows | **0** |
| KRA keyword coverage | **0 of 2,360 KRAs** |
| Submitted manager evaluations, active cycle | **0** |
| Employees with no CTC on record | **1,427** |
| Employees on the master | 1,494 |

Two further figures are from earlier in the week and were **not
re-measured** on the 29th, because the instance was stopped by then:

- **1,338 of 1,427 people have no KRA sheet.** This caps the timesheet
  engine regardless of how the scoring works — there is nothing to credit
  their hours to.
- **53 designations covering 291 people have no grade.**

Both are worth re-checking before they are quoted to Mindgate.

---

## C. Waiting on Mindgate

### Credentials and access

1. **Rotate the Anthropic API key.** Overdue, and the current key is live
   on the box. Every AI feature fails until this is done.
2. **SMTP host, port, user and password** (point 17). Reminders and
   connect invitations cannot leave the box without it.
3. **Google OAuth client ID and secret** (point 5). Meet links stay off.
4. **Employee and manager test logins on production** (point 22). The
   submit-to-approve loop cannot be demonstrated without them.

### Data

5. **One real Zoho Sprints export.** The cheapest unblock on this list:
   it makes all four timesheet phases demonstrable at once.
6. **Prior-year annual ratings.** Super 50 and the 9-box need them.
7. **The Career Pathing Matrix uploaded back** (point 13).
8. **A reporting manager for 61 employees** who currently have none.
9. **The corrected KRA library** — `docs/KRA-library-upload-corrected-25Sep2026.xlsx`,
   225 shelves. The existing 2,360 rows must be cleared first. Say the
   word and we will run it.
10. **Nine department corrections**, including the Application Support
    Executives currently under Development.

### Decisions

11. **What "more confirmation" means for quarterly connects** (point 31).
12. **Confirm the mid-year visibility change** (point 20) — the employee
    no longer sees the manager's mid-year rating.
13. **Whether to switch automatic timesheet scoring on.** It ships off
    deliberately. On today's data 87% of logged hours are unmapped, and a
    letter grade computed on the remaining 13% would produce arguments
    rather than measurements. Turning it on is one settings change once
    the item mapping has settled.
14. **Whether "100% on-time submission" is still required.** Compliance
    currently counts days that carry a log, not whether a sheet was
    submitted or locked by the 3rd. This is the one criterion the
    now-dropped Zoho API sync would have unlocked. It may be inferable
    from `approval_status` in a real export — that can only be confirmed
    once we see one.

---

## Closed this week

- **Phases 1 to 4 of the Zoho timesheet rating engine** — keywords on a
  KRA; the work-item to KRA mapping and the matching engine; the Self,
  Manager and HR screens with the mapping backlog; settled months, the
  hours-weighted year-end rollup, the manager override, and a context
  column on Calibration that deliberately does not feed the rating.
- **The Calibration grade-band editor** — target %, increment range and
  standard are now editable on the page that argues about them.
- **The Zoho API sync formally dropped** — see
  `docs/DECISION-NO-ZOHO-SYNC.md`. Nothing was built for it, so nothing
  was removed.
- **Three live defects fixed**, each reproduced on a running instance
  before the fix: the timesheet settings blob being wiped by an unrelated
  save; the increment ranges being destroyed by any save of the matrix;
  and screen copy telling HR their keywords "will be" matched when the
  matching had already gone live.

The 31-point tracker stands at **27 done, 4 pending** — points 5, 17, 22
and 31, all listed in section C above.

---

## How to read this list

Sections A and C are work that has not started. Section B is not work at
all — it is the state of the client instance, and most of it can only be
changed by Mindgate putting data in.

The instance is stopped to avoid running cost. Starting it takes about
three minutes including the SSM agent registering; it should be stopped
again afterwards.

# Release log and the cycle phases — Agentic PMS

Covers what is now live on `pms.agentichumans.in`, and how the appraisal
cycle's phases changed.

| | |
|---|---|
| Live commit | `3d6fbd9` |
| Instance | `pms.agentichumans.in` (EC2, systemd) |
| Migrations applied | 034, 035, 036 |
| Tests | 429 passing |
| Data | 1,398 active employees · 2,155 KRA library rows · 267 shelves |

---

## Part 1 — What was released

Four commits, all on `main` and all live. Newest last.

| Commit | What it does |
|---|---|
| `ab39a25` | The change-request analysis — each of the three requests checked against the running application before anything was built |
| `cc71ae5` | The three requests built: returned-plan editing, department shelves, the KRA a goal serves |
| `62921cc` | The merged window — submitting your KRAs opens your growth plan |
| `3d6fbd9` | Growth Planning folded into KRA Setting as one phase |

### `ab39a25` — the analysis

Not code. Each request was run against a live instance first, and two of the
three were not what they looked like from outside:

- **Approved goals** — confirmed, and worse than reported. The phase check ran
  *before* the plan's status, so a manager returning the plan did not unblock
  editing either. A whole-tenant cycle rollback was the only remedy for one
  person's goal.
- **Department dropdown** — needed. **1,281 of 1,398 employees** hold a job
  title that exists in more than one department. `Manager` alone spans 15.
- **Growth path after the KRA** — half already true. The sequencing was
  enforced; the *association* was computed by the AI, shown in the popup, and
  then discarded on save because the table had no column for it.

### `cc71ae5` — the three requests

| | Change | Migration |
|---|---|---|
| 1 | A **returned** development plan is editable in any phase up to Calibration. The return is the authorisation — the phase does not have to authorise it a second time. | none |
| 2 | `pms.kra_library` gains a nullable `department`. Matching is most-specific-wins: your own department and title, else the department-blank shelf. **Every shelf published before this keeps working as the fallback**, so nothing had to be re-uploaded. | 034 |
| 3 | `pms.development_goals` records the KRA a goal serves — as an id checked against the employee's own KRAs, and as the title it had when the goal was written. | 035 |

Also in this commit: the HR Admin → **Settings** screen (`core.admin_settings`
had existed since migration 001 with no screen behind it), and a fix for a
target-date field that rendered empty because the column comes back as an ISO
timestamp and `<input type="date">` silently rejects it.

### `62921cc` — the merged window

Submitting your KRA sheet to your manager opens **Target achievements for the
year** and **Aspiring Career**, for that employee, in the same phase. It is the
same moment the KRA sheet locks, so the two hand over cleanly: you stop writing
KRAs and start writing the goals that serve them.

### `3d6fbd9` — one phase instead of two

Covered in Part 2.

---

## Part 2 — The cycle phases

### Before — ten phases

```
Draft → KRA Setting → Growth Planning → Mid-Year Review → Self-Appraisal
      → Manager Evaluation → Delivery Head Review → Calibration
      → Publish → Closed
```

Growth Planning was a separate step on the strip. HR had to advance the cycle
into it before anybody could write a growth plan, and roll the cycle back —
an **all-tenant** action — whenever one person needed to finish late.

### After — nine phases

```
Draft → KRA Setting and Growth Planning → Mid-Year Review → Self-Appraisal
      → Manager Evaluation → Delivery Head Review → Calibration
      → Publish → Closed
```

The two are one phase, shown as **KRA Setting and Growth Planning**. Inside it:

| The employee… | …and this happens |
|---|---|
| opens the cycle | KRA Setting is open; the growth plan is shut, and says *"Submit your KRAs to your manager first"* |
| **submits their KRA sheet** | their sheet locks, and **Target achievements for the year** and **Aspiring Career** open for them — immediately, with no HR action |
| has their plan returned by their manager | it reopens for edits in any phase up to Calibration |

The trigger is the employee's own act, not HR's, and it is **per employee** —
one person submitting opens nothing for anybody else.

### What HR does differently

- **Two fewer transitions per cycle.** Advance from KRA Setting straight to
  Mid-Year Review.
- **No rollback to let somebody finish.** They were never waiting on HR.
- The cycle-open notice now names both halves and the order they happen in.

### What did not change

- The stored phase value is still `kra_open`. Renaming it would have rewritten
  every cycle row, every audit entry and every notification ever sent, to change
  a word that is only ever shown through the label.
- KRA editing still closes the moment the cycle leaves this phase.
- An approved or submitted plan stays locked.
- Progress on goals and milestones is still updatable all year.

### Existing cycles

Migration 036 moves any cycle sitting in `growth_planning` to `kra_open` and
writes a `PHASE_MERGED` row to `pms.audit_log` saying why. Without it those
cycles would have been stuck — `canAdvance()` answers *"unknown phase"* for a
value no longer in the order. On this instance the live cycle was already in
`kra_open`, so the migration correctly moved nothing.

Closed and cancelled cycles keep whatever phase they ended on, and the old
`Growth Planning` label is still recognised so historical rows read correctly.

> ### One consequence, stated plainly
>
> There is no longer any phase that opens the growth plan for **everybody**.
> An employee who never submits a KRA sheet gets no growth plan on that cycle.
> That is the merge working as asked, not an oversight — but HR should know it,
> because the old Growth Planning phase was the safety net for exactly that
> case.

---

## Part 3 — Verified on the live instance

After the deploy, on `pms.agentichumans.in`:

- [x] `3d6fbd9` checked out; `agentic-pms-api` and `nginx` both active
- [x] Migrations 034, 035 and 036 ran clean and are recorded in
      `core.migrations_log`
- [x] Zero cycles left in `growth_planning`
- [x] 1,398 employees and 2,155 library rows unchanged by the deploy
- [x] Every existing library row has `department IS NULL` — the fallback — so
      no shelf changed behaviour
- [x] The served bundle carries the new label and the nine-phase list
- [x] `ANTHROPIC_API_KEY` preserved; AI features still on
- [x] No errors in the service log since the restart

---

*Agentic PMS · Mindgate Solutions — release notes for `3d6fbd9`, 16 September.*

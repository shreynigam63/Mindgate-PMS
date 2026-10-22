# Performance Management System — the logic book

How the product actually works, section by section: what each screen reads, what it
writes, and the rules that decide whether it lets you.

It is written for somebody who has to answer "why did it do that?" — a
reviewer, a new developer, or HR working out whether a behaviour is a bug
or a decision. Every rule below names the file that enforces it, so the
book can be checked against the code rather than believed.

**Read Part 1 first.** Four mechanisms govern every screen in the product.
Once those are clear, most of Part 2 is predictable.

**Live at pms.agentichumans.in** (7 October 2026). The build is in the
**?** menu and at `/api/v1/health`. It carries:

- connects with anyone, and the HR question (§2.1);
- KRA, KPI and weightage editable in the reviews (§3.1);
- the Final Rating as a chain (§3.3);
- the manager's Performance Improvement Plan (§3.14);
- the HOD's Team Competencies (§2.3);
- the bell-curve chart on Calibration (§3.4).

- the Manager Dashboard rebuilt on the main Dashboard's design (§2.2);
- the HRBP tab trimmed to eleven pages (§2.4);
- deleting a survey (§3.11);
- one card design on every dashboard (§1.4).

The build a screen is running is shown in its **?** menu, and
`/api/v1/health` reports the same commit.

---

# Part 1 — The engine

## 1.1 The cycle, and its nine phases

Everything in the performance module hangs off one row: the active cycle in
`pms.cycles`. Its `phase` is the clock the whole tenant runs on.

`server/modules/performance/phase-machine.js` — pure, no database, so the
rules are unit-tested directly.

```
draft → kra_open → mid_year_review → self_appraisal → manager_eval
      → hod_eval → calibration → publish → closed
```

- **Forward one step at a time.** `canAdvance` refuses any jump; HR cannot
  skip from `kra_open` to `calibration`.
- **Rollback one step**, HR-controlled and audited by the caller.
- **Cancel** from any phase except `closed`.
- `closed` is terminal — no advance, no rollback.

Stored values never changed when labels did. `self_appraisal` is shown as
**Annual Review**; `kra_open` is shown as **KRA Setting and Growth
Planning**. Renaming the stored value would rewrite every cycle row, audit
entry and notification ever sent, to change a word that only `phaseLabel()`
displays.

### What each phase opens

| Phase | Actions it permits |
|---|---|
| `kra_open` | `kra_edit`, `kra_submit`, `kra_decide` |
| `self_appraisal` | `self_edit`, `self_submit` |
| `manager_eval` | `manager_edit`, `manager_submit` |
| `hod_eval` | `hod_edit`, `hod_submit` |
| `calibration` | `calibrate`, `adjust`, `top_talent` |
| `publish` | `publish` |

Two families sit outside that table on purpose.

**KRA actions are open in every phase except `draft` and `closed`.** The
lock moved off the cycle and onto the sheet (§3.1). A draft cycle has not
been opened to anybody; a closed one is history. Everything between is
open, and the sheet's own status decides who may write.

**Mid-year actions open at a phase and stay open** (`OPEN_FROM`): from
`mid_year_review` through to `self_appraisal`, the last phase an employee
may still be writing in. They do not close when the phase passes.

> **Why employee windows stay open.** The earlier rule was "editable only
> once the cycle is in this phase", which meant HR could not advance the
> cycle without shutting the door on anybody mid-way through. The only
> remedy was a tenant-wide rollback — which reopens it for *everyone*, the
> opposite of locking. Now a window opens on a phase and closes on **your**
> act: you submitted, or your manager approved.

## 1.2 Who may open a screen

One row in `core.page_permission` drives **both** the menu and the
direct-URL guard. They cannot disagree, because they are the same row.

```
tenant_id │ page │ route │ required_permission
```

`NULL` = public, registered consciously. The eight "my own" pages are every
employee's own record; Improvement Plan is row-scoped in its handler; My
Surveys and People Hub are everyone's.

**Effective permissions = `role_permissions[role]` ∪ `user_permissions[email]`**,
with `*` as wildcard. Default bundles (`migrations/002`):

| Role | Permissions |
|---|---|
| `employee` | `pms_self`, `engagement_take`, `people_view` |
| `manager` | + `pms_team_eval` |
| `hod` | + `pms_hod` |
| `hrbp` | `pms_self`, `pms_hrbp`, `people_view`, `engagement_take` |
| `hr` | `pms_admin`, `pms_team_eval`, `pms_hod`, `pms_hrbp`, `engagement_admin`, `people_admin`, `letters_admin`, `pms_compensation`, … |
| `admin` | `*` |

Bundles are **data, not code**. A client edits them; they never fork. They
are re-seeded at every boot with `ON CONFLICT DO NOTHING`, so a missing
grant is restored and an added one is kept. (Until 6 Oct the `hrbp` bundle
was granted only to tenants that existed when migration 068 ran, so a fresh
install's HRBPs held no HRBP access; it is now in the boot seed.)

Three layers, in order (`core/auth.js`, `core/permissions.js`):

1. **authenticate** — JWT, active employees only.
2. **apiPermissionParity** — a route table matched by method + longest path
   prefix. A 403 from here names what was needed in a `needs` field, which
   is what makes the next misconfiguration self-diagnosing.
3. **handler guards** — row-scoped decisions the table cannot express
   ("my team only", "HR-only section").

> **The carried lesson.** Route rules cover coarse, all-or-nothing routes
> only. A flat prefix across mixed read/write routes denies users the
> handler would have allowed, so reads and writes get separate
> method-scoped rows. Row scoping lives in handlers, full stop.

## 1.3 Whose rows you see

Permission answers *may I open this screen*. Scope answers *which people are
on it*, and they are different questions.

| Who | Sees |
|---|---|
| Employee | Their own records |
| Manager | Their direct reports (`core.employees.manager_id`) |
| HOD | Their department, via `core.department_heads` |
| **HRBP** | Their remit — see below |
| HR / admin | Everybody in the tenant |

**The HRBP is the interesting one.** An HRBP opens HR's own screens on
parallel `/hrbp/*` routes, and sees only their own people on each.

`server/modules/performance/hrbp-gateway.js` is one gateway in front of the
whole module rather than edits in 104 handlers:

- **`LENT`** — `pms_admin`, `people_admin`, `engagement_admin`, granted for
  the life of one request. Named, not a wildcard, so adding one is a
  decision somebody had to write down.
- **`TENANT_WIDE`** — settings, cycles, the KRA library, competency
  framework, the onboarding holidays, activity matrix and SPOC list, and
  similar. Configuration is the tenant's, not a person's: an HRBP may read
  it and may not change it.
- **Writes must name a person in the remit.** The gateway resolves every id
  in the request — an employee, a KRA sheet, a connect, an RnR nomination,
  an onboarding joiner or task — to the person it belongs to, and refuses
  the write if that person is outside the remit or cannot be resolved.
- **`HR_ONLY`** — `/hrbp/admin`. Reading is not automatically safe: lending
  `pms_admin` would otherwise open the screen that *sets* remits, letting
  an HRBP widen their own.
- **Roles and passwords are never lent (8 Oct).** Changing someone's role,
  setting their password, bulk logins and the employee import check the
  permission the person *holds* (`holdsPermission`), not one the gateway
  lent. Until then an HRBP could make anyone in their remit — themselves
  included — HR or Super Admin, or set an HR person's password and sign in
  as them. The client's rule: *"Only HR and Super Admins should have this
  access."* An HRBP still edits profiles in their remit; the Employees page
  shows them "Logins and roles are managed by HR" instead of the controls.
  The same held-only check covers adding people, removing several at once,
  erasing for good, the department list and HOD assignments, and the
  remit-setting routes themselves.
- **Letter case and smuggled ids are not a way round (8 Oct).** The
  gateway's HR-only and company-wide checks compare a lower-cased path,
  because Express matches routes in any case (`/HRBP/admin` used to slip
  past). And a bulk action's list of people (`ids`) is checked against the
  remit too: one in-remit `employee_id` beside a list of anybody no longer
  carries the write.

The remit itself lives in `core.hrbp_scope` (`kind` = location or HOD,
`value`). Routes are separate from `/admin/*` on purpose: one page row
drives both menu and guard, so giving an HRBP the `/admin/*` rows would put
the **HR section itself** in their menu.

## 1.4 Four house rules visible on every screen

**One card design on every dashboard (7 Oct).** The client asked to
"update all old UI to new UI". So every dashboard's count strip now uses
the main Dashboard's pastel attention card, from `frontend/src/Kpi.jsx`.
That covers:

- Home and the Manager Dashboard;
- the Competency Dashboard;
- the HR, HRBP and team Timesheet dashboards;
- the employee's own timesheet summary.

Before this, the last four drew their own white stat tile.

1. **Deterministic numbers; AI narrates.** Every rating, score and
   distribution is SQL. The agentic module drafts *text*, always labelled a
   draft, stored with the input that produced it. No AI output is ever
   parsed into a rating field.
2. **Thresholds, labels and dropdowns live in tables.** Rating scales,
   grade bands, increment ranges, competency levels, RnR awards — all
   editable rows. A client configures; they never fork.
3. **No silent failure.** Every batch operation returns per-row reasons.
   Boot fails on a migration error: a schema the code expects but does not
   have is a broken deploy, not a degraded state.
4. **Every change that affects a rating is audited.** `core.audit_log` plus
   explicit adjustment records, so *"why did my rating change?"* always has
   a queryable answer.

---

# Part 2 — The five role sections

Since 6 Oct the screen is a white top bar (product name, page search,
notifications, help, account) over a navy sidebar. The sidebar starts with
**Dashboard** and then five role sections — **Self, Manager, HOD, HRBP,
HR** — each opening into its pages. A sixth, **HR Ops**, holds one page —
the First-Week Journey (`/hrops/onboarding`, §3.12) — for the `hr_ops`
role, and is hidden for anyone who already reaches that tracker through
New Hire Insights (HR and HRBP). They are groups in
`frontend/src/App.jsx`; an item appears only if the viewer holds its page
permission, and a section whose every item is filtered out disappears
entirely. The search box finds only pages the viewer may open. The help
menu shows the build the screen is running, and a tab left open across a
deploy shows a *Reload now* bar (`BuildWatch`).

## 2.1 Self — 13 pages plus Dashboard, everyone

| Page | Route | What governs it |
|---|---|---|
| Dashboard | `/home` | Top of the sidebar, §2.6 |
| My KRAs | `/my/kras` | Sheet status machine, §3.1. Weights must total exactly 100 to submit. Each KRA shows its timesheet hours and rating, §3.7 |
| My Growth | `/my/growth` | Opens on **your** KRA submission, §3.2. Short-term and long-term aspiration are separate records; long-term stays editable through Manager Evaluation |
| Connects | `/team/connects` | Connect log. **With anyone**: your own connect names who it was with (default your manager), and that person signs it off — the one who logged a connect never signs it off; the other person in it, or HR, does (§3.20). Every connect asks *"Do you need HR as part of this connect?"* — yes names one person from HR, who is told and can read it. HR is anyone holding the `hr` or `hrbp` role, or anyone whose department or designation says HR ("Human Resources", "HR Manager", "Head of HR", "HR Business Partner"); "hr" must be a whole word, so "Chrome Engineer" does not count. Suggested: the HRBP whose remit covers you, else an HR role-holder, else the first person from the HR department. Action items carry `sort_order` — `created_at` ties inside one transaction |
| Mid-Year Review | `/my/midyear` | Opens at `mid_year_review`, stays open to end of Annual Review. Per-KRA ratings with a computed overall. KRA, KPI and weightage editable here, §3.1 |
| Annual Review | `/my/self-appraisal` | Opens at `self_appraisal`. Locks permanently on sign-off. KRA, KPI and weightage editable here, §3.1 |
| Final Rating | `/my/annual-review` | The annual review only, as a chain: your rating → manager → HOD → HR → final, §3.3 |
| My Rating | `/my/rating` | **Gated**: opens only once something is published for you. Not a permission — an emptiness |
| Past Cycles | `/my/history` | Published history plus imported prior-year ratings |
| My Competencies | `/my/competencies` | §3.8 |
| Timesheet | `/my/timesheet` | Your own report only. **HR uploads timesheets** (§3.22); there is no upload here. Your manager decides which KRA each item serves |
| Improvement Plan | `/pip` | Public page, row-scoped in the handler: your own plan, or your reports' |
| My Surveys | `/engagement` | §3.11 |
| People Hub | `/people` | Company noticeboard |

**My Rating's gate is a "nothing here yet", not a permission.** The page row
is public, so typing the URL must *not* answer with the access-denied
screen — that would tell somebody they had lost a right they never lost. It
says "No published ratings yet" and what will change that.

## 2.2 Manager — 11 pages, `pms_team_eval`

| Page | Route | What governs it |
|---|---|---|
| Manager Dashboard | `/team/dashboard` | The Dashboard one scope out, built from the main Dashboard's own components (7 Oct): greeting band with the one action, pastel attention cards for what is outstanding across the team, Quick Actions, the named *Waiting on you* list, and the tabbed My Team table. Your reports only, never the company. First in the section, so opening Manager lands here |
| Nominate for RnR | `/rnr/nominate` | §3.10 |
| Team Overview | `/team/overview` | Every report, all phases at a glance |
| Team KRA Sheets | `/team/kra-sheets` | Each KRA shows the report's timesheet hours and rating, §3.7. Approve or return. A return **must** carry a comment — refused 422, *"the employee must know why"* (`approvals.js`) |
| Team Target Achievements | `/team/growth` | Growth-plan decisions |
| Team Mid-Year | `/team/midyear` | Manager half of the checkpoint |
| Team Evaluation | `/team/eval` | Opens at `manager_eval`. Each KRA shows its timesheet rating beside the manager's buttons, §3.7. KRA, KPI and weightage editable here, §3.1. On annual cycles the **Potential** step: four questions, 1–5, §3.15 |
| Team Competencies | `/team/competencies` | Manager assessment per report |
| 9-Box Grid | `/team/nine-box` | The manager's direct reports on the 9-box, §3.15. Never the manager themselves |
| Improvement Plans | `/team/pip` | Open and run a report's Performance Improvement Plan, §3.14. Team Evaluation links here for the person open |
| Timesheet | `/team/timesheet` | Where the mapping is done, §3.7 |

Scope is the reporting line. When a reporting manager changes, open records
move with the employee (`manager-handover.js`) — otherwise a submitted sheet
sits in the queue of somebody who no longer manages them.

## 2.3 HOD — 4 pages, `pms_hod`

| Page | Route | What governs it |
|---|---|---|
| HOD Review | `/hod` | Opens at `hod_eval`. Shows employee, manager and timesheet ratings per KRA |
| Team Competencies | `/hod/competencies` | **Every** active employee in the departments this person heads — not only direct reports — with a department dropdown, a by-department table (people, assessed, average level, required, gap, below required), the by-area summary, and each person's ratings read-only. HR sees every department. Rating stays the manager's |
| 9-Box Grid | `/hod/nine-box` | Everyone in the departments this person heads (`core.department_heads`), §3.15 |
| RnR Approvals | `/rnr/approvals/delivery-head` | Stage 2 of §3.10 |

The `hod` role grants access to the *screen*; `core.department_heads` decides
**which department's** evaluations appear. A person with the role and no
mapping has a permanently empty queue — which is why the HOD
screen exists and why a department can be given a head before anyone is in
it.

## 2.4 HRBP — 11 pages, `pms_hrbp`

HR's own screens, on `/hrbp/*` routes, narrowed to the partner's own people
by the gateway in §1.3:

- All Approvals, RnR Approvals, Employees;
- KRA Overview, KRA Library;
- Competency Framework, Competency Dashboard;
- Timesheet, PMS Completion Report;
- Calibration, New Hire Insights.

**Nine taken off on 7 Oct** at the client's request, and left with HR:
Cycles, HOD, Career Pathing Matrix, Settings, Super 50, Engagement Surveys,
9-Box Grid, Closure Letters and Increment Simulation. The menu entries, the
routes and the page rows went together (migration 085), so a typed URL
cannot reach what the menu no longer offers.

Read-only for the HRBP where the thing is the tenant's rather than a
person's: KRA Library, Competency Framework.

## 2.5 HR — 22 pages

All Approvals, Cycles, Employees, HOD, **HR Business
Partners**, **RnR Final Approval**, **RnR Administration**, Career Pathing
Matrix, KRA Overview, KRA Library, Competency Framework, Competency
Dashboard, Timesheet, PMS Completion Report, Calibration, 9-Box Grid,
Closure Letters, Increment Simulation, Super 50, Engagement Surveys, New
Hire Insights, Settings.

Three are HR's alone: assigning HRBP remits, the final RnR gate, and RnR
administration.

**All Approvals** (`approvals.js`) carries a distinction worth knowing:

- **decisions** — a sheet or plan somebody *submitted*, awaiting an approve
  or a return. Bulk-approvable, because approving is the whole action.
- **waiting** — a mid-year sign-off, a manager or HOD evaluation. Nobody
  has submitted anything; the named person still has to *write* their
  assessment. These carry no approve button, because bulk-approving one
  would mean writing an empty evaluation in someone else's name.

## 2.6 Dashboard

The Dashboard (`/home`, `HomePage.jsx`) answers *what now?*:

1. **Greeting band** — good morning/afternoon, the date, and the single most
   urgent thing, chosen server-side, with its link.
2. **Four attention cards** — what is outstanding, in the order it blocks
   people: evaluations to write, reports with no connect logged, employees
   with no manager, approvals pending, a returned KRA sheet, mid-year or
   annual review due, open connect actions. Only real counts get a card;
   with fewer than four, the row is completed with the person's own counts
   (KRAs and weight, connects, growth goals, rating) — never zeroes.
3. **Quick Actions** — four shortcuts on one line, chosen from pages the
   viewer may open, so none leads to an access-denied screen.
4. **Onboarding emails for you to send** — only for someone who is a SPOC
   on the First-Week Journey: the joiner emails that are theirs, due within
   a week or overdue, five at a time. *Open in Gmail* opens the draft in
   their own Gmail; *I've sent it* records it (§3.12). Nothing for anyone
   else.
5. **Requested to manager** — what you are waiting on someone else for.
6. **My Team** (managers, and HR over everyone) — reports, KRA sheets
   approved, connects pending, evaluation completion; tabs for KRA
   approvals, evaluation status and connects; a department filter and
   name search; one row per person.

**Removed on request:** "My performance" (5 Oct — every link was already in
the menu); and on 6 Oct the **Surveys waiting on you** list and the **PMS
Cycle – Current Status** card (*"please remove these two tabs from
homepage"*). Surveys are still on **Self → My Surveys** and in
notifications. The cycle eligibility rule (§3.6) is still computed and
returned by `/pms/home`; it simply has no card on Home now.

---

# Part 3 — The machinery

## 3.1 The KRA sheet status machine

`pms.kra_sheets.status`:

| Status | Who may write |
|---|---|
| `draft` / `returned` | The employee edits and submits |
| `submitted` | Locked to the employee; the manager decides |
| `approved` | Locked to everyone until HR reopens |

**Submission requires weights totalling exactly 100** (`weightsValid`,
tolerance 0.01 for numeric drift).

The sheet is open for the whole cycle — every phase but `draft` and
`closed`. The client's words: *"KRA should be open for all in entire cycle,
but once KRA is submitted by employee it should be locked for him unless
manager returns the KRA with any feedback."*

**Editable in the reviews (7 Oct):** *"KRA, KPIs and weightage should be
editable in mid year, annual review."* In `mid_year_review`,
`self_appraisal` and `manager_eval` (`reviewKraEditable`), the employee and
their manager (or HR) may change an existing KRA's title, KPI (`measures`)
and weight in the rating cards themselves, on Mid-Year Review, Team Mid-Year,
Annual Review and Team Evaluation. An **Edit KRAs, KPIs & weightage** button
at the top of the list turns every card's title, KPI and weight into fields,
with a running total and Save / Cancel. It is one edit across all the
cards, not a pencil per card, because the weights must total 100 across the
sheet. The routes are `GET`/`PUT /pms/review/kras/:employeeId`.
The rules:

- the same KRAs, by id: none added or removed, because ratings are keyed to them;
- weights still total exactly 100;
- the sheet stays `approved`;
- every change is audited field by field (`KRA_EDITED_IN_REVIEW`) and the
  other person is notified;
- from `hod_eval` on, refused 409.

## 3.2 Growth planning opens per person

`growthEditable()` — the rule the cycle alone cannot express:

- In `kra_open`, it opens **when you submit your own KRA sheet**. Not when
  your manager approves it, and not when HR advances the tenant.
- After `kra_open`, the phase alone carries it, through Annual Review.
- A plan the manager **returned** is editable whatever the phase, up to
  Calibration — the return *is* the authorisation.
- `submitted` or `approved` is locked, and that outranks the window.

The intent of the older "don't write a plan against KRAs you are still
inventing" rule survives in the submission condition: at that point the
sheet is out of your hands, weights totalling 100 and all.

**Aspiring Career, per horizon** (`aspirationEditable()`, 8 Oct). The
**Short-Term** tab follows the rule above. The **Long-Term** tab opens the
same way and stays open **through Manager Evaluation**; from **HOD Review**
on it is locked, whatever else has reopened — a returned plan included.
Each tab has its own target role, plan and milestones (milestones typed on
Long-Term used to be saved onto Short-Term). Milestone *progress* stays
editable all year, on both.

**Which roles a tab offers — the Career Pathing Matrix.** Rows match on
the employee's designation (From Role), department (blank = company-wide)
and level. **Levels are compared as grade and band, not as text**
(`people/career-level.js`): "Band 6", "E3" and "E3 · Band 6" are the same
rung for an employee whose band is "E3 · Band 6"; "E2 · Band 6" or
"Band 7" is not; blank means any level. Before 8 Oct the matrix's
"Band 6" never matched the master's "E3 · Band 6", and employees were told
their path "does not match your level". The same move written several
times — once per department, or with differently written levels — is
offered **once**, the employee's own department's row first. Short-Term
offers one rung; **Long-Term walks up to three rungs** along rows HR wrote
(each To Role and To Level becoming the next From), with times added up
and competencies combined. The target role is validated against the same
list. HR's "matches N employees" counter uses the same level rule.

**What each tab asks** (8 Oct). **Short-Term** is the next move only, and
it is **derived from the Career Pathing Matrix**: *Target role* must be a
move configured from the employee's role and level — the server refuses
anything else, and with no path configured there is nothing to choose
(the screen says to ask HR; it used to accept any typed role) — and
*Expected timeline* is the matrix's typical time for that move, stored by
the server whatever is sent and shown read-only (typed only where HR left
the figure blank). **Long-Term**
asks the rest — total years of experience, skills and interests, growth
plan and milestones. Saving Short-Term sends only its two fields, and a
field a save does not send is kept, so anything an older version stored
on Short-Term is not wiped (it is simply not shown). The Short-Term AI
reads experience and skills from the Long-Term tab for its readiness
read, and ignores any growth plan left on Short-Term.

**Expected timeline comes from the matrix** (8 Oct). Choosing a target
role — from the list or with *Use this one* — sets Expected timeline to
the matrix's typical time for that move (on Long-Term, the whole climb),
shown underneath with the minimum ("typically 24 months for this move, at
least 18 months"). A changed role no longer keeps the timeline typed for
the previous one; a growth plan written for a different role is flagged
("This plan was written for … — update it"). **A saved goal that is not
on the tab's list** is shown as such rather than silently replaced. On
Short-Term it is usually where the person wants to end up, saved before
the matrix matched; **Move it to Long-Term** (`POST
/people/career/my-path/move-to-long-term`) takes its role, timeline, plan
and milestones there in one step and clears Short-Term for the next move
(experience and skills stay on both). It is refused when Long-Term already
has a goal. A long-term goal already saved may be kept while HR has not
yet written the steps to it; a new long-term target must come from the
matrix.

**Where could I aim next? (AI).** Sends the tab's horizon and **what is on
the form, saved or not** — target role, timeline, growth plan, years of
experience, skills and interests (a blank field falls back to what was
last saved on that tab). The model starts from those, assesses a named
target role first, and may only propose roles the matrix offers for that
tab. When nothing matches, the box above the form says why — none
configured, other departments only, level, or deactivated. **Use this one**
sets the target role and fills **only blank fields** (timeline, growth
plan); it never overwrites what the employee wrote, and adds suggested
milestones not already listed, undated.

**Long-Term's target role is open** (8 Oct: "please keep target role open
for long term"). The employee types any role; the roles below — the steps
after the short-term goal, from the matrix or the Grade and Level sheet —
are offered as suggestions, with the matrix timeline filled in when one is
picked. Short-Term stays a matrix move.

**Is it a cross-department move?** Answered from the organisation's data,
not the AI (`GET /people/career/target-departments?role=`): where the role
is held today on the employee master and where the matrix files it. Only
in other departments → a *Cross-department move — Delivery → Human
Resources* badge under the role, as it is typed; in the employee's own
department → "Within your department"; held nowhere → nothing shown.

**Build my plan for <role> (AI)** — `POST /agentic/career-plan`, Long-Term
only. For the typed role it drafts certifications (real, widely recognised
ones only, each with why), the expected timeline (the organisation's
figure where the matrix or sheet reaches the role, otherwise a marked
estimate), the skills the move needs and those the employee already has,
a growth plan running through the short-term goal, and 4–6 next
milestones; it is given the cross-department fact and states it. *Use this
plan* fills the timeline if blank, adds the plan (skills and
certifications included) below anything already written, and adds
milestones not already listed — undated.

**Long-Term starts after the saved Short-Term goal** (8 Oct: "long term
should derive next goal pathing of saved short term details and not same
as short term details"). Once the employee has saved a short-term role the
matrix offers, Long-Term's list is the steps **after** it — walked from
that role and its level, up to two more moves — and the short-term role is
never offered again. Times count from now: the short-term move's figure
plus the next ones ("typically 60 months for the 2 steps"). With no
short-term goal saved yet, Long-Term walks from the employee's own role.
Where the matrix has **no row from a role**, the walk takes **one grade up
on the Grade and Level sheet** instead (`gradeRungAbove`): the next grade
after that role's grade, and the role the sheet names at it for the job
family — the same rule the suggested-matrix download uses — with the
sheet's experience band for its time. So a Software Developer whose
short-term goal is Senior Software Developer is offered *Lead - Technical*
on Long-Term even before HR writes that row; the screen says the step
came from the sheet. Short-Term stays matrix-only. When neither the
matrix nor the sheet has a level above the short-term role, Long-Term says *Nothing
configured beyond your short-term goal yet* and names what HR should add
(`none_beyond_short_term`); the AI says the same rather than repeating the
short-term role. Short-Term's timeline is always shown as the matrix's
figure for the chosen move, even where an older version stored a typed
one.

**Long-Term builds on Short-Term** (8 Oct). The Long-Term tab shows the
saved short-term goal it continues from ("Builds on your short-term goal:
Senior Software Developer in 12–18 months"), and its experience and
skills start from the short-term answers when blank — the same person on
both tabs. A Long-Term suggestion is sent the short-term target role,
timeline, plan and milestones; each matrix rung that runs *through* the
short-term target is marked, and the model proposes the role that comes
**after** it — never the short-term role itself — with the time from now
for the whole climb, first steps to start alongside the short-term plan,
and milestones that follow the short-term ones without repeating them.
**Use this one** fills the blank long-term fields: target role,
timeline, growth plan, milestones, and experience and skills from
Short-Term. With no short-term goal yet, the tab says to set it first.

## 3.3 Ratings: numbers in the database, letters on screen

Ratings stay **numeric** in storage — a weighted average of per-KRA scores
is arithmetic. Letters are a presentation layer (`grade.js` server-side for
PDFs and exports, `frontend/src/grade.jsx` for screens; two copies because
they cannot import each other, and a letter on screen with a bare number in
the PDF the employee keeps would be the worst of both).

The scale is a table on the cycle (`rating_scale`), not a constant.

A rating can move three times — manager, then HOD, then calibration — so
every change is audited with its reason.

**The Final Rating page is that chain (7 Oct):** *"Final rating will consist
only of annual review rating followed by Manager, HOD and HR."*
`rating_chain` on `/pms/my/annual-review` holds five steps:

1. Your overall self-rating.
2. The manager's overall.
3. The HOD's overall, with comment.
4. HR's latest calibration adjustment, with its reason, or "No change".
5. Final: `COALESCE(HR, HOD, manager)`, the same order publish uses, or the
   published figure once it exists.

Steps 2 to 5 are withheld from the employee until their rating is
published. The page lists the annual review by KRA: self and manager, with
the KPI. Mid-Year, Target achievements, Aspiring Career and rating history
are no longer on it; they stay on their own pages.

## 3.4 Calibration and the kitty

`calibration-budget.js`. **Money is integer paise throughout**, converted
only at the edges: a thousand employees at 7.5% summed as floats drifts
from the figure anyone gets adding the column in a spreadsheet, and a
budget comparison off by rounding is worse than none.

Salary-bracket filter, a live kitty and budget panel, per-grade increment
ranges, three pools, and a grid computing revised CTC per person. Two
sanity ceilings: a percentage over 100 and a lump sum over ₹100 crore are
treated as typos.

Grade bands are editable on the page — thresholds in tables, not code.

**The bell curve is always on the page (7 Oct).** It is a chart of the
percentage of rated people at each rating (bars), against the cycle's
`bell_curve` targets (a dashed curve). Below it, a table gives actual,
target and the gap in points for each rating. Unrated people are counted
beside the chart, not in the percentages, because the targets add up to
100% of the people being rated. Before this it was shown only when the
kitty panel was absent, so on a cycle with a kitty it had disappeared.

## 3.5 Increment simulation models pay, it does not set it

`increment-rules.js`. Nothing in it or its routes writes to
`pms.compensation`. A simulation that could quietly become somebody's
actual salary is a different and far more dangerous feature than the one
asked for; the absent write path is what makes "run a few scenarios" safe.

Band ranges are inclusive at both ends — how people write them ("4 to 5
gets 10%") — and overlaps are rejected at save time.

## 3.6 Who is in this cycle

`eligibility.js`, from the client's rule: *joined on or before 31 Dec 2026 →
July 2027 appraisal; joined on or after 1 Jan 2027 → July 2028.*

Implemented generally, not as two fixed dates, so July 2029 needs no code
change. The cycle card states both halves, then tells **you** which applies
— so somebody *not* in this cycle is told when theirs is, instead of
working it out.

No date of joining on the master means eligibility cannot be computed, and
the card says exactly that rather than guessing.

## 3.7 Timesheet → KRA

Three pure modules, deliberately separate: matching (`timesheet-kra-match`),
scoring (`timesheet-kra-score`), rules (`timesheet-rules`). Attribution has
to be arguable on its own, and a scoring change must never quietly move
where somebody's hours were said to go.

What ships for the sheet as a whole is **coverage reporting**, plus a **rating per KRA** (below):

| Number | Meaning |
|---|---|
| mapped % | of hours considered, how many are placed against any KRA |
| weighted coverage % | of the KRA sheet **by weight**, how much saw work |
| alignment % | how closely effort matched the weights |
| score / grade | **withheld** unless HR enables it *and* the mapping is thick enough to mean anything |

Weighted coverage rather than counting buckets, because counting rewards
breadth over value: on the real client month, every hour in one KRA scored
14%, while an hour in each of seven would have scored 100%.

The monthly rollup feeds Calibration as a **suggestion only**.

**The upload template (8 Oct).** *HR → Timesheet → Download template* (on Self → Timesheet until 22 Oct)
gives an `.xlsx` laid out exactly like the Zoho Sprints export people
already upload: sheet *Main*, the five metadata rows, the Timesheet / Item
/ Meeting bands, and the same 52 headings in the same order — repeated
names included, because the parser takes the first *Created On* (the
Timesheet band's). So a filled template and a real export go through the
same parser with nothing special-cased (`timesheet-template.js`; the
round trip is in `timesheet-template.test.js`). The columns the PMS reads
are shaded — required (Log owner, Log Date, Log Hours for calculation),
recommended (Owner Mail Id, Item Id, Item Name, Description) and optional
— with a note on each heading. Log Date is a real date cell; both hours
columns and the Created On columns are text, for the whole column, so a
spreadsheet cannot turn "7:30" into a fraction of a day. Main carries no
example row, so nothing sample can be loaded by mistake; the example and
the downloader's own name and email are on a second sheet, *How to fill
this in*, which the upload never reads.

**What the upload refuses (8 Oct, after the template's review).** Every
rule below is reported per row on *Check the file* — the row is not
loaded, the rest of the file is — and the check now shows the **total
hours** it will load, not only the row count:

| A row with… | Before | Now |
|---|---|---|
| hours as `7:30` in *Log Hours(for calculation)* | 7 h | 7.5 h |
| a time-formatted hours cell (pasted from another sheet) | 1899 h | read as h:mm |
| hours that are neither a number nor h:mm, or none at all | the leading digits, or 0 h — and the day counted as filled | reported |
| more than 24 hours in one log | loaded | reported |
| an item, description or hours but no owner/date (a second log on the same day written by hand) | dropped without a word | reported: every row needs its date and owner |
| a date that does not exist (31/Sep) | rolled to 1 Oct | reported |
| a Log Date written as a formula (`=O8+1`) | "not a date" | the formula's date |
| text partly bold (rich text) | "[object Object]" | the text |

Zoho's own summary rows at the foot of an export (a Log Type and a total,
nothing else) are still skipped, and the client's real export loads
exactly as before. The cell-reading fixes are in the shared Excel reader,
so the employee and KRA imports get them too.

**How an hour reaches a KRA**, in order (`timesheet-kra-match.js`):

1. **An explicit mapping** — a manager or HR said "this item is that KRA".
2. **The KRA's own name** — the item is named after a KRA on the person's
   sheet (ignoring case, spacing and a trailing full stop; a title of 12+
   characters also matches when it appears inside a longer item name). Added
   6 Oct after a client upload renamed items to KRA titles and still showed
   0%: until then only keywords matched.
3. **A keyword** — the KRA's keywords appear in the item name or
   description.
4. **Nothing** — the hours stay unplaced and the screen says so. Two KRAs
   matching the same item give it to neither ("ambiguous").

**One Item Id, several names.** When the same Item Id carries different
item names in a period (the client's U5P-I58 was both *GFF Activities* and
*Code review, security & architectural compliance*), each name is its own
item, so a renamed row is not swallowed by the first name. A mapping saved
on the bare Item Id still applies to every name under it, except where the
name is a KRA title.

### Timesheet rating per KRA (6 Oct)

Specified by the client: *"if 1 KRA weighs 25%, it will be based on ratings
like A+, A, B+, B as per no of hours worked … I have to work 140 hours and
I have worked 70 hours … <40% will have B rating, <80% will be A and <100%
will be A+."*
Ladder confirmed by the client the same day: *"A+ more than 100%, A more
than 80%, B+ more than 70%, B below 69%"* — each band starts at its figure,
so working exactly the expected hours is A+.

| Step | Formula |
|---|---|
| required hours | working days in the period × hours per day (8 by default; weekends and the timesheet holiday list skipped) |
| KRA expected hours | required hours × the KRA's weight ÷ weight of the KRAs measured from timesheets |
| KRA effort % | hours placed against the KRA ÷ its expected hours (not capped — overtime shows, e.g. 125%) |
| rating | **A+** 100% and above, **A** 80–99.9%, **B+** 70–79.9%, **B** below 70% (editable as `kra_bands`) |

Example: 140 h required, a 25% KRA expects 35 h. 17.5 h on it is 50% → B; 25 h is 71% → B+; 28 h is 80% → A; 35 h or more is 100%+ → A+.
A KRA *not measured from timesheets* expects no hours and its weight is
shared across the others. Hours not yet mapped to a KRA count for none, so
ratings rise as items are mapped.

Where it shows: on **My KRAs** and **Team KRA Sheets**, under each KRA (hours worked, hours expected, %, rating, with a month picker and the formula above the table); on the **Timesheet** page; and beside each KRA on **Team Evaluation** and **HOD Review**.

Periods: the **Timesheet** page rates one month (to today at most). Team
Evaluation and HOD Review rate the **days the uploads cover** within the
cycle, so a month nobody uploaded is not counted as hours not worked.

It is **evidence, never the rating of record** — "shown beside, manager
decides". Nothing writes it into an evaluation.

Who sees it: the employee (their own), their manager, the HOD of their
department, and HR (`GET /api/v1/pms/timesheet/kra/ratings/:employeeId`).

**Configuring it: HR → Timesheet → Settings → *KRA rating from the
timesheet*.** Hours per working day, the "indicative below this % mapped"
threshold, and the bands (label and starting %; add or remove a band), with
a worked check line that recomputes as you type. Saved to the timesheet
scoring settings (`core.admin_settings`, key `timesheet`, `scoring`)
through `PUT /api/v1/pms/timesheet/kra/scoring`, which validates them
(every band needs a label, one band must start at 0, hours per day 0–24),
audits the change, and leaves the overall score's own switch as it was. The
working-day calendar — cycle start day and holidays — is the card above it.
An HRBP cannot change either: they apply to everybody.

## 3.8 Competencies

A framework of competencies with levels per role, an employee
self-assessment and a manager assessment. Technical skills are captured by
tier — Primary, Secondary, Tertiary, Basic — rather than one proficiency
per competency.

The manager's ratings, averaged from a **submitted** assessment, are one half
of the 9-box's potential score, §3.15.

## 3.9 Super 50

`super50.js`, from the client: *"ratings will be derived from last three
annual reviews and ratings should be A or A+ with current year ratings as
A+."*

Default rule `{ window: 3, minGrade: 'A', latestGrade: 'A+' }` — and it no
longer hardcodes which **numbers** mean A and A+; it reads the tenant's
scale. The window counts published annual history plus prior years imported
from whatever the client appraised on before this product.

## 3.10 Rewards & Recognition

Three engines, separate on purpose: **eligibility**, **quota**, **workflow**.

**Workflow** — `draft → pending_delivery_head → pending_hrbp → pending_hr →
final_approved`. Reject and send-back require a reason. A sent-back
nomination can be resubmitted; a rejected one cannot.

**Eligibility** is a rule engine, not hardcoded categories: it is handed an
employee, an award row and the tenant's settings. Every refusal is a full
sentence naming the rule, the actual value, and when it changes — because a
screen that says "not eligible" and stops sends the manager to email HR,
which is the manual process with extra steps.

Experience windows are **half-open `[min, max)`**. The client spotted the
overlap themselves: Rising Star is 1–3 years, Buddy Star 3+, so exactly 3.0
would qualify for both and the winner would be whoever nominated first.
Half-open makes 3.0 Buddy Star, always.

**Who can read nominations (8 Oct).** Each approval stage reads its own
queue (HOD, HRBP in remit, HR), a nominator reads the nominations they
raised (*Your nominations* on Nominate for RnR), and one nomination opens
for its nominator, its current stage and HR. Earlier awards (the
nominee's history) are shown to the stage and HR, not to the nominator,
and a manager can nominate only their own team. HR's final stage needs HR
access held in person — an HRBP cannot read it or decide it through the
gateway. A team award, which names nobody, belongs to the remit of the
manager who raised it. Outside the stages, only the nominator resubmits
and only HR marks an award given. The company-wide list — every nominee with department and nominator —
is open to nobody: *"it should not be visible currently, in future if we
want we will allow this display access."* Until then any signed-in person
could read it by typing the RnR Dashboard's address. The RnR Dashboard and
My Nominations pages are switched off (`SHOW_RNR_DASHBOARD`); opening them
later means granting `rnr_view_all`, restoring their two page rows
(migration 086 says how) and turning the switch on.

**Quota** — 3% per cycle, one consolidated pool HR allocates across levels,
consumed only at the final HR gate. Loyalty awards sit **outside** it: a
10-year award is a fact about a date, not something won in competition, and
refusing the fifty-first person to reach ten years in a cycle of forty-two
would mean declining to recognise someone for having worked there.

## 3.11 Engagement and anonymity

**Deleting a survey (7 Oct).** Every survey on the Engagement page has a
Delete button, whatever its status. The page asks first, and says how
many answers go with it. The survey's questions, invitations and responses
are deleted with it, because the foreign keys cascade. The audit row
`SURVEY_DELETED` keeps the title, the status, how many were invited and
how many had answered. Only `engagement_admin` can delete. An HRBP cannot:
a survey names no employee, so the gateway cannot check it against a remit.

**Anonymity is structural.** Invitations and responses are separate tables
and nothing may join them for an anonymous survey; the agentic themes
feature reads a view with no identity columns.

Exports apply three rules on the way out, because once a file leaves the
product nothing is enforced:

1. Unattributed answers never appear beside a name.
2. Aggregates of fewer than **5** responses are withheld.
3. An HRBP's export is scoped to their people and labelled as such.

External reviews (AmbitionBox, Glassdoor) arrive by **spreadsheet import**.
There is no feed: Glassdoor retired its public review API in 2021,
AmbitionBox never had one, and both prohibit scraping. Such surveys are
`import_only` — they take responses but never invite anybody.

## 3.12 First-Week Journey — onboarding tracker (New Hire Insights, HR and HRBP; HR Ops)

The client's *7 Days Onboarding Tracker* workbook, as a tab on New Hire
Insights (opens first; *Survey Insights* is the other tab). The HR Ops
team has the same tracker as its own menu entry, **HR Ops → First-Week
Journey** (`/hrops/onboarding`), hidden for anyone who can already open
New Hire Insights.

Tables: `people.onboarding_activities` (the 48-row matrix, with the
`sender_role` each task's email is sent from), `_days`, `_holidays`,
`_joiners` (with `personal_email`), `_tasks`, `_feedback`,
`_feedback_questions`, `_spocs`, `_task_emails` (with `from_email` and
`sender_role`) — migrations 081, 082 and 083. The screen: a **Report date**, buttons for
**Activity matrix**, **SPOCs**, **Holidays** and **Add joiner**, five
cards, *By owner*, *By day of the journey*, and the joiner list; a joiner
opens to their week, day by day, then Day-7 feedback.

- **A joiner is an employee** picked from the master (anyone active who
  joined in the last three weeks or joins in the next six is offered;
  anyone else by search). Manager, department and
  designation come from the master. Buddy and HR POC are chosen.
- **Starting a joiner creates one task per active activity** — 48 from
  the client's Activity Matrix.
- **Planned date** = `WORKDAY(DOJ, offset, holidays)`: weekends and the
  Holidays list are skipped; 0 is the date of joining, 6 is Day 7. Never
  stored — a holiday added later moves every plan.
- **Day 1 includes readiness** (8 Oct: "pre-day and Day 1 both should
  come under Day 1 only", as the client's workbook labelled them). The six
  readiness activities (offset −2) are part of **Day 1**, listed first
  within it under *Before joining — readiness*, then *On the day*; the
  day reads *Day 1 · Readiness, Welcome & Belonging*. Their dates do not
  move — still two working days before joining, because they must be done
  before the joiner arrives. There is no Pre-Day 1 any more; *By day of
  the journey* starts at Day 1.
- **Status** on the Report Date: *Completed* (has a completion date),
  *Overdue* (planned date passed), *Due Today*, *Upcoming*. Days overdue =
  `NETWORKDAYS(planned, report date) − 1`.
- **Joiner status**: *Completed* when every task is; else *N overdue*;
  else *On track*. *Where*: Not joined (any time before the date of
  joining) / Day n / After Day 7.
- **Day-7 feedback**: 1–5 on seven statements; average shown per joiner
  and across joiners.
- **Dashboard**: joiners in onboarding, due today, overdue, average
  feedback, completion %, by owner (a shared activity counts for every
  owner group named), by day.
- **Hidden on screen since 8 Oct** ("please hide first week journey page
  from new hire insights on front end and keep the same in database").
  `SHOW_FIRST_WEEK_JOURNEY = false` in `frontend/src/features.js` hides the
  First-Week Journey tab on New Hire Insights (which opens on Survey
  Insights), the HR Ops menu entry and the *Onboarding emails for you to
  send* card on Home. Every table, API route and row described below is
  unchanged; setting the switch to `true` and deploying brings it all back.
- **Who may open it**: `engagement_admin` (HR) or `onboarding_ops`
  (`people/onboarding.js`, `guard`). **HRBP** sees and edits only joiners
  in their remit — the counts too. Holidays, the SPOC list and the matrix
  are company-wide, so an HRBP reads them and HR changes them.
- **The tick belongs to HR Ops, HR and HRBP** (corrected 7 Oct). Marking a
  task done or not done, its completion date, *Mark due ones done*, the
  acknowledgement and sending a joiner email need **`onboarding_ops`**,
  which the `hr_ops`, `hr` and `hrbp` bundles carry (migrations 002 and
  083; `opsGuard`). Anyone else who can open the tracker sees the ticks
  greyed, with "HR Ops, HR and HRBP mark tasks done", and can still add
  remarks, issues and closure dates. The server refuses the fields
  regardless of what the screen shows (403, `needs: onboarding_ops`).
  `hr_ops` is a role HR assigns on **Employees** like any other.
- **Every task's email goes TO the joiner, FROM the SPOC who owns the
  activity** (corrected 7 Oct; it used to go to the SPOC). *Email joiner ·
  from {role}* on each task opens the draft — "Dear {first name}", what
  happens, when, what it is for, signed by the SPOC — editable before it
  goes. Every send is kept on the task with who it was from and to.
- **Which SPOC** — the activity's `sender_role`, the first owner named on
  the client's matrix (migration 083, `SENDER`): e.g. the intimation mail
  from the **Recruiter**; HR Welcome, Documentation and the HRMS/policies
  walkthrough from **HR Ops**; Workplace Tour from **Admin**; IT Setup and
  Access Validation from **IT**; Team Introduction and the KPI/KRA
  discussion from the **Manager**; Buddy Introduction from the **Buddy**;
  Code of Conduct and the 7-day connect from **HR**; Business Overview and
  PMS Orientation from the **HRBP**; Learning Needs from **L&D**. Where
  the matrix names two owners (*Manager/SME*, *HR Ops → IT*) the first
  sends it. The
  matrix shows it in an *Email from* column. The address: Manager and
  Buddy from the joiner's record; HR from the joiner's HR POC, else the HR
  desk; every other role from the **SPOCs** list on this page. A SPOC with
  no address set is named on screen and nothing is sent.
- **Which address of the joiner's** — before the date of joining, the
  **personal email** HR records on the joiner's week (the company mailbox
  usually does not exist yet); from day one, the company address from
  the employee master; the personal one if the master has none. With
  neither, the screen says so and nothing is sent. Both addresses are
  worked out on the server, never taken from the request.
- **How it leaves: the SPOC sends it from their own Gmail — no setup**
  (decided 7 Oct: "avoid all these setup and share mails directly from
  spocs mail"). Every employee's **Home** page carries *Onboarding emails
  for you to send* when they are the SPOC for any (`GET
  /people/onboarding/my-emails`): the activities whose sender works out
  to *their* address — the activity's SPOC role from the SPOC list, or the
  joiner's own manager, buddy or HR POC — not yet done, not yet sent, due
  within seven days or overdue; five shown, most urgent first, with *Show
  all*. **Open in Gmail** opens Gmail's compose window in their own
  browser and Google account (`authuser`), addressed to the joiner with
  the draft filled in; they send it there and press **I've sent it**
  (`POST /tasks/:id/mark-sent`). The PMS cannot see anyone's Gmail, so
  "sent" is the SPOC's word, logged as `own_gmail` / `sent_by_spoc` with
  who said so and when, and audited. HR Ops, HR and HRBP (in remit) can
  **Mark as sent** on the SPOC's word from the tracker, where each task's
  email box says whether it is waiting on the SPOC or was sent and when.
  Nobody else can mark another person's email sent.
- **Optionally, the PMS sends them itself** once HR has set email up under
  Settings → Email and switched it to Live (below): *Send through the PMS
  now* appears for HR Ops, HR and HRBP, still from the SPOC's own address
  (Google's SMTP relay, a Google key, or a mailbox with Send As).
- **Email: HR → Settings → Email — three steps.** Until email is *Live*
  (the default is *Simulated*), every email is logged in `core.notif_log`
  and none is delivered.
  1. **Connect.** Three choices:
     - **Google Workspace** (Mindgate; the default when nothing else is
       set). **The simple way — Google's SMTP relay** (7 Oct, "make this
       more simple for IT"): IT, once, in the Google Admin console → Apps
       → Google Workspace → Gmail → Routing → *SMTP relay service*:
       allowed senders *Only addresses in my domains*; authentication
       *Only accept mail from the specified IP addresses* with this
       server's public IP (shown on the card, with a copy button — found
       from AWS's `checkip` service, or `SERVER_PUBLIC_IP`); *Require TLS*.
       No key, no password: the PMS connects to `smtp-relay.gmail.com:587`
       without signing in, greets with the company domain (Google turns
       away an unqualified name), and sends from the person's own address —
       any address in the domain, group addresses included. HR sets the
       address reminders are sent from. The IP must stay fixed (an Elastic
       IP on AWS). Copies do not land in the SPOC's Sent folder.
       **Alternative — a service-account key** (a link on the card), for
       copies in each SPOC's Sent folder: IT enables the Gmail API in a
       Google Cloud project, creates a service account and downloads its
       JSON key, uploads it here, then in the Admin console → Security →
       API controls → *Domain-wide delegation* adds the **Client ID**
       (shown after upload) with the one scope
       `https://www.googleapis.com/auth/gmail.send`. The PMS signs an
       RS256 token request for each person (`sub`) and posts to the Gmail
       API (`core/gmail.js`). That lets it *send* (never read) as any user
       in the domain — not groups — so it only ever sends as an address it
       worked out itself (the activity's SPOC, the joiner's manager, buddy
       or HR POC, or the reminders sender), never one from a request, and
       logs every send. The key is write-only and never audited.
     - **Microsoft 365** / **Other**: one mailbox and its password; the
       provider fills in server, port and STARTTLS (*Advanced (for IT)*
       holds the rest). It sends onboarding emails *as* the SPOC, needing
       Send As from IT. `SMTP_*` / `MAIL_FROM` in `api.env` still work.
  2. **Send a test email to yourself** — really delivered even in
     Simulated mode, only to the person pressing it, through the same
     transport every email uses; gives up after 20 seconds; a failure comes
     back as a sentence (`core/mail.js` `explain`: Google not yet
     authorised, Gmail API off, not a Workspace user, Authenticated SMTP
     off, wrong password, server unreachable, Send As refused) with the
     server's own words beneath. With Google, **each SPOC address is
     checked as well, without sending anything** (`GET
     /people/onboarding/spocs/check`): Google refuses a token for a group,
     a typo or an outsider.
  3. **Go live** — offered only after a delivered test; the server refuses
     it otherwise. Saving new connection details, or switching between
     Google and a mailbox, throws the old test away (and a switch while
     live drops back to recorded-only until tested).

  The badge says where HR is: *Not set up*, *Next: send a test email*,
  *Test failed*, *Ready to go live*, *Live*. The card is HR's alone — an
  HRBP does not see it.

Verified against all 288 real rows of the workbook: planned date, status
and days overdue match on every one. Two workbook faults were corrected
rather than copied: 55 tracker rows per joiner for 48 activities, and the
Ownership sheet counting "Recruiter" as IT. (A third — Readiness rows
labelled Day 1 though planned before joining — was split out as
"Pre-Day 1" on 6 Oct and put back under Day 1 at the client's request on
8 Oct.)

## 3.13 Reminders

`reminder-schedule.js` is the pure calendar; `reminders.js` answers who it
is about and whether they already got it.

1. quarterly connect — employee + manager, first Monday after each quarter
2. mid-year self — 1 September, then 15th/20th/25th/last Friday
3. mid-year manager — first Monday of September, then the same
4. mid-year chase — every weekday from 3 days after the employee signs
   until the manager finalises
5. annual — the same three shapes again, in March

Plus a self-chase after **7 days** on a form nobody has filled in, measured
from the phase opening (the latest `PHASE_ADVANCE` in `pms.audit_log`).

---

## 3.14 Performance Improvement Plan

Publish opens one automatically. On an **annual** cycle the rule is the
9-box's (§3.15): Underperformer (0,0), and anybody below the Low limit who
cannot be placed — not (0,1) or (0,2). On a **mid-year** cycle it is still a
final rating below the cycle's `pip_threshold`. A later publish of the same
cycle that moves somebody out of (0,0) withdraws an untouched automatic plan
(status `closed_withdrawn`, the employee is told) and hands one already
started to HR.
Since 7 Oct the **manager** (or HR) can also open one, from
**Improvement Plans** (`/team/pip`) or the link on Team Evaluation. One plan
per person per cycle (409 otherwise). The plan has three parts, all
required:

1. **Description** of the performance concern (`performance_description`).
2. **Targeted areas**: each an area and what good looks like
   (`target_areas`, jsonb).
3. **Gates**: dated checkpoints where the improvement has to be shown,
   inside the plan's start and end dates (`pms.pip_gates`).

Each gate is reviewed separately, as **met** or **not met**, and a note is
required. A reviewed gate cannot be dropped from the plan. Weekly notes and
a closure with a reason continue as before. A closed plan is a record and
cannot be edited. The employee reads their plan on `/pip` and cannot edit
it. Opening, editing, gate reviews and closing are audited and notified.


## 3.15 9-Box Grid

Built to the client's *9-Box Grid – PMS Build Specification* (13 Oct).
Rules in `nine-box-rules.js` (pure), everything else in `nine-box.js`.
Annual cycles only.

**Axes.** Written (Performance, Potential); performance runs left to right,
potential bottom to top, so (0,0) is bottom-left and (2,2) top-right. Both
are on the 1–5 scale and banded the same way: Low below 3.0, Medium 3.0–3.9,
High 4.0 and above. A score is rounded to two places before banding.

- **Performance** is the final rating: calibration adjustment, else the
  submitted HOD rating, else the submitted manager rating — publish's order.
- **Potential** is 50/50 the **competency score** (the manager's ratings,
  averaged, from a submitted assessment, §3.8) and the **questions score**
  (the manager's four Potential questions, 1–5, all four answered). One half
  missing: the other alone, marked *one half*.

**Not placed:** a new joiner (joined after the cycle's cut-off,
`eligibility.js`; no joining date counts as placeable), no rating, or no
potential input at all.

**Settings per cycle** (`pms.nine_box_settings`, Cycles → 9-Box settings):
the two limits, the competency weight, the nine names and actions, the
questions. No row means the latest earlier cycle's, else the defaults.
Locked once the cycle's 9-box is published; questions can be reworded but
not added or removed once a manager has answered.

**Live until publish.** Calibration, the grid and the reports work the box
out from the inputs on every read, so a changed limit or an override moves
people at once. HR overrides **one band** in calibration with a mandatory
reason (`pms.nine_box_overrides`, append-only, audited); a null band goes
back to the worked-out one. Nobody overrides their own.

**At publish** each person's placement is stored (`pms.nine_box_placements`,
with scores, bands, overrides, previous box, movement and the settings
used), `cycles.nine_box_published_at` is stamped (a rollback before publish
clears it), and:

| Box | What publish does |
|---|---|
| (0,0) | Automatic PIP (§3.14) and its action |
| (2,2) | Succession pool for the department; Super 50 recorded |
| (1,2), (2,1), (0,2), (0,1) | Development action for the manager; (0,2) due in 30 days, (0,1) in 60 |
| (1,1), (2,0), (1,0) | The box's action for the manager |
| Not placed, below Low | Automatic PIP |
| (0,0) after (0,0) in the previous cycle | Escalation to HR (HR closes it, not the manager) |
| Left (2,2) | Retention alert to HR and the manager |

The **previous cycle** is the one immediately before by appraisal year whose
9-box was published; no row there means no previous box, so a gap breaks a
streak. A re-publish supersedes what no longer applies and reopens what
applies again. Managers and HR get one digest each; nothing an employee is
sent names a box.

**Who sees what.** `/admin/nine-box` (pms_admin) the whole company;
`/hod/nine-box` (pms_hod) their departments; `/team/nine-box`
(pms_team_eval) their direct reports. Nobody sees their own box — not on the
grid, Calibration, the cycle activity feed, or either data export. An HRBP's
company view is cut to their remit before it is counted.

---

## 3.16 MoM tab — daily connects and their minutes

Connects → **MoM** (everyone), and Team Connects → **MoM** (manager and HR). Code: `server/modules/performance/mom.js`, `frontend/src/pages/MomTab.jsx`. **Simplified on 15 Oct** ("a lot more complicated to handle"): no recording in the PMS and no recording notice, a three-part form, and a published MoM is simply edited.

1. **Set up once.** The manager saves the team's Google Meet link (only `https://meet.google.com/xxx-xxxx-xxx`), the daily time and length, and the attendees (all direct reports unless narrowed). **Saving the link switches daily connects on.** The manager or HR can switch them off and on again; removing the link switches them off.
2. **Every working day** (Monday–Friday less HR's holidays) a connect is created per switched-on team, with a reminder 15 minutes before carrying the Meet link.
3. **After the call** the organiser opens the MoM and either uploads or pastes the Google Meet transcript — the AI fills in the minutes (owners only when named, due dates only when said, no judgements about people; "Low confidence" when the transcript is thin) — or types them. The form has three parts: **Notes**, **Action items** (task, owner, due date) and **Attendance** (everyone ticked; untick who missed it). Publishing needs the notes and an owner and a due date on every action item.
4. **Published**: attendees are told (nothing to acknowledge); each owner gets their items, with reminders when due and overdue, and the owner's manager is told at three days overdue. Open items carry over to the team's next MoM until marked done. The organiser or HR can **Edit** a published MoM; owners of new items are told, a removed item is cancelled (not deleted), and the change is kept in the audit log. A published MoM can also be **redone with AI**: upload or paste the transcript on it, and the AI draft opens in its editor (notes and attendance from the draft, existing action items kept and the AI's new ones added). Nothing changes until **Save changes**; **Discard AI draft** sets it aside.
5. At 6 pm a connect with no MoM and no transcript is **Missing** and the organiser is told; it can still be written later or marked "not held" with a reason.

Who sees what: attendees see published MoMs of their connects; the manager their team's; HR all, plus the daily **Report** and MoM settings (transcript retention, 365 days by default; which notices are also emailed). MoMs and action items are kept permanently. A recording made in the PMS before 15 Oct can still be played until its retention date; the recording and notice routes remain on the server, unused by the screens.

## 3.17 Changes of 15 Oct — My Growth, Connects, sign-in, Timesheet, HOD Review

**My Growth — Expected timeline (both tabs).** The Career Pathing Matrix's months are a career clock that started on the employee's first working day. What is shown is the matrix's figure for the whole path **less total experience**, never below "Due now". Example: 5 years' experience, 72 months to the short-term role and 48 more to the next — Short-Term **12 months**, Long-Term **(72 + 48) − 60 = 60 months**. (Until 15 Oct experience came off the first step only.) Total experience is the HRMS figure; else the years the employee entered; else **the time since joining** — never zero. The screen says which was used.

**My Growth — Long-Term role by experience.** Long-Term looks up to five rungs ahead and suggests the rung the employee's total experience points to: the first one their experience does not already cover, so a long career can skip a level. It is listed first, pre-filled when the tab is empty, and given to the AI as the role to propose.

**Connects — sorted by AI.** The connect form asks only what was discussed (and the topic). After the save, AI sorts it into Achievements, Blockers and Feedback — nobody types those. The save never waits on the AI; the connect shows "Sorting…", then "Sorted by AI from the discussion". If the AI fails, the connect says why and offers Try again; the discussion is always kept as written.

**Connects — Team Connects.** Self → Connects shows your own connects and the ones others had with you to sign off. Your reports' connects are on **Team Connects**:

| Tab | Shows the connects of |
|---|---|
| Manager | your direct reports — and you log a connect with a report here |
| HOD | everyone on your reporting line, through their managers |
| HRBP | the employees in your remit |
| HR | everyone |

**Connects — training suggestions.** On Team Connects (pick a person) and on your own Connects page, *Suggest training* asks the AI for 3–6 trainings from that person's last 12 connects (blockers, feedback, recurring themes) and their KRAs. Each names the need and the connect dates it comes from. It is a draft, stored with its input; it never rates the person.

**Sign-in — Forgot password.** *Forgot password?* emails a one-time 8-character code. It works for 30 minutes and once; five wrong tries spend it; a new request replaces it; at most three requests an hour per address. The answer is the same whether or not the address has an account. It needs email switched on (Settings → mail mode *live*); otherwise the page says to ask HR. A code rather than a link, so a forged request cannot point the email at another site.

**Timesheet — Login hours %.** Hours logged ÷ (hours a working day × working days), working days being Monday–Friday less HR's holidays, up to today. 8 hours a day unless HR changes it (Timesheet → Settings → *Login hours a working day*). 207 hours over 23 working days is 207 ÷ 184 = **112.5%** (until 15 Oct it was the share of days with any log: 22 of 23, 95.7%). Green / Amber / Red use the same thresholds. Days filled and missing are still shown.

**HOD Review — three tabs.** *Review queue* as before. *Team analysis*: the Delivery Head's reporting line — the whole team, the direct reportees, then each manager's team — with KRAs approved, self-appraisals, manager evaluations and the HOD's own reviews submitted, and the ratings (the HOD's where submitted, else the manager's submitted one) as an average and a distribution by grade; open any group for the people. *9-Box Grid (my team)*: the 9-box of that reporting line only, not every employee of the departments they head. The HOD menu's 9-Box Grid opens this tab.

## 3.18 Super 50 benefits

What being Super 50 brings, from the client's policy sheet (15 Oct). Who is Super 50 in a year is §3.9; this section is the benefits year built on it.

**The benefits year.** One per appraisal: *Super 50 benefits 2026-27* is based on the **FY25-26** annual appraisal and runs **1 Jul 2026 – 30 Jun 2027**. HR creates it from the policy sheet on HR → Super 50 Benefits and can change anything on it: dates, tiers, amounts, benefits, entitlements and hubs.

**Tiers, by consecutive years.** A year counts when the Super 50 rule held for it, judged on the ratings up to that year — published cycles and imported pre-PMS years alike. The run ends at the first year that did not qualify or has no rating.

| Consecutive years | Tier | Amount | Beyond the celebration, felicitation and fast-track promotion |
|---|---|---|---|
| 1 | Super 50 | ₹30,000 | — |
| 2 | Super 50 Twice | ₹30,000 | single-punch full attendance; 10 days EL mandatory; an IIT/IIM programme from the catalogue |
| 3 or more | Super 50 Elite | ₹50,000 | single-punch full attendance; 10 days EL mandatory; IIT/IIM 2-day refresher; 125% of last year's variable |

The higher tier replaces the lower: each person holds one tier, and one amount. Example: A+ in FY25-26, FY24-25 and FY23-24 over A in the two years before — each of those three years qualified, so **Elite**. A+ this year but A last year — last year did not qualify, so the run is one: **Super 50**.

**When tiers are set.** When HR publishes the annual cycle the benefits year is based on, and whenever HR presses *Set the tiers now*. A new or higher tier is told to the person in the app and by email. Someone who no longer qualifies (a corrected rating) loses the tier — unless a claim of theirs is already approved, which HR decides. A run that awards nobody says why (the rule's grades are not on the annual scale; nobody has a rating for the year).

**One budget, claimed against bills.** The certification amount and the hub reimbursements are the same money. A claim names its hub — Knowledge (books, library), Health (gym, sports club), Personal (hobby membership), Tech (Claude certification, mobile, laptop) — the amount, and the bill (PDF, JPG, PNG or WEBP, up to 5 MB). It cannot be more than what is left after approved claims **and those still waiting on HR**. No cap per item.

**HR alone decides.** Approve, or return with a reason the employee sees. Approving re-checks the limit. Nobody decides their own claim. The employee can withdraw a claim while it waits.

**The lapse.** Claims are taken only between the year's dates. What is not claimed by the end date lapses. A reminder goes out once, 30 days before (HR can change the days), to everyone with money left; the year closes itself the day after it ends.

**Other benefits.** *Entitlements* (Excel): tier, consecutive years, amount, approved, waiting, left, single punch, mandatory EL days, fast-track, programme — and the variable % only for someone who may see pay. *Approved claims* (Excel) for finance, with a total. Calibration shows each person's tier and fast-track flag beside their name. Twice and Elite pick their IIT/IIM programme on My Super 50 from HR's catalogue; HR marks it completed. Every awardee downloads a certificate; HR plans the felicitation in Events & CSR from the page (the form opens filled in).

## 3.19 Queries

People Hub → **Queries** (until 15 Oct "Appraisal Queries"). *Raise query* opens the form on the page: **Title**, **Raise to** — one or more colleagues found by name or email, each told in the app and by email (leave it empty to raise it to HR) — and **Description**.

People Hub shows the queries you raised and those raised to you. **HR → Queries** is HR's inbox of every query in the company, with Open / Answered / Closed and *Raised to me or to HR*; someone in HR answers a query raised to them there, not from People Hub. Only the person who raised it, the people it is raised to and HR can open a query.

Status: **Open** until someone else answers, then **Answered**; the raiser's reply makes it Open again. Any of them can **Close** it, after which it takes no more replies. The raiser is emailed every answer; the others are told in the app.

A query raised to nobody goes to HR, and everyone in HR is told, in the app and by email (16 Oct).

## 3.20 Changes of 16 Oct — from the client's QA

From the defect tracker and the employee and manager test cases.

**Signing in.** Empty boxes are named before anything is sent: *Enter your email and password* / *Enter your email* / *Enter your password*. Every password box has its own Show/Hide button. A password is typed by hand: it cannot be copied or cut out of the box, nor pasted or dropped into it, and the box says so when someone tries. A browser's own saved-password fill still works (it is not a paste). The mailbox password in Email settings is a system secret, not a login, and can still be pasted. After **30 minutes** without a click, key or scroll in any PMS tab, you are signed out; a notice two minutes before offers *Stay signed in*. The sign-in page then says why you were signed out. *Forgot password* checks the code is 8 characters and the new password at least 8 before sending.

**Company name and logo.** HR sets them on Settings → Company branding (PNG, JPG, WEBP or SVG, at most 300 KB). They show on the sign-in page and in the top bar, beside Agentic PMS. Nothing shows until HR sets them. Audited.

**Notifications.** Every notice opens the page it is about (several pointed at pages that no longer existed), and opens it without reloading the app. Older notices with an old address are sent to the right page. The panel stays open while you read: clicking a notice opens its page behind the panel and marks that notice, so you can go on to the next. It closes with the bell, its ×, Esc, or a click outside it.

**Menu search.** Pages hidden in the current phase are not offered; pages shut in this phase are shown with a lock and the reason, and Enter opens the first page that is open.

**Manager evaluation.** Submit needs every KRA rated (*Rate every KRA before submitting — N still have no rating*), and only the employee's manager (or HR) submits. Once submitted it is locked. HR reopens it on the Completion Report with a reason; the manager is told the reason. Reopening is possible only while manager evaluation is open — after that HR changes the rating in Calibration. Saved KRA ratings come back when the page is opened again. The one exception to "every KRA rated": an overall set through the 7 organisational parameters (switched off on screen since 23 Sep).

**HOD rating.** A HOD rates only employees in a department they head, never themselves (another HOD or HR does), only after the manager has submitted, and only on the cycle's scale. Submitted, it is locked; HR changes it in Calibration with a reason. The queue says why it is empty (no department headed / not the HOD phase yet / nothing submitted by managers yet), shows the manager, and keeps the HOD's saved comment.

**Completion Report.** The search also matches the status columns (*pending*, *submitted*, *complete*…).

**Download all my data.** An Excel workbook written for the person, not the database: *About this file*, *Profile*, *KRAs*, *Annual Review* and *Annual Review by KRA*, *Manager evaluation*, *Growth plan*, *Career path*, *Connects*, *Improvement plan*, *Ratings*, *Consents*, *Review meetings*, *AI suggestions*. Names instead of ids (the cycle, the KRA, the manager), dates as dates, Yes / No, statuses in words; no ids, internal keys or code anywhere. Each sheet prints one page wide. HR's export of someone adds the sheets marked *HR only*. The API still answers JSON unless `?format=xlsx` is asked for.

**My Competencies.** A refused submit keeps the form: the competencies still blank are marked in red and the first one is opened.

**Connects.** Search also finds the HR person, who logged it, the KRA linked, the date written several ways (16/10/2026, 16 Oct 2026, 2026-10-16) and *signed off* / *pending sign-off*. **Sign-off** is by the other person in the connect, never the one who logged it — or by HR. A connect saved before the author was recorded keeps the old rule (its manager signs). Everyone else in the connect is told when it is signed off. The Manager Dashboard's connect links open Team Connects.

**Timesheet upload.** A re-upload replaces **only the days the file has logs for**, person by person; the check says how many stored logs that will replace, and the result how many it did. (Until 16 Oct every day from the file's first date to its last was replaced: a file with 1 and 30 Sep wiped the days between.) The file box empties after an upload. An empty *Log owner* is reported even when Owner Mail Id is filled. A row with hours and only a sprint, item type or project is reported, not skipped. **Dates:** 18/Sep/2026, 18-Sep-26, 18 September 2026, Sep 18, 2026 and 2026-09-18 are read; an all-number date is read only when one reading is possible — 25/09/2026 is 25 Sep — and 05/09/2026 is refused: *ambiguous — it could be 5 Sep or 9 May. Write it as 05/Sep/2026*.

**RnR.** The HOD stage belongs to the nominee's own HOD — the head(s) of their department in the department-head register (a team award: the nominator's department). Another department's HOD does not see it, cannot open it and cannot decide it; only that department's HOD is told. A department with no head registered stays open to every HOD. Nominations are taken only between the cycle's open and close dates (company time zone); after the close the page says so and Submit is off. A rejection's or send-back's reason shows in *Your nominations*. The HRBP (for someone in their remit) and HR are told when a nomination reaches them. The approval screen shows a team award's team, members, project and quantified impact.

**PIP.** A closed plan cannot be changed at all, status and reason included. Weekly notes are never written by the person on the plan, even if they are HR. Without an open cycle, a second plan for someone whose plan is still running is refused.

**Dashboards.** The Dashboard names the phase in every phase and says what it means for you, e.g. *Annual Review — Write your Annual Review: rate yourself against each KRA and submit*, or *Manager Evaluation — Your manager is evaluating your year. Nothing is needed from you.* On the Manager Dashboard the manager's **own** overdue work (a returned KRA sheet, their own Annual Review) comes before the team's, marked *Your own work first*; the *Team progress* row is always shown. On Team KRA Sheets only the employee's own manager gets Approve / Return; HR decides others from All Approvals.

**Team Evaluation.** The files an employee attached to their Annual Review are listed under *Their annual review*, each with its KRA, to open while rating.

**Reporting-line change.** KRA sheets and growth plans follow the employee to the new manager whatever their state (as before). A mid-year sign-off, a manager evaluation or a competency assessment the old manager **submitted** stays with them: they still find it (marked *former report · read only*) and can open it; they cannot change it. One they had not submitted follows the employee. The record keeps the manager it was submitted under.

**Weights edited during a review.** Changing KRA weights on the review screens works the self-rating out again, and a manager evaluation still in draft. A submitted manager evaluation keeps the rating its manager signed (HR reopens it to re-rate). Each recomputation is audited with the old and new figure. Example: self ratings 5 and 2 at 50/50 = 3.5; at 80/20 = **4.4**.

**Competencies — reopen.** HR → Competency Dashboard → *Reopen a submitted assessment*: search, pick the self- or manager assessment, give a reason. The employee (self) or their manager (manager assessment) can edit and submit again, and is told the reason. Audited.

## 3.21 Changes of 20 Oct — from the client's QA, round 2

**How much can be typed.** A one-line field (a title, a name, a topic, a team name) takes at most **150 characters**. A box for writing at length (a comment, a description, a KPI, a narrative, an answer) takes at most **220 words**, and never more than 2,000 characters (that stops one unbroken string thousands of letters long). Under each such box a counter reads *38 / 220 words*; typing or pasting past the limit stops at the limit. The server holds the same rule on every save under Performance, People and Engagement, and names the field: *"What went well" is too long — keep it to 220 words (it has 310).* Left alone because they are long by nature: meeting minutes and transcripts, HR's letter and email templates, and settings. AI drafts that fill these boxes (Annual Review strengths and areas to improve, the mid-year narrative) are kept to whole lines within 220 words. One KRA in the library is longer than 150 characters (Admin · Executive, "Facility Repairs & Preventive Infrastructure Maintenance…", 159): HR shortens it in the KRA Library; anyone who has it on their sheet shortens it there before saving.

**Required fields** carry a red asterisk: KRA title and weightage on My KRAs; the comment needed to return a KRA sheet or a growth plan; mid-year ratings, the reflection and the manager's narrative; every KRA rating in Team Evaluation; every competency rating; the HOD rating; a query's title and description; a connect's date; a growth goal's title and target date; a PIP's concern, targeted areas and gates; a nomination's justification (when the award asks for one) and a team award's team name; the reason when HR overrides a rating in Calibration.

**Status tabs** (Team KRA Sheets, Team Evaluation, All Approvals) always show every tab with its count, 0 included: on Team KRA Sheets *All · Pending · Approved · Returned · Not submitted*. Statuses read in words (*Not submitted*, not `not_started`) and weights as *100%*.

**Team Timesheet.** The Manager menu's timesheet page is named *Team Timesheet*.

## 3.22 Changes of 22 Oct — timesheets are uploaded by HR

*"Timesheet will be updated only by HR/Super Admin and not by employee. Kindly update logic and remove option from employee for uploading time sheet. Also for HR provide option to upload per person and bulk as well."*

**Who uploads.** Only HR and Super Admin, checked on the permission they **hold** (`pms_admin`; `holdsPermission`, `timesheet.js` `mayUpload`). An employee or a manager gets 403 *"Timesheets are uploaded by HR. Ask HR to upload yours."* on the upload and on the template; an HRBP reads their remit's timesheets but is not lent the upload. Self → Timesheet is the employee's own report and nothing else.

**Two ways to load, one route** (`POST /pms/timesheet/upload`, check first, then `?commit=1`):

| Mode | How | What loads |
|---|---|---|
| Bulk | HR → Timesheet → Upload timesheets → *Bulk — everyone in the file* | Every row, against the person it names (Owner Mail Id, else Log owner) |
| One person | *One person* → find the employee; or the upload on that person's own timesheet | `?employee_id=` — only that person's rows; every other row is reported (*"this upload is for … only"*) and left alone |

Everything else is as before: a re-upload replaces only the days the file has logs for, per person; each upload is audited per person (`TIMESHEET_UPLOADED`, now with `mode`). The template is on HR → Timesheet; in One person mode it names that person's Log owner and Owner Mail Id. `GET /pms/timesheet/all` carries `can_upload`, which decides whether the screen shows the upload.

## 3.23 Changes of 22 Oct — Log Title is the KRA

Asked: "in download template log title should be use as KRA title and KRA coverage will be mapped
accordingly instead of item used as KRA coverage."

| What | Rule |
|---|---|
| Template | Log Title (column D) is shaded as the KRA column and offers a list: the person's KRA titles in the active cycle (one-person template), or every title (bulk, with a **KRA titles** sheet saying whose each is). Help sheet updated; it no longer says employees upload. |
| Upload | Log Title is read and stored with each log (`pms.timesheet_entries.log_title`, migration 098). **Check the file** reports rows naming one of their owner's KRAs, blank ones, and every Log Title that is not one of the owner's KRA titles (row, title, reason). Those rows still load. |
| KRA coverage | Order: **Log Title** → manager's mapping → item named after a KRA → keywords → unplaced. A Log Title equal to one of the person's KRA titles (case, spacing and a trailing full stop ignored) places the log there — chip **By Log Title**, not remappable on screen. A Log Title that is not a KRA title is shown as unplaced with the reason, never guessed from the item name or keywords; a manager may map it. A log with no Log Title is placed exactly as before. One item logged against two KRAs shows as two lines. |
| HR backlog | Hours placed by Log Title count as mapped. |
| Matching | A Log Title matches a KRA title on letters and digits only, "&" read as "and" — so punctuation, spacing and case never stop a match. |
| Screen | KRA coverage states the hours placed by Log Title, the hours whose Log Title is not a KRA, and the hours with **no Log Title** — with what to do when logs were uploaded with that column empty (upload again with the titles; it replaces those days). Each unplaced item uploaded without a Log Title says so. |

# Part 4 — Changing behaviour without code

| What | Where |
|---|---|
| Who may open a page | `core.page_permission` |
| What a role may do | `core.role_permissions`, `core.user_permissions` |
| Rating scale, bell curve | `pms.cycles.rating_scale`, `bell_curve` |
| Grade bands, increment ranges | Calibration screen → `pms.grade_ladder`, `pms.increment_matrix` |
| Competency levels | `pms.competency_scale`, `pms.competency_role_levels` |
| RnR awards, bands, quota | `rnr.awards`, `rnr.band_levels`, `rnr.settings` |
| Connect questions | `pms.connect_questions` |
| HRBP remits | `core.hrbp_scope` |
| Department heads | `core.department_heads` (HR → HOD) |
| Super 50 rule, KRA Library scope | HR → Settings |
| Super 50 benefits: dates, tiers, amounts, benefits, hubs, IIT/IIM catalogue | HR → Super 50 Benefits → `pms.super50_policies`, `pms.super50_programmes` |
| Timesheet calendar (cycle start day, holidays, compliance thresholds) | HR → Timesheet → Settings |
| Timesheet KRA rating bands, hours per day, indicative threshold | HR → Timesheet → Settings → KRA rating from the timesheet |
| Which KRA a work item serves; KRAs not measured from timesheets | Manager → Timesheet (mapping), HR mapping backlog |
| Onboarding activity matrix, day themes, Day-7 statements | `people.onboarding_activities`, `_days`, `_feedback_questions` (seeded from the client's workbook) |
| Onboarding holidays, SPOC email addresses (who each email is sent from) | New Hire Insights → First-Week Journey → Holidays / SPOCs |
| Which SPOC sends each onboarding activity's email | `people.onboarding_activities.sender_role` (seeded from the client's matrix) |
| A joiner's personal email (used before joining) | The joiner's week → *Personal email (before joining)* |
| Who ticks onboarding tasks | Permission `onboarding_ops` — in the `hr_ops`, `hr` and `hrbp` bundles; role `hr_ops` set on Employees |
| Email for reminders and notifications (and, optionally, onboarding emails sent by the PMS itself): Google SMTP relay, Google key, or a mailbox; test; Go live. Onboarding emails need none of it — SPOCs send them from Home | HR → Settings → Email (three steps) |
| AI on/off | `ANTHROPIC_API_KEY` in `/etc/agentic-pms/api.env` — instance-owned, never written by a deploy |
| AI model | `deploy/service/managed-settings.env`, pushed into `api.env` by every deploy (`UNMANAGED=AI_MODEL` pins a box) |

---

# Part 5 — What it deliberately does not do

- **It is not an HRMS.** The employee master is a mirror, loaded by
  validated import. Nothing edits it as a system of record.
- **It does not set pay.** Increments are modelled, never written.
- **AI never produces a number.** Ratings, scores and distributions are
  SQL; AI drafts text, labelled a draft, stored with its input.
- **No dummy data.** Empty states are honest.
- **A missing key is not a broken product.** With no `ANTHROPIC_API_KEY`,
  agentic endpoints answer a clean 503 and everything else works.
- **The timesheet does not set a rating.** Its per-KRA rating is shown
  beside the manager's and HOD's own; the people rate.
- **It does not pretend to send email.** In simulated mode an email is
  recorded and the screen says it was not delivered.

---

*Checked against the code on 7 October 2026. Where this book and the code disagree,
the code is right and this book is a bug.*

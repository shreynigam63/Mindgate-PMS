# Agentic PMS — HR Manual

**Mindgate Performance Management System**
For the HR team who administer the system. Version of 29 September 2026.

---

## 1. Signing in, and issuing logins

Sign in with your work email and password. **Every account is forced to choose
its own password on first sign-in** — the user cannot reach any page until
they have. So when you circulate a login, the password you send is a one-time
credential by design; you do not need to chase people to change it.

There is **no self-service password reset**. Resets come through you.

Change your own password with the **Password** button, top right.

---

## 2. How access is decided

Worth understanding before you start granting things, because it explains
every "Access denied" question you will be asked.

A person's effective permissions are **their role's bundle, plus anything
granted to them individually**. Default role bundles ship per tenant —
employee, manager, hod, hr, admin — and they are **data, not code**: you can
edit them without anyone touching the software.

Two consequences:

- **The menu and the direct-URL guard come from the same row.** A menu item someone cannot see is also a URL they cannot type their way into. They can never disagree.
- **An "Access denied" message names what was needed.** That field is there deliberately — it diagnoses the misconfiguration for you. Nine times out of ten the fix is the permission data, not the software.

**Salary is separate.** Increment Simulation sits behind its own permission,
not bundled with general HR administration. A manager must never see it.

---

## 3. The HR menu

| Menu item | What it does |
|---|---|
| **All Approvals** | Every pending decision across the company, in one place. |
| **Cycles** | Create and run appraisal cycles. |
| **Employees** | The employee master — imported, not edited here. |
| **Department Heads** | Who heads which department. |
| **Career Pathing Matrix** | Which roles lead to which. |
| **KRA Overview** | Org-wide view of who has KRAs and who does not. |
| **KRA Library** | Publish a shelf of suggested KRAs per job title. |
| **Competency Framework** | What the organisation expects, by competency and job. |
| **Competency Dashboard** | Where the organisation stands against it. |
| **Timesheet** | Compliance, KRA coverage, closing periods, the year-end rollup. |
| **PMS Completion Report** | Who has completed what. |
| **Calibration** | Grade bands, distribution, the increment kitty. |
| **9-Box Grid** | Performance against potential. |
| **Closure Letters** | Generated letters at cycle close. |
| **Increment Simulation** | Model increments against the kitty. *Separate permission.* |
| **Super 50** | The high-performer watchlist. |
| **Engagement Surveys** | Write, open, close and read surveys. |
| **New Hire Insights** | What the lifecycle surveys are saying. |
| **Settings** | Tenant-wide configuration. |

---

## 4. Employees — the master is a mirror

**The employee master is loaded from your HRMS export. It is not an HRMS and
must not be edited as if it were one.** Re-import when the source changes.

The importer accepts the HRMS export's own column names, and it **validates
before it writes**: duplicate email addresses, missing managers, and cycles in
the reporting chain are all reported per row, with the reason. Nothing is
silently dropped.

Employees with no email address are given a placeholder address so they still
exist in the org chart. They cannot sign in until a real one arrives.

**Deleting an employee removes them from the list — it does not destroy their
records.** Ratings, KRAs and history survive.

**Changing someone's reporting manager moves their open records with them.**
You do not need to reassign anything by hand.

---

## 5. KRA Overview vs KRA Library

These two sit next to each other and are easily confused. The difference
matters:

- **KRA Overview** — assigns and tracks KRAs for **named people**.
- **KRA Library** — publishes a **shelf per job title** that employees pick from when writing their own.

### Publishing a shelf

1. **Download template (.xlsx)** — or `.csv`.
2. Fill it in. Columns: Department, Designation, Parameters, KRA (S.M.A.R.T goals), KPIs, Suggested Weightage, Comments, and optionally **Keywords**.
3. **Validate** first. This is a dry run — it tells you what would happen and writes nothing.
4. **Publish**.

Rules to know:

- **Every worksheet is read**, so a multi-tab role workbook publishes in one go.
- **Department is optional.** Written once, it carries down the rows beneath it; a new Designation clears it. Blank on a designation's first row publishes a **company-wide** shelf everyone with that title sees; naming a department publishes a shelf **only that department** sees.
- **A shelf does not need to total 100.** It is a menu; employees pick a hundred points' worth from it.
- **Publishing replaces the shelf for each department and designation in the file, and leaves every other shelf untouched.**

At the bottom, **Designations with no shelf yet** lists the job titles whose
holders currently write their KRAs from scratch, ordered by how many people
that affects. That list is your work queue.

### Timesheet keywords

At the top of the same page. **Keywords are what Zoho task names are matched
against** when hours are attributed to KRAs. A keyword on a shelf row is
inherited by every KRA created from it.

**Nothing is scored from keywords yet** — a keyword places an item against a
KRA, it does not produce a rating. Coverage is the number to watch.

**Value-add words** are the separate list that flags exceptional work
(automation, optimisation, critical fix, patent, cross-team support, process
improvement, innovation, value addition). Edit the list here.

---

## 6. Timesheet — the HR view

Two tabs: **Compliance** and **KRA coverage**.

### Compliance

Organisation-wide timesheet compliance, filterable by department.

### KRA coverage

Four things live here, in the order you use them.

**a) The backlog — "Who needs a mapping session".** Everyone who logged time,
with how many items are unplaced. Note the two states, because they need
different action:

- **"no KRAs"** — this person logged time but has **no KRA sheet for the cycle**. Their hours cannot be credited to anything until they write one. *That is a KRA problem, not a mapping one* — chasing their manager to do a mapping session will achieve nothing.
- **"unplaced"** — they have KRAs, but items are unmatched. Their manager needs to sit down with the mapping session.

**b) Close a period.** Closing settles everybody who logged time in that
period: the numbers are snapshotted together with the configuration that
produced them, and they **stop moving**. That is what makes them safe to carry
into calibration.

The sequence is fixed and the screen enforces it:

1. **Pick a period** from the dropdown.
2. **Preview.** You get a table of exactly who would be settled and what each would score, headed *"…nothing saved yet"*.
3. Only then does **Close for N people** become active. **The count is people, not months** — one period settles for N employees.

**A period that is not over yet cannot be closed.** The system refuses and
tells you the end date, rather than freezing a partial month.

**c) The year-end rollup.** Cycle-to-date across the settled months. Read the
line above the table: it tells you how many periods are closed, how many
people are thick enough to read, and how many months were overridden.

Two things this view states plainly, and you should repeat to anyone who asks:

- **Percentages are weighted by the hours behind them, not averaged across months.** A month with 8 hours does not count the same as a month with 160.
- **This is context for a calibration conversation. It does not feed the proposed rating, the distribution or the increment kitty.**

**d) Settings** (the button on the page header). Scoring configuration:

| Setting | Meaning |
|---|---|
| **Auto score** | Whether a score is computed at all. **Ships OFF.** With it off, every month reports coverage only. |
| **Weight: coverage / compliance / value-add** | The three components, default 50 / 30 / 20. |
| **Minimum mapped %** | How much of the hours must be placed before a score means anything. Default 80. |
| **Grade bands** | The score-to-letter ladder (A+ / A / B+ / B / C). |

All of it is data. None of it is in the code, and you change it without a
release.

---

## 7. Calibration

**Grade bands are editable here**, with a live target total as you type. The
band table drives how scores become letters everywhere else.

The **increment matrix** sets the percentage range per grade. Save it
carefully and check the min/max columns afterwards — these ranges are what the
out-of-band guardrail fires on.

The timesheet column on this screen is **context only**, as the rollup says.
It is a suggestion for the conversation, never an input to the rating.

---

## 8. The rest of the HR tab

**Cycles** — create the appraisal cycle, set its dates, open and close its
stages.

**All Approvals** — every pending decision in one queue, so nothing sits
unnoticed with a manager who has stopped looking.

**PMS Completion Report** — who has completed what, for chasing.

**Competency Framework / Dashboard** — what each role requires, and where the
organisation stands against it. Employees and managers both rate against this;
the dashboard shows where the two views differ.

**9-Box Grid** — performance against potential. Visible to HR and Delivery
Head only.

**Super 50** — the high-performer watchlist. The rule is scale-aware and
configurable, and the page explains how each person got on the list.

**Increment Simulation** — model increments against the kitty. *Behind its own
permission.*

**Closure Letters** — generated at cycle close.

**Career Pathing Matrix** — which roles lead to which, with a department named
on every suggested transition. Supports bulk add and bulk delete.

**Engagement Surveys / New Hire Insights** — write, open, close and read
surveys. **Anonymity is structural**: for an anonymous survey, invitations and
responses are held in separate tables and nothing can join them. The themes
feature reads a view with the identity columns excluded. This is not a policy
setting you could switch off by accident.

**Settings** — tenant-wide configuration.

---

## 9. Rules the system holds you to

Worth knowing, because they will surprise you at least once:

- **Every state change that affects a person's rating is audited.** "Why did my rating change?" always has a queryable answer.
- **No silent failure.** Batch operations return a reason per row. If something did not import, the system tells you which row and why.
- **No dummy data.** An empty screen means nothing has been set up — it is never a placeholder.
- **Numbers are deterministic; the AI only narrates.** Ratings, scores and distributions are computed. Anything the AI writes is **labelled as a draft** and stored with the input that produced it. It never sets a number.
- **Thresholds and labels live in tables.** You configure; you never need a code change for a threshold, a band or a dropdown.

---

## 10. Troubleshooting

| Symptom | Where to look |
|---|---|
| **"Access denied" with a `needs:` field** | The permission data. The field names exactly what was missing. |
| **A domain-worded refusal** | A row-level rule in the page itself (my-team-only, HR-only section), not the permission table. |
| **Someone sees no tabs** | Their role has no pages. Check the role bundle. |
| **Timesheet shows "no KRAs" for someone** | They have logged hours but no KRA sheet for this cycle. A KRA problem. |
| **A period will not close** | It has not ended yet. The refusal names the end date. |
| **Scores are all "no score"** | Auto-scoring is off (the default), or mapped % is below the minimum. Both are stated on screen. |
| **A rating is not visible to the employee** | It has not been published. Their *My Rating* stays greyed until it is. |

---

## 11. What to tell people when you circulate their login

A short note that will save you most of the questions:

> Your login is your work email. The system will ask you to choose your own
> password the first time you sign in — you cannot get past that screen until
> you do. Start with **My KRAs** and, if your role has a published shelf, use
> **Suggest KRAs for my role**. Weights must total 100. Everything you pick
> stays editable. Nothing you see on the Timesheet screen sets your rating.

---

*Agentic PMS — HR Manual · 29 September 2026*

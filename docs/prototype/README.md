# docs/prototype — the proposed PMS UI, as a clickable prototype

**Open `pms-ui-prototype.html` in any browser.** One self-contained file, no
server, no build, works offline. That file is the **left sidebar**, which is
the chosen direction. `pms-ui-prototype-tabs.html` beside it is the same
product with role-tab navigation — kept so the choice can be revisited, and
so the two can still be compared. See **Two navigation variants** below.

## What this is

A **visual prototype only**, built to answer "if we adopt the shared UI, how
will the whole PMS module look?" before committing to changing the real app.

- **It is not connected to any data.** Every number is illustrative, though
  the counts shown (1,398 employees, 61 without a manager, 2,155 library rows,
  the 105% shelf) are the real live figures, so the screens read truthfully.
- **The live PMS is untouched.** Nothing in `frontend/src` was modified to
  produce this.

## What it covers

21 screens in three groups:

| Group | Screens |
|---|---|
| **Self** | My KRAs · My Growth · Quarterly Connects · Mid-Year Review · Annual Review · Final Rating · My Rating |
| **Manager** | Team Overview · Team KRA Sheets · Team Evaluation · Delivery Head Review · Improvement Plans |
| **HR / Admin** | Dashboard · **All Approvals** · KRA Overview · KRA Library · Cycles · Employees · Calibration · 9-Box Grid · Completion Report |

Click through the menu on the left — or, in the tabs variant, the role tabs
and the menu beneath them. Rating chips and status tabs respond, so the
screens feel live without any data behind them.

## Each role sees only its own groups

The prototype models **access**, not a view switcher. What a person cannot
use is not rendered for them at all — nothing is greyed out, and no control
reaches it:

| Signed in as | Available |
|---|---|
| Employee | Self |
| Manager | Self + Manager |
| HR / Super Admin | Self + Manager + HR / Admin, including **All Approvals** |

The **Viewing as** control in the header exists only so all three can be
reviewed in one file. In the real app the signed-in role decides and there is
no switcher — that control would not ship.

**All Approvals** is the super-admin surface asked for separately: every
pending decision in the company — KRA sheets, growth plans, mid-year
sign-offs, evaluations, connect confirmations — in one queue, with bulk
approve. It reflects what the product already enforces: a super admin may
approve at any level for any employee including themselves, and every
self-approval is stamped `self_action` in the audit log.

## The colours are not new

Every token comes from `frontend/tailwind.config.js` — navy `#1b3b6f`, brand
pink `#ec407a`, lagoon `#17a2b8`, amber `#f5821f`, leaf `#43a047` — which that
file records as "sampled directly from the BRD's reference screenshots … the
client's own existing design language". The shared mockups and the product
already share a palette. What differs is **structure**, not colour.

This revision is deliberately more vibrant: each page opens with a gradient
hero band, the stat tiles are filled rather than white, and the 9-box grid is
heat-tinted. Every gradient is mixed from the five tokens above, plus one
violet (`#7c4dbe`) reserved for super-admin surfaces — which the product
already uses for its AI panels. Nothing here needs a colour the app cannot
currently produce.

## The header

The product names itself in full — **Performance Management System** — and the
strip beneath it carries **Dashboard** only. This is the PMS module's own
navigation, not the HRMS menu: Admin, Employee, Attendance, Leave, Payroll,
Training, RMS, Analytics and Utilities are gone. Dashboard is home — it
returns the signed-in person to their own landing screen.

## Two navigation variants, same screens

The structural question was how to reach 21 screens. Both answers are built,
and **the left sidebar is the one chosen**:

| File | Navigation | |
|---|---|---|
| `pms-ui-prototype.html` | **Left sidebar** — every screen this person can open, listed at once under group headings | chosen |
| `pms-ui-prototype-tabs.html` | **Role tabs** — Self / Manager / HR / Admin, each with its own short horizontal sub-nav | alternative |

They are generated from one set of screen functions and one role map, so the
content is identical to the character and only the navigation differs. Each
one links to the other from its banner.

### How the sidebar handles 21 items

Two things keep a long menu usable, both in the chosen file:

- **It scrolls on its own.** The sidebar pins to the top of the viewport once
  the header scrolls away, and if the menu is taller than the screen it
  scrolls inside itself rather than dragging the page with it. Verified:
  with every group expanded HR's menu needs 1047px in a 900px box, scrolls
  to its end, and the page stays at scroll 0.
- **Groups collapse, and only the one you land in starts open.** Each
  heading carries its count and folds its section away. HR is handed
  9 visible items (HR / Admin) with Self · 7 and Manager · 5 one click
  below; a manager gets Manager open and Self folded. Opening one group does
  not shut the others, because HR working across Approvals and the Library
  needs both. Navigating to a page always opens its group, so nothing can
  leave you on a screen whose menu entry is hidden.

### Where each role lands

Dashboard — and switching person — goes to that role's landing screen, not
to the first item in the list:

| Role | Lands on |
|---|---|
| Employee | My KRAs |
| Manager | Team Overview |
| HR / Super Admin | PMS Dashboard |

Both variants use the same landing screens, so they behave alike.

### Going back to role tabs

Nothing is one-way. No screen knows which shell it is in, so reversing is
swapping the two `file` values in `LAYOUTS` at the top of the assembly section
in `generate.py` and running it again — `pms-ui-prototype.html` then carries
the tabs and the sidebar moves to the other filename. Both variants keep
being generated and checked either way; the only thing the swap decides is
which one gets the plain filename and which one the per-role PDFs are shot
from.

In the real app the same holds. The navigation is one component reading one
role map; the pages, routes and permissions are untouched by this choice, so
switching later is a nav change, not a rebuild.

What the difference actually costs, measured at 1440×900:

| | Role tabs | Left sidebar |
|---|---|---|
| Clicks to reach a screen in another group | **2** (tab, then item) | 1, or 2 if its group is collapsed |
| Screens listed at once, as handed over (HR) | 9 of 21 | 9 of 21, with the other 12 one click away |
| Menu fits the screen at 1440×900 | yes | yes — 531px of 900px for HR |
| Menu fits with every group expanded (HR) | n/a | no, 1047px — and it scrolls itself, not the page |
| Horizontal space taken from the page | none | 248px |

So: the sidebar shows the whole product in one column and reaches most of it
in a click, at the cost of 248px of page width. The tabs keep the page full
width, at the cost of hiding two thirds of the product behind a tab.

The role gating is the same in both, and is not what is being compared: an
employee sees only Self either way.

## What is drawn here that the product does not already do

Corrected on 23 Sep after going through each one in the running app. The
first version of this list called all four new features; three of them are
mostly or entirely built already, and saying otherwise would have had us
rebuild what exists.

| Drawn | Already in the product | Actually missing |
|---|---|---|
| **Career Path ladder** (Current → next → next, with timelines) | Aspiring Career on My Growth: target role constrained by the Career Pathing Matrix, expected timeline, growth plan, milestones with target dates and progress, AI "Suggest a path" | only the read-only **ladder view** — the chain of transitions drawn as steps |
| **"Org IDP"** on the development plan | the plan itself, as "Target achievements for the year", with goals, progress and manager approval | nothing but the **label** |
| **"Confirmed by manager"** on a Quarterly Connect | manager sign-off, end to end: a Sign off action, Signed off / Pending sign-off chips, and an "N awaiting sign-off" count (migration 012, BR-4.3) | nothing — **this is the same feature**. What is missing is only that pending sign-offs are not listed in All Approvals |
| **potential rating** on the manager's evaluation | potential is captured at **Calibration**, via the 9-box cell, and stored on `pms.top_talent` | moving or mirroring it onto the manager's evaluation, so potential is set when the manager writes the review rather than afterwards |

So the genuinely new work is one read-only view, one label, one queue row,
and one decision about where potential is captured — not four features.

## Screenshots of every screen, per role

`screens/` holds one PDF per role, each with a contents page and then every
screen that role can open, in menu order. They are shot from
`pms-ui-prototype.html`, so they show the chosen layout:

| File | Screens |
|---|---|
| `screens/PMS-screens-employee.pdf` | 7 |
| `screens/PMS-screens-manager.pdf` | 12 |
| `screens/PMS-screens-hr.pdf` | 21 |

```bash
node docs/prototype/screens.mjs
```

`FILE=pms-ui-prototype-tabs.html` shoots the other variant instead. The shots
are JPEG rather than PNG on purpose: as PNG the HR deck comes out at 16MB,
which defeats the point of a file you can email. `KEEP=1` leaves the
per-screen images and the print HTML behind, which is how you check the PDF
layout without a PDF rasteriser installed.

## Regenerating

```bash
python3 docs/prototype/generate.py
```

Needs `frontend/dist` built, because the prototype embeds Inter from the
product's own build output rather than fetching a webfont.

One run writes both variants. Two source files: `generate.py` holds the
screens, the role map and the two shells, `prototype.css` holds the styling.
They are inlined into each output file, so both stay portable single HTML
documents.

```bash
node docs/prototype/check.mjs      # walks BOTH variants
```

Check it by **clicking it**, not by looking at it. A screenshot cannot tell
you whether the router is bound — an earlier build rendered perfectly and had
no working handlers at all, because the generator had escaped its own
JavaScript. The click-through that catches it walks every screen for every
persona and asserts exactly one is visible, each has its hero, no off-limits
control is reachable, and the console is clean.

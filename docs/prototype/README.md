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
| Clicks to reach a screen in another group | **2** (tab, then item) | **1** |
| Screens visible in the menu at once (HR) | 9 of 21 | 21 of 21 |
| Fits without scrolling (employee, 7) | yes | yes |
| Fits without scrolling (manager, 12) | yes | yes |
| Fits without scrolling (HR, 21) | yes | **no** — the list ends at 1137px of a 900px viewport, so HR scrolls the menu |
| Horizontal space taken from the page | none | 248px |

So: the sidebar is faster and shows the whole product at a glance, at the cost
of a narrower page and a menu HR has to scroll. The tabs keep every menu short
and the page full width, at the cost of one extra click and of hiding two
thirds of the product behind a tab. Neither is obviously right — that is why
both exist.

The role gating is the same in both, and is not what is being compared: an
employee sees only Self either way.

## What is drawn here but does not exist in the product yet

These are **new features**, not re-skins, and need separate scoping:

- the **Career Path ladder** (Current → next → next, with target timelines)
- **"Org IDP"** as a concept on the development plan
- **"Confirmed by manager"** on a Quarterly Connect (the product has manager
  *sign-off*, which is a different thing)
- the **potential rating** on the manager's evaluation — drawn on Team
  Evaluation and marked as new

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

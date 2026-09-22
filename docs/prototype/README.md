# docs/prototype — the proposed PMS UI, as a clickable prototype

**Open `pms-ui-prototype.html` in any browser.** One self-contained file, no
server, no build, works offline.

## What this is

A **visual prototype only**, built to answer "if we adopt the shared UI, how
will the whole PMS module look?" before committing to changing the real app.

- **It is not connected to any data.** Every number is illustrative, though
  the counts shown (1,398 employees, 61 without a manager, 2,155 library rows,
  the 105% shelf) are the real live figures, so the screens read truthfully.
- **The live PMS is untouched.** Nothing in `frontend/src` was modified to
  produce this.

## What it covers

21 screens across three role tabs:

| Tab | Screens |
|---|---|
| **Self** | My KRAs · My Growth · Quarterly Connects · Mid-Year Review · Annual Review · Final Rating · My Rating |
| **Manager** | Team Overview · Team KRA Sheets · Team Evaluation · Delivery Head Review · Improvement Plans |
| **HR / Admin** | Dashboard · **All Approvals** · KRA Overview · KRA Library · Cycles · Employees · Calibration · 9-Box Grid · Completion Report |

Click the role tabs and the menu beneath them. Rating chips and status tabs
respond, so the screens feel live without any data behind them.

## Each role sees only its own tabs

The prototype models **access**, not a view switcher. The tabs a person cannot
use are not rendered for them at all — they are not greyed out, and there is
no control that reaches them:

| Signed in as | Tabs available |
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

## The one structural decision this prototype makes

A horizontal sub-nav cannot hold 29 screens — at 1360px it clips after about
16. So this uses **role tabs (Self / Manager / HR), each with its own short
sub-nav**. That solves the overflow *and* answers the separate request for
role-based views with a single control.

If you would rather keep all 29 in one list, the alternative is a left sidebar
inside the PMS tab — say so and I will render that variant for comparison.

## What is drawn here but does not exist in the product yet

These are **new features**, not re-skins, and need separate scoping:

- the **Career Path ladder** (Current → next → next, with target timelines)
- **"Org IDP"** as a concept on the development plan
- **"Confirmed by manager"** on a Quarterly Connect (the product has manager
  *sign-off*, which is a different thing)
- the **potential rating** on the manager's evaluation — drawn on Team
  Evaluation and marked as new

## Regenerating

```bash
python3 docs/prototype/generate.py
```

Needs `frontend/dist` built, because the prototype embeds Inter from the
product's own build output rather than fetching a webfont.

Two source files: `generate.py` holds the screens and the role map,
`prototype.css` holds the styling. They are inlined into the single output
file, so the published prototype stays one portable HTML document.

```bash
node docs/prototype/check.mjs
```

Check it by **clicking it**, not by looking at it. A screenshot cannot tell
you whether the router is bound — an earlier build rendered perfectly and had
no working handlers at all, because the generator had escaped its own
JavaScript. The click-through that catches it walks every screen for every
persona and asserts exactly one is visible, each has its hero, no off-limits
control is reachable, and the console is clean.

# Agentic PMS — deployment and handover docs

Two kinds of document here.

**`PAGE-*`** describes a screen as it stands: what is on it, where each piece
is rendered, what the numbers mean, and how to change it. Read these to
understand a feature.

**`CHANGE-*`** describes one shipped change: what it altered, why, how to
deploy it and how to prove it landed. Read these to ship.

Everything below is **already live on pms.agentichumans.in**. The deploy steps
are written for a **client PoC account** that is behind.

---

## Deploying to a PoC that is behind

One command brings a host to the current `main`:

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
```

It pulls, installs, builds the frontend into `/var/www/agentic-pms`, restarts
`agentic-pms-api` and waits for health. Migrations run **in-process at boot**
and **fail the boot** if one throws, so a bad migration stops the deploy rather
than half-applying it.

You do not deploy these changes one at a time — one update brings them all.
The per-change docs exist so you know **what to verify** and **what to tell the
client**, not because each needs its own deploy.

> `VITE_API_URL` must stay **unset** on the host. It is baked in at build time
> and the frontend is served from the same origin as the API.

**The only change here that touches the schema** is migration `037`
(`CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md`). Snapshot `core.migrations_log` and the
`pms.kra_sheets` status counts before you start; that doc has the exact
commands and the expected after-state.

---

## The changes, in the order they shipped

| # | Document | Schema | Visible to |
|---|---|---|---|
| 1 | [`CHANGE-KRA-OPEN-ALL-CYCLE.md`](CHANGE-KRA-OPEN-ALL-CYCLE.md) — the sheet is open all cycle and locks on submission | none | **every employee** |
| 2 | [`CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md`](CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md) — a submitted sheet reopens when the job changes | **migration 037** | employees, managers, HR |
| 3 | [`CHANGE-KRA-LIBRARY-TEMPLATE-DEPARTMENT.md`](CHANGE-KRA-LIBRARY-TEMPLATE-DEPARTMENT.md) — Department added to the KRA Library template | none | HR only |
| 4 | [`PAGE-CAREER-PATHING-MATRIX-UPLOAD.md`](PAGE-CAREER-PATHING-MATRIX-UPLOAD.md) — bulk upload for the career matrix | none | HR only |

> **1 and 2 belong together.** The lock without the reopen traps an employee
> holding objectives for a job they no longer have. Never ship 1 alone.

## Screen references

| Document | Screen |
|---|---|
| [`PAGE-MY-KRAS-LIBRARY-PICKER.md`](PAGE-MY-KRAS-LIBRARY-PICKER.md) | My KRAs — the "Start from the … KRA library" banner |
| [`PAGE-HR-KRA-LIBRARY.md`](PAGE-HR-KRA-LIBRARY.md) | HR Admin — KRA Library |
| [`PAGE-CAREER-PATHING-MATRIX-UPLOAD.md`](PAGE-CAREER-PATHING-MATRIX-UPLOAD.md) | HR Admin — Career Pathing Matrix |

## Older material

| Document | |
|---|---|
| [`RELEASE-AND-CYCLE-PHASES.md`](RELEASE-AND-CYCLE-PHASES.md) | the nine cycle phases and what each opens |
| [`KRA-LIBRARY-DEPLOYMENT.md`](KRA-LIBRARY-DEPLOYMENT.md) | first deployment of the KRA Library |
| [`ENABLE-AI-ASSISTANCE.md`](ENABLE-AI-ASSISTANCE.md) | switching the AI features on with an API key |
| [`CHANGE-KRA-SHEET-STATUS-LABEL.md`](CHANGE-KRA-SHEET-STATUS-LABEL.md) | the "submitted to manager" chip |

---

## Screenshots

Every image lives in `images/` and is a real capture of the deployed build
driven in a browser against a **restored copy** of the live database — never
production, and never a mock-up.

Re-shoot after any change to a documented page:

```bash
node docs/capture-screenshots.mjs
```

It takes `UI`, `API`, `EMPLOYEE`, `HR`, `PASSWORD`, `OUT` and `PW` from the
environment, so it is not tied to one developer's ports, and exits non-zero on
a console error — a page error means the shot may have caught a half-rendered
screen.

The captions quote counts that come out of the images, so **a stale image makes
a document lie**. Four of the flow shots (the rejected/valid/published states
of an upload, and the KRA lock states) need a filled-in file or a specific
sheet status, so they are captured by hand; the script covers the rest.

---

## After the deploy — what is still HR's to do

Neither of these is a code task, and both will be asked about:

1. **Re-upload the KRA library with the Department column.** Until then the
   department dropdowns on *My KRAs* are structurally live but functionally
   inert, and every employee correctly falls back to the company-wide shelf.
   That is correct behaviour, not a bug. See
   `CHANGE-KRA-LIBRARY-TEMPLATE-DEPARTMENT.md` §8.

2. **Decide whether `kra_library_scope` should be on at all.** If departments
   are not going to be used, setting it back to `designation` removes two
   controls from every employee's My KRAs page. SQL in
   `PAGE-MY-KRAS-LIBRARY-PICKER.md` §4.

---

## Running the tests before you ship

```bash
cd server
createdb apms_check                 # MUST be a fresh database
DATABASE_URL=postgres://postgres:pgpass@127.0.0.1:5432/apms_check \
DATABASE_SSL=false JWT_SECRET=t TENANT_SLUG=x AUTH_DEV=true npm test
```

> **A fresh database every time.** Re-running against a used one produces four
> phantom failures in `self-appraisal-rating.test.js` from leftover rows. They
> are not real, and chasing them wastes an afternoon.

# Agentic PMS — READ THIS FIRST IN EVERY SESSION

Employee Performance Management System, extracted as a product from the AH
platform. Client-deliverable: dedicated instance per client, deploy-and-
transfer + AMC. Spec + extraction plan live with Nilesh (Agentic PMS
Product Specification v1.0; Extraction Plan) — ask if not provided.

## Session bootstrap
1. Read this file.
2. Skills auto-load from .claude/skills/ — trust them over improvisation:
   conventions · migrations · security-permissions · extraction-playbook ·
   secrets-and-shipping.
3. `cd server && npm test` — 9 tests must pass before and after your work.
4. Never commit node_modules/, dist/, or any secret (scan in the shipping skill).

## State (update this section every session)
- 29-Aug-2026: **Employee deletion built.** Asked to delete test users and
  for a delete option in the app — I don't have network access to the
  live Render deployment to delete anyone myself (my sandbox can't reach
  onrender.com at all), so I could only build the feature and hand back
  exact steps to use it.
  This was the most consequential route added this session, so it got
  the most careful treatment. First mapped every table across all 11
  migrations referencing employee_id/manager_id/hod_id/nominee_id/
  nominated_by (~25 tables) — discovered almost NONE of them have a real
  foreign-key constraint back to core.employees (only
  core.department_heads and core.notifications do), meaning a naive
  DELETE would silently leave 20+ tables full of orphaned rows rather
  than erroring, which is worse than a clean FK violation would have
  been.
  New DELETE /employees/:employeeId (people_admin-only, core/employees.js),
  a single transaction with two distinct behaviours depending on which
  side of a relationship the employee is on: (1) records that are their
  OWN are deleted outright (cascades handle child rows automatically —
  pms.kras via sheet_id, pms.evidence via appraisal_id, pms.development_
  goals via plan_id, pms.pip_weekly_entries via pip_id, all pre-existing
  ON DELETE CASCADE); (2) records where they appear as someone ELSE's
  manager/reviewer are nulled out where the column is nullable (preserves
  the OTHER employee's own record untouched) or, where the schema has
  that column as NOT NULL (pms.manager_evaluations.manager_id, pms.
  hod_evaluations.hod_id, pms.connects.manager_id, pms.
  connect_reminders_log.manager_id), that SPECIFIC review row is deleted
  too — a real, documented, unavoidable consequence of the schema, not a
  bug, and made explicit in both the code comments and the UI's warning
  text rather than hidden. core.local_credentials/user_roles/
  user_permissions (keyed by email, not id) are cleaned up separately.
  An audit_log entry is written BEFORE the employee row disappears, so
  who/what/when is still traceable afterward even though the employee
  record itself is gone.
  CAUGHT A REAL RISK IN MY OWN FIRST DRAFT before it ever ran: I'd
  wrapped several of the ~25 deletes in .catch(() => {}) defensively —
  but that's genuinely dangerous INSIDE a transaction, since Postgres
  aborts the whole transaction server-side the moment any statement
  fails, and a swallowed catch would mask the real cause while every
  later statement in the same transaction fails too with a confusing
  unrelated error. Removed all of them once I'd already verified (by
  reading every migration directly) that every table/column referenced
  genuinely exists — the defensiveness was unnecessary AND risky at the
  same time.
  Frontend: DirectoryPage.jsx's "Manage" panel gained a Delete section —
  requires typing the employee's exact name to confirm (not just a
  browser confirm() dialog) before the button enables, with the
  survives-vs-removed distinction explained in the warning text itself.
  VERIFIED LIVE end-to-end against real Postgres, the full real-world
  path: imported a throwaway test employee via the actual CSV import
  route, gave them a real login, confirmed they could log in (200),
  deleted them, confirmed they no longer appear in the employee list,
  and confirmed their login now correctly fails (401 Invalid
  credentials) — not simulated, the exact sequence a real user would do.
  test/employee-delete.test.js: 4 integration tests, including the single
  hardest property to get right — deleting a MANAGER preserves their
  REPORT's own KRA sheet (with manager_id correctly nulled) while
  correctly removing the NOT-NULL manager_evaluations/connects rows that
  literally cannot exist without a valid manager reference. All 4 passed
  on the first real run, no test bugs this time.
  126/126 backend tests pass (53/126, 73 skipped, without DB); clean
  production build.
- 29-Aug-2026: **Inline single-employee profile edit built** — asked
  directly whether designation/department/etc. could be edited after
  import; the honest answer was "only by re-uploading the whole file,"
  which is clunky for a one-field fix. Built the missing convenience.
  New PUT /employees/:employeeId (people_admin-only, core/employees.js):
  edits name/department/designation/role_band/manager (by email lookup)/
  date_of_joining/status directly. email is DELIBERATELY not accepted by
  this route at all — core.local_credentials and core.user_roles are
  both keyed by (tenant_id, email), not employee id, so changing email
  here without also cascading that change would silently orphan someone's
  password and role. Simpler and safer to just not allow it from this
  quick-edit form; re-import (which already upserts by email) remains
  the path for that. Manager resolution is stricter/more helpful than
  the bulk importer's: looks up the email against the actual database
  (not just rows in an uploaded file) and returns a clear 422 with the
  reason if it can't find them or if it would make someone their own
  manager, rather than the importer's silent no-op on an unresolvable
  manager. Reuses the exact same BR-1.5 open-cycle-only propagation the
  bulk importer already had for a manager change (KRA sheets/dev plans
  on OPEN cycles follow the new manager; CLOSED cycles keep the original,
  for audit accuracy) — this edit path can change someone's manager too,
  so it needed the identical fix, not a narrower one.
  Frontend: DirectoryPage.jsx's "Manage access" button and panel were
  combined into a single "Manage" button opening one panel with two
  sections — Edit profile, and Access (the password/role feature from
  earlier) — rather than two separate buttons/panels per row.
  VERIFIED LIVE against real Postgres: fixed a real test employee's
  designation from null to "Senior Software Engineer" (plus department
  and role_band) via the actual HTTP route, confirmed the change
  persisted on the next GET — the exact real-world scenario that
  prompted building this.
  test/employee-edit.test.js: 5 integration tests, including one
  confirming the open/closed-cycle manager-propagation distinction holds
  for this route too. Hit and fixed a test typo of my own (asserted
  lowercase "mgrb" against a seeded email actually cased "mgrB" — the app
  correctly preserves stored casing; the test's expectation was wrong,
  not the app).
  122/122 backend tests pass (53/122, 69 skipped, without DB); clean
  production build.
- 29-Aug-2026: **HR-provisioned login credentials + role assignment
  built.** Asked directly whether creating users "through the
  application" was OK — the honest answer was no: beyond the one-time
  bootstrap-admin (core/setup.js, now permanently locked) and CSV/Excel
  import (creates employee PROFILE rows only, no password at all), there
  was genuinely no way to give anyone else a real login. Real production
  auth is meant to be the client's SSO/IdP (core/auth.js's own comments),
  never actually built — until it is, this is the supported path.
  New POST /employees/:id/credentials (people_admin-only) — HR sets a
  password directly on an existing employee's behalf (a deliberate,
  documented exception to the "only the account holder chooses their own
  password" principle used everywhere else, e.g. bootstrap-admin —
  acceptable only because there is no working self-service alternative
  at all right now). New PUT /employees/:id/role (people_admin-only) —
  assigns one of the 5 existing permission bundles (employee/manager/hod/
  hr/admin); setting back to 'employee' deletes the core.user_roles row
  entirely rather than storing a redundant explicit default.
  GET /employees now also returns has_login and role per employee (a
  LEFT JOIN against core.local_credentials/core.user_roles), so the
  Employees page can show who can actually sign in.
  Frontend: DirectoryPage.jsx gained a "Manage access" expandable row per
  employee — set password, change role. HIT AND FIXED THE SAME REACT BUG
  AGAIN mid-build: a shorthand `<>` fragment inside .map() can't take a
  key, and I'd made this exact mistake once already this session in
  KraOrgOverviewPage.jsx — caught it this time via inspection before it
  ever reached a screenshot, fixed with Fragment+key the same way.
  VERIFIED LIVE end-to-end against real Postgres, not just via the test
  suite: HR set a real password for the existing emp@test.com test user,
  that employee immediately logged in directly with it (role: employee),
  HR then promoted them to manager, and their very next login correctly
  reflected role: manager — the actual multi-step real-world flow, not
  simulated.
  test/employee-credentials.test.js: 4 integration tests. Hit a test bug
  of my own while writing it (the shared login() helper hardcodes
  password 'pass', but one test had already changed that specific user's
  real password — diagnosed and fixed by logging in with the actual
  current password instead, not by weakening the assertion).
  117/117 backend tests pass (53/117, 64 skipped, without DB); clean
  production build.
- 28-Aug-2026: **Fixed "Not Found" on refresh/direct URL load in
  production** — flagged from a live deploy (refreshing e.g. /admin/cycles
  gave "Not Found"). Root cause: React Router's client-side routing only
  understands paths like /admin/cycles AFTER index.html's JavaScript has
  loaded and taken over — clicking a link inside the app works because no
  real HTTP request happens (react-router intercepts it), but a hard
  refresh or a directly-opened/shared URL makes the BROWSER ask Render's
  static file server for that exact path as a real file, which doesn't
  exist (the only real file is index.html). This is exactly why it looked
  fine while clicking around during earlier testing and only broke once a
  URL was shared or refreshed directly — the failure mode was inherently
  invisible to normal click-through testing.
  Fixed with the standard, Render-documented mechanism for single-page
  apps: added a `routes: [{ type: rewrite, source: /*, destination:
  /index.html }]` block to render.yaml's frontend service. Real static
  files (JS/CSS/fonts/etc.) still resolve normally and take priority —
  the rewrite only catches paths that don't match a real file, handing
  them to index.html so react-router gets a chance to load and take over
  client-side, exactly the same mechanism as Netlify's _redirects or
  Vercel's rewrites for the same class of problem. Does not affect API
  calls at all — those go straight to the separate api service via the
  absolute VITE_API_URL already baked into the JS bundle at build time,
  never through this static site's routing.
  Validated the YAML syntax; could not test the actual rewrite behaviour
  against live Render infrastructure from this sandbox (no route to
  onrender.com), so this needs a real-world confirmation after the next
  deploy — noted honestly rather than claimed as fully verified.
  113/113 backend tests pass (unaffected, config-only change).
- 28-Aug-2026: **Fixed a real layout bug flagged from a live screenshot**:
  every page's content wrapper (`className="space-y-4 max-w-Nxl"`) had a
  max-width but no `mx-auto`, so on any screen wider than that max-width
  the whole page hugged the left edge with a large dead void on the right
  — looked broken/unfinished, not a matter of taste. Confirmed systemic
  (20 of the app's ~25 pages had this exact pattern) via a proper regex
  search rather than the narrower grep used the first time (which missed
  it because max-w-4xl sat at the END of the className string, not
  followed by a space — a real miss worth noting for next time). Fixed
  with a Python regex sweep across all 20 files in one pass, adding
  mx-auto to the two exact patterns found ("space-y-4 max-w-X" and
  "max-w-X space-y-4"), while correctly leaving KraOrgOverviewPage.jsx's
  `inp max-w-xs` search box untouched — that's a small left-aligned input
  within a row, not a page wrapper, and centering it would have been
  wrong. Verified live at a 1920px viewport (wider than the screenshot
  that surfaced the bug) with real screenshots before and after: content
  now sits properly centered in the available space on every page
  checked, including one (My Growth) that naturally doesn't fill an
  ultra-wide viewport by design — confirmed that reads as intentional
  spacing now, not a layout bug, once the centering itself was fixed.
  113/113 backend tests pass (unaffected, frontend-only); clean
  production build.
- 28-Aug-2026: **Full visual redesign to match the BRD's reference
  screenshots + "liquid glass, smooth and bright fonts, minimalism,
  uniform/homogeneous" directive.** Extracted the 7 screenshots actually
  embedded in the BRD docx (unzip'd it directly — they'd never been looked
  at before this) and sampled exact colors from them with PIL rather than
  eyeballing: navy #1b3b6f, brand pink #ec407a (the literal "you are here"
  active-tab color in every reference screenshot), teal #17a2b8, amber
  #f5821f, green #43a047. Applied centrally rather than per-page — app.css's
  shared classes (.card/.btn-pri/.btn-sec/.inp/.lbl/.chip) and
  tailwind.config.js's new navy/brand/lagoon/amber2/leaf palette + Inter
  typeface (self-hosted via @fontsource, not a CDN dependency) are what
  every one of the ~25 pages already builds on, so one central change
  reached the whole app uniformly instead of 25 individual edits.
  "Liquid glass" specifically: a fixed, low-saturation radial-gradient
  wash (pink/teal/navy) behind the whole app, with the sidebar/header and
  the login/setup cards using a new .glass utility (backdrop-blur-xl +
  translucent white + soft border) that floats above it — deliberately
  NOT applied to data-dense content cards/tables, which stay flat opaque
  white for legibility (glass at the navigation layer, clarity at the
  data layer, a considered choice, not an oversight). Pink is used as a
  single deliberate signature accent (active nav item, logo mark) rather
  than spread across every button, matching the reference's own pattern
  and the "spend your boldness in one place" principle.
  Then swept all 25 page files: replaced neutral CHROME colors only
  (slate-800/stone-50/stone-100/stone-200/divide-stone etc. used for
  backgrounds, borders, muted text) with the new navy scale — deliberately
  did NOT touch semantic status colors (emerald=success, rose=danger,
  amber=pending/AI-draft, purple=AI, blue/cyan=phase indicators), since
  recoloring those to match the brand palette would remove real
  information a user relies on to parse status at a glance.
  ALSO FOUND AND FIXED while reading the screenshots closely: the BRD's
  own "BR-6.2 confirmed" banner on the Annual Review mockup reveals the
  actual client-approved 7-parameter weights (17.78/11.11/17.78/17.78/
  11.11/11.11/13.33%, derived from "share of the 45-element engagement
  framework" — 8, 5, 8, 8, 5, 5, 6 elements respectively) — different
  from the placeholder defaults used earlier in this session (15/15/14
  ×5). Corrected migrations/008-review-parameters.js's DEFAULT_PARAMETERS
  to the exact confirmed values; verified in Node that the new weights sum
  to precisely 100 with zero floating-point drift, so weightsValid()'s
  tolerance check passes cleanly. Existing already-seeded tenants keep
  whatever values they have (HR can already edit these from the Cycles
  screen) — this only changes the default for tenants provisioned from
  here on.
  VERIFIED LIVE, not just built: stood up the real backend + Vite dev
  server + a headless Chrome (via puppeteer, using the cached Chrome
  binary already present from an earlier npx playwright install) and
  actually logged in and clicked through 6 different pages spanning every
  major UI pattern in the app (nav-heavy, card/button-heavy, data-table-
  heavy, stats+search+table-heavy, empty-state, and a page with real
  semantic-color status chips) to confirm the redesign holds up
  uniformly on real, already-seeded data — not just a static mockup.
  113/113 backend tests pass (unaffected — this was a frontend-only
  change plus the one migration default-value correction, verified with
  DB attached); clean production build both before and after the full
  color sweep.
- 28-Aug-2026: **First-time setup screen added to the frontend** — using
  the backend bootstrap endpoint (below) required curl/PowerShell, which
  was correctly called out as not remotely user-friendly for whoever
  actually needs to stand this deployment up. App.jsx's Login component
  now checks GET /setup/status on load; if no account exists anywhere on
  the deployment yet, it shows a proper "First-Time Setup" form (name,
  email, password, confirm) instead of the plain sign-in box — submitting
  it calls bootstrap-admin then immediately auto-logs the new admin in,
  so creating the account and being signed into the app is ONE step, no
  terminal involved at all. Once an account exists, /setup/status
  permanently reports false and every subsequent visitor just sees the
  normal sign-in form — this is a one-time first-run screen, not a
  standing public signup page. Handled one real edge case explicitly
  rather than showing a confusing raw error: if AUTH_DEV isn't enabled
  yet on this deployment, bootstrap still succeeds but the automatic
  login step will fail (dev-login is gated behind AUTH_DEV=true) — the
  form catches that specific case and tells the person exactly what to
  do (ask whoever manages the deployment to enable AUTH_DEV, then reload
  and sign in manually with the credentials they already chose) instead
  of a generic "Invalid credentials" or similar.
  Verified live end-to-end against real Postgres, reproducing exactly
  what the new UI does: fresh tenant (0 employees) -> GET /setup/status
  returns true -> bootstrap-admin -> immediate dev-login succeeds with
  role=admin -> GET /setup/status now returns false. Clean frontend
  production build. 113/113 backend tests still pass (unaffected —
  frontend-only change).
- 28-Aug-2026: **One-time admin bootstrap built (core/setup.js)** — a fresh
  deployment had no way to create ANY account: production has AUTH_DEV=false
  (correctly), and dev-login is the only login route in the codebase at
  all (real SSO/Azure-AD, referenced in core/auth.js's own comments as
  the intended production auth, was never actually built). Without this,
  nobody could log in to create a user, and the person deploying
  shouldn't be handed a password chosen — and therefore known — by
  anyone else. New unauthenticated GET /api/v1/setup/status and POST
  /api/v1/setup/bootstrap-admin: the caller supplies their OWN name/
  email/password (min 8 chars), which is bcrypt-hashed immediately and
  never logged/echoed back. Safety model: this route requires no auth
  (nothing to authenticate against yet) so it relies entirely on one
  guard — it only works when the tenant currently has ZERO employees,
  checked and enforced inside a transaction holding a Postgres advisory
  lock (pg_advisory_xact_lock keyed on the tenant id) so concurrent
  requests can't race past the check together. The moment one employee
  exists (including the admin just created), it permanently locks itself
  out for that tenant — same "first user becomes admin" pattern as many
  self-hosted apps (e.g. GitLab's first-login sets the root password),
  not a standing admin-creation backdoor.
  test/setup-bootstrap.test.js: 5 integration tests, including one that
  actually fires 3 simultaneous bootstrap attempts at a fresh tenant via
  Promise.all and confirms exactly one succeeds — proving the advisory
  lock holds under real concurrency, not just sequential calls. HIT AND
  FIXED A REAL BUG WHILE WRITING THIS: the test file initially omitted
  setting process.env.JWT_SECRET before requiring core/auth (every other
  integration test file in this project does this explicitly; this one
  didn't) — running it standalone hung indefinitely rather than failing
  loudly, because core/auth.js's devLogin has no try/catch around an
  async handler, so an unset-secret failure inside jsonwebtoken never
  sent an HTTP response and the client's fetch() waited forever. Root-
  caused via a manual debug script outside node:test (isolated the exact
  same bootstrap+login flow, worked fine with JWT_SECRET set in the
  shell, confirming the missing env var — not the route logic — was the
  cause) before fixing the test file. This surfaced a real, pre-existing
  latent fragility in devLogin itself — fixed in the same commit, not
  left for later: wrapped the whole handler in try/catch, so any
  unexpected failure now returns a proper 500 with a logged reason
  instead of hanging the caller's connection forever. Verified directly:
  reran the exact previously-hanging scenario (no JWT_SECRET set) and
  confirmed it now responds in ~100ms with a 500 instead of hanging.
  113/113 tests pass with DB attached (53/113, 60 skipped, without).
  Pushed to both remotes.
- 28-Aug-2026: **First real Render deploy attempt surfaced two genuine
  infra issues, both fixed** (this is the first time this app has
  actually been deployed to Render, not just tested locally):
  1. Blueprint sync failed: "cannot have more than one active free tier
     database" — Render allows only one free Postgres per workspace, and
     the deploying workspace already had one elsewhere. Fixed in
     render.yaml: database moved to basic-256mb (Render's own documented
     cheapest PAID Postgres tier, ~$6-7/month, confirmed against Render's
     Blueprint YAML reference and example repos) — api + frontend stay on
     the free plan, so total cost is ~$6-7/month, the lowest possible
     given the one-free-database-per-workspace constraint. (Earlier in
     this same session, api+db+frontend were all attempted on plan: free
     and separately, before that, on paid defaults totalling ~$17.50/mo —
     both superseded by this.)
  2. First boot after that fix crashed: "connect ECONNREFUSED" to the
     database's internal IP, then auto-restarted and crashed again. Root
     cause: a Postgres database freshly created in the SAME Blueprint sync
     as the api service is not immediately reachable — the web service
     started trying to connect before the database finished its own
     initial provisioning (a real, observed race, not a theoretical one).
     Fixed: core/db.js gained retryUntilReachable() (pure retry/backoff
     logic, dependency-injected connectivity check) and waitForDatabase()
     (the real-pool wrapper), called from index.js's main() BEFORE
     runMigrations() — up to 15 attempts, 4s apart (60s total grace).
     Still fails loudly after exhausting retries, preserving the existing
     "a broken deploy is not a degraded state" philosophy — this only
     tolerates the specific narrow "not up yet" startup race, nothing
     else. test/wait-for-database.test.js: 5 unit tests against the REAL
     exported retryUntilReachable() (via a fake connectivity-check
     callback, not a hand-duplicated copy of the logic) — succeeds
     immediately when reachable, retries through transient failures then
     succeeds, still throws after exhausting retries, respects
     maxAttempts exactly, only logs "reachable" when a retry was actually
     needed. Runs with NO database and NO env vars configured (pg's Pool
     is lazy — doesn't connect at construction, only on first query — so
     requiring core/db.js with DATABASE_URL unset is safe as long as
     nothing calls the real pool). Also live-verified full boot still
     works normally end-to-end when the DB IS already reachable (no
     regression, no added log noise on the happy path).
  108/108 tests pass with DB attached (53/108, 55 skipped, without —
  note the 5 new tests here run unconditionally in BOTH environments,
  unlike this project's other integration suites, since they need no DB).
  Pushed to both remotes (nileshsatpute82/Agentic-PMS and
  sanve196/Mindgate_PMS — the latter is the one actually connected to
  Render for this deployment).
- 28-Aug-2026: **Found and fixed a real deploy-breaking gap before it hit
  production**: the frontend called relative /api/v1 paths everywhere
  (utils/api.jsx's api() helper, plus 4 hardcoded <a href> download links
  for evidence/closure-letters/GDPR export). That works in local dev only
  because vite.config.js's dev-server proxy forwards /api to
  localhost:8080 — but Render deploys the frontend as a static site, a
  SEPARATE service from the API, with its own domain. Every API call in
  production would have hit the static site's own domain and 404'd — the
  app would have loaded (HTML/CSS/JS all served fine) but nothing would
  have worked. Fixed: utils/api.jsx now exports API_BASE, resolved from
  import.meta.env.VITE_API_URL (an absolute https://.../api/v1 URL) when
  set, falling back to the old relative /api/v1 for local dev. Every one
  of the 5 places that previously hardcoded /api/v1 now imports and uses
  this one constant. render.yaml's frontend service gets
  VITE_API_URL injected at BUILD time (Vite bakes env vars into the
  static bundle at build, not runtime) via Render's fromService blueprint
  feature, pointed at the api service's host. Verified by building the
  frontend BOTH ways (with and without VITE_API_URL set) and grepping the
  actual built JS bundle to confirm each one contains the correct URL —
  not just trusting the build succeeded.
  Also: pushed the full repo (all commits, complete history) to a second
  remote, https://github.com/sanve196/Mindgate_PMS — this is now the repo
  used for the actual Render deployment. Verified via GitHub API that the
  new repo's commit count, latest commit SHA, and file tree (including
  all 13 migrations) match the original exactly.
- 28-Aug-2026: **Closed the 3 concrete remaining gaps from the last audit
  pass** (calendar integration stays deliberately deferred; broad "GDPR
  compliance" and "bi-directional HRMS" aren't fully closeable without
  external systems, but their concrete, buildable pieces now are):
  1. **Evidence upload** — pms.evidence existed since migration 003 with
     nothing writing to it. New POST/GET /pms/my/self-appraisal/evidence,
     DELETE .../evidence/:id, shared GET /pms/evidence/:id/download
     (owner, their manager, or admin). Frontend: upload/list/delete/
     download wired into SelfAppraisalPage.jsx.
  2. **Closure letter PDF generation** — closed the "Phase 4 template
     engine decision" this file's own header comment had flagged as
     deferred. Added pdfkit (no vulnerabilities beyond the pre-existing
     uuid/exceljs transitive advisory). HR reviews/edits the existing
     AI-drafted letter text (never auto-applied — same human-approval
     safeguard as every other agentic feature), then POST
     /pms/closure-letters/:employeeId/:cycleId/generate renders a real
     PDF (rating/label read directly from the published history row,
     never re-typed, so the letter cannot state a different number than
     what was actually published) and stores it. New GET
     /pms/closure-letters (HR list) and .../download (owner/manager/HR;
     "me" as employeeId resolves to the caller). Frontend:
     ClosureLettersPage.jsx (HR Admin > Closure Letters) — draft, edit
     inline, generate; MyRatingPage.jsx gained a per-cycle download link.
  3. **GDPR data export (Article 15, right of access)** — new core/gdpr.js,
     GET /gdpr/export (self) and /gdpr/export/:employeeId (HR), aggregating
     every table holding personal data about one employee into a single
     JSON. Deliberately did NOT attempt automated erasure (Article 17) —
     cascading deletes across a live system with audit/legal-retention
     obligations is a policy decision for HR/legal, not a safe self-service
     button. MyRatingPage.jsx gained a "Download all my data" link.
  STORAGE CHOICE (documented in migrations/013-file-storage.js): both
  evidence and closure-letter PDFs are stored as bytea IN POSTGRES, not
  on local disk (Render's web services have an EPHEMERAL filesystem —
  anything written there is lost on restart/redeploy) and not in an
  external object store (no credentials configured in this environment).
  Reasonable for POC volume; flagged as worth revisiting for a
  high-volume production deployment.
  SECURITY-RELEVANT CHANGE: core/auth.js's authenticate() now also
  accepts a ?token= query param, as a fallback ONLY for plain <a href>
  download links which can't attach an Authorization header — the
  header path is completely unchanged for every other call in the app.
  Tested explicitly (test/auth-query-token.test.js): header path
  unaffected, query fallback works, no token still 401s, a bogus query
  token is rejected rather than silently ignored. This touches the most
  foundational function in the app, so the full suite was run
  immediately after the change and confirmed zero regressions before
  building anything on top of it.
  Testing: 3 new integration test files (evidence-upload, closure-letter-pdf
  — including a direct check that downloaded bytes start with the actual
  %PDF magic number, not just a correctly-labelled empty response —
  gdpr-export) plus the auth test above. Verified with a clean frontend
  production build and a full fresh-database migration run (0->13).
  103/103 tests pass with DB attached (48/103, 55 skipped, without).
- 28-Aug-2026: **Full BRD re-audit against actual code** (not prior notes)
  — re-read the BRD/plan verbatim and grepped/read actual route files for
  every BR item, rather than trusting CONTEXT.md's own earlier summaries.
  Found and fixed 4 more genuine gaps:
  1. **BR-4.3 (manager sign-off on connects) was NOT implemented** —
     pms.connects had no status/sign-off column at all, just a plain log
     insert. Fixed: migration 012 adds signed_off/signed_off_at; new
     POST /pms/connects/:id/sign-off as an explicit action distinct from
     creating the log (a manager can log now, sign off after review).
  2. **BR-4.2 (AI theme/sentiment summary for connects, linked to KRAs)
     confirmed still missing** — the existing engagement_themes feature
     is for anonymous SURVEY verbatims, a different thing. Fixed: new
     POST /agentic/connect-insights (6th agentic feature) summarises one
     employee's own logged connect notes, links themes back to KRA ids
     already stored per connect, never suggests a rating (same
     stripRatingSuggestions safeguard as the other 5).
  3. **BR-1.5 (KRA info auto-updates on HRMS manager/dept change) confirmed
     still missing, now fixed** — pms.kra_sheets/pms.development_plans
     snapshot manager_id once at creation and never got updated when
     core.employees.manager_id changed via re-import. Fixed in
     core/employees.js's loadEmployees(): a new Pass 3 propagates a
     manager change to any STILL-OPEN cycle's KRA sheet/dev plan only —
     closed-cycle records deliberately keep their original manager, so a
     later reassignment doesn't silently rewrite audit history.
  4. **No frontend page for Quarterly Connect existed at all** — BR-4.1
     ("Build the 1-on-1 Log screen, Fig. 6") was marked Completed with
     zero UI. Fixed: new ConnectsPage.jsx (nav: Team > Quarterly
     Connects) — log a new connect, sign-off button, AI insights button
     surfacing the new connect-insights feature above.
  All four fixes verified with dedicated integration tests against real
  Postgres (test/connect-signoff.test.js, test/connect-insights.test.js,
  test/hrms-manager-sync.test.js — the last one specifically proving
  closed-cycle history is NOT rewritten) plus a clean frontend production
  build. 91/91 tests pass with DB attached (48/91, 43 skipped, without).
  Everything else checked in this audit (KRA management, Development
  Plan, Career Path, Mid-Year, Annual Review, 7-parameter engine, 9-Box,
  Super 50, retention alerts, PIP, Delivery Head ordering via the phase
  machine, consent gate, audit trail, AI human-approval safeguard) was
  confirmed correctly implemented by reading the actual route code, not
  assumed from memory.
- 28-Aug-2026: **Mid-Year Review dual sign-off consolidation built
  (BR-5.1/5.2)**. The editing itself already worked generically (self_edit/
  manager_edit phase gates aren't cycle_type-restricted, so self-appraisal
  and manager-evaluation entry already functioned during a midyear
  cycle) — what was missing, flagged in an earlier session, was anywhere
  either party could see BOTH sign-off statuses ("Pending"/"Signed" per
  BR-5.2's exact wording) side by side. buildMidYearSummary() in
  modules/performance/index.js is a small, focused consolidation (far
  simpler than Annual Review's — BR-5 doesn't ask for KRA/dev-plan
  aggregation, just the dual status + each side's rating/narrative). New
  GET /pms/my/midyear-review (self) and GET /pms/team/midyear-review/
  :employeeId (manager/HOD/HR, same 403 guard pattern used throughout).
  Frontend: new MidYearReviewPage.jsx (nav: My Performance > Mid-Year
  Review) — two side-by-side cards (yours/manager's), Signed/Pending
  badge, narrative fields once available, a link into the existing
  Self-Appraisal page to actually edit (deliberately not re-implementing
  that editing UI a second time). Verified with a clean production
  build. test/midyear-review.test.js: 3 integration tests (dual status
  correctly differentiates Signed vs Pending; manager can view a report's
  status, unrelated employee 403s; a brand-new employee gets
  not_started/Pending rather than an error). All 3 passed on the first
  run. 87/87 tests pass with DB attached (48/87, 39 skipped, without).
- 28-Aug-2026: **Calendar/meeting-tool integration — DEFERRED, by
  decision, not oversight.** This is the last item from the original
  11-point roadmap ("draw discussion points from calendar and meeting
  tools, with consent"). Asked which provider (Google Calendar,
  Microsoft 365/Outlook, or a generic pluggable interface) — the answer
  was "don't know yet, decide later." Correctly NOT guessed at: picking a
  provider commits to a specific OAuth flow, API surface, and data model
  that would be expensive to redo if wrong. What IS already in place and
  ready for whichever provider gets chosen: the full consent-gate
  infrastructure (core/consent.js, built earlier this session) and the
  meeting_based flag on pms.connects that already 403s without explicit
  employee consent — so whenever a provider is chosen, the integration
  slots into an existing, tested safety boundary rather than needing one
  built from scratch. This is the one item NOT closed out this session;
  everything else in the original plan (44 System Build tasks) has now
  been verified, fixed, or built.
- 28-Aug-2026: **Delivery Head relabeling done (BR-8.1)**. This was
  flagged in an earlier session as a naming-only fix since the feature
  itself (extra approval layer above the manager, before HR calibration)
  was already fully built under the internal name "HOD". On closer look
  this session, "HOD" turned out to appear in nearly every file in the
  codebase — but almost all of those are internal identifiers: the
  hod_eval PHASE VALUE persisted in pms.cycles.phase, the pms_hod
  PERMISSION STRING persisted in core.role_permissions, and the
  pms.hod_evaluations table/column names. Renaming any of those would
  need a real data migration for existing rows and change the API
  contract, for zero user-visible benefit — so they were deliberately
  left untouched. Only the actual DISPLAYED strings were changed to say
  "Delivery Head": App.jsx nav label, HodQueuePage.jsx's heading/column
  header/empty-state text, CalibrationPage.jsx's column header,
  utils/api.jsx's phaseLabel() (the phase stepper shown throughout the
  app), and one backend error message users can see directly
  ("Delivery Head evaluation is not open"). Verified: full backend test
  suite unaffected (no test asserted on the old exact string), clean
  frontend production build, and a live check confirming the internal
  /pms/hod/queue route and its response shape are completely unchanged.
  84/84 tests pass with DB attached.
- 28-Aug-2026: **Mid-Year 7-Parameter Pulse Check built (BRD Fig. 7b)**.
  "Employees complete a pulse check on their own experience, for their own
  reference... informational only, does not feed the Annual Review
  score." Built as a STRUCTURALLY isolated feature rather than trusting a
  runtime check: migrations/011-pulse-check.js adds pms.pulse_checks as a
  separate table from pms.parameter_scores (the Annual Review's engine,
  migration 008) — scoring a pulse check literally cannot write to
  pms.manager_evaluations because the code path never touches that table
  at all. Self-only routes: GET/PUT /pms/my/pulse-check (available only
  on an active MIDYEAR cycle via activeCycle(tenantId,'midyear'); shows
  the same 7 org-configured parameters as Annual, but a simple self-only
  average, not a weighted rating). Frontend: new PulseCheckPage.jsx (nav:
  My Performance > Pulse Check) — five-button 1-5 scoring per parameter,
  self-average shown for personal reflection. Verified with a clean
  production build. test/pulse-check.test.js: 4 integration tests, the
  critical one directly querying pms.manager_evaluations before/after
  maxing out every parameter to prove zero rows are ever created there.
  84/84 tests pass with DB attached (48/84, 36 skipped, without).
  FLAGGED, NOT YET BUILT: there is no dedicated Mid-Year Review page in
  the frontend at all (unlike Annual Review, which got a proper
  consolidated screen this session) — worth checking whether the
  project-plan items 27-30/32 marked "Completed" for Mid-Year are as real
  as they claim, same pattern as Development Plan turned out not to be.
- 28-Aug-2026: **Quarterly Connect reminders built (BR-4.4)**. No separate
  worker/cron service exists in this deploy (render.yaml only
  defines api + frontend web services), so this runs in-process: an
  interval in index.js checks once at boot and then daily, plus a manual
  HR-triggered POST /pms/connects/check-reminders as a backup/testing
  path. modules/performance/connect-reminders.js: pure isConnectDue()
  (default 90-day cadence; never-held is always due) and
  shouldRemindAgain() (default 7-day cooldown so the same person isn't
  reminded every single day) — 8 unit tests, no DB. Orchestration
  (checkAndSendConnectReminders, in modules/performance/index.js) finds
  every active employee with a manager, checks their most recent connect
  against the cadence and their most recent reminder against the
  cooldown, and notifies BOTH the employee and their manager when due.
  migrations/010-connect-reminders.js: pms.connect_reminders_log is the
  cooldown record (auditable history, not a stateful flag). Verified the
  server actually boots cleanly with the new interval and that the
  boot-time check correctly fired against this session's real,
  persistent test tenant (an employee overdue since earlier testing
  triggered a real reminder on boot). test/connect-reminders-integration.test.js:
  3 integration tests (only overdue/never-held employees are reminded,
  not a recently-connected one; running the check again immediately
  doesn't double-remind; the manager is notified too, not just the
  employee). Caught the same role-seeding + missing-credentials mistake
  as earlier sessions in my own test before trusting the first run.
  80/80 tests pass with DB attached (48/80, 32 skipped, without).
- 28-Aug-2026: **Annual Review consolidation screen built (BR-6.1)** — "the
  system must support an end-of-year review workflow that consolidates
  KRA outcomes, development plan progress, and career path status." This
  was the one clearly-defined remaining piece from the original priority
  list once Development Plan, Career Path, and the 7-parameter engine
  existed to consolidate. Deliberately a READ-ONLY aggregation over
  already-existing sources of truth, not a new one: buildAnnualReviewSummary()
  in modules/performance/index.js pulls KRA definitions joined with their
  self_appraisals/manager_evaluations entries (keyed by kra_id in those
  tables' jsonb blobs) as "KRA outcomes", development plan goals +
  average progress, career path, the 7-parameter scores + live weighted
  rating, rating history, and the Super 50 flag — all into one call.
  New GET /pms/my/annual-review (self) and GET /pms/team/annual-review/
  :employeeId (manager/HOD/HR, with the same "not your report" 403 guard
  used everywhere else). Frontend: new AnnualReviewPage.jsx (nav: My
  Performance > Annual Review) — sectioned view (KRA outcomes,
  development plan with progress bars, career path, 7-parameter grid with
  live weighted total, rating history), Super 50 badge when flagged.
  Verified with a clean production build AND a live shape-check against
  real Postgres. test/annual-review.test.js: 3 integration tests
  (consolidation pulls real data correctly from all 4 sources in one
  call; manager can view a report's summary, unrelated employee correctly
  403s; a brand-new employee with zero cycle activity gets empty-but-valid
  sections rather than an error). All 3 passed on the first run. 69/69
  tests pass with DB attached (40/69, 29 skipped, without).
- 28-Aug-2026: **Org-wide KRA overview + enter-on-behalf built (BR-1.1/1.4)**
  — found to be another gap in the same vein as Development Plan/Career
  Path: /team/kra-sheets was manager-scoped only (WHERE manager_id=
  req.user.id), and every KRA edit/submit route was hardcoded to
  req.user.id, so HR had no org-wide view and literally could not enter a
  KRA on someone else's behalf despite BR-1.4 requiring it. New
  GET /pms/kra/org-overview (HR-only, status counters + search across
  every active employee, "not_started" for anyone with zero sheet rows —
  not just missing from the list); new GET/PUT/POST
  /pms/hr/kra-sheet/:employeeId(/kras)(/submit), mirroring the self-service
  routes but parameterized by employee_id and gated pms_admin. Frontend:
  new KraOrgOverviewPage.jsx (HR Admin > KRA Overview) — counters, search,
  inline "Enter on behalf" editor per row. Verified with a clean
  production build. test/kra-org-overview.test.js: 5 integration tests
  (org-wide visibility including HR/manager's own accounts correctly
  counted, search, admin-only gate, full enter-on-behalf lifecycle,
  manager blocked from the HR-only routes). Caught my own test's missing
  role-seed mistake (forgot to give the HR test user the 'hr' role) before
  trusting the result. 66/66 pass with DB attached (40/66, 26 skipped,
  without).
- 28-Aug-2026: **Development Plan (BR-2.1/2.2/2.3) + Career Path
  (BR-3.1/3.2) built** — found to be entirely missing (Development Plan)
  or half-built (Career Path — HR-admin matrix config existed, zero
  employee-facing route) despite BOTH being marked "Completed" in the
  project plan and in this file's own earlier Phase 0 notes. A full
  codebase search for "development", "IDP", "MyGrowth" turned up nothing
  before today.
  migrations/009-development-plan.js: pms.development_plans +
  pms.development_goals, mirroring pms.kra_sheets/pms.kras deliberately
  (same draft/submitted/approved/returned lifecycle, same one-row-per-
  employee-per-cycle shape). Reuses the kra_open phase window via new
  devplan_edit/devplan_submit/devplan_decide action names in
  phase-machine.js's ALLOWS table (tested). Progress updates (BR-2.3: "at
  any point in the year") are deliberately NOT phase-gated — either the
  employee or their manager can update progress_pct on an already-approved
  plan's goal at any time.
  ALSO FOUND AND FIXED in the same migration: people.career_paths
  (migration 004) had no unique constraint on (tenant_id, employee_id),
  so an upsert for "set my career path" would have failed at runtime the
  first time anyone tried it — added the missing constraint (idempotent
  via pg_constraint check, since Postgres has no ADD CONSTRAINT IF NOT
  EXISTS). Verified via a full fresh-database migration run (0->9 clean)
  to prove this is deployable, not just patched over the one already-
  migrated test database.
  New routes: GET/PUT /pms/my/development-plan(/goals)(/submit),
  PUT .../goals/:goalId/progress, GET /pms/team/development-plans +
  POST .../decide (mirrors KRA manager approval exactly). People module:
  GET/PUT /people/career/my-path (employee sets target_role + plan;
  "guardrails" BR-3.2 enforced softly — if HR has configured any
  career_matrix role_bands, target_role must match one; unconfigured
  matrix blocks nothing), GET /people/career/team (manager visibility).
  Frontend: new MyGrowthPage.jsx (nav: My Performance > My Growth) —
  side-by-side Development Plan (goal CRUD, progress bars, submit) and
  Career Path (role-band select or free text depending on whether
  guardrails are configured, plan textarea) per BRD Fig. 5, plus a
  manager-facing "Team Development Plans" approve/return section (not in
  the BRD's Fig. 5 itself, but a plan stuck at "submitted" with no way to
  decide it would not be a usable feature). Verified with a clean
  production build and a live shape-check against real Postgres
  confirming the exact JSON the frontend expects.
  test/development-plan.test.js (2 tests: full lifecycle including the
  approved-plan-still-allows-progress-updates case, and a genuine
  unrelated-employee 403 check) + test/career-path.test.js (4 tests:
  unconfigured guardrails accept anything, configured guardrails reject
  an unlisted role, manager visibility, upsert-not-duplicate). Caught and
  fixed a test-isolation bug identical in shape to earlier ones this
  session (an unscoped subquery picked up more than one row across
  repeated runs against the shared persistent test DB) before trusting
  the result. 61/61 tests pass with DB attached (40/61, 21 skipped,
  without).
- 28-Aug-2026: **7 Organizational Parameters weighted rating engine built
  (BR-6.2/BR-6.3)** — the biggest remaining piece from the priority order.
  migrations/008-review-parameters.js: pms.review_parameters (configurable
  name/weight_pct/sort_order, seeded with the 7 BRD-named drivers — My
  Organisation Culture, My Work, My Manager, My Organisation, My Senior
  Leadership, My Career & Learning, My Team — at BRD-default weights
  summing to exactly 100) and pms.parameter_scores. New tenants get the
  defaults via ensureDefaultParameters() at boot, same pattern as
  migration 002. computeWeightedRating() in rating-rules.js is a pure,
  unit-tested (13 tests) function — incomplete scoring (not every
  parameter scored) is explicitly flagged, never silently averaged over a
  gap. New routes: GET/PUT /pms/review-parameters (HR configures, reusing
  phase-machine's weightsValid() so this is held to the exact same
  "sums to 100" rule as KRA weights), GET/PUT /pms/team/parameter-scores/
  :employeeId (manager scores each of the 7, sees a live-recalculating
  weighted total per Fig. 8b — annual cycles only, 409s on midyear).
  CRITICAL DESIGN CHOICE: the computed weighted score writes directly into
  the EXISTING, already-tested pms.manager_evaluations.overall_rating
  column once complete — the exact same column PIP, Super 50, 9-Box, and
  /publish already read. Nothing downstream needed to change to consume a
  7-parameter-derived rating instead of a manager-typed one.
  Also added a guard: PUT /team/evaluations/:employeeId now 409s if a
  caller tries to set overall_rating directly on an annual cycle (must go
  through parameter-scores instead) — otherwise the whole weighting
  requirement would just be a UI suggestion nobody has to follow. Mid-Year's
  separate BR-5.4 self+manager rating is completely unaffected (guard is
  annual-only).
  THIS GUARD BROKE two previously-passing tests (pip.test.js, super50.test.js
  — both directly PUT overall_rating on annual cycles). Fixed properly, not
  papered over: both now use a scoreAllParamsTo() helper (scoring every
  parameter identically makes the weighted average exactly equal that
  value regardless of individual weights, since weights sum to 100) —
  correctly exercises the real, intended production path instead of the
  now-disallowed shortcut.
  Frontend: TeamEvalPage.jsx's plain rating <select> is now conditional —
  annual cycles get a new ParameterScoring component (grid of the 7
  parameters, 1-5 each, live weighted total, "N not yet scored" state);
  midyear cycles keep the original select unchanged. CycleAdminPage.jsx
  gained a ReviewParametersConfig section for HR (add/remove/reweight
  parameters, Save disabled until the total is exactly 100). Both verified
  with clean production builds. 55/55 backend tests pass with DB attached
  (40/55, 15 skipped, without).
- 28-Aug-2026: **9-Box Grid view built (BR-6.4)**. pms.top_talent already
  captured nine_box_cell per employee (entered via the existing
  Calibration screen) but there was no aggregated VIEW of it anywhere —
  only per-row entry. New GET /pms/nine-box?level=org|department|manager
  aggregates the current cycle's top_talent rows into named groups, each
  with counts and the actual people per cell (not just counts — HR needs
  to see who, not just how many). Access: HR or Delivery Head (pms_admin
  OR pms_hod) — wider than /watchlist's HR-only, matching BR-6.4's stated
  audience specifically. Frontend: NineBoxPage.jsx (HR Admin > 9-Box Grid)
  with a level toggle rendering an actual 3x3 grid per group. Verified via
  test/nine-box.test.js (5 tests: org/department/manager grouping, HOD can
  view, plain manager cannot, invalid level falls back to org rather than
  erroring). 44/44 pass with DB attached (34/44, 10 skipped, without).
- 28-Aug-2026: **Retention Alerts built (BR-6.6)** + **notification bell added
  to the frontend shell** (a cross-cutting gap found while building this:
  GET/POST /notifications had existed since Phase 0 with zero frontend
  surface — every notification created so far, PIP-opened, Super50-flagged,
  rating-published, was invisible to users until now).
  alertHrOfRetentionRisk() in modules/performance/index.js fans out an
  in-app notification to every employee holding the hr or admin role in
  the tenant (core.user_roles), the instant someone is newly Super50-
  flagged inside /publish — best-effort (a failed notify() for one HR user
  doesn't roll back the publish). Verified live + via super50.test.js
  (extended to assert exactly one retention_alert notification with the
  right employee name in the title lands on the HR user). Caught and fixed
  a real bug in my OWN test while doing this: the assertion query wasn't
  tenant-scoped, so a stale employee row with the same test email from an
  earlier run in this persistent test DB caused a false failure (count=2
  instead of 1) — fixed by scoping the query to the test's own tenant_id.
  frontend/src/pages/NotificationBell.jsx: polling dropdown (60s interval —
  no push channel exists), unread badge, click-to-mark-read, wired into
  App.jsx's header on both breakpoints. Verified with a clean production
  build. 39/39 backend tests pass with DB attached.
- 28-Aug-2026: **Super 50 / High-Performer Watchlist built (BR-6.5)**.
  migrations/007-super50.js adds core.employees.super50_flag/super50_since
  (persisted, alongside the existing potential_rating/nine_box_cell
  write-back columns, not computed fresh on read). Pure eligibility rule
  in modules/performance/rating-rules.js — isSuper50Eligible() — unit
  tested with no DB (7 tests). Recomputed at /publish for annual cycles
  only (midyear publishes don't touch it): flags true only on the 3rd
  consecutive top-tier (4=A or 5=A+) rating where the MOST RECENT one is
  specifically 5=A+; unflags automatically the moment the streak breaks
  (this is "currently on the watchlist", not a permanent badge). New
  GET /pms/watchlist (HR/Management only, matches BRD Owner column) feeds
  Retention Alerts (BR-6.6, next). Frontend: WatchlistPage.jsx (HR Admin >
  Super 50). Verified live across 4 real published cycles (2 top-tier ->
  not yet flagged -> 3rd cycle A+ -> flagged -> low rating -> unflagged);
  test/super50.test.js codifies this + the "most recent must be A+ not
  just A" edge case. 39/39 pass with DB attached (34/39, 5 skipped,
  without).
- 28-Aug-2026: **PIP module built (BR-7.1 auto-trigger + BR-7.2 weekly
  tracking through to closure)**. pms.pip_records existed since migration
  003 but had zero routes — nothing had ever written to it. Added:
  migration 006 (pip_threshold column on pms.cycles, pms.pip_weekly_entries
  table, unique index for idempotency, closed_reason column); auto-trigger
  wired into POST /publish (opens a PIP when final_rating < cycle's
  pip_threshold, ON CONFLICT DO NOTHING so re-publish never duplicates);
  full CRUD (GET /pip, GET /pip/:id, PUT /pip/:id, POST /pip/:id/entries)
  with employee=read-only-own, manager-of/HR=read+write, closing requires
  a closed_reason, closed PIPs reject further entries. Frontend: new
  PIPPage.jsx (nav: Team > Improvement Plans), wired into App.jsx.
  RATING-SCALE MAPPING DECISION (documented in migrations/006-pip.js):
  the BRD/plan describe the threshold in letter grades ("below B+") but
  the actual schema is numeric 1-5 with English labels — there is no
  letter-grade column anywhere. Used a configurable numeric threshold
  (default 3.0, i.e. below "Meets Expectations") as the closest reading;
  this is a judgment call to confirm with client HR during UAT, same as
  the plan itself flags. Same mapping question will recur for Super 50's
  "3 consecutive A/A+" — worth deciding once, consistently, when that's
  built next.
  test/pip.test.js: full lifecycle integration test (real Postgres, skips
  cleanly without DATABASE_URL) — auto-trigger, permission split, mandatory
  closure reason, post-closure lock, idempotent re-publish. 30/30 pass
  with DB attached (27/30, 3 skipped, without).
- 28-Aug-2026: **Ran against a real Postgres for the first time** (previously
  only ever tested against in-memory/no-DB unit tests). Migrations 001-005
  all run clean start-to-finish on Postgres 16. Found and fixed two real
  bugs only a real DB surfaces: (1) POST /pms/connects inserted kra_ids with
  an untyped NULL vs '{}' COALESCE, erroring "uuid[] vs text" on every call
  — BR-4.1 (Quarterly Connect logging) had never actually been exercised
  end-to-end despite being marked Completed. Fixed with explicit ::uuid[]
  casts. (2) New tenants created after migration 002 (i.e. every normal
  boot of a fresh deploy, since the tenant is created AFTER migrations run)
  got ZERO role_permissions rows — every route 403'd. Fixed: ensureTenantSeeds()
  now runs at boot right after tenant resolution, idempotent. This was a
  deploy-blocking bug that would have hit Bucket 2 (Deployment & Environment
  Setup) directly. test/consent.test.js integration-tests both fixes'
  surrounding behaviour live against Postgres (skips cleanly without
  DATABASE_URL so plain `npm test` still needs no DB).
- 28-Aug-2026: BR-1.1 bulk Excel upload — core/employees.js now accepts
  .xlsx (via exceljs; NOT the `xlsx`/SheetJS package, which has two
  unpatched high-severity advisories) alongside the existing CSV path, both
  funnelled into one validateEmployeeRows() so behaviour is identical.
  Legacy .xls is explicitly rejected with a clear message (that format
  needs a different parser entirely; no safe npm option currently exists).
  tools/sample-employees.xlsx added. 6 new tests (employees.test.js: 9→15).
- 28-Aug-2026: Employee consent capture (BRD §6 NFR) — core/consent.js.
  New core.employee_consents table (migration 005); hasConsent()/
  requireConsent() are the gate ANY meeting-recording/transcription/
  calendar-pull feature must call. Only the employee themself can grant/
  revoke their own consent (pms_self) — managers/HR get view-only. Wired
  into the one concrete point that exists today: POST /pms/connects
  meeting_based=true 403s without consent. No calendar/meeting-tool
  integration exists yet to consume this (that's still a separate, unbuilt
  item) — this lays the gate down ready for it. Verified end-to-end
  live against Postgres: grant → allowed, revoke → blocked again, audit_log
  captures both, manager view-only confirmed (no route exists for a manager
  to set it).
- Delivery Head (BR-8.1) — CORRECTION: this already exists, under the name
  "HOD" (pms.hod_evaluations, /pms/hod/queue, HodQueuePage.jsx). Functionally
  complete (routes to HOD before HR calibration/publish). Only a naming/
  relabelling task remains to align with BRD terminology, not a build task.
- Phase 0 (People Core): SCAFFOLDED 27-Aug-2026 — runner, schema 001,
  auth (JWT + dev-login), permissions (parity gate), employees mirror +
  validated CSV import (9/9 tests), seed 002, deploy files, frontend shell.
- Phase 0 COMPLETE in code 27-Aug: mail (send-mode, provider slots),
  notifications API. Storage iface deferred to first upload need (evidence).
  STILL PENDING: run against a real Postgres (exit test in plan §3).
- FRONTEND (product pages) 27-Aug: Tailwind + react-router + lucide added;
  App shell with grouped nav (My Performance / Team / HR Admin / Engagement
  & People) matching AH design language (stone/amber/slate). Pages: MyKRAs
  (weights chip, submit gated at 100, returned-with-comment banner),
  SelfAppraisal (per-KRA narratives, 1.2s auto-save badge, submit locks),
  MyRating, TeamEval (self-appraisal panel, rating select from cycle scale,
  "Draft the writing" agent button -> DRAFT card -> copy-into-fields,
  auto-save), HodQueue, CycleAdmin (phase strip, advance/rollback, publish
  w/ failure alert, cycle-health agent card), Calibration (distribution vs
  targets, adjust-with-required-reason prompt, 9-box select, session-brief
  agent), Engagement (invitations, take-flow with anonymity notice +
  opt-in checkbox, results w/ eNPS, theme-verbatims agent; prompt-based
  builder is INTERIM — real survey-builder screen still owed), PeopleHub
  (events RSVP, awards nominate, CSR, query threads), Directory (CSV
  import UI). Build clean. NOT YET: real survey/cycle builder screens
  (prompt()-based interim), evidence upload, connects UI, career UI,
  letter PDF, mobile pass, e2e against live server.
- Phase 3 DONE (backend) 27-Aug: core/ai.js — ONE narration entry point
  (Anthropic API via fetch, AI_MODEL env, 503 when no key so everything else
  works), parseAiJson + stripRatingSuggestions PURE+tested (no rating-shaped
  key survives any draft, second line of defence after the prompts), every
  draft stored in agentic.drafts with its deterministic input verbatim.
  modules/agentic: the five §5A features — appraisal-draft (manager-scoped,
  ignores self-RATINGS uses narratives), calibration-brief (distribution vs
  bell curve by dept), engagement-themes (verbatims only, anonymity by
  construction, one short quote max per theme), letter-draft (exact
  rating/label, template adds branding), cycle-health (coverage per stage +
  chase list). GET /agentic/drafts lists provenance. NOT YET: real API call
  ever made (no key in sandbox), frontend surfaces for drafts.
- Phase 2 STARTED 27-Aug: migration 004 (engagement + people schemas —
  anonymity STRUCTURAL: invitations/responses separate, employee_id on a
  response only via tested shouldAttribute()); engagement router (survey
  CRUD+questions, open builds invitations+notifies, take-flow with required-
  question check, results with eNPS + verbatims with no identity in reach);
  people router (awards programs/cycles/nominations+decide, events+RSVP,
  CSR+participation, campus drives/candidates, appraisal queries+threads,
  career matrix). 18/18 tests. NOT YET: engagement frontend, survey builder
  screen, people frontend, midyear, evidence upload, agentic module.
- Phase 1 STARTED 27-Aug: migration 003 (full pms schema), phase machine
  (pure, 5 tests), performance router: cycles+phase transitions/rollback,
  KRA sheets (edit/submit/approve-return, weight=100), self-appraisal,
  manager eval, HOD queue, calibration (distribution vs bell curve,
  adjustments with mandatory reason, top-talent/9-box), publish (history +
  rating mirror + letter records + notify, per-row failures), my-rating,
  connects. NOT YET: evidence upload, PIP routes, career framework, midyear
  specifics, closure-letter PDF, frontend pages (lift in P1 continuation),
  behavioural parity pass against AH source route-by-route.
- Phases 1-4: see Extraction Plan. Source repo for lifting:
  nileshsatpute82/agentic-humans-platform (route-prefix lifting only).

## Hard rules (details in skills)
tenant_id everywhere · modules never import each other's internals · boot
fails on migration error · per-row errors on batch ops · deterministic
numbers, AI narrates · employee master is a CSV-synced mirror · no dummy data
· no secrets in repo · no AH git history ever.

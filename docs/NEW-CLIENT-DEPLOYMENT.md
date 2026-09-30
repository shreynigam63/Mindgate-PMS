# Standing up Agentic PMS for a new client

Read this first, then follow `DEPLOY.md` (Render) or `deploy/README.md`
(EC2). This page only covers what is *different* about a second client; it
does not repeat the deployment steps.

---

## The one rule that governs everything

**One instance = one tenant.** Every row in the database carries a
`tenant_id`, resolved once at boot from the `TENANT_SLUG` environment
variable. Deploy a **second instance** for a second client. Do not try to
serve two clients from one.

`TENANT_SLUG` is effectively **set once and never changed**. On an empty
database the server creates the `core.tenants` row from it. Change it
afterwards and nothing is renamed — the application silently resolves to a
*different* tenant, comes up completely empty, and the original data is
still sitting there under the old slug. It looks like data loss and is not.

---

## What is client-specific, and where it lives

Almost nothing is in the code. Everything below is **data**, set per tenant
at runtime through the UI or an import:

| Thing | Where it is set |
|---|---|
| Tenant name and slug | `TENANT_SLUG` at boot |
| Employees, managers, departments | CSV/HRMS import on the **Employees** page |
| Role bundles (employee / manager / hod / hr / admin) | `core.role_permissions`, seeded per tenant, editable as data |
| Which pages each role sees | `core.page_permission` — drives the menu *and* the direct-URL guard |
| Appraisal cycles and their dates | **Cycles** page |
| KRA shelves per designation | **KRA Library** page, published from a workbook |
| Grade bands and the score ladder | **Calibration** page |
| Increment ranges per grade | **Calibration** page |
| Timesheet scoring (auto-score on/off, the 50/30/20 weights, minimum mapped %) | Timesheet → **Settings** |
| Timesheet keywords and value-add words | **KRA Library** page |
| Competency framework | **Competency Framework** page |

**There is no code fork for a new client.** If you find yourself editing a
`.jsx` or a route to make a client work, stop — the thing you want is
almost certainly a table.

---

## Defaults the new instance will start with

Worth knowing, because two of them surprise people:

- **Auto-scoring is OFF.** Timesheet months report coverage only and read
  *"no score"* until someone turns it on in Timesheet → Settings. That is
  deliberate: scoring should be switched on knowingly, once mapping has
  settled.
- **Minimum mapped % is 80.** Below that, no score is produced and the
  screen prints the reason.
- Weights are **50 coverage / 30 compliance / 20 value-add**.
- Grade bands are **A+ 90 / A 75 / B+ 60 / B 45 / C 0**.
- **The first sign-in of every account forces a password change.** You
  cannot hand out a permanent password by accident.

---

## Order of operations for a new client

1. Deploy the instance (`DEPLOY.md` or `deploy/README.md`), with the
   client's own `TENANT_SLUG`.
2. Confirm `/api/v1/health` returns `{"ok":true,...}`. If the API will not
   start, read the logs — a migration failure fails the boot on purpose.
3. Create the first administrator (the app's first-run screen).
4. **Import the employee master.** Nothing else works until people exist:
   no KRAs, no managers, no approvals. The importer validates before it
   writes and reports per row — duplicate emails, missing managers, cycles
   in the reporting chain.
5. Open a cycle.
6. Publish the KRA library, if the client has one. Optional, but without it
   every employee writes their KRAs from scratch.
7. Set grade bands and the increment matrix on **Calibration**.
8. Decide the timesheet settings — in particular whether auto-scoring is on.
9. Circulate logins with the manuals (`docs/Agentic-PMS-*-Manual.pdf`).

Steps 4 and 9 are the ones that decide whether the rollout goes well.

---

## Things that are NOT in this bundle

- **`node_modules`.** Run `npm install` in both `server/` and `frontend/`.
- **Any secret.** No API key, database URL, JWT secret or password is in
  here, and none should ever be committed. `ANTHROPIC_API_KEY` is supplied
  at deploy time and is only needed for the AI drafting features — the
  product works without it (see `docs/ENABLE-AI-ASSISTANCE.md`).
- **The Mindgate client's data.** This is source only.
- **`docs/screens/` and `docs/prototype/`** — about 50 MB of screenshots and
  prototype PDFs, left out to keep the bundle small. They are in the
  repository if anyone wants them.

---

## Verifying the new instance

`docs/E2E-TESTING-GUIDE.md` is a walk-through of every working process. The
automated suites are in the bundle too:

```bash
cd server   && npm install && npm test     # needs a real Postgres via DATABASE_URL
cd frontend && npm install && npm test     # browser tests, ~4 minutes, needs the stack running
```

---

*Agentic PMS · bundle cut from commit `744a913`, 30 September 2026*

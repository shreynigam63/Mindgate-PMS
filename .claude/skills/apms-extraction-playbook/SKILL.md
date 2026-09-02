---
name: apms-extraction-playbook
description: How code is lifted from the AH monolith into this repo — route-prefix lifting, the employee-reference rewrite, the measured dependency surface, and what to delete on sight. Use whenever porting any endpoint, page, or table from the AH platform (agentic-humans-platform repo) into a module here.
---

# Extraction Playbook (AH → Agentic PMS)

Source: `nileshsatpute82/agentic-humans-platform`, `server/orchestrator/index.js` (~57k lines). PMS block ≈ lines 11961–20941; HRBP block ≈ 20954–27797 (verify with grep — the file moves). Measured surface (26-Aug-2026): the ONLY external reads are hr.employees (94), hr.department_heads (7), core.notifications/admin_settings (7), plus 2 decorative reads of project/customer to DELETE on sight. Zero coupling to CRM/tickets/finance/leave/LMS.

**Lift by route prefix, never by line range.** Routes interleave in the monolith. For each endpoint: copy the handler + every helper it calls (grep the helper name, copy, de-dupe into core/), then write a request-level test asserting the same status+shape as production.

**Rewrites, mechanical:**
- `hr.employees` → `core.employees` (mirror). Any column not in the mirror: STOP, add it to migration + the CSV importer in the same commit, don't invent.
- `hr.department_heads` → `core.department_heads` (adds tenant_id).
- Notifications/settings/audit → core equivalents (signatures match by design).
- Every query gains `tenant_id = $n`. No exceptions, even though v1 is single-tenant.
- `isHRorSA`-style role arrays → `hasPermission(user, '<perm>')`; add the grant to the default bundles seed.
- Mail sends → the core mail interface (send-mode aware). S3 keys → core storage with tenant prefix.

**Frontend:** pages lift as-is (UI preservation is a requirement). Fix imports to the new api client; strip AH-only nav/context. The two `.legacy.jsx` pages that were LIVE in AH (PMSPage.legacy = HR cycle creation, HRBPEngagementPage.legacy = survey builder) are NOT lifted — their replacement screens are built new (plan §3, Phases 1–2).

**Never bring over:** the AH git history (contains credentials), the file-migration runner pattern, dummy/demo seeds, ACC branding, the two decorative project/customer reads.

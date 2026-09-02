---
name: apms-security-permissions
description: Access control in Agentic PMS — effective permissions (role ∪ user grants), the route parity gate with log-only→enforce lifecycle, page_permission driving nav and URL guard, and handler guards for row-scoped rules. Use for any 403, missing nav item, new permission-gated page or endpoint, or when touching core.role_permissions / user_permissions / page_permission / route_permission.
---

# Agentic PMS Security & Permissions

Ported whole from the AH platform (production-proven for ~500 users), simplified where AH carried scar tissue.

**Model:** effective permissions = `role_permissions[role]` ∪ `user_permissions[email]`; `*` = wildcard. Roles live in `user_roles` (default `employee`). Default bundles: employee / manager / hod / hr / admin — seeded per tenant, editable as data, never hardcoded in handlers.

**Layers, in order:** authenticate (JWT, active employees only) → `apiPermissionParity` (route table: method + longest path prefix; `enforced=false` logs WOULD-DENY, `true` 403s **with `needs` named** — that field self-diagnoses the next misconfiguration) → handler guards for row-scoped decisions (my-team-only, HR-only sections).

**The carried lesson (expense-parity incident, AH):** route rules cover *coarse all-or-nothing* routes only. A flat prefix over mixed read/write routes will deny users the handler would have allowed — reads and writes get separate method-scoped rows. Row-scoped logic lives in handlers, full stop.

**Lifecycle:** new rules start log-only; promote to enforced only after a clean observation window in `api_denial_log`. Denials name who is about to be locked out — read them before enforcing.

**Diagnosing "Access denied":** the error string names the layer. `{error, needs}` = route table (check longest matching prefix vs the user's effective set). A domain message = handler guard. Fix the *data* first; the table is usually what's wrong, not the code.

**page_permission** drives nav visibility AND the direct-URL guard from the same row; NULL required_permission = public, register consciously.

---
name: apms-conventions
description: Agentic PMS house rules — module boundaries, tenant_id discipline, no-silent-failure, per-row error reporting, deterministic-numbers-AI-narrates, and what belongs in core vs modules. Use whenever writing or reviewing any code in this repo, adding an endpoint, table, or module, or deciding where something lives.
---

# Agentic PMS Conventions

Extracted product from the AH platform; these rules are the distilled lessons, enforced from commit one.

## Structure
`server/core` = auth, employees mirror, org, permissions, notifications, mail, settings, storage, audit, tenancy. `server/modules/{performance,engagement,people,agentic}` = the product. **Modules import core; modules never import each other's internals** — cross-module reads go through the other module's exported interface (mirrors the old cross-schema reads, made explicit).

## Non-negotiables
- **tenant_id on every table and in every WHERE.** Single-tenant instances still filter by it; SaaS stays open.
- **No silent failure.** Every catch fixes or surfaces. Batch operations return per-row reasons (see the CSV importer as the reference implementation). Boot FAILS on migration error.
- **No dummy data.** Empty states are honest.
- **Deterministic numbers; AI narrates.** Ratings, scores, distributions are SQL. The agentic module drafts text, always labelled as a draft, stored with the input that produced it.
- **Employee master is a mirror.** Loaded by the CSV importer (validated: duplicate emails, missing managers, chain cycles). Never edited as if this were an HRMS.
- **Thresholds, labels, dropdowns in tables**, not code. Clients configure; they never fork.
- **Errors sanitized to users, complete in logs.** The `needs` field on 403s stays — it self-diagnoses misconfigurations.
- **Anonymity is structural** in engagement: invitations and responses stay separate tables; nothing may join them for anonymous surveys, and the agentic themes feature reads a view that excludes identity columns.

## Every state change that affects a person's rating is audited
core.audit_log + explicit adjustment records. "Why did my rating change" must always have a queryable answer.

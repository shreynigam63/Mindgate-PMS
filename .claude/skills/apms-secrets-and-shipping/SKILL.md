---
name: apms-secrets-and-shipping
description: Commit, push and secrets rules for Agentic PMS — pre-commit checks, commit message shape, what must never enter the repo, and deploy verification. Use before any git add/commit/push, when adding dependencies or env vars, and when a deploy seems not to have landed.
---

# Shipping & Secrets

**Secrets: never in the repo.** Not in code, docs, scripts, or commit messages — this product exists partly because the parent repo leaked PATs into a committed file. Env vars only; document the KEY name, never the value. Pre-commit scan (added lines only — a cleanup commit legitimately shows the old value in its removal diff):

```bash
git diff --cached | grep -E "^\+" | grep -nE "gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
```

**Before staging:** `node --check` on touched server files; `npm test` in server/ (the suite must pass — it is the extraction safety net); `npm run build` in frontend/ when it exists. `node_modules/` and `dist/` are gitignored from day one — keep them so.

**Commits:** one concern each; heredoc messages (`git commit -F`) with what/why, root cause if a fix, what's deliberately untouched, and a test plan. Client-deliverable repo: history will be read by client engineers — write for them.

**Deploys:** boot fails loudly on missing env (REQUIRED_ENV in index.js) and on migration errors — that is by design; a refusing boot is a working safety, not an outage to patch around. Verify a deploy by behaviour or a log line, never by a static version string.

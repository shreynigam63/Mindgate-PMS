# Enabling the AI assistance — Agentic PMS

**Scope for this round: the AI features only.** No other tab, screen or
behaviour changes. The code is already deployed — this is one environment
variable and a restart.

| | |
|---|---|
| Work | ~5 minutes |
| Code to deploy | None |
| Migrations to run | None |
| Screens changed | None |

---

## The change, in one line

| Today | After |
|---|---|
| `ANTHROPIC_API_KEY` is not set. Every AI button is present and clickable; each one answers **HTTP 503**: *"Agentic features are not configured on this instance (ANTHROPIC_API_KEY missing)."* | The same buttons, in the same places, return drafts. Nothing appears, moves or disappears — the screens are identical either way. |

That message is the product behaving correctly, not a fault. The AI work is
already written, tested and deployed; it is gated on a key the instance has
never been given. Supplying the key is the whole change.

---

## Part 1 — Why nothing else moves

The gate is a single runtime check in `server/core/ai.js`:

```js
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';

function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

// the one entry point every AI route goes through
if (!aiEnabled()) {
  const e = new Error('Agentic features are not configured on this instance (ANTHROPIC_API_KEY missing).');
  e.status = 503; throw e;
}
```

It reads `process.env` **at call time, not at build time**. So the switch is
thrown by the environment, and the following are all things you explicitly
**do not** do:

- **No code deploy.** Not one line changes. Leave the running build on the
  commit it is on.
- **No database migration.** Nothing in `server/migrations/` runs, and no
  existing table is touched.
- **No frontend rebuild.** The key is read server-side only and sent as the
  `x-api-key` header to `api.anthropic.com`. It never reaches the browser —
  there is no reference to it anywhere in `frontend/src`. The static bundle
  stays exactly as served.
- **No change to any other tab.** KRAs, Mid-Year, Team Evaluation,
  Calibration, Increment Simulation, the KRA Library, the employee Directory
  — all unchanged, before and after.
- **No new route, permission or role.** The 23 routes under
  `/api/v1/agentic` already exist and are already reachable; today the 16
  that call the model refuse with 503.

> **The one thing the database gains.** On the first *successful* AI call the
> server runs `CREATE SCHEMA IF NOT EXISTS agentic` and
> `CREATE TABLE IF NOT EXISTS agentic.drafts`, then stores each draft
> alongside the exact deterministic input that produced it. Purely additive,
> in its own schema, and it alters nothing that already exists — but it is a
> real write, so it is named here rather than glossed over.

> **If the instance is on an older build.** The key enables every AI feature
> *the deployed bundle already contains*. If an instance is running a build
> from before a given AI feature was added, that feature needs the normal
> deploy — out of scope for this round. Check what the instance is running
> before promising a specific button.

---

## Part 2 — Setting the key

> ### ⛔ The key never goes in git
>
> Not in `render.yaml`, not in a committed `.env`, not in a Dockerfile, not in
> this document. **The repository is public.** A key that reaches a commit is
> burned and must be **revoked**, not deleted — the history keeps it.
> Everywhere below, `sk-ant-…` is a placeholder; paste the real value only
> into the store named, and send it to whoever needs it over a channel that is
> not the repo.

Pick the section that matches how this instance runs. Each is: put the value
in one place, restart the API process, done.

### systemd (EC2) — edit the env file, restart the unit

```bash
sudo sed -i '/^ANTHROPIC_API_KEY=/d' /etc/agentic-pms/api.env
echo 'ANTHROPIC_API_KEY=sk-ant-…' | sudo tee -a /etc/agentic-pms/api.env >/dev/null
sudo systemctl restart agentic-pms-api

# nothing else gets restarted — nginx and the static bundle are untouched
systemctl status agentic-pms-api --no-pager
```

The file is `root:apms`, mode `0640`. Keep it that way — it is readable by the
service user and nobody else. The installer never overwrites this file, so
re-running `install.sh` later will not wipe the key.

If the restart fails, `journalctl -u agentic-pms-api -n 40` will say why; a
stray quote or a trailing space around the `=` is the usual cause.

### Docker — add it to the compose env file

```bash
# deploy/docker/.env — gitignored, and must stay so
ANTHROPIC_API_KEY=sk-ant-…

# then, from deploy/docker/
docker compose up -d
```

The compose file already passes it through as
`ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}`, which is why the variable
resolves to empty today instead of failing to start. Only the API container is
recreated; the database volume and the web container are untouched.

### Render — dashboard → the API service → Environment

Open the `agentic-pms-api` service, add `ANTHROPIC_API_KEY` with the real
value, and save. Render restarts the service on its own.

`render.yaml` already declares the variable with `sync: false`. That is what
keeps the value out of git *and* preserves it across Blueprint syncs — do not
give it a `value:`, ever.

Do not touch the frontend service. It does not need the key and does not need
redeploying for this change.

### The second variable

`AI_MODEL` selects the model. It is **not** a secret and belongs in version
control. The code falls back to `claude-sonnet-4-5` if it is unset, which is a
generation behind — both `render.yaml` and the systemd installer already set
`claude-opus-5`, so on a current instance there is nothing to do here. The
request body is plain `model / max_tokens / system / messages`, so a newer
model is drop-in with no code change.

---

## Part 3 — Confirming it worked

One call proves it, and it is safe to run against a live instance — it reads
an employee's own KRAs and returns a draft; it writes no rating and changes no
record.

```bash
B=https://<host>/api/v1

TOK=$(curl -s -X POST "$B/auth/dev-login" -H 'Content-Type: application/json' \
  -d '{"email":"<hr-admin>","password":"<password>"}' | jq -r .token)

curl -s -X POST "$B/agentic/devplan-suggest" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}' \
  | jq '{ok, goals: (.draft.suggested_goals | length)}'

# {"ok": true, "goals": 9}   -> the key is live
# HTTP 503                   -> still not configured: the value did not reach
#                               the process, or it was not restarted
```

Then confirm it in the product the way a user will see it:

- [ ] Sign in as any employee and open **My Growth**.
- [ ] Use the suggestion button under *Target achievements for the year*.
- [ ] Suggestions appear instead of the 503 banner.
- [ ] Open one other tab — **My KRAs** will do — and confirm it looks exactly
      as it did before.

> **Blast radius, stated plainly.** If the key is wrong or the account has no
> credit, the AI buttons keep returning an error and *everything else in the
> product carries on working*. There is no failure mode of this change that
> takes the PMS down.

---

## Part 4 — What the key turns on

23 routes exist under `/api/v1/agentic`; 16 of them call the model and are the
ones this unblocks. The rest — reading stored drafts, saved analyses and kept
recommendations — already work without a key. In the UI they surface as
buttons on these screens, and nowhere else:

| Screen | Who sees it | What the button does |
|---|---|---|
| My Growth | Employee | Suggests development goals from the employee's own KRAs; suggests aspiring-career steps |
| Mid-Year Review | Employee | Drafts the mid-year write-up; reviews each KRA justification; summarises the discussion |
| Self-Appraisal | Employee | Review assist on the self-appraisal; meeting summary |
| My Rating | Employee | Appraisal summary and the recommendations the employee can keep |
| Team Evaluation | Manager | Drafts the manager's appraisal text; pre-publish appraisal summary |
| Quarterly Connects | Manager | Themes across connects, auto-tagging, meeting summary |
| Cycles | HR / admin | Cycle health — where the cycle is stuck and who to chase |
| Calibration | HR / admin | Calibration brief for the panel |
| Closure Letters | HR / admin | Drafts the letter body |
| Review Analysis (HR) | HR / admin | The confidential 7-parameter analysis |
| Engagement | HR / admin | Themes across survey responses |

Every one of these is a **draft** the person can edit, discard or ignore.
Nothing is auto-submitted, and no AI output is shown to anyone other than the
person who asked for it.

> **What it is not allowed to do.** The house rule is **deterministic numbers,
> AI narrates**, enforced at the single entry point in `server/core/ai.js`. No
> AI call can produce a rating, score or distribution;
> `stripRatingSuggestions()` removes rating-shaped keys from structured output
> as a second line of defence. Every number in the product — weights, ratings,
> weighted averages, increment costs — is computed by the application from the
> data. If a change ever makes a number depend on a model reply, that change
> is wrong.

---

## Part 5 — Turning it back off

Symmetrical with turning it on, and just as cheap. Remove the variable and
restart the API:

```bash
sudo sed -i '/^ANTHROPIC_API_KEY=/d' /etc/agentic-pms/api.env
sudo systemctl restart agentic-pms-api

# Docker: delete the line from deploy/docker/.env, then: docker compose up -d
# Render: delete the variable in the dashboard; the service restarts itself
```

Every AI endpoint returns the clean 503 again and the rest of the product is
untouched. Drafts already stored in `agentic.drafts` stay readable — dropping
that table is not part of a rollback and should not be done casually.

---

## Part 6 — Handover checklist

- [ ] Key received over a channel that is not the repository, and not pasted
      into a ticket, a commit message or a chat that is archived publicly.
- [ ] Value set in exactly one place for this instance — the section from
      Part 2.
- [ ] API process restarted; nothing else restarted or redeployed.
- [ ] `devplan-suggest` returns `{"ok": true, …}`.
- [ ] My Growth shows suggestions; one unrelated tab confirmed unchanged.
- [ ] Confirmed the key is *not* present in `git status`, `git diff`, or any
      file staged for commit.
- [ ] Billing alert set on the Anthropic account, so usage is visible before
      it is a surprise.

> ### ⛔ Standing security note
>
> Any key that has previously been shared in chat, email or a document should
> be treated as exposed and **rotated** before this goes to a client instance.
> Rotating is a two-minute job in the Anthropic console and the only place the
> new value needs to reach is the one store named in Part 2.

---

*Agentic PMS · Mindgate Solutions — AI enablement handover. Scope: AI features
only; no other screen or behaviour changes in this round. Companion documents:
`docs/enable-ai-assistance.html` (the same content as a page) and
`docs/KRA-LIBRARY-DEPLOYMENT.md` (the separate feature deployment).*

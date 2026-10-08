# Deploying from GitHub Actions

One-time setup for `.github/workflows/deploy.yml`. Until it is done the
workflow runs the tests and **skips** the deploy with a notice, so merging
it changes nothing.

## Why OIDC rather than an access key

The old way was a person with long-lived AWS keys running `update.sh` over
SSM from whatever machine they were sitting at. That failed twice in a week
when the environment holding the keys was recycled, and it meant the keys
travelled through chat to get the job done.

With OIDC there is **no stored credential**. GitHub mints a short-lived
token that names this repository and branch; AWS trusts that token to
assume one narrow role and hands back credentials that expire in minutes.
Nothing to leak, nothing to rotate, nothing to lose with a container.

Note what is being trusted: anyone who can push to `main` can deploy. That
is the point, and it is why the trust policy below is pinned to this
repository and this branch, and why the workflow uses a `production`
environment you can put reviewers on.

## 1. Tell AWS to trust GitHub (once per account)

Skip if `token.actions.githubusercontent.com` is already an identity
provider in IAM.

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

## 2. The role the workflow assumes

Trust policy — `trust.json`. Replace `<ACCOUNT_ID>`. The `sub` condition is
what stops another repository, or a branch nobody reviews, from assuming
this role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:shreynigam63/Mindgate-PMS:environment:production"
      }
    }
  }]
}
```

> **CORRECTED 6 Oct.** This said `ref:refs/heads/main`, which can never
> match: the deploy job declares `environment: production`, and a job
> with an environment is identified to AWS as
> `repo:<owner>/<repo>:environment:<name>`, not by its branch. Every
> AssumeRole would have been refused. What limits deploys to `main` is
> now the `production` environment's deployment-branch rule (section 3),
> so set that rule — without it, any branch could run in `production`.
>
> A step-by-step console version of this guide, for whoever holds the AWS
> admin login, is `docs/DEPLOY-FROM-GITHUB.md`.

Permissions — `policy.json`. Only the one instance, only the one document,
and reading back the result. Replace `<ACCOUNT_ID>`, `<REGION>`,
`<INSTANCE_ID>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:<REGION>:<ACCOUNT_ID>:instance/<INSTANCE_ID>",
        "arn:aws:ssm:<REGION>::document/AWS-RunShellScript"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    }
  ]
}
```

```bash
aws iam create-role --role-name agentic-pms-gha-deploy \
  --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name agentic-pms-gha-deploy \
  --policy-name ssm-deploy --policy-document file://policy.json
```

`ssm:SendCommand` on a specific instance is already a shell on that box as
root — `update.sh` needs sudo. There is no way to make this role weaker and
still have it deploy; keep the instance list to exactly one.

## 3. Repository settings

**Settings → Secrets and variables → Actions**

| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/agentic-pms-gha-deploy` |
| Secret | `EC2_INSTANCE_ID` | `i-0b15f364a2f4cf09a` |
| Variable | `AWS_REGION` | the instance's region (the workflow defaults to `ap-south-1`) |

Neither identifier is a password, but keeping them out of the logs keeps
the instance id out of a public fork's build output.

**Settings → Environments → `production`** — set **Deployment branches**
to `main` only (required: the AWS trust policy trusts this environment, so
this rule is what keeps other branches out). Add required reviewers here if
you want a human to approve each deploy. The workflow already targets that
environment, so protection rules apply with no further change.

## 4. The branch the box is on

A push to `main` deploys `main`. A manual run deploys the branch typed into
its `ref` input — blank means `main` — and only a branch: a tag or a commit
is refused by the `resolve` job, and again by `update.sh`, because it would
leave the box on a detached HEAD that later runs cannot move.

Deploying another branch switches the box to it, and switches only once the
screens for that branch's commit are in hand. Deploying `main` again
switches it back. (The production environment admits runs started from
`main` only; the branch being *deployed* is the input.)

## Where the screens are built (since 8 Oct)

**On GitHub, not on the instance.** The deploy of `15ba4fe` took the PoC
down for about seven hours: the instance stopped answering part-way
through the deploy, never picked up the command, and needed a stop/start.
The heaviest thing `update.sh` used to do was build the frontend (`npm ci`
plus a Vite build) on the same small box that serves the site, and that is
the likeliest cause. So the build moved:

| Job | What it does |
|---|---|
| `resolve` | turns the push, or the branch typed into a manual run, into **one commit**. Every later job uses it, and "Re-run failed jobs" reuses it — nothing looks the branch up a second time, so a push landing mid-run cannot slip an untested commit through |
| `test` | the server suite on that commit — the gate |
| `web-build` | `npm ci` + `npm run build` on GitHub's runner, with a **read-only** token and no credentials left in the checkout; checks the bundle is complete and carries its commit |
| `web-publish` | publishes that build as the tag `web-build/<full commit sha>` (an orphan commit whose files ARE `frontend/dist`). The only job that can write, and it runs no npm — third-party build code never sees a write token. Then removes old bundles; a failure there is a warning, never a reason to hold the deploy |
| `deploy` | after all of them: one SSM command. The instance downloads that tag, checks it, and copies it into place. It never builds |

What this changes on the box (`deploy/service/update.sh`). **Everything is
decided before anything moves**:

1. Backup, fetch.
2. Which branch — a branch on origin only, never a tag or a bare commit —
   and which commit. It must be on that branch, and forward of what the
   box runs. A box whose own branch has commits origin does not is refused
   here, not halfway.
3. **The screens for that exact commit**: downloaded and checked — every
   file `index.html` names is present and not empty, and the bundle
   carries the commit it was built from.

Any "no" up to here leaves the checkout, the packages, the site and the
running API exactly as they were. Only then:

4. Move the checkout (switching branch if asked).
5. Server packages: `npm ci` only when the installed set is not the one
   `server/package.json` and its lock describe. That is judged by a stamp
   written after a *successful* install — so an install that failed is
   retried by the next run, and most deploys run no npm at all. (The first
   deploy after this change installs once, to write the stamp.)
6. Copy the screens into place (readable by nginx, whatever the download
   directory's mode), reconcile settings, restart, health check — and the
   page nginx actually serves must name the build just installed.

Three details that matter:

- **The commit is pinned.** The workflow sends the commit it tested and
  built, and `update.sh` deploys that one — not whatever `main` is by the
  time the command arrives. A commit the box is already past is not
  deployed backwards: re-running an old run says "Already past", touches
  nothing — no screens, no settings, no restart — and finishes green.
  Re-running the *current* commit is a repair: screens re-copied,
  packages checked, API restarted, reported as "NOTHING NEW".
- **The deploy scripts run from the commit being deployed.** The SSM
  command copies `deploy/service` out of that commit and runs the copy, so
  a change to `update.sh` takes effect in the deploy that ships it. (That
  is also how the very first deploy of this change already uses the new
  `update.sh`.)
- **Nothing new in AWS.** The repository is public and the box already
  fetches from it; the tags need only the workflow's own token. The deploy
  role is unchanged.

The tags show up in the repository's tag list. The `web-publish` job keeps the
bundles for the last 30 commits on `main` (plus the one it just built) and
deletes the rest. A bundle is about 2 MB.

**Building on the box is still possible, deliberately** — for when GitHub
is unavailable: `sudo BUILD_ON_BOX=1 /opt/agentic-pms/deploy/service/update.sh`
(`sudo` first: `BUILD_ON_BOX=1 sudo …` loses the setting). It builds in a
separate worktree of the target commit before anything moves, so a failed
or killed build leaves the box as it was — but it is still the heavy step
on a small instance.

Tested in `server/test/deploy-web-bundle.test.js`: publish and fetch
against real temporary git repositories, the refusal of a missing or
mismatched bundle, pruning, and the real `update.sh` run end to end with
stand-ins for systemd, npm and nginx — including that with no bundle the
box does not change at all, and that the exact command the workflow sends
runs the right script with the right arguments.

## What building this gate found

The point of a gate is that it runs the suite somewhere clean, and the
first clean run paid for the whole exercise. Against a virgin database the
server suite failed on `A LOYALTY MILESTONE DOES NOT CONSUME AN AWARD
SLOT` — not because the rule was wrong, but because the test guards itself
("the award master has to be seeded for this to mean anything") and
`rnr.awards` was **empty**.

The cause is this repo's oldest trap: `index.js` creates the tenant AFTER
migrations run, so a migration that loops over `core.tenants` to seed
per-tenant data reaches nobody on a fresh install. Three migrations were
doing exactly that and were never wired into boot:

| Migration | What a fresh install was missing |
|---|---|
| `068` / `069` / `078` | the HRBP tab's pages, the RnR screens, and HR's screen for assigning a remit |
| `077` | every RnR award, the band→level map, employment statuses and the quota settings |
| `060` | the grade ladder, role families, designation→grade and department→family |

None of it ever showed on the PoC box, whose tenant predates all three.
Every one of them would have hit the next install.

All are now called at boot and covered by
`server/test/fresh-tenant-bootstrap.test.js`, which also carries the guard
that fails for the *next* migration that exports a per-tenant seeder
nothing calls — which is how `077` and `060` were found after `069`.

## What the workflow will and will not catch

It runs the **server suite** against a real Postgres before it deploys.

It does **not** run the browser suite — that needs the API, Vite and
Chromium together, which is a slower job nobody has built yet. It is the
suite that catches nav and layout regressions, so it stays a local
pre-merge step. Worth closing.

A deploy that pulls nothing is treated as a **failure**, not a quiet
success: `update.sh` says "NOTHING NEW was deployed" in that case and the
workflow greps for it. That sentence exists because a no-op deploy once
read as a real one and was believed for days.

## Deploying by hand, when you need to

Nothing here replaces the manual path. From AWS Console → Systems Manager →
Session Manager, on the instance:

```bash
sudo /opt/agentic-pms/deploy/service/update.sh
# or, if GitHub has not built the screens for that commit:
#   sudo BUILD_ON_BOX=1 /opt/agentic-pms/deploy/service/update.sh
sudo -u postgres psql -d apms -tc "SELECT count(*) FROM core.page_permission;"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/v1/health
```

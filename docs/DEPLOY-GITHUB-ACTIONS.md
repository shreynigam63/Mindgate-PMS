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

The instance checkout currently sits on `claude/push-code-github-2rhnnq`.
The workflow passes `main` by default, so **the first run moves the box
onto `main`** and every deploy after it is "what is on main is what is on
the box".

Today both refs are the same commit, so that first run changes the branch
and not one line of code — which is the cheapest moment to do it. If you
would rather leave the box on its branch, run the workflow manually with
the `ref` input blank; `update.sh` then just pulls whatever branch it is
already on.

## Where the screens are built (since 8 Oct)

**On GitHub, not on the instance.** The deploy of `15ba4fe` took the PoC
down for about seven hours: the instance stopped answering part-way
through the deploy, never picked up the command, and needed a stop/start.
The heaviest thing `update.sh` used to do was build the frontend (`npm ci`
plus a Vite build) on the same small box that serves the site, and that is
the likeliest cause. So the build moved:

| Job | What it does |
|---|---|
| `test` | the server suite, as before — the gate |
| `web` | `npm ci` + `npm run build` on GitHub's runner, checks the bundle carries its commit, and publishes it to this repository as the tag `web-build/<full commit sha>` (an orphan commit whose files ARE `frontend/dist`) |
| `deploy` | after both: one SSM command. The instance fetches that tag, unpacks it, and copies it into place. It never builds |

What this changes on the box, in order (`deploy/service/update.sh`):

1. Backup, fetch — as before.
2. **Download the screens for the exact commit being deployed — before
   anything moves.** No bundle, or a bundle stamped with another commit,
   stops the deploy right there, with the checkout, the packages, the site
   and the running API all exactly as they were.
3. Move the checkout (forward only, along the branch).
4. Server packages: `npm ci` only when `server/package.json` or its lock
   changed. Most deploys change neither, so most deploys run no npm at all.
5. Copy the screens into place, reconcile settings, restart, health check —
   as before.

Three details that matter:

- **The commit is pinned.** The workflow sends the commit it tested and
  built, and `update.sh` deploys that one — not whatever `main` is by the
  time the command arrives. A commit the box is already past is not
  deployed backwards.
- **The deploy scripts run from the commit being deployed.** The SSM
  command copies `deploy/service` out of that commit and runs the copy, so
  a change to `update.sh` takes effect in the deploy that ships it. (That
  is also how the very first deploy of this change already uses the new
  `update.sh`.)
- **Nothing new in AWS.** The repository is public and the box already
  fetches from it; the tags need only the workflow's own token. The deploy
  role is unchanged.

The tags show up in the repository's tag list. The `web` job keeps the
bundles for the last 30 commits on `main` (plus the one it just built) and
deletes the rest. A bundle is about 2 MB.

**Building on the box is still possible, deliberately** — for when GitHub
is unavailable: `sudo BUILD_ON_BOX=1 /opt/agentic-pms/deploy/service/update.sh`.
It is the old behaviour, with the old risk on a small instance.

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

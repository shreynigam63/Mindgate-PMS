# Deploying Mindgate PMS from GitHub — step by step

This guide connects GitHub to the AWS server that runs
**pms.agentichumans.in**, so that every change merged into `main` is tested
and put live automatically. It is written for the person who has
**administrator access to the AWS account** and **admin access to the GitHub
repository**. No command line is needed — every step is in the AWS console
or on github.com.

Time: about 15 minutes, once. Nothing here stores a password or an access
key anywhere: GitHub proves who it is to AWS each time and gets a key that
expires within the hour.

---

## What you will end up with

```
merge to main ──► GitHub runs all tests ──► GitHub asks AWS to run the
                                            update script on the server
                                                  │
                                                  ▼
                         server: backup → pull → build → restart → health check
                                                  │
                                                  ▼
                        GitHub fails the run if the site did not actually change
```

## Values used in this guide

| What | Value |
|---|---|
| GitHub repository | `shreynigam63/Mindgate-PMS` (write it with these exact capitals) |
| Server (EC2 instance id) | `i-0b15f364a2f4cf09a` |
| AWS region | the region the server is in — `ap-south-1` (Mumbai) unless yours differs |
| AWS account id | yours — shown in the AWS console, top-right menu, 12 digits |
| Role name | `agentic-pms-gha-deploy` |

Find the region: AWS console → **EC2** → **Instances** → click the instance →
the **Availability Zone** (for example `ap-south-1a`); the region is that
without the last letter.

---

## Step 1 — Let AWS trust GitHub

Skip this step if it has been done before in this AWS account (you will see
`token.actions.githubusercontent.com` in the list).

1. AWS console → **IAM** → **Identity providers** → **Add provider**.
2. Provider type: **OpenID Connect**.
3. Provider URL: `https://token.actions.githubusercontent.com`
4. Audience: `sts.amazonaws.com`
5. **Add provider**.

## Step 2 — Create the role GitHub will use

1. AWS console → **IAM** → **Roles** → **Create role**.
2. Trusted entity type: **Custom trust policy**. Replace everything in the
   box with the policy below, putting your 12-digit account id in place of
   `<ACCOUNT_ID>`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": {
         "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
       },
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

   > **Why `environment:production` and not the branch.** The deploy job
   > runs in GitHub's `production` environment, and GitHub then identifies
   > it to AWS by that environment, not by the branch. A trust policy
   > naming `ref:refs/heads/main` is refused on every run. Step 4 limits
   > the `production` environment to `main`, so only `main` can deploy.

3. **Next**. On the permissions page add nothing — click **Next**.
4. Role name: `agentic-pms-gha-deploy` → **Create role**.
5. Open the new role → **Add permissions** → **Create inline policy** →
   **JSON**, and paste this, replacing `<REGION>`, `<ACCOUNT_ID>` and keeping
   the instance id:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "ssm:SendCommand",
         "Resource": [
           "arn:aws:ec2:<REGION>:<ACCOUNT_ID>:instance/i-0b15f364a2f4cf09a",
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

6. Policy name: `ssm-deploy` → **Create policy**.
7. Copy the role's **ARN** from the top of its page. It looks like
   `arn:aws:iam::123456789012:role/agentic-pms-gha-deploy`.

What this role can do: send the "run a shell command" instruction to **this
one server**, and read back the result. Nothing else in the account. That
is still root on that server — which is what deploying needs — so keep the
instance list to exactly one.

## Step 3 — Give GitHub the two values

github.com → the repository → **Settings** → **Secrets and variables** →
**Actions**.

Tab **Secrets** → **New repository secret**, twice:

| Name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the ARN copied in step 2.7 |
| `EC2_INSTANCE_ID` | `i-0b15f364a2f4cf09a` |

Tab **Variables** → **New repository variable** (only if your region is not
`ap-south-1`):

| Name | Value |
|---|---|
| `AWS_REGION` | your region, for example `ap-south-1` |

Neither value is a password; they are kept as secrets so the server id does
not appear in public build logs (the repository is public).

## Step 4 — Lock deploys to `main`

github.com → the repository → **Settings** → **Environments**.

1. Open **production** (or **New environment** → name it exactly
   `production`).
2. **Deployment branches and tags** → **Selected branches and tags** →
   **Add deployment branch rule** → `main`.
3. Optional: **Required reviewers** → add yourself, if you want to click
   *Approve* before each deploy goes live.

This is the rule that makes "only `main` can deploy" true; the AWS role in
step 2 trusts anything that runs in this environment.

## Step 5 — First deploy

github.com → **Actions** → **Deploy** (left list) → **Run workflow** →
branch `main`, *Git ref to deploy* `main` → **Run workflow**.

The run has three parts:

| Part | What it does | Typical time |
|---|---|---|
| **test** | the full server test suite against a clean database | 4–6 min |
| **preflight** | checks the two secrets exist | seconds |
| **deploy** | backup → pull → build → restart on the server, then checks it | 3–5 min |

The first run also moves the server's checkout from the
`claude/push-code-github-2rhnnq` branch onto `main`. From then on, what is on
`main` is what is live.

**It worked when** the run is green and its summary shows a line like:

```
==> Healthy. Deployed e1422a4 -> 817960d on main.
```

Then open https://pms.agentichumans.in, press **Ctrl+Shift+R** once, and
check the **?** menu at top right: it shows `Build` and the same short code.

## Step 6 — Every deploy after this

Nothing to do. Merging into `main` starts the same run on its own. Tabs
that were already open show a blue **"A newer version of PMS has been
deployed — Reload now"** bar.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Run green, but **deploy** shows *skipped* | a secret is missing or misspelt | redo step 3; names must match exactly |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | the trust policy does not match | step 2.2: check the account id, the repository name's capitals, and `environment:production` |
| `AccessDenied … ssm:SendCommand` | the inline policy's region, account or instance is wrong | step 2.5 |
| `InvalidInstanceId` | the server is not registered with Systems Manager | if Session Manager works for you, it is registered — check the region in step 3 |
| `update.sh reported no change` | the server was already on this commit (for example, someone deployed by hand) | nothing is broken; the next merge deploys normally |
| `nginx is serving … but this build is …` | the website folder nginx serves is not the one the script writes | send the run log to the developer |
| **test** red | a test failed, and nothing was deployed | send the run log to the developer; the site is untouched |
| Waiting for approval | you turned on required reviewers in step 4 | **Review deployments** → **Approve** |

**Undoing a bad release:** revert the change on `main` (github.com → the
merged commit → **Revert**, or ask the developer). The revert is a new
commit, so it deploys the same way. The update script also takes a database
backup before every deploy, under `/var/backups/agentic-pms` on the server.

**Deploying by hand still works** if GitHub is unavailable: in Session
Manager on the server, `sudo /opt/agentic-pms/deploy/service/update.sh`.

---

## Technical reference

The workflow is `.github/workflows/deploy.yml`; the CLI version of these
steps and the reasoning behind them are in `docs/DEPLOY-GITHUB-ACTIONS.md`.

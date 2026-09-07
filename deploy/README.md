# Agentic PMS — EC2 deployment

Deploying the PMS to a single EC2 instance in a customer's own AWS
account, with PostgreSQL on the same box. Two supported paths, both
producing the same running system:

| | [Path A — systemd service](#path-a--systemd-service) | [Path B — Docker](#path-b--docker) |
|---|---|---|
| Runs as | `agentic-pms-api.service` | three containers under Compose |
| Postgres | installed on the host | `postgres:16-alpine` container + volume |
| Node | installed on the host | inside the image |
| Best when | the customer already manages EC2 with systemd, or wants Postgres under their existing DBA tooling | the customer wants one command, or the box already runs Docker |

Pick one. Running both against the same database is not supported —
they would both run migrations and both run the reminder sweeps.

---

## Is one EC2 with Postgres on it actually OK?

**For a PoC or a pilot: yes, and it is the right call.** The whole system
is one Node process, one nginx and one Postgres. Splitting the database
onto RDS for a fifty-person pilot buys you very little and costs a
managed-database bill plus a VPC to reason about.

What you are actually giving up by not using RDS, stated plainly:

| | Postgres on the EC2 box | RDS |
|---|---|---|
| Backups | whatever you set up — this repo gives you a nightly `pg_dump` + 14-day retention | automated, point-in-time recovery to any second in the window |
| Failure of the instance | the app AND the database are down | only the app is down |
| Patching | yours | AWS's, in a maintenance window |
| Restore granularity | last night's dump | any point in time |
| Cost | one instance | one instance + the RDS bill |

So the honest rule:

* **PoC, pilot, UAT, internal demo → one EC2 with Postgres on it.** Take
  the backups seriously (below) and you are fine.
* **Real employee appraisal records, or an availability commitment to the
  customer → move the database to RDS.** It is a one-line change:
  point `DATABASE_URL` at the RDS endpoint and drop `DATABASE_SSL=false`
  so the connection is encrypted. Nothing in the application changes.

Two things that are **not** optional either way:

1. **The nightly dump must be copied off the box.** Both paths install a
   nightly `pg_dump`, but the dumps land on the same EBS volume as the
   database they came from. A lost volume loses both. There is a
   commented-out `aws s3 sync` at the bottom of
   `deploy/service/backup.sh` — turn it on, or the backups are a comfort
   rather than a recovery plan.
2. **Do not use instance store.** A `d`/`i`-family instance's local NVMe
   is wiped on stop/start. The database must be on EBS (gp3). Every
   general-purpose instance type is EBS-only, so you get this by default
   unless you go looking for trouble.

### Sizing

| Users | Instance | Disk |
|---|---|---|
| PoC, up to ~200 employees | **t3.small** (2 vCPU / 2 GB) | 30 GB gp3 |
| Up to ~1,000 employees | t3.medium (2 vCPU / 4 GB) | 50 GB gp3 |

**t3.micro is not enough.** 1 GB of RAM cannot complete the Vite
production build — the OOM killer takes it partway through with no
useful error. `install.sh` detects this and adds a 2 GB swap file so the
build finishes, but swap is a workaround, not a size.

Disk is dominated by evidence attachments and closure letters, which
migration 013 stores as bytes **in Postgres** rather than on the
filesystem. Budget roughly 10 MB per employee per cycle if attachments
are used heavily.

### Security group

| Port | Source | Why |
|---|---|---|
| 80 / 443 | the customer's office/VPN CIDRs — **not** `0.0.0.0/0` for a PoC | the app |
| 22 | admin CIDRs only, or nothing if you use SSM Session Manager | access |
| 5432 | **nobody** | the app reaches Postgres over `127.0.0.1`; nothing outside the box needs it |

Both paths keep Postgres bound to loopback or to the Docker network, so
5432 is unreachable from outside regardless — but leave it out of the
security group anyway.

---

## Path A — systemd service

### Install

```bash
sudo dnf install -y git || sudo apt-get install -y git
git clone https://github.com/shreynigam63/Mindgate-PMS.git
cd Mindgate-PMS
sudo TENANT_SLUG=<customer-short-name> bash deploy/service/install.sh
```

That single command installs Node 22, PostgreSQL 16, nginx, the app, the
systemd service and the nightly backup timer, then waits for
`/api/v1/health` to answer before it claims success. Tested on Ubuntu
22.04/24.04, Debian 12, Amazon Linux 2023 and RHEL 9.

`TENANT_SLUG` names the tenant. **Choose it once.** It is resolved to a
tenant id on first boot and stamped onto every row, so changing it later
does not rename anything — it silently resolves to a *different*, empty
tenant while the real data sits behind under the old slug.

Optional on the same line: `ANTHROPIC_API_KEY=sk-ant-...` to enable the
AI features, `PG_MAJOR=15` if 16 is not packaged for the release,
`DB_NAME` / `DB_USER` to override the defaults.

**The installer is also the upgrade path.** It is safe to re-run: it
never regenerates a secret that already exists, never overwrites
`/etc/agentic-pms/api.env`, and never drops the database.

### What it puts where

| | |
|---|---|
| Application | `/opt/agentic-pms` |
| Built frontend | `/var/www/agentic-pms` |
| Config and secrets | `/etc/agentic-pms/api.env` — `root:apms`, mode `0640` |
| Service | `agentic-pms-api.service`, running as the unprivileged `apms` user |
| nginx site | `sites-available/agentic-pms` (Debian) or `conf.d/agentic-pms.conf` (RHEL) |
| Backups | `/var/backups/agentic-pms`, nightly 02:15, 14-day retention |
| Logs | `journalctl -u agentic-pms-api` |

### Day-to-day

```bash
systemctl status agentic-pms-api          # is it up
journalctl -u agentic-pms-api -f          # what is it doing
systemctl restart agentic-pms-api         # restart
sudo /opt/agentic-pms/deploy/service/update.sh    # deploy a new version
sudo /opt/agentic-pms/deploy/service/backup.sh    # backup right now
systemctl list-timers agentic-pms-backup.timer    # when is the next backup
sudo /opt/agentic-pms/deploy/service/restore.sh /var/backups/agentic-pms/apms-....dump
```

`update.sh` takes a backup *before* it pulls, because a new version may
bring migrations and a migration is the one change on this box that a
restart cannot undo.

---

## Path B — Docker

### Install

```bash
git clone https://github.com/shreynigam63/Mindgate-PMS.git
cd Mindgate-PMS/deploy/docker
cp .env.example .env && chmod 600 .env
# fill in the three CHANGE_ME values — the file tells you how to generate each
docker compose up -d --build
```

Three containers on one private network:

```
web (nginx :80)  ──/api──▶  api (node :8080)  ──▶  db (postgres :5432)
      │
      └── serves the built React bundle
```

Only `web` publishes a port. The API and the database are unreachable
from outside the box **regardless of how the security group is
configured** — a misconfigured SG cannot expose Postgres here.

### Day-to-day

```bash
docker compose ps
docker compose logs -f api
docker compose up -d --build            # deploy a new version after a git pull
./backup.sh                             # backup right now
./restore.sh backups/apms-....dump
```

Add the nightly backup to root's crontab — the Docker path has no
systemd timer:

```
15 2 * * * /opt/agentic-pms/deploy/docker/backup.sh >> /var/log/apms-backup.log 2>&1
```

> **`docker compose down -v` deletes the database.** The `-v` removes the
> `pgdata` volume, which is every employee, cycle, rating and uploaded
> file. `docker compose down` without `-v` is the safe one.

---

## First run (both paths)

### 1. Create the first administrator — do this immediately

The bootstrap endpoint is unauthenticated and **locks itself the moment
any employee exists**. That is what makes it safe, and it is why you
should not leave a freshly deployed instance sitting around.

```bash
curl -X POST http://<host>/api/v1/setup/bootstrap-admin \
  -H 'Content-Type: application/json' \
  -d '{"email":"hr.admin@customer.com","name":"HR Admin","password":"<a strong password>"}'
```

Check it is closed afterwards — `bootstrap_available` must be `false`:

```bash
curl http://<host>/api/v1/setup/status
```

### 2. Everything else

Employees, roles, passwords, the first cycle and KRA loading are in
[`../DEPLOY.md`](../DEPLOY.md) section 4, which applies unchanged.

---

## Authentication — read this before go-live

`AUTH_DEV=true` **is required.** It is the only login path that exists in
this build.

That name is misleading and worth unpicking, because it looks alarming in
a customer environment and the reality is more ordinary: the route does a
real bcrypt password check against `core.local_credentials` and only lets
active employees in. It is not a backdoor and it does not skip
authentication. Setting it to `false` does not harden anything — it
returns 404 from the only login route and locks out every user including
the administrator.

What it genuinely lacks, and what you are accepting for a PoC: no MFA, no
password policy, no lockout after failed attempts, and no self-service
reset. `core/auth.js` is written so the customer's IdP (Azure AD via
OIDC) drops in beside it — that provider is scaffolded, not implemented.

**Before this carries real appraisal data for real employees, wire the
IdP.** For a PoC on test data, `AUTH_DEV=true` behind a security group
limited to the customer's own network is a reasonable place to be.

---

## HTTPS

Plain HTTP is fine for a PoC behind a restricted security group. Session
tokens cross the wire, so anything beyond a PoC needs TLS. Two options:

**A DNS name and Let's Encrypt** — simplest when the box is directly
reachable:

```bash
sudo apt-get install -y certbot python3-certbot-nginx   # or: dnf install certbot python3-certbot-nginx
sudo certbot --nginx -d pms.customer.com
```

Certbot edits the installed nginx site in place and installs a renewal
timer. Nothing in the app needs to change: the bundle calls a relative
`/api/v1`, so it follows the scheme it was loaded over.

**An ALB or CloudFront in front** — the usual answer when the instance is
private. Terminate TLS there, forward to port 80. The `X-Forwarded-Proto`
header is already set by the nginx config.

---

## Troubleshooting

**`systemctl status agentic-pms-api` says `failed`, logs show
"Missing required env"** — one of `DATABASE_URL`, `JWT_SECRET`,
`TENANT_SLUG` is absent from `/etc/agentic-pms/api.env`. The app refuses
to start rather than run half-configured.

**Boot dies on a connection error that reads like a bad password** —
`DATABASE_SSL=false` is missing. `core/db.js` turns SSL **on** unless
that variable is the exact string `false`, so the pool tries TLS against
a local Postgres that never offered it. Loopback traffic has nothing for
TLS to protect; set it and restart.

**Every `/api` call returns 502, but nginx looks healthy** — on Amazon
Linux or RHEL this is almost always SELinux blocking nginx from making
outbound connections. `install.sh` sets `httpd_can_network_connect`, but
if it was skipped:

```bash
sudo setsebool -P httpd_can_network_connect 1
```

**The app loads but every API call 404s, or the console shows
`ERR_NAME_NOT_RESOLVED`** — the frontend was built with `VITE_API_URL`
set. On EC2 it must be **unset**: unset makes the bundle call the
relative `/api/v1` that nginx proxies. Set, it bakes an absolute
`https://<value>/api/v1` into the JavaScript. Rebuild without it.

**A hard refresh on `/admin/cycles` returns 404 but clicking there
works** — the SPA fallback is missing. Clicking never makes an HTTP
request (react-router handles it in the browser); a refresh does. Both
nginx configs here have the `try_files ... /index.html` rewrite; check
the right site is enabled and that Debian's default site was removed.

**Uploads fail with a bare 413** — nginx's `client_max_body_size`. Both
configs set 12m, above the app's own 10 MB ceiling, so the app is the
thing that says no. If you replaced the config, put it back.

**The frontend build is "Killed"** — out of memory. See sizing above.

**`docker compose up` fails on the build** — check the Docker daemon has
disk (`docker system df`). Note the old `deploy/docker-compose.yml`
never worked: it declared `build: ../server` when no Dockerfile existed.
It has been replaced by `deploy/docker/docker-compose.yml`.

---

## What is deliberately not here

* **No autoscaling, no second instance.** The reminder sweeps run
  in-process on a 24-hour interval (`server/index.js`), so a second
  instance would run them twice. They are ledger-gated and would not
  actually double-send, but the design is one instance per tenant and
  the deployment reflects that.
* **No secrets in this repo.** `.env` and `/etc/agentic-pms/api.env` are
  generated on the box and git-ignored. This repository is public.
* **No CI/CD.** `update.sh` (or `docker compose up -d --build`) run by
  hand is the deployment mechanism, deliberately: a PoC that redeploys
  itself on a push is a PoC that changes under the customer mid-demo.

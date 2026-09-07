#!/usr/bin/env bash
# ============================================================================
# Agentic PMS — one-shot installer for a standalone EC2 instance.
#
#   sudo TENANT_SLUG=acme bash deploy/service/install.sh
#
# Installs and wires up, on this one box:
#   * Node.js 22            (NodeSource)
#   * PostgreSQL 16         (PGDG on Debian/Ubuntu, distro repo on AL/RHEL)
#   * nginx                 (serves the React bundle, proxies /api)
#   * agentic-pms-api       (systemd service, unprivileged user)
#   * agentic-pms-backup    (systemd timer, nightly pg_dump + retention)
#
# SAFE TO RE-RUN. It is the upgrade path as well as the install path: it
# never regenerates secrets that already exist, never drops the database,
# and never overwrites /etc/agentic-pms/api.env. Re-running after a
# `git pull` rebuilds and restarts — that is what update.sh does.
#
# Supported: Ubuntu 22.04/24.04, Debian 12, Amazon Linux 2023, RHEL 9 and
# derivatives. Needs outbound HTTPS to the distro repos, NodeSource,
# PGDG and the npm registry — an instance in a private subnet needs a NAT
# gateway or those hosts mirrored internally.
# ============================================================================
set -euo pipefail

APP_USER=apms
APP_DIR=/opt/agentic-pms
WEB_ROOT=/var/www/agentic-pms
ENV_DIR=/etc/agentic-pms
ENV_FILE="${ENV_DIR}/api.env"
BACKUP_DIR=/var/backups/agentic-pms
PG_MAJOR="${PG_MAJOR:-16}"
DB_NAME="${DB_NAME:-apms}"
DB_USER="${DB_USER:-apms}"

# The checkout this script is being run from — resolved rather than
# assumed, so the installer works whether the repo was cloned to
# /home/ec2-user/Mindgate-PMS, /opt/agentic-pms, or anywhere else.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo TENANT_SLUG=... bash $0"
[ -f "${SRC_DIR}/server/index.js" ] || die "Cannot find the app at ${SRC_DIR} — run this from inside the repo checkout."

# ---------------------------------------------------------------------------
# 0. Work out what we are installing on
# ---------------------------------------------------------------------------
. /etc/os-release
case "${ID}${ID_LIKE:-}" in
  *debian*|ubuntu*) PKG=apt ;;
  *rhel*|*fedora*|amzn*) PKG=dnf ;;
  *) die "Unsupported distribution: ${PRETTY_NAME}. Use the Docker path (deploy/docker) instead." ;;
esac
say "Installing Agentic PMS on ${PRETTY_NAME} (package manager: ${PKG})"

# Vite's production build is the single most memory-hungry step here and
# it is what falls over first on a 1 GB t3.micro — with no useful error,
# just "Killed" from the OOM killer partway through the bundle. A swap
# file is not a substitute for RAM, but it is the difference between the
# build finishing slowly and the build not finishing at all.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 1900 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  warn "Only ${MEM_MB} MB RAM and no swap — the frontend build will likely be OOM-killed."
  say "Creating a 2 GB swap file at /swapfile"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  warn "Swap added, but t3.small (2 GB) or larger is the right answer for this box."
fi

# ---------------------------------------------------------------------------
# 1. Packages
# ---------------------------------------------------------------------------
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  # unattended-upgrades runs by default on Ubuntu AMIs and holds the dpkg
  # lock for minutes at a time. Without a lock timeout, apt-get fails
  # instantly with "Could not get lock /var/lib/dpkg/lock-frontend" and the
  # whole install aborts on a condition that would have cleared itself.
  APT="apt-get -o DPkg::Lock::Timeout=600"
  $APT update -qq
  $APT install -y -qq curl ca-certificates gnupg rsync nginx openssl

  if ! node --version 2>/dev/null | grep -q '^v22\.'; then
    say "Installing Node.js 22 from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_22.x" | bash - >/dev/null
    $APT install -y -qq nodejs
  fi

  if ! command -v psql >/dev/null 2>&1; then
    say "Installing PostgreSQL ${PG_MAJOR} from PGDG"
    # Ubuntu 22.04 and Debian 12 ship Postgres 14 and 15 respectively, so
    # the distro repo alone cannot give a consistent version across the
    # supported releases. PGDG can, which matters because the version the
    # customer runs should be the version this was tested against.
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    $APT update -qq
    $APT install -y -qq "postgresql-${PG_MAJOR}"
  fi
  PG_SERVICE=postgresql
else
  dnf install -y -q rsync nginx openssl >/dev/null

  if ! node --version 2>/dev/null | grep -q '^v22\.'; then
    say "Installing Node.js 22 from NodeSource"
    curl -fsSL "https://rpm.nodesource.com/setup_22.x" | bash - >/dev/null
    dnf install -y -q nodejs >/dev/null
  fi

  if ! command -v psql >/dev/null 2>&1; then
    say "Installing PostgreSQL ${PG_MAJOR}"
    dnf install -y -q "postgresql${PG_MAJOR}-server" "postgresql${PG_MAJOR}" >/dev/null \
      || die "postgresql${PG_MAJOR}-server is not available on this release. Re-run with PG_MAJOR=15."
    # Unlike Debian packaging, the RPMs do not create a cluster for you.
    [ -f /var/lib/pgsql/data/PG_VERSION ] || /usr/bin/postgresql-setup --initdb
  fi
  PG_SERVICE=postgresql
fi

systemctl enable --now "$PG_SERVICE"
systemctl enable nginx

# ---------------------------------------------------------------------------
# 2. Database role, database and host-based auth
# ---------------------------------------------------------------------------
say "Configuring PostgreSQL"

# The app connects over TCP to 127.0.0.1 with a password (that is the
# shape of DATABASE_URL). Debian's default pg_hba already allows
# scram-sha-256 there; the RPM default is `ident`, which rejects the
# connection with a message about the postgres user that has nothing
# obvious to do with the real cause. Normalise both.
HBA="$(sudo -u postgres psql -tAc 'SHOW hba_file')"
if ! grep -qE '^\s*host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256' "$HBA"; then
  cp "$HBA" "${HBA}.apms.bak.$(date +%s)"
  sed -i -E 's|^(\s*host\s+all\s+all\s+127\.0\.0\.1/32\s+)(ident|trust|peer|md5|password)\s*$|\1scram-sha-256|' "$HBA"
  grep -qE '^\s*host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256' "$HBA" \
    || echo "host    all             all             127.0.0.1/32            scram-sha-256" >> "$HBA"
  systemctl reload "$PG_SERVICE"
fi

# Re-running must not change a password the running service is already
# using, so the existing env file is the source of truth when there is one.
DB_PASS=""
if [ -f "$ENV_FILE" ]; then
  DB_PASS="$(sed -n 's|^DATABASE_URL=postgres://[^:]*:\([^@]*\)@.*|\1|p' "$ENV_FILE")"
  [ -n "$DB_PASS" ] && say "Reusing the database password already in ${ENV_FILE}"
fi
if [ -z "$DB_PASS" ]; then
  # Alphanumeric only, on purpose: this value is embedded in a URL, and a
  # generated '/' or '@' silently truncates DATABASE_URL into something
  # that fails with a confusing "role does not exist".
  DB_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
fi

if [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")" = "1" ]; then
  sudo -u postgres psql -qc "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}'" >/dev/null
else
  sudo -u postgres psql -qc "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}'" >/dev/null
fi
if [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" != "1" ]; then
  # Owned by the app role so it can CREATE SCHEMA — the migrations build
  # core, pms, people, engagement and agentic, and PostgreSQL 15+ no
  # longer lets a non-owner do that in a fresh database.
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
  say "Created database '${DB_NAME}' owned by '${DB_USER}'"
fi

# ---------------------------------------------------------------------------
# 3. Application user and files
# ---------------------------------------------------------------------------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER" \
  || useradd --system --create-home --shell /sbin/nologin "$APP_USER"

say "Installing the application to ${APP_DIR}"
mkdir -p "$APP_DIR"
# --delete keeps the target an exact copy of the checkout so a file
# removed upstream does not linger and get served or required. The
# excludes stop us copying a build machine's node_modules over the
# target's, which is how you get a native module built for the wrong
# libc silently in place.
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'frontend/dist' \
  "${SRC_DIR}/" "${APP_DIR}/"

say "Installing server dependencies"
# `npm ci` not `npm install`: it installs exactly the committed lockfile,
# so the customer's box runs the dependency tree that was tested rather
# than whatever floated in since.
(cd "${APP_DIR}/server" && npm ci --omit=dev --no-audit --no-fund)

say "Building the frontend"
# VITE_API_URL IS DELIBERATELY UNSET. Unset makes the bundle call the
# relative '/api/v1', which nginx proxies to the API on loopback. Setting
# it would bake an absolute https:// URL into the JavaScript (see
# frontend/src/utils/api.jsx) — wrong on a plain-HTTP PoC box, and a
# rebuild rather than a reload every time the hostname changes.
(cd "${APP_DIR}/frontend" && unset VITE_API_URL && npm ci --no-audit --no-fund && npm run build)

mkdir -p "$WEB_ROOT"
rsync -a --delete "${APP_DIR}/frontend/dist/" "${WEB_ROOT}/"
chown -R root:root "$WEB_ROOT"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/server"

# ---------------------------------------------------------------------------
# 4. Environment file
# ---------------------------------------------------------------------------
mkdir -p "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  say "Keeping the existing ${ENV_FILE} (secrets preserved)"
else
  [ -n "${TENANT_SLUG:-}" ] || die "TENANT_SLUG is required on a first install.
  It names this tenant and is stamped onto every row on first boot, so it must
  be chosen deliberately and never changed afterwards. Re-run as:
      sudo TENANT_SLUG=<customer-short-name> bash $0"

  say "Writing ${ENV_FILE}"
  cat > "$ENV_FILE" <<ENVEOF
# Agentic PMS — service environment. Read by systemd, root:${APP_USER} 0640.
# Generated by deploy/service/install.sh on $(date -u +%FT%TZ).
# Re-running the installer will NOT overwrite this file.

DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}

# REQUIRED for a local Postgres. core/db.js turns SSL ON unless this is
# the exact string "false", so omitting it makes the pool attempt TLS
# against a server that never offered it and the boot dies on an error
# that reads like a bad password. The connection never leaves loopback,
# so there is nothing for TLS to protect here.
DATABASE_SSL=false

# Signs session tokens. Rotating it logs everyone out — which is the
# correct response if it ever leaks.
JWT_SECRET=$(openssl rand -hex 32)

# Names this tenant. SET ONCE: it is resolved to a tenant id on first
# boot and stamped onto every row, so changing it later does not rename
# anything — it resolves to a DIFFERENT, empty tenant while the real data
# stays behind under the old slug.
TENANT_SLUG=${TENANT_SLUG}

# Local email+password login. This is the only login path that exists in
# this build; the OIDC/IdP provider is scaffolded but not implemented, so
# "false" locks out every user including the administrator. See
# "Authentication" in deploy/README.md.
AUTH_DEV=true

# Optional. Empty = no AI: every agentic endpoint returns a clean 503 and
# nothing else in the app changes.
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
AI_MODEL=${AI_MODEL:-claude-opus-5}

PORT=8080
ENVEOF
fi
# 0640 root:apms — the service can read it, no other account on the box can.
chown "root:${APP_USER}" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ---------------------------------------------------------------------------
# 5. systemd + nginx
# ---------------------------------------------------------------------------
say "Installing the systemd units and the nginx site"
install -m 644 "${APP_DIR}/deploy/service/agentic-pms-api.service"    /etc/systemd/system/
install -m 644 "${APP_DIR}/deploy/service/agentic-pms-backup.service" /etc/systemd/system/
install -m 644 "${APP_DIR}/deploy/service/agentic-pms-backup.timer"   /etc/systemd/system/
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

if [ -d /etc/nginx/sites-available ]; then
  install -m 644 "${APP_DIR}/deploy/service/nginx.conf" /etc/nginx/sites-available/agentic-pms
  ln -sfn /etc/nginx/sites-available/agentic-pms /etc/nginx/sites-enabled/agentic-pms
  # Debian's packaged default site is also `default_server` on :80, and
  # two of those is a config error nginx refuses to start on.
  rm -f /etc/nginx/sites-enabled/default
else
  install -m 644 "${APP_DIR}/deploy/service/nginx.conf" /etc/nginx/conf.d/agentic-pms.conf
  # The RPM's stock server{} block in nginx.conf itself also claims :80.
  if grep -qE '^\s*server\s*\{' /etc/nginx/nginx.conf && [ ! -f /etc/nginx/nginx.conf.apms.bak ]; then
    warn "The distro nginx.conf has its own server block on :80."
    warn "If nginx fails to start, comment it out — a backup is at /etc/nginx/nginx.conf.apms.bak"
    cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.apms.bak
  fi
fi

# SELinux (Amazon Linux, RHEL) denies nginx outbound connections by
# default, which shows up as a 502 on every /api call while nginx itself
# looks perfectly healthy — one of the least obvious failures on this box.
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != "Disabled" ]; then
  say "SELinux is enforcing — allowing nginx to proxy to the local API"
  setsebool -P httpd_can_network_connect 1 || warn "setsebool failed; /api may 502 until it is allowed."
fi

nginx -t
systemctl daemon-reload
systemctl enable --now agentic-pms-api
systemctl enable --now agentic-pms-backup.timer
systemctl restart agentic-pms-api
systemctl restart nginx

# ---------------------------------------------------------------------------
# 6. Prove it actually came up
# ---------------------------------------------------------------------------
say "Waiting for the API to answer"
# First boot runs 32 migrations, so this is not instant.
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1/api/v1/health >/dev/null 2>&1; then
    OK=1; break
  fi
  sleep 2
done

if [ "${OK:-0}" != "1" ]; then
  printf '\n\033[1;31mThe API did not answer within two minutes.\033[0m\n'
  echo "Last 40 log lines:"
  journalctl -u agentic-pms-api -n 40 --no-pager || true
  exit 1
fi

IP="$(curl -fsS --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<DONE

============================================================================
 Agentic PMS is running.

   URL          http://${IP}/
   Health       http://${IP}/api/v1/health
   Service      systemctl status agentic-pms-api
   Logs         journalctl -u agentic-pms-api -f
   Config       ${ENV_FILE}      (root:${APP_USER} 0640)
   Backups      ${BACKUP_DIR}    (nightly 02:15, 14-day retention)

 NEXT: create the first administrator. The endpoint is unauthenticated and
 locks itself the moment any employee exists, so do it now, not later:

   curl -X POST http://${IP}/api/v1/setup/bootstrap-admin \\
     -H 'Content-Type: application/json' \\
     -d '{"email":"hr.admin@customer.com","name":"HR Admin","password":"<a strong password>"}'

 Then follow section 4 of DEPLOY.md for employees, roles and the first cycle.
============================================================================
DONE

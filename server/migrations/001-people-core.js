// 001 — People Core schema. Every table carries tenant_id (finalised
// decision #1: dedicated instances now, tenant_id discipline so SaaS stays
// open). Idempotent throughout: a crashed boot may re-run this.
//
// The employees table is a MIRROR of the client's HRMS, loaded via the CSV
// importer — never dual-maintained. Its column list is the mechanical
// inventory of what the lifted modules actually read, not a guess.

module.exports.up = async (db) => {
  await db.query(`CREATE SCHEMA IF NOT EXISTS core`);

  await db.query(`CREATE TABLE IF NOT EXISTS core.tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,
    settings    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
  )`);

  // Employee mirror. Fields per the AH module inventory (94 read sites).
  await db.query(`CREATE TABLE IF NOT EXISTS core.employees (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    emp_code      text,
    name          text NOT NULL,
    email         text NOT NULL,
    department    text,
    designation   text,
    role_band     text,
    manager_id    uuid REFERENCES core.employees(id),
    date_of_joining date,
    status        text NOT NULL DEFAULT 'active',      -- active | inactive
    -- optional rating mirror (written on publish; the HRMS write-back set)
    last_appraisal_rating   text,
    last_appraisal_cycle_id uuid,
    last_appraisal_at       timestamptz,
    potential_rating        text,
    nine_box_cell           text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_employees_tenant ON core.employees(tenant_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_employees_manager ON core.employees(manager_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS core.department_heads (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id),
    department  text NOT NULL,
    employee_id uuid NOT NULL REFERENCES core.employees(id),
    PRIMARY KEY (tenant_id, department)
  )`);

  // ---- Access control: the table-driven design ported whole from AH ----
  await db.query(`CREATE TABLE IF NOT EXISTS core.role_permissions (
    tenant_id  uuid NOT NULL,
    role       text NOT NULL,
    permission text NOT NULL,
    PRIMARY KEY (tenant_id, role, permission)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS core.user_permissions (
    tenant_id  uuid NOT NULL,
    email      text NOT NULL,
    permission text NOT NULL,
    PRIMARY KEY (tenant_id, email, permission)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS core.user_roles (
    tenant_id  uuid NOT NULL,
    email      text NOT NULL,
    role       text NOT NULL,
    PRIMARY KEY (tenant_id, email)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS core.page_permission (
    tenant_id           uuid NOT NULL,
    page                text NOT NULL,
    route               text,
    required_permission text,          -- NULL = public: register consciously
    PRIMARY KEY (tenant_id, page)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS core.route_permission (
    tenant_id           uuid NOT NULL,
    method              text NOT NULL DEFAULT '*',
    path_pattern        text NOT NULL,
    required_permission text NOT NULL,
    enforced            boolean NOT NULL DEFAULT false,  -- log-only first; promote after a clean window
    note                text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, method, path_pattern)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS core.api_denial_log (
    id         bigserial PRIMARY KEY,
    tenant_id  uuid,
    at         timestamptz NOT NULL DEFAULT now(),
    email      text, method text, path text,
    needed     text, enforced boolean
  )`);

  // ---- Notifications, settings, audit ----
  await db.query(`CREATE TABLE IF NOT EXISTS core.notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    employee_id uuid REFERENCES core.employees(id),
    kind       text NOT NULL,
    title      text NOT NULL,
    body       text,
    link       text,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_notif_emp ON core.notifications(employee_id, read_at)`);

  await db.query(`CREATE TABLE IF NOT EXISTS core.admin_settings (
    tenant_id uuid NOT NULL,
    key       text NOT NULL,
    value     jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS core.audit_log (
    id         bigserial PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    at         timestamptz NOT NULL DEFAULT now(),
    actor_email text,
    action     text NOT NULL,
    entity     text, entity_id text,
    details    jsonb
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_tenant_at ON core.audit_log(tenant_id, at DESC)`);

  // ---- Local auth (dev + break-glass; production auth is the client's IdP) ----
  await db.query(`CREATE TABLE IF NOT EXISTS core.local_credentials (
    tenant_id uuid NOT NULL,
    email     text NOT NULL,
    password_hash text NOT NULL,
    PRIMARY KEY (tenant_id, email)
  )`);
};

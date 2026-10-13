// HR's Events & CSR page (13 Oct: "apart from awards, there is no option
// for HR to start Events from HR Admin tab"). People Hub has always shown
// events and CSR activities, and the server could always create them, but
// no screen did, so People Hub said "No events scheduled." for good.
//
// One row drives both the HR menu entry and who may open the URL. HR and
// Super Admin hold people_admin; an HRBP does not, and the HRBP gateway
// refuses these writes for them anyway.
const PAGES = [
  ['events_admin', '/admin/events', 'people_admin'],
];

// Also called at boot — a migration cannot seed a tenant created after it
// runs (see 069 and fresh-tenant-bootstrap.test.js).
async function ensureEventPages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`,
      [tenantId, page, route, perm]);
  }
}

async function up(db) {
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    for (const [page, route, perm] of PAGES) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, page) DO UPDATE SET route=EXCLUDED.route,
           required_permission=EXCLUDED.required_permission`, [id, page, route, perm]);
    }
  }
}

module.exports = { up, ensureEventPages, PAGES };

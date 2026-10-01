// Re-seed the survey library so the external-review template lands.
//
// seedTemplates() only inserts what is missing, so this adds the new row
// and leaves every template a tenant has edited exactly as they edited it
// — the rule the library has had since 056.
const { seedTemplates } = require('./056-survey-templates');

async function up(db) {
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await seedTemplates(db, id);
  }
}
module.exports = { up };

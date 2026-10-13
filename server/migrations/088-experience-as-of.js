// WHEN an experience figure was true (13 Oct). The Aspiring Career
// Expected timeline is what is left of a move after the employee's total
// experience, and the client asked for it from their CURRENT experience.
// A figure with no date never counts down: "12 months left" in October
// would still say 12 a year later. So each figure carries the day it was
// recorded, and the time since is added when it is read:
//
//   core.employees.total_experience_as_of    set by the HRMS import
//                                           whenever it brings a figure
//   people.career_paths.years_experience_as_of set when the employee
//                                           changes the years they typed
//
// Existing figures are dated today (HRMS: none was read before 13 Oct)
// or from the row's last update (typed years), the best that is known.
async function up(db) {
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS total_experience_as_of timestamptz`);
  await db.query(`UPDATE core.employees SET total_experience_as_of = now()
                   WHERE total_experience_years IS NOT NULL AND total_experience_as_of IS NULL`);
  await db.query(`ALTER TABLE people.career_paths ADD COLUMN IF NOT EXISTS years_experience_as_of timestamptz`);
  await db.query(`UPDATE people.career_paths SET years_experience_as_of = COALESCE(updated_at, now())
                   WHERE years_experience IS NOT NULL AND years_experience_as_of IS NULL`);
}
module.exports = { up };

// 016 — Career Path expected timeline (BR-3.1).
//
// FOUND MISSING: employees could set a target role and a growth plan
// narrative, but nowhere to say WHEN they expect to get there. Free text
// (e.g. "12-18 months", "2-3 years") rather than a rigid date — career
// timelines are ranges people reason about, not fixed deadlines, and this
// matches how the BRD's own reference mockups phrase it ("Target: 12-18
// months") for career-ladder steps.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE people.career_paths ADD COLUMN IF NOT EXISTS target_timeline text`);
};

// 046 — the two questions the Aspiring Career form now asks.
//
// Asked for on 23 Sep: "aspiring career should have two open questions,
// 1. total no of years, 2. your skill sets and interests, and based on
// these two AI should suggest benchmark, competencies, whether they are
// eligible for this position or not."
//
// WHY THESE TWO ARE STORED RATHER THAN ASKED EACH TIME. An eligibility
// read is only as good as what it was given, and an employee should not
// have to retype their experience every time they want one. Storing them
// also means the ANSWER can be re-derived later against a changed matrix
// and compared with what was said before.
//
// years_experience is TOTAL professional experience, which is not
// date_of_joining: that is tenure at this company, and someone who
// joined last year may have fifteen years behind them. The employee is
// the only reliable source for it, which is why it is a question.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE people.career_paths
                    ADD COLUMN IF NOT EXISTS years_experience numeric(4,1)`);
  await db.query(`ALTER TABLE people.career_paths
                    ADD COLUMN IF NOT EXISTS skills_interests text`);
};

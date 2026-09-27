// Making somebody change the password HR chose for them.
//
// Asked for on 27 Sep, alongside the bulk-credentials run: "the password
// for all employees will be their name@123 and during login everyone
// should get change password option during first login." Compulsory, on
// the client's own answer when asked.
//
// The two halves belong together. A password built from a published
// pattern — first name, then @123 — is one any colleague can guess, and
// on this master 23 people would share akshay@123. That is acceptable
// only because it is a one-use password: this flag is what makes it one.
//
// FALSE BY DEFAULT and NOT backfilled. The accounts that already exist
// chose or were given their passwords before this rule, and flipping
// them all would lock out the client's own admin at the worst possible
// moment. It is set going forward, by the places where HR sets a
// password on somebody else's behalf — which is every place a password
// is set at all, until there is an IdP.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE core.local_credentials
    ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`);
};

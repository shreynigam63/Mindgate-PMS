// A survey nobody takes.
//
// The external-review template says in its own description that nobody
// answers it — it is filled by importing a spreadsheet. Opening one
// nonetheless invited all 1,427 employees on the client's instance,
// because Open has always meant "work out the audience and invite it"
// and nothing told it this survey has no audience. I did that, in the
// course of taking a screenshot, and the invitations and notifications
// had to be deleted by hand.
//
// A description is not a control. This makes it one: a survey marked
// import_only opens so its results can be read, and invites nobody. The
// flag lives on the template and is copied onto the survey, so a client
// who builds their own import-only template gets the same protection
// without a second code change.
async function up(db) {
  for (const t of ['engagement.survey_templates', 'engagement.surveys']) {
    await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS import_only boolean NOT NULL DEFAULT false`);
  }
  await db.query(
    `UPDATE engagement.survey_templates SET import_only=true WHERE key='external_review'`);
  // Surveys already created from it — including the one on the PoC box.
  await db.query(
    `UPDATE engagement.surveys SET import_only=true WHERE template_key='external_review'`);
  // And the invitations that should never have existed. Nobody can
  // answer an import-only survey, so an invitation to one is a row that
  // only ever produces a reminder for something that cannot be done.
  await db.query(
    `DELETE FROM engagement.invitations WHERE survey_id IN
       (SELECT id FROM engagement.surveys WHERE import_only AND completed_at IS NULL)`)
    .catch(async () => {
      await db.query(
        `DELETE FROM engagement.invitations i USING engagement.surveys s
          WHERE i.survey_id = s.id AND s.import_only AND i.completed_at IS NULL`);
    });
}
module.exports = { up };

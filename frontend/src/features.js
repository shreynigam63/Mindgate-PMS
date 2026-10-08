// Screen-level switches. Each hides a feature on the FRONT END only —
// its tables, API routes and data stay exactly as they are, so turning it
// back on is this one line and a deploy.
//
// FIRST-WEEK JOURNEY (the onboarding tracker): hidden on 8 Oct ("please
// hide first week journey page from new hire insights on front end and
// keep the same in database so we can use it anytime we need"). Off, it
// takes away: the First-Week Journey tab on New Hire Insights, the HR Ops
// menu entry, and the "Onboarding emails for you to send" card on Home.
export const SHOW_FIRST_WEEK_JOURNEY = false;

// RNR DASHBOARD and MY NOMINATIONS: off since 8 Oct. Both showed every
// nominee in the company to anyone who typed the address ("it should not
// be visible currently, in future if we want we will allow this display
// access"). The server refuses the company-wide list too, unless a role
// is granted rnr_view_all — see server/migrations/086-rnr-dashboard-off.js
// for everything that turning it back on takes.
export const SHOW_RNR_DASHBOARD = false;

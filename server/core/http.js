// Shared HTTP request guards — core.
//
// WHY THIS EXISTS: every id in this schema is a uuid, and Postgres
// rejects a malformed one by throwing. Handlers pass req.params straight
// into a query, so a request like GET /consent/status (no /status route
// exists, so it matches /:employeeId) reached the database as an
// employee_id of "status" and came back as:
//
//   HTTP 500 {"error":"invalid input syntax for type uuid: \"status\""}
//
// Two problems in one response. It is a 500 for what is plainly a bad
// request, so it reads as "the server is broken" in logs and monitoring
// rather than "the caller sent nonsense". And it hands the caller a raw
// driver message, disclosing the backing store and the column's type for
// free. Found by exercising the API against a live deploy; it affected
// every route taking a uuid path param, not one endpoint.
//
// Enforced with router.param() rather than a router.use() middleware:
// route params are not populated until a route matches, so a use()
// middleware sees an empty req.params and cannot check anything. A
// param callback runs exactly when a matched route binds that name,
// which is the only hook that can do this generically.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Path params that are uuids. Verified against migrations/ rather than
// assumed: every table reachable by one of these has `id uuid`. The only
// integer keys in the schema (core.audit_log, pms.audit_log,
// core.api_denial_log — all bigserial) are read as lists and never
// addressed by id in a route, so none of them appear here.
//
// DELIBERATELY ABSENT: :department (core/employees.js's
// /department-heads/:department), which carries a department NAME like
// "Engineering". Adding it here would 400 every valid call to that
// route. Any future param that is not a uuid must likewise stay out.
const UUID_PARAMS = ['employeeId', 'cycleId', 'sheetId', 'planId', 'goalId', 'itemId', 'driveId', 'id'];

// "me" is a real value in this API, not a malformed uuid: routes such as
// GET /pms/closure-letters/me/:cycleId/download let a caller name
// themselves without first having to look up their own employee id, and
// resolve it from req.user. The first version of this guard rejected it
// with 400 and broke that download — caught by the test that covers it.
//
// Allowed as a SENTINEL, not as a general escape hatch: it is passed
// through untouched, and every handler that accepts it already maps it to
// req.user.id before any query. A handler that does not recognise "me"
// still receives the literal string and would fail its own lookup, which
// is a 404 about a row that does not exist rather than a database error
// about a malformed uuid — the thing this guard exists to prevent.
const SELF_PARAM = 'me';

// Rejects a malformed uuid path param with 400 before it can reach a
// query. Registering a name a router never uses is harmless, so every
// router can take the same list.
function guardUuidParams(router, names = UUID_PARAMS) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (UUID_RE.test(value) || value === SELF_PARAM) return next();
      // Names the offending param without echoing the value back, so a
      // reflected-value payload cannot ride out in an error body.
      return res.status(400).json({ error: `${name} is not a valid id` });
    });
  }
}

module.exports = { UUID_RE, UUID_PARAMS, SELF_PARAM, guardUuidParams };

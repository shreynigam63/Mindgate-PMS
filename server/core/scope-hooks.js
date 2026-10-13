// Where a module can narrow what a CORE router returns.
//
// The house rule is that modules import core and core never imports a
// module, and it is a rule worth keeping — it is the thing that stops the
// dependency graph becoming a knot. But the employee directory lives in
// core, and the HRBP gateway that narrows it lives in the performance
// module, so the narrowing has to reach across that line somehow.
//
// It reaches across by inversion: core runs whatever is registered here,
// and the module registers itself when it loads. The dependency still
// points from the module into core, which is the direction the rule
// requires, and core stays ignorant of what a remit is.
//
// Registration order does not matter — `run()` reads the list per
// request, so a module loaded after a core router was built still takes
// effect.

const hooks = [];

/** Called by a module at load time. */
function register(fn) { hooks.push(fn); }

/** Mounted by a core router, directly after authenticate. */
function run() {
  return function scopeHooks(req, res, next) {
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      if (i >= hooks.length) return next();
      const fn = hooks[i]; i += 1;
      return fn(req, res, step);
    };
    return step();
  };
}

/**
 * The rows of a file download this request may see. A hook narrows a JSON
 * body after the handler has built it, but a spreadsheet is bytes by
 * then, so a handler that builds one passes its rows through here first.
 * A hook that narrows a request says whom it may see in req.remitVisible
 * (a Set of employee ids); rows that name nobody are left out with the
 * rest. Until 13 Oct an HRBP's Employees, Completion and Calibration
 * downloads covered the whole company, salaries included.
 */
function visibleRows(req, rows, key = 'employee_id') {
  const visible = req && req.remitVisible;
  if (!visible) return rows;
  return rows.filter((r) => r && visible.has(r[key]));
}

module.exports = { register, run, hooks, visibleRows };

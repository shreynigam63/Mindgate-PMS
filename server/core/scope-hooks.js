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

module.exports = { register, run, hooks };

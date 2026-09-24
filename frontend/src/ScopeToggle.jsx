// "My reports" / "All employees", on the Manager tab's five lists.
//
// Asked for on 24 Sep: "Team KRA sheets, Team Evaluation and Team Mid-Year
// in Manager tab should have only names of reportees reporting to him and
// not all employees."
//
// Those lists used to open on the whole company for anyone holding
// pms_admin, which was itself asked for on 18 Sep ("super admin ... should
// be able to approve at all levels for any employees including their own").
// Both asks are real, so this keeps both: the lists now DEFAULT to the
// caller's own reports, and an admin can still widen them.
//
// A PLAIN MANAGER NEVER SEES THIS CONTROL. The server decides — it returns
// can_see_all only for pms_admin, and ignores ?scope=all from anyone else,
// so this is a convenience on top of the gate, never the gate itself.
export default function ScopeToggle({ data, value, onChange }) {
  if (!data || !data.can_see_all) return null;
  // aria-pressed, not just a colour: this is a two-state control and the
  // selected one has to be announced, not only shown. It is also the only
  // thing a test can read the state from — the class is styling.
  const btn = (key, label, title) => (
    <button type="button" title={title} aria-pressed={value === key}
      onClick={() => onChange(key)}
      className={`chip ${value === key
        ? 'bg-white text-navy-800'
        : 'bg-white/20 text-white hover:bg-white/30'}`}>
      {label}
    </button>
  );
  return (
    <span className="flex items-center gap-1">
      {btn('mine', 'My reports', 'Only the people who report to you')}
      {btn('all', 'All employees', 'Every employee — you hold super admin, so you can act at any level for any of them')}
    </span>
  );
}

// The query suffix for the current choice. Kept beside the control so a
// page cannot render one and fetch the other.
export const scopeParam = (value) => (value === 'all' ? '?scope=all' : '');

// The two views of one person's timesheet: compliance, and KRA coverage.
//
// Phase 3 of the Zoho timesheet rating engine. One control, used on all
// three Timesheet tabs, so "Compliance" and "KRA coverage" mean the
// same thing and sit in the same place for an employee, their manager
// and HR.
//
// COMPLIANCE STAYS THE DEFAULT. It is the view that has been there
// since 25 Sep and the one that works for everybody; KRA coverage needs
// a KRA sheet, which 1,338 of the client's 1,427 people do not have.
// Opening on a view that says "nothing to show" for most of the company
// would read as the product being broken.
export default function TimesheetTabs({ value, onChange }) {
  const tabs = [
    ['compliance', 'Compliance'],
    ['kra', 'KRA coverage'],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map(([key, label]) => (
        <button key={key} type="button" onClick={() => onChange(key)}
          className={`chip px-3 py-1.5 transition-colors ${key === value
            ? 'bg-navy-700 text-white'
            : 'bg-white text-navy-500 border border-navy-100 hover:bg-navy-50'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

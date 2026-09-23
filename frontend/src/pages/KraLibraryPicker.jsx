import { useEffect, useState } from 'react';
import { Library } from 'lucide-react';
import { api } from '../utils/api';
import { AiModal } from './AiDraftPanel';

// "Choose from library" — the shelf of KRAs HR published for a role, as a
// pick list the employee (or their manager) adds from.
//
// WHY A PICKER RATHER THAN AUTO-FILLING THE SHEET. HR could push a role's
// KRAs straight onto everyone's sheet — the bulk importer already does
// exactly that, keyed by employee. This exists because the shelf is a
// MENU: it deliberately offers more than 100 points' worth, and which
// hundred applies is the employee's call with their manager. Auto-filling
// would turn a starting point into an instruction and quietly remove the
// conversation the phase exists for.
//
// Used from two places with different subjects: an employee picking their
// own, and a manager or HR filling a sheet on someone's behalf. `source`
// is the endpoint, so the caller decides whose shelf this is — a manager
// must see their REPORT's designation, never their own.
// Thousands grouping. The company-wide total runs to four figures on a
// tenant this size, and "1656 KRAs" reads as a reference number rather
// than a count.
const num = (n) => Number(n).toLocaleString('en-IN');

export default function KraLibraryPicker({ source, onAdd, disabled = false }) {
  const [state, setState] = useState(null);   // null until loaded
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState({});
  const [err, setErr] = useState(null);
  // null = show me whatever the matching rule picks. A string (including
  // '') is a deliberate choice from the dropdown, and '' means the
  // company-wide shelf — which is why this is not just a falsy check.
  const [dept, setDept] = useState(null);

  useEffect(() => {
    let live = true;
    const url = dept === null ? source
      : `${source}${source.includes('?') ? '&' : '?'}department=${encodeURIComponent(dept)}`;
    api(url)
      .then((d) => { if (live) setState(d); })
      // A shelf that fails to load must not take the KRA page down with
      // it — the page's actual job is editing KRAs, and this is an
      // optional shortcut on top of that.
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [source, dept]);

  if (err) return <p className="text-[11px] text-rose-500">KRA library unavailable: {err}</p>;
  if (!state) return null;

  // The two honest empty states. Neither is an error, and neither should
  // look like one — but they have different fixes, so they say different
  // things rather than sharing a vague "nothing here".
  if (state.reason === 'no_designation') {
    return (
      <p className="text-[11px] text-navy-400">
        Your record has no designation set, so there is no role library to offer. Ask HR to add
        it — then your role's suggested KRAs will appear here.
      </p>
    );
  }
  if (state.reason === 'no_library') {
    return (
      <p className="text-[11px] text-navy-400">
        No KRA library has been published for <b>{state.designation}</b>
        {state.scope === 'department+designation' && state.department && <> in <b>{state.department}</b></>} yet.
        Write your KRAs below, or ask HR to publish a set for your role.
      </p>
    );
  }

  // WHICH SHELF THIS IS. With department matching on, one job title can
  // have several shelves, and the employee should not have to guess which
  // one they are looking at — "Manager" in Development and "Manager" in
  // Human Resources are different lists with the same name.
  //
  // Silent when matching is off, because then there is only ever one shelf
  // per title and naming it would be noise.
  const deptScoped = state.matched_scope === 'department' && state.matched_department;
  // Which department the line underneath should talk about: the one being
  // looked at if the viewer chose one, otherwise their own.
  const subject = state.asked_department || state.department;
  const onFallback = state.scope === 'department+designation' && !deptScoped && subject;
  // Choosing a department by hand is not the same as choosing SOMEBODY
  // ELSE'S. Picking your own from the list is the ordinary thing to do, and
  // being told you are "browsing another department" for doing it reads as
  // an accusation of a mistake you did not make.
  const elsewhere = !!state.asked_department && (!state.department
    || state.asked_department.trim().toLowerCase() !== state.department.trim().toLowerCase());
  // The employee's own row out of the department roster. The server
  // still sends every title the department employs — the department total
  // above is the sum of them — but only this one is put on screen.
  const mine = (state.department_designations || []).find((d) => d.mine) || null;
  // What the Department dropdown is currently showing. '' is "All
  // departments", which is a real selection and not a missing one, so the
  // untouched case (null) has to fall back to the server's view rather
  // than be treated as blank.
  const selectedDept = dept === null ? (state.viewing_department || '') : dept;

  const available = state.entries.filter((e) => !e.already_added);
  const chosen = state.entries.filter((e) => picked[e.id] && !e.already_added);
  // Entries already on the sheet have no checkbox, so they are not part of
  // "all" — including them would make the button promise more than it can
  // tick and never reach the all-selected state.
  const allPicked = available.length > 0 && available.every((e) => picked[e.id]);
  const total = chosen.reduce((t, e) => t + (Number(e.suggested_weight) || 0), 0);
  const rounded = Math.round(total * 100) / 100;

  const add = () => {
    onAdd(chosen.map((e) => ({
      title: e.title,
      measures: e.measures || '',
      description: e.description || '',
      category: e.category || '',
      weight: e.suggested_weight == null ? '' : Number(e.suggested_weight),
    })));
    setPicked({});
    setOpen(false);
  };

  return (
    <>
      <div className="card p-3 border-lagoon-300 bg-lagoon-50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[18ch] flex-1">
            <p className="text-xs font-bold text-lagoon-700">
              Start from the {state.designation} KRA library
              {deptScoped && <> · <span className="text-lagoon-600">{state.matched_department}</span></>}
            </p>
            <p className="text-[11px] text-navy-500">
              HR has published <b>{state.entries.length}</b> KRA{state.entries.length === 1 ? '' : 's'} for
              {deptScoped
                ? <> <b>{state.designation}</b> in <b>{state.matched_department}</b></>
                : <> this role</>}
              {available.length !== state.entries.length && `, ${available.length} not yet on this sheet`}.
              {available.length
                ? ' Pick what applies, then adjust the wording and weights.'
                : ' You already have all of them — open it to check the wording and weights against your new role.'}
            </p>
            {/* This title's KRAs are published under more than one
                department and none company-wide, so what is on screen is
                all of them together. Said out loud: presenting a merged
                list as if one department had written it would be a claim
                the data does not support. */}
            {state.served_across_departments && (
              <p className="text-[11px] text-amber2-600 mt-1">
                These are published under more than one department, so all of them are shown
                together. Check which apply to your role before adding.
              </p>
            )}
            {/* Shown whenever department matching is switched on, because
                from that moment "which department's shelf is this?" is a
                real question even if the answer is still "the only one".
                Hidden when matching is off, since the dimension is not in
                play and the dropdown would be furniture. */}
            {state.scope === 'department+designation' && (state.shelves || []).length > 1 && (
              <div className="flex items-center gap-2 mt-2">
                <label className="lbl mb-0" htmlFor="shelf-dept">Department</label>
                <select id="shelf-dept" className="inp !py-1 !text-xs !w-auto"
                  value={dept === null ? (state.viewing_department || '') : dept}
                  onChange={(e) => { setDept(e.target.value); setPicked({}); }}>
                  {/* A department option is about the DEPARTMENT: every KRA
                      served to every job title it employs. The designation
                      control underneath already breaks that down per title,
                      so repeating this title's own count here would say the
                      same thing twice and leave the department dimension
                      unmeasured. The two numbers therefore count different
                      things on purpose — "All departments" is this one job
                      title, a named department is the whole department. */}
                  {state.shelves.map((sh) => (
                    <option key={sh.department || '__all'} value={sh.department || ''}>
                      {sh.department
                        ? `${sh.department} · ${
                            sh.department_kras
                              ? `${num(sh.department_kras)} KRA${sh.department_kras === 1 ? '' : 's'} across ${
                                  sh.department_titles} title${sh.department_titles === 1 ? '' : 's'}`
                              : 'none published'}`
                        // "All departments" is every department added up,
                        // so this line is exactly the sum of the lines
                        // below it. It is NOT what selecting the option
                        // loads — that is still this one job title's
                        // company-wide shelf — for the same reason the
                        // department entries are not: the Designation
                        // control beside them reports that number.
                        : `All departments · ${
                            sh.all_kras
                              ? `${num(sh.all_kras)} KRA${sh.all_kras === 1 ? '' : 's'} across ${
                                  sh.all_departments} department${sh.all_departments === 1 ? '' : 's'}`
                              : 'none published'}`}
                    </option>
                  ))}
                </select>
                {state.chosen_by_hand && elsewhere && (
                  <span className="text-[11px] text-navy-400">Browsing another department's shelf.</span>
                )}
              </div>
            )}

            {/* The employee's OWN designation, and only that one. The
                department's other titles used to be listed here, disabled,
                so the shape of the department was visible; requested
                directly, they are now hidden instead — an employee holds
                one title, and the other nine were nine things they could
                not do. The department total above still accounts for them,
                so nothing has gone missing from the numbers.

                Still a select rather than plain text, so the control keeps
                its shape beside the Department dropdown and has somewhere
                to grow if a second title ever applies to one person.

                It appears only once a specific department is chosen.
                "All departments" is not a department, so there is nothing
                for a designation to be read within — and the row would
                otherwise sit there unchanged whatever the dropdown above
                it said, which is what made it look inert. */}
            {mine && selectedDept && (
              <div className="flex items-center gap-2 mt-2">
                <label className="lbl mb-0" htmlFor="shelf-desig">Designation</label>
                <select id="shelf-desig" className="inp !py-1 !text-xs !w-auto"
                  value={mine.designation} onChange={() => {}}>
                  <option value={mine.designation}>
                    {mine.designation} · {mine.kras} KRA{mine.kras === 1 ? '' : 's'}
                  </option>
                </select>
                <span className="text-[11px] text-navy-400">
                  Your designation in {state.department} — the KRAs below are the ones published
                  for it.
                </span>
              </div>
            )}
            {onFallback && (
              // Not a warning: a company-wide shelf is a legitimate answer,
              // and most roles will only ever have one. It is said out loud
              // so nobody assumes these KRAs were written for their
              // department when they were not.
              <p className="text-[11px] text-navy-400 mt-1">
                These are the company-wide {state.designation} KRAs. {subject} has
                none of its own yet, so this is the list that applies
                {elsewhere ? ' there' : ' to you'}.
              </p>
            )}
          </div>
          {/* Opens whenever a shelf EXISTS, not only when something on it is
              addable. It used to disable itself once every published KRA was
              already on the sheet — technically true, and the wrong answer
              after a role change: the sheet reopens precisely so the employee
              can review it against the NEW role, and the one control that
              shows them that role's shelf was dead, with the only explanation
              in a hover tooltip nobody sees.
              Nothing can be double-added: an entry already on the sheet keeps
              its "Added" chip instead of a checkbox, and the Add button inside
              stays disabled until something is ticked. */}
          <button className="btn-pri !bg-lagoon-700 whitespace-nowrap" disabled={disabled || !state.entries.length}
            title={!state.entries.length ? 'HR has not published any KRAs for this role yet' : ''}
            onClick={() => setOpen(true)}>
            <Library size={13} className="inline mr-1" />
            {available.length ? 'Choose from library' : 'View library'}
          </button>
        </div>
      </div>

      {open && (
        <AiModal title="KRA library" badge={false} onClose={() => setOpen(false)}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* The running total is the reason this footer exists. The
                  sheet must reach exactly 100 to submit, so showing the
                  selection's weight here turns "pick some KRAs, then find
                  out" into one decision made with the number in view. */}
              {/* Over-100 is called out since Select all made it one
                  click away — a shelf is a menu and deliberately offers
                  more than a hundred points, so this is a normal thing to
                  do and then trim, not an error. Adding is still allowed:
                  the weights are editable on the sheet, and the sheet's own
                  submit check is what enforces exactly 100. */}
              <span className="text-[11px] text-navy-500">
                <b>{chosen.length} selected</b>
                {chosen.length > 0 && (
                  <> · <span className={rounded === 100 ? 'text-emerald-600 font-semibold'
                    : rounded > 100 ? 'text-amber-600 font-semibold' : 'text-navy-500'}>{rounded}%</span> of 100
                    {rounded > 100 && <span className="text-amber-600"> — trim the weights after adding</span>}</>
                )}
              </span>
              <div className="flex gap-2">
                <button className="btn-sec" onClick={() => setOpen(false)}>Cancel</button>
                <button className="btn-pri !bg-lagoon-700" disabled={!chosen.length} onClick={add}>
                  Add {chosen.length || ''} KRA{chosen.length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          }>
          <p className="text-[11px] text-navy-400 -mt-1">
            {state.designation} · everything you add stays fully editable.
          </p>
          {!available.length && (
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2">
              Every KRA published for this role is already on your sheet, so there is
              nothing new to tick. This is the list as HR published it — compare the
              wording and the suggested weights against what you have.
            </p>
          )}
          <Shelf entries={state.entries} picked={picked}
            toggle={(id) => setPicked((p) => ({ ...p, [id]: !p[id] }))}
            allPicked={allPicked}
            onSelectAll={() => setPicked(allPicked
              ? {}
              : Object.fromEntries(available.map((e) => [e.id, true])))} />
        </AiModal>
      )}
    </>
  );
}

// Grouped by Parameter, in the order HR published them — the same grouping
// the KRA sheet itself uses, so the picker and the thing it fills read the
// same way round. Order is first appearance, not alphabetical: HR chose it.
function Shelf({ entries, picked, toggle, allPicked, onSelectAll }) {
  const selectable = entries.filter((e) => !e.already_added).length;
  const groups = [];
  const byCat = new Map();
  for (const e of entries) {
    const cat = (e.category || '').trim() || '—';
    if (!byCat.has(cat)) { byCat.set(cat, []); groups.push(cat); }
    byCat.get(cat).push(e);
  }
  return (
    <div className="space-y-1">
      {onSelectAll && selectable > 0 && (
        <div className="flex justify-end">
          <button className="text-[11px] font-semibold text-lagoon-700 hover:text-lagoon-900"
            onClick={onSelectAll}>
            {allPicked ? 'Clear selection' : `Select all ${selectable}`}
          </button>
        </div>
      )}
      {groups.map((cat) => (
        <div key={cat}>
          <p className="text-lagoon-700 font-semibold mt-2 mb-1">{cat === '—' ? 'No parameter' : cat}</p>
          {byCat.get(cat).map((e) => {
            const on = !!picked[e.id];
            return (
              <div key={e.id} className="flex items-start gap-2.5 py-1.5 border-b border-navy-50 last:border-0">
                {/* An entry already on the sheet loses its checkbox rather
                    than keeping a live one that would add a second copy of
                    the same KRA. */}
                {e.already_added ? (
                  <span className="chip bg-emerald-100 text-emerald-700 mt-0.5 shrink-0">Added</span>
                ) : (
                  <input type="checkbox" className="mt-1 shrink-0 accent-lagoon-700 w-3.5 h-3.5"
                    checked={on} onChange={() => toggle(e.id)} aria-label={e.title} />
                )}
                <div className={`flex-1 min-w-0 ${e.already_added ? 'opacity-60' : ''}`}>
                  <p className="font-semibold">{e.title}</p>
                  {e.measures && <p className="text-navy-400 whitespace-pre-line">{e.measures}</p>}
                  {e.description && <p className="text-navy-300">{e.description}</p>}
                </div>
                {e.suggested_weight != null && (
                  <span className="chip bg-navy-50 text-navy-500 shrink-0 whitespace-nowrap">{Number(e.suggested_weight)}%</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

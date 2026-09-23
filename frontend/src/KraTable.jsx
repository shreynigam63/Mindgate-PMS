import { NO_CATEGORY } from './pages/MyKRASheetPage';

// THE ONE KRA TABLE: Parameters · KRAs · KPIs · Weightage.
//
// Asked for on 23 Sep, with the client's own sheet as the reference:
// "KRAs should be under parameters in a single table instead of separate
// with the same parameter displayed separate." Before this, every KRA was
// its own card carrying a parameter chip, so a scorecard with six
// "Project / Process" KRAs printed that label six times and read as a
// flat list of eight unrelated things.
//
// The parameter is therefore ONE MERGED CELL spanning its KRAs, exactly
// as it is on the sheet HR already works from. One component, used by the
// library shelf and by My KRAs in all three of its states, because the
// whole point is that the two pages stop looking like different products.
//
// Cells are render props rather than props-with-data: the library shows
// text and an edit pencil, My KRAs shows inputs, and a read-only sheet
// shows text again. The STRUCTURE is what has to be identical, not the
// contents.

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function paramLabel(cat) {
  return cat === NO_CATEGORY ? 'No parameter set' : cat;
}

export default function KraTable({
  groups,
  renderKra, renderKpi, renderWeight,
  // An extra row at the end of each parameter group — "+ Add a KRA under
  // Financial" on the editable sheet, nothing on a read-only one.
  groupFooter,
  // An extra row at the very end, inside the body — "+ New parameter".
  bodyFooter,
  // The figure in the table footer, and whether it is the good number.
  totalLabel, total, totalOk,
  // Shown under the table. Never a tooltip: these explain a rule.
  legend,
  // Widest content column gets the room. The library's KPI text runs long.
  kpiHeaderNote,
}) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="kratable">
          <thead>
            <tr>
              <th className="kt-p">Parameters</th>
              <th className="kt-k">KRAs</th>
              <th>
                KPIs
                {kpiHeaderNote && <span className="kt-note"> {kpiHeaderNote}</span>}
              </th>
              <th className="kt-w num">Weightage</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const extra = groupFooter ? groupFooter(g) : null;
              // The merged cell has to span the KRA rows AND the group's
              // own footer row, or the "+ Add" row sits outside the
              // parameter it belongs to and the border breaks.
              const span = g.rows.length + (extra ? 1 : 0);
              return (
                <GroupRows key={g.cat} g={g} span={span} extra={extra}
                  renderKra={renderKra} renderKpi={renderKpi} renderWeight={renderWeight} />
              );
            })}
            {bodyFooter}
          </tbody>
          {total != null && (
            <tfoot>
              <tr>
                <td colSpan={3}>{totalLabel}</td>
                <td className={`num ${totalOk ? 'kt-ok' : 'kt-bad'}`}>{round(total)}%</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {legend && <div className="kt-legend">{legend}</div>}
    </div>
  );
}

function GroupRows({ g, span, extra, renderKra, renderKpi, renderWeight }) {
  const pct = round(g.weight);
  return (
    <>
      {g.rows.map((row, n) => (
        <tr key={row.i != null ? row.i : (row.k.id || n)} className={n === g.rows.length - 1 && !extra ? 'kt-last' : ''}>
          {n === 0 && (
            <td className="kt-param" rowSpan={span}>
              <div className={`kt-pname ${g.cat === NO_CATEGORY ? 'kt-none' : ''}`}>{paramLabel(g.cat)}</div>
              <div className="kt-psub">
                {g.rows.length} KRA{g.rows.length === 1 ? '' : 's'} · {pct}%
              </div>
              {/* The subtotal as a bar as well as a number. A scorecard
                  that is 70% Financial and 5% People is the thing nobody
                  notices in a list, and it is still fixable at this
                  point — which is the whole reason to group. */}
              <div className="kt-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
            </td>
          )}
          <td className="kt-k">{renderKra(row)}</td>
          <td className="kt-kpi">{renderKpi(row)}</td>
          <td className="kt-w num">{renderWeight(row)}</td>
        </tr>
      ))}
      {extra && <tr className="kt-add kt-last"><td colSpan={3}>{extra}</td></tr>}
    </>
  );
}

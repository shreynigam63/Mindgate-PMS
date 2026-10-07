import { useEffect, useRef, useState } from 'react';
import { gradeFor } from '../grade';

// THE BELL CURVE, as a picture. Asked for on 7 Oct: "bell curve is missing
// on this page, please bring back the bell curve distribution and should be
// displayed in graph as per percentage range."
//
// x: the cycle's own rating scale, lowest to highest, so the target reads
//    as the bell it is.
// y: percentage of the RATED population — the targets add up to 100% of
//    the people being calibrated, so the actual bars are measured the same
//    way. Unrated people are counted beside the chart, not inside it.
// Two series, never colour alone: actual is a bar with its % printed on
// it, target is a dashed curve with a dot and its own label.
const ACTUAL = '#2f7fe8';   // brand-500
const TARGET = '#d96b0f';   // amber2-600 — validated against ACTUAL for CVD

const H = 260;
const PAD = { l: 38, r: 8, t: 22, b: 40 };

// Catmull-Rom through the target points, as cubic Béziers: a smooth curve
// that still passes exactly through every target.
function smooth(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}

export default function BellCurveChart({ distribution, targets, scale }) {
  distribution = distribution || {};
  targets = targets || {};
  scale = scale || [];
  const [hover, setHover] = useState(null);
  // Drawn at the container's real width, so text is the same size on a
  // phone as on a desktop instead of scaling with a viewBox.
  const box = useRef(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const values = (scale.length ? scale.map((s) => s.value) : [1, 2, 3, 4, 5]).slice().sort((a, b) => a - b);
  const rated = values.reduce((n, v) => n + (distribution[String(v)] || 0), 0);
  const unrated = distribution.unrated || 0;
  const cats = values.map((v) => {
    const count = distribution[String(v)] || 0;
    const actual = rated ? (count / rated) * 100 : 0;
    const target = targets[String(v)] != null ? Number(targets[String(v)]) : null;
    const s = scale.find((x) => x.value === v);
    return { v, count, actual, target, label: gradeFor(v, scale) || String(v), name: s ? s.label : '' };
  });

  // The y-axis tops out at the next 10% above the biggest value, so a
  // 55% target is not drawn against a 100% axis and flattened.
  const peak = Math.max(10, ...cats.map((c) => Math.max(c.actual, c.target || 0)));
  const yMax = Math.min(100, Math.ceil(peak / 10) * 10 + (peak % 10 === 0 ? 10 : 0));
  const ticks = [];
  const step = yMax > 60 ? 20 : 10;
  for (let t = 0; t <= yMax; t += step) ticks.push(t);

  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const band = iw / cats.length;
  const barW = Math.min(56, band * 0.5);
  const x = (i) => PAD.l + band * i + band / 2;
  const y = (pct) => PAD.t + ih - (pct / yMax) * ih;
  const targetPts = cats.filter((c) => c.target != null).map((c) => [x(cats.indexOf(c)), y(c.target)]);
  const hasTargets = targetPts.length > 0;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-navy-600 mb-1">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: ACTUAL }} />Actual — % of rated people</span>
        {hasTargets && (
          <span className="flex items-center gap-1.5">
            <svg width="22" height="10" aria-hidden><line x1="1" y1="5" x2="21" y2="5" stroke={TARGET} strokeWidth="2" strokeDasharray="4 3" /><circle cx="11" cy="5" r="3" fill={TARGET} /></svg>
            Bell-curve target %
          </span>
        )}
        <span className="text-navy-400 ml-auto">{rated} rated{unrated ? ` · ${unrated} not yet rated (not in the %)` : ''}</span>
      </div>
      <div className="relative" ref={box}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img"
          aria-label={`Rating distribution against the bell curve: ${cats.map((c) => `${c.label} ${Math.round(c.actual)}%${c.target != null ? ` (target ${c.target}%)` : ''}`).join(', ')}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#dbe3ef" strokeWidth="1" />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#7d95bb">{t}%</text>
            </g>
          ))}
          {cats.map((c, i) => {
            const h = (c.actual / yMax) * ih;
            const bx = x(i) - barW / 2;
            const by = PAD.t + ih - h;
            return (
              <g key={c.v}>
                {h > 0 && (
                  // Rounded top, square base: a path rather than rx so the
                  // bar stays anchored to the baseline.
                  <path d={`M${bx},${PAD.t + ih} V${by + Math.min(4, h)} Q${bx},${by} ${bx + Math.min(4, h)},${by} H${bx + barW - Math.min(4, h)} Q${bx + barW},${by} ${bx + barW},${by + Math.min(4, h)} V${PAD.t + ih} Z`}
                    fill={ACTUAL} opacity={hover == null || hover === i ? 1 : 0.55} />
                )}
                <text x={x(i)} y={by - 5} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1b3b6f">
                  {Math.round(c.actual)}%
                </text>
                <text x={x(i)} y={H - PAD.b + 16} textAnchor="middle" fontSize="12" fontWeight="700" fill="#1b3b6f">{c.label}</text>
                <text x={x(i)} y={H - PAD.b + 30} textAnchor="middle" fontSize="9.5" fill="#7d95bb">{c.count} {c.count === 1 ? 'person' : 'people'}</text>
              </g>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} stroke="#7d95bb" strokeWidth="1" />
          {hasTargets && (
            <>
              <path d={smooth(targetPts)} fill="none" stroke={TARGET} strokeWidth="2" strokeDasharray="5 4" />
              {cats.map((c, i) => c.target != null && (
                // Dot only: the target figure is in the tooltip and the
                // table below — printed here it collides with the bar's.
                <circle key={`t${c.v}`} cx={x(i)} cy={y(c.target)} r="4.5" fill={TARGET} stroke="#ffffff" strokeWidth="2" />
              ))}
            </>
          )}
          {/* Hit targets: the whole column, bigger than the mark. */}
          {cats.map((c, i) => (
            <rect key={`h${c.v}`} x={PAD.l + band * i} y={PAD.t} width={band} height={ih} fill="transparent"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          ))}
        </svg>
        {hover != null && (() => {
          const c = cats[hover];
          const diff = c.target != null ? Math.round(c.actual - c.target) : null;
          return (
            <div className="absolute pointer-events-none bg-white border border-navy-100 shadow-lg rounded-lg px-2.5 py-1.5 text-[11px] text-navy-700"
              style={{ left: `${(x(hover) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}>
              <p className="font-bold">{c.label}{c.name ? ` · ${c.name}` : ''}</p>
              <p>Actual: <b>{Math.round(c.actual)}%</b> ({c.count} of {rated})</p>
              {c.target != null && <p>Target: <b>{c.target}%</b>{diff !== 0 && <span className="text-navy-400"> · {diff > 0 ? '+' : ''}{diff} pts</span>}</p>}
            </div>
          );
        })()}
      </div>
      {/* The same numbers as a table — the chart's text view. */}
      <table className="w-full text-[11px] mt-2">
        <thead><tr className="text-navy-400"><th className="text-left font-semibold py-0.5">Rating</th>
          {cats.map((c) => <th key={c.v} className="font-semibold">{c.label}</th>)}</tr></thead>
        <tbody>
          <tr><td className="text-navy-500 py-0.5">Actual</td>{cats.map((c) => <td key={c.v} className="text-center">{Math.round(c.actual)}% <span className="text-navy-400">({c.count})</span></td>)}</tr>
          {hasTargets && <tr><td className="text-navy-500 py-0.5">Target</td>{cats.map((c) => <td key={c.v} className="text-center">{c.target != null ? `${c.target}%` : '—'}</td>)}</tr>}
          {hasTargets && (
            <tr><td className="text-navy-500 py-0.5">Gap</td>{cats.map((c) => {
              const g = c.target != null && rated ? Math.round(c.actual - c.target) : null;
              return <td key={c.v} className={`text-center ${g == null || g === 0 ? 'text-navy-400' : g > 0 ? 'text-amber2-600' : 'text-navy-600'}`}>{g == null ? '—' : `${g > 0 ? '+' : ''}${g} pts`}</td>;
            })}</tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

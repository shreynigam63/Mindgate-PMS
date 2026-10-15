// The band every page opens with.
//
// Pages used to title themselves with a bare <h2 className="text-lg
// font-bold">, which meant 29 pages and 29 slightly different header rows.
// This is the one place that decides what a page title looks like.
//
// 15 Oct: every page now opens like the Dashboard (asked with a screenshot
// of each: "please update this UI from the 1st screenshot for all pages") —
// the same light band, dark title and summit drawing as the Dashboard's
// greeting, instead of a dark gradient per group. Anything beside the title
// — the cycle chip, an action button — is passed as children and sits at
// the right of the band.
//
// `hue` is still accepted, and still checked, so no page has to change;
// it no longer colours the band.
import Summit from './Summit';

const HUES = ['navy', 'teal', 'lagoon', 'violet', 'azure', 'amber', 'leaf'];

export default function PageHead({ title, sub, hue = 'navy', children }) {
  const h = HUES.includes(hue) ? hue : 'navy';
  return (
    <div className={`pagehead pagehead-${h}`}>
      <Summit className="pagehead-art" flag={false} />
      <div className="min-w-0">
        <h2>{title}</h2>
        {sub && <div className="pagehead-sub">{sub}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">{children}</div>}
    </div>
  );
}

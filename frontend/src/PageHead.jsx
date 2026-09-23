// The band every page opens with.
//
// Pages used to title themselves with a bare <h2 className="text-lg
// font-bold">, which meant 29 pages and 29 slightly different header rows.
// This is the one place that decides what a page title looks like.
//
// `hue` picks the gradient. The default follows the area of the product the
// page belongs to rather than being decorative: navy for a person's own
// pages, lagoon for a manager's, violet for HR and super-admin surfaces.
// Anything beside the title — the cycle chip, an action button — is passed
// as children and sits at the right of the band.

// The hues that actually have a gradient. A name not on this list falls
// back to navy, because the failure mode otherwise is invisible: .hero
// sets white text and the hero-* class supplies the background, so a
// misspelt or missing hue renders a white title on the page's near-white
// background and the band reads as an empty strip. That is exactly what
// 'lagoon' did on two Manager pages until 23 Sep — the class had never
// been written. Adding a hue means adding BOTH the class in app.css and
// the name here.
const HUES = ['navy', 'teal', 'lagoon', 'violet', 'azure', 'amber', 'leaf'];

export default function PageHead({ title, sub, hue = 'navy', children }) {
  const h = HUES.includes(hue) ? hue : 'navy';
  return (
    <div className={`hero hero-${h}`}>
      <div className="min-w-0">
        <h2 className="text-lg font-bold">{title}</h2>
        {sub && <div className="hero-sub">{sub}</div>}
      </div>
      {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
    </div>
  );
}

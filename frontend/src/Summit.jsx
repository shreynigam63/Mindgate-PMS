import { useId } from 'react';

// A small mountain with a flag — the reference's motif, drawn inline so
// it costs no request and scales with the card.
// GRADIENT IDS ARE PER INSTANCE. The sidebar card and the greeting band
// both draw this, and SVG ids are document-wide: with fixed ids the
// greeting's mountains pointed at the sidebar's gradients, and on a short
// screen the sidebar card is display:none — Chrome then paints nothing, so
// the band showed a flag on empty air. useId gives each copy its own.
export default function Summit({ className = '', flag = true }) {
  const u = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = (k) => `sm-${k}-${u}`;
  return (
    <svg viewBox="0 0 240 120" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id('a')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b8def" /><stop offset="1" stopColor="#2f5bd3" />
        </linearGradient>
        <linearGradient id={id('b')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9c4fb" /><stop offset="1" stopColor="#7aa2f7" />
        </linearGradient>
        <linearGradient id={id('c')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f8b4c8" /><stop offset="1" stopColor="#f9d2a8" />
        </linearGradient>
      </defs>
      <path d="M150 120 L196 58 L240 120 Z" fill={`url(#${id('c')})`} opacity=".75" />
      <path d="M0 120 L58 66 L92 92 L128 44 L176 120 Z" fill={`url(#${id('b')})`} />
      <path d="M60 120 L128 34 L196 120 Z" fill={`url(#${id('a')})`} />
      <path d="M128 34 L112 54 L122 52 L128 60 L134 52 L144 55 Z" fill="#fff" opacity=".85" />
      {flag && (<>
        <line x1="128" y1="34" x2="128" y2="6" stroke="#1d3b8f" strokeWidth="2" />
        <path d="M128 7 L146 12 L128 18 Z" fill="#2563eb" />
      </>)}
    </svg>
  );
}

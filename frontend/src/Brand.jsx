import { useEffect, useState } from 'react';
import { api } from './utils/api';

// The client's own name and logo, beside the product's (16 Oct, Def-002:
// "MGS Name & Logo is missing on Login Page & Dashboard"). HR sets both on
// Settings → Company branding; nothing shows until they do. Read once per
// page load and shared, since the sign-in page and the top bar both ask.
let cached = null;
let pending = null;
const listeners = new Set();
export function loadBrand(force) {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && pending) return pending;
  pending = api('/brand').then((b) => { cached = b || {}; listeners.forEach((f) => f(cached)); return cached; })
    .catch(() => { cached = {}; return cached; }).finally(() => { pending = null; });
  return pending;
}

export function useBrand() {
  const [b, setB] = useState(cached);
  useEffect(() => {
    listeners.add(setB);
    if (!cached) loadBrand();
    return () => { listeners.delete(setB); };
  }, []);
  return b || {};
}

export function BrandMark({ brand, large, divider }) {
  if (!brand || (!brand.logo && !brand.name)) return null;
  return (
    <span className={`flex items-center gap-2 min-w-0 ${divider ? 'pl-3 border-l border-navy-100' : ''} ${large ? 'justify-center pb-1' : ''}`}>
      {brand.logo && <img src={brand.logo} alt={brand.name || 'Company logo'} className="brand-logo" style={large ? { height: 40, maxWidth: 200 } : undefined} />}
      {brand.name && <span className={`brand-name ${large ? '!text-base' : 'hidden sm:inline'}`}>{brand.name}</span>}
    </span>
  );
}

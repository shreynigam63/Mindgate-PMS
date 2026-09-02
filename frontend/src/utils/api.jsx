// Shared API client + tiny helpers for the product pages.
//
// In local dev, relative /api/v1 paths work via Vite's dev-server proxy
// (vite.config.js). In production on Render, the frontend deploys as a
// SEPARATE static site from the API service — a relative path would hit
// the static site's own domain and 404. VITE_API_URL (set at build time
// via render.yaml's fromService reference to the api service's host) is
// how the built static bundle knows the API's real domain. Every part of
// the app — the api() helper AND the handful of plain <a href> download
// links (evidence, closure letters, GDPR export) — uses this same
// constant, so there is one place this logic lives, not four.
export const API_BASE = import.meta.env.VITE_API_URL ? `https://${import.meta.env.VITE_API_URL}/api/v1` : '/api/v1';

export const api = async (path, opts = {}) => {
  const token = localStorage.getItem('apms_token');
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
};

export const PHASES = ['draft', 'kra_open', 'growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval', 'calibration', 'publish', 'closed'];
export const phaseLabel = (p) => ({ draft: 'Draft', kra_open: 'KRA Setting', growth_planning: 'Growth Planning', mid_year_review: 'Mid-Year Review', self_appraisal: 'Self-Appraisal', manager_eval: 'Manager Evaluation', hod_eval: 'Delivery Head Review', calibration: 'Calibration', publish: 'Publish', closed: 'Closed', cancelled: 'Cancelled' }[p] || p);
export const phaseColor = (p) => ({ draft: 'bg-navy-50 text-navy-600', kra_open: 'bg-blue-100 text-blue-700', growth_planning: 'bg-teal-100 text-teal-700', mid_year_review: 'bg-fuchsia-100 text-fuchsia-700', self_appraisal: 'bg-cyan-100 text-cyan-700', manager_eval: 'bg-amber-100 text-amber-700', hod_eval: 'bg-orange-100 text-orange-700', calibration: 'bg-purple-100 text-purple-700', publish: 'bg-emerald-100 text-emerald-700', closed: 'bg-navy-100 text-navy-600', cancelled: 'bg-rose-100 text-rose-700' }[p] || 'bg-navy-50 text-navy-600');

export function DraftBadge() {
  return <span className="chip bg-amber-100 text-amber-700">AI DRAFT — edit before use</span>;
}

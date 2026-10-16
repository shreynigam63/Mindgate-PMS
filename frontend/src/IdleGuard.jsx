import { useEffect, useState } from 'react';

// Signed out after 30 minutes without activity (16 Oct, Def-003: "user is
// logged in even after 2 to 3 hours"). Two minutes before, a notice offers
// to stay signed in. Activity in any tab of the PMS counts for all of them:
// the last moment is kept in this browser, so a second tab does not sign
// out someone who is working in the first.
export const IDLE_MINUTES = 30;
const WARN_MINUTES = 2;
const KEY = 'apms_last_active';
export const EXPIRED_FLAG = 'apms_signed_out_idle';

const now = () => Date.now();
const read = () => { try { return Number(localStorage.getItem(KEY)) || now(); } catch { return now(); } };
const touch = () => { try { localStorage.setItem(KEY, String(now())); } catch { /* private window */ } };

export default function IdleGuard() {
  const [left, setLeft] = useState(null); // seconds until sign-out, while warning
  useEffect(() => {
    touch();
    let last = 0;
    const onActivity = () => { const t = now(); if (t - last > 15000) { last = t; touch(); } };
    const events = ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }));
    const tick = setInterval(() => {
      const idle = (now() - read()) / 1000;
      const limit = IDLE_MINUTES * 60;
      if (idle >= limit) {
        try { localStorage.removeItem('apms_token'); localStorage.setItem(EXPIRED_FLAG, '1'); } catch { /* ignore */ }
        window.location.href = '/';
      } else if (idle >= limit - WARN_MINUTES * 60) setLeft(Math.ceil(limit - idle));
      else setLeft(null);
    }, 1000);
    return () => { events.forEach((e) => window.removeEventListener(e, onActivity, { capture: true })); clearInterval(tick); };
  }, []);
  if (left == null) return null;
  const m = Math.floor(left / 60); const s = String(left % 60).padStart(2, '0');
  return (
    <div className="fixed inset-0 z-50 bg-navy-900/40 flex items-center justify-center p-4" role="alertdialog" aria-live="assertive">
      <div className="card p-5 max-w-sm w-full space-y-3 bg-white">
        <p className="font-bold text-navy-800">Still there?</p>
        <p className="text-sm text-navy-600">You have not used the PMS for a while. For your security you will be signed out in <b>{m}:{s}</b>.</p>
        <button type="button" className="btn-pri w-full" onClick={() => { touch(); setLeft(null); }}>Stay signed in</button>
      </div>
    </div>
  );
}

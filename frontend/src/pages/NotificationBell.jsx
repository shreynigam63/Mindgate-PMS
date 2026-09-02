import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell } from 'lucide-react';
import { api } from '../utils/api';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  // Calculated at open time from the bell's viewport rect (see toggle below).
  // Kept in state rather than computed inline so a resize/scroll during "open"
  // doesn't cause the panel to drift on every render — it stays where it was
  // when the user opened it, which is what people expect from a menu.
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [items, setItems] = useState([]);
  const [err, setErr] = useState(null);
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  // The panel is rendered via portal into document.body, which puts it
  // OUTSIDE rootRef's subtree — so the click-outside handler needs to check
  // this ref too, otherwise the very click that lands on a notification would
  // be treated as "outside" and close the panel before the link/handler fires.
  const panelRef = useRef(null);

  // Poll loader. Explicit try/catch (rather than the previous .then/.catch)
  // so I can BOTH clear err on success AND preserve items on failure — two
  // things the earlier one-liner got wrong:
  //   (1) It never reset `err` when a subsequent load succeeded, so once
  //   any single poll had failed the red banner stuck around forever
  //   until the panel was closed.
  //   (2) It set err on ANY failure — including transient background
  //   polls that failed while the previous data was still perfectly
  //   valid — so users saw a scary "Failed to fetch" banner sitting on
  //   top of 5 real notifications that hadn't gone anywhere.
  // The fix is threefold: clear err on success, keep items on failure,
  // and only actually render the error to the user when we have nothing
  // else to show them (see the render below). Common cause of the
  // transient failure on this deployment: agentic-pms-api is on Render's
  // free tier, which sleeps after 15 min of no traffic — a background
  // poll can hit the sleeping service and get a network error, then the
  // service wakes up and the next poll succeeds seconds later.
  const load = async () => {
    try {
      const r = await api('/notifications');
      setItems(r.notifications);
      setErr(null);
    } catch (e) {
      // Deliberately do NOT clear items — a transient poll failure should
      // never wipe the last-known-good notification list from the panel.
      setErr(e.message);
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // simple poll — no push channel exists yet
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onClick = (e) => {
      const inButton = rootRef.current && rootRef.current.contains(e.target);
      const inPanel = panelRef.current && panelRef.current.contains(e.target);
      if (!inButton && !inPanel) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const unread = items.filter(i => !i.read_at).length;

  const markRead = async (id) => {
    try { await api(`/notifications/${id}/read`, { method: 'POST' }); load(); } catch { /* non-critical */ }
  };

  // Was: absolute right-0 relative to the bell. Two real bugs came from that,
  // discovered in this exact order:
  //
  //   (a) right-0 anchors the panel's RIGHT edge to the bell, so from a bell
  //   that sits inside a LEFT sidebar the panel extended leftward — off-screen
  //   or into the browser chrome, exactly the "notifications half-cut-off"
  //   problem flagged from a live screenshot.
  //
  //   (b) even with the direction reversed, the sidebar has overflow-y-auto
  //   (needed for its own vertical scrolling), which creates a clipping
  //   context that any position: absolute child gets cut off inside,
  //   regardless of z-index.
  //
  //   (c) — the one I missed on the first pass and had to fix a second time —
  //   the sidebar also has backdrop-blur-xl (backdrop-filter: blur(24px)).
  //   Per the CSS spec, ANY ancestor with backdrop-filter (or transform,
  //   filter, perspective, etc.) becomes the containing block for descendant
  //   position: fixed elements, defeating fixed's normal escape from
  //   ancestor clipping. So a fixed-positioned panel STILL got clipped by
  //   the sidebar — visible as ~100px-wide truncated notification titles.
  //
  // Real fix: React portal — render the panel to document.body, outside the
  // sidebar's DOM subtree entirely, so no ancestor of the panel has clipping,
  // overflow, backdrop-filter, or transform to worry about. Coordinates are
  // captured from the bell's own bounding rect at open time (see toggle).
  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const width = 320; // must match w-80 on the panel below
      const gap = 6;
      // Anchor the panel's LEFT to the bell's LEFT — pushes it out to the
      // RIGHT of the bell, into the main content area, which is always empty
      // above the fold on this screen. If that would overflow the viewport
      // right edge (small screens, mobile) shift back just enough to fit
      // with an 8px margin.
      let left = rect.left;
      const overflow = left + width - window.innerWidth + 8;
      if (overflow > 0) left = Math.max(8, left - overflow);
      setPos({ top: rect.bottom + gap, left });
    }
    setOpen(o => !o);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button ref={btnRef} className="relative p-2 rounded-lg hover:bg-navy-50" onClick={toggle} aria-label="Notifications">
        <Bell size={16} className="text-navy-500" />
        {unread > 0 && <span className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] leading-4 text-center font-bold">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="fixed w-80 max-h-96 overflow-y-auto bg-white border border-navy-100 rounded-xl shadow-glass z-50"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="px-3 py-2 border-b border-navy-100 text-xs font-bold text-navy-500 uppercase tracking-wide flex items-center justify-between">
            <span>Notifications</span>
            {unread > 0 && <span className="chip bg-rose-100 text-rose-600 normal-case">{unread} unread</span>}
          </div>
          {/*
            Show the error banner ONLY when we have nothing else to display.
            If items.length > 0, those are still valid — the failure was
            just a background refresh — so surfacing a scary "Failed to
            fetch" on top of real data would confuse more than it helps.
            The 60-second poll will retry on its own; when it succeeds, the
            load() function above will clear err back to null.
          */}
          {err && !items.length && <p className="p-3 text-xs text-rose-600">Couldn't load notifications: {err}</p>}
          {!err && !items.length && <p className="p-6 text-xs text-navy-400 text-center">Nothing yet.</p>}
          {items.map(n => (
            <a key={n.id} href={n.link || '#'} onClick={() => !n.read_at && markRead(n.id)}
              className={`block px-3 py-2 border-b border-navy-50 last:border-0 hover:bg-navy-50 transition-colors ${!n.read_at ? 'bg-amber-50/50' : ''}`}>
              <p className="text-xs font-semibold text-navy-800">{n.title}</p>
              {n.body && <p className="text-[11px] text-navy-500 mt-0.5">{n.body}</p>}
              <p className="text-[10px] text-navy-400 mt-1">{new Date(n.created_at).toLocaleString()}</p>
            </a>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

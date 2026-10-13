// Wall-clock time in the COMPANY's time zone, and back (13 Oct). Event
// times are entered and shown in it, so "6 pm" means 6 pm in Pune for the
// HR person typing it and for every employee reading it, whatever their
// own laptop is set to. Built on Intl alone; no library.

const fmt = (tz) => new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const parts = (d, tz) => Object.fromEntries(fmt(tz).formatToParts(d)
  .filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
// How far the zone is ahead of UTC at instant d, in ms.
const offsetMs = (d, tz) => {
  const p = parts(d, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - (d.getTime() - d.getMilliseconds());
};

/** 'YYYY-MM-DDTHH:mm' read in `tz` → an ISO instant; undefined when it is not a real time. */
export function wallToIso(v, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(v || ''));
  if (!m) return undefined;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (Number.isNaN(guess)) return undefined;
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);   // again, for a change of clocks in between
  const back = isoToWall(new Date(t).toISOString(), tz);
  return back === v ? new Date(t).toISOString() : undefined;   // 31 Feb and the like
}

/** An ISO instant → 'YYYY-MM-DDTHH:mm' as the clock reads in `tz` (for <input type="datetime-local">). */
export function isoToWall(iso, tz) {
  if (!iso) return '';
  const p = parts(new Date(iso), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** An instant for people to read, in `tz`, with the zone named. */
// (dateStyle/timeStyle cannot be combined with timeZoneName, so spelt out.)
export const showAt = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: tz, timeZoneName: 'short' }) : '');

/**
 * When an event is over: its end time, or without one the end of the day
 * it starts — in `tz`, the same rule the server uses to close its RSVPs.
 */
export function endOfEvent(e, tz) {
  if (e.ends_at) return new Date(e.ends_at);
  const p = parts(new Date(e.starts_at), tz);
  return new Date(new Date(wallToIso(`${p.year}-${p.month}-${p.day}T23:59`, tz)).getTime() + 59999);
}

// Opening hours: one daily schedule + closed weekdays (0 = Sunday … 6 = Saturday). Overnight works (18:00 → 02:00).
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function cleanHours(h) {
  if (h == null || h === '') return null;
  if (typeof h === 'object' && h.allDay) return { allDay: true, closed: [...new Set((Array.isArray(h.closed) ? h.closed : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() };
  if (typeof h !== 'object' || !HM.test(h.open || '') || !HM.test(h.close || '') || h.open === h.close) return undefined;   // undefined = invalid
  const closed = [...new Set((Array.isArray(h.closed) ? h.closed : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return { open: h.open, close: h.close, closed };
}
const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Is it open now, in this time zone? null when no hours are set. */
export function isOpenNow(h, timeZone = 'Asia/Beirut', now = new Date()) {
  if (h && h.allDay) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
    return !h.closed.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd));
  }
  if (!h || !h.open || !h.close) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const m = Number(p.hour) * 60 + Number(p.minute), o = mins(h.open), c = mins(h.close);
  if (o < c) return !h.closed.includes(day) && m >= o && m < c;
  // overnight: after opening today, or before closing (the shift that started yesterday)
  if (m >= o) return !h.closed.includes(day);
  return m < c && !h.closed.includes((day + 6) % 7);
}

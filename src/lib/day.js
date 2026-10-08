// "Today" in the platform's reference time zone (Beirut): the public daily counters reset at local midnight.
export function dayInfo(now = new Date(), timeZone = 'Asia/Beirut') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const y = +parts.year, m = +parts.month, d = +parts.day;
  const localAsUtc = Date.UTC(y, m - 1, d, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const start = Date.UTC(y, m - 1, d) - offsetMs;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, start: new Date(start), resetsAt: new Date(start + 86_400_000) };
}

// Small local-date helpers. Dates are handled as 'YYYY-MM-DD' strings (local),
// times as 'HH:MM' strings (24h, local).

export const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function addMonths(s, n) {
  const d = parseYmd(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
}

export const today = () => ymd(new Date());

export function diffDays(a, b) {
  // b - a in whole days
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WD_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function weekday(s) { return parseYmd(s).getDay(); }

export function fmtTime(t) {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return m ? `${h}:${pad(m)} ${ap}` : `${h} ${ap}`;
}

// "Today", "Tomorrow", "Yesterday", "Wednesday" (within a week), else "Mon Nov 24"
export function fmtRelative(s, ref = today()) {
  const n = diffDays(ref, s);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  const d = parseYmd(s);
  if (n > 1 && n < 7) return WEEKDAYS[d.getDay()];
  const base = `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  return d.getFullYear() === parseYmd(ref).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function fmtLong(s) {
  const d = parseYmd(s);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

// Combine a local date + time into a local "floating" ISO string (no offset)
export function localIso(date, time) {
  return `${date}T${time}:00`;
}

export function addMinutesLocal(date, time, minutes) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi + minutes);
  return { date: ymd(dt), time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}` };
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

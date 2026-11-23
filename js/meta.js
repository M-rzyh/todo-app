// Converts between app tasks and Google Calendar events.
//
// Everything is stored in fields any Calendar client can write, so tasks added
// from Google Calendar itself (or by Claude) show up correctly:
//   summary      → "✓ " prefix when done, then the task name
//   description  → task description, plus a footer:   —
//                                                      Priority: P1 · Labels: #lab #urgent
//   start        → all-day date (no time) or date-time (deadline time)
//   recurrence   → RRULE
//   colorId      → priority colour (P1 red, P2 orange, P3 blue)

import { addDays, addMinutesLocal, localIso, ymd, pad, localTimeZone } from './dates.js';

export const DONE_PREFIX = '✓ ';
export const PRIORITY_COLOR = { 1: '11', 2: '6', 3: '9', 4: null };
const COLOR_PRIORITY = { 11: 1, 4: 1, 6: 2, 5: 2, 9: 3, 7: 3 };

function htmlToText(s) {
  if (!s) return '';
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function splitDescription(raw) {
  const lines = htmlToText(raw).replace(/\r/g, '').split('\n');
  let priority = null; const labels = [];
  let i = lines.length;
  while (i > 0) {
    const line = lines[i - 1].trim();
    if (line === '') { i--; continue; }
    const pm = line.match(/priority:\s*p?([1-4])/i);
    const lm = line.match(/labels?:\s*(.+?)(?:\s*·\s*priority.*)?$/i);
    if (pm || lm) {
      if (pm && priority == null) priority = +pm[1];
      if (lm) lm[1].split(/[\s,·]+/).map((x) => x.replace(/^[#@]/, '').trim()).filter((x) => x && !/^priority:?$/i.test(x) && !/^p[1-4]$/i.test(x))
        .reverse().forEach((l) => { if (!labels.includes(l)) labels.unshift(l); });
      i--; continue;
    }
    if (/^[—–-]{1,3}$/.test(line)) { i--; break; }
    break;
  }
  return { text: lines.slice(0, i).join('\n').trim(), priority, labels };
}

export function buildDescription(text, priority, labels) {
  const parts = [];
  if (priority && priority < 4) parts.push(`Priority: P${priority}`);
  if (labels && labels.length) parts.push(`Labels: ${labels.map((l) => '#' + l).join(' ')}`);
  const body = (text || '').trim();
  if (!parts.length) return body;
  return `${body}${body ? '\n\n' : ''}—\n${parts.join(' · ')}`;
}

function startOf(ev) {
  if (ev.start?.date) return { date: ev.start.date, time: null };
  if (ev.start?.dateTime) {
    const d = new Date(ev.start.dateTime);
    return { date: ymd(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  return { date: null, time: null };
}

export function eventToTask(ev) {
  const { text, priority, labels } = splitDescription(ev.description || '');
  const summary = ev.summary || '(untitled)';
  const done = summary.startsWith(DONE_PREFIX) || summary.startsWith('✓') || ev.extendedProperties?.private?.done === '1';
  const { date, time } = startOf(ev);
  return {
    id: ev.id,
    seriesId: ev.recurringEventId || (ev.recurrence ? ev.id : null),
    recurring: !!(ev.recurringEventId || ev.recurrence),
    name: summary.replace(/^✓\s*/, ''),
    description: text,
    date, time,
    priority: priority ?? COLOR_PRIORITY[ev.colorId] ?? 4,
    labels,
    done,
    htmlLink: ev.htmlLink,
  };
}

// ---- Recurrence <-> RRULE -------------------------------------------------

export function recurrenceToRrule(rec, hasTime) {
  if (!rec) return null;
  let r = `RRULE:FREQ=${rec.freq}`;
  if (rec.interval && rec.interval > 1) r += `;INTERVAL=${rec.interval}`;
  if (rec.freq === 'WEEKLY' && rec.byday?.length) r += `;BYDAY=${rec.byday.join(',')}`;
  if (rec.until) r += `;UNTIL=${rec.until.replace(/-/g, '')}${hasTime ? 'T235959Z' : ''}`;
  return [r];
}

export function rruleToRecurrence(list) {
  const line = (list || []).find((l) => l.startsWith('RRULE:'));
  if (!line) return null;
  const parts = Object.fromEntries(line.slice(6).split(';').map((p) => p.split('=')));
  const rec = { freq: parts.FREQ, interval: +(parts.INTERVAL || 1), byday: [], until: null };
  if (parts.BYDAY) rec.byday = parts.BYDAY.split(',').map((d) => d.replace(/^[-+\d]+/, ''));
  if (parts.UNTIL) { const u = parts.UNTIL.slice(0, 8); rec.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`; }
  return rec;
}

export function describeRecurrence(rec) {
  if (!rec) return '';
  const n = rec.interval > 1 ? rec.interval : null;
  const NAMES = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
  let s;
  if (rec.freq === 'DAILY') s = n ? `Every ${n} days` : 'Every day';
  else if (rec.freq === 'WEEKLY') {
    if (rec.byday?.join(',') === 'MO,TU,WE,TH,FR') s = 'Every weekday';
    else if (rec.byday?.length) s = `Every ${n ? n + ' weeks on ' : ''}${rec.byday.map((d) => NAMES[d]).join(', ')}`;
    else s = n ? `Every ${n} weeks` : 'Every week';
  } else if (rec.freq === 'MONTHLY') s = n ? `Every ${n} months` : 'Every month';
  else if (rec.freq === 'YEARLY') s = n ? `Every ${n} years` : 'Every year';
  else s = 'Repeats';
  if (rec.until) s += ` until ${rec.until}`;
  return s;
}

// Build the event body for insert/patch from a task-like object
export function taskToEvent(t, { durationMin = 30, includeRecurrence = true } = {}) {
  const tz = localTimeZone();
  const ev = {
    summary: (t.done ? DONE_PREFIX : '') + t.name.trim(),
    description: buildDescription(t.description, t.priority, t.labels),
    colorId: PRIORITY_COLOR[t.priority] ?? null,
    extendedProperties: { private: { todoApp: '1', done: t.done ? '1' : '0' } },
  };
  if (t.date) {
    if (t.time) {
      const end = addMinutesLocal(t.date, t.time, durationMin);
      ev.start = { dateTime: localIso(t.date, t.time), timeZone: tz, date: null };
      ev.end = { dateTime: localIso(end.date, end.time), timeZone: tz, date: null };
    } else {
      ev.start = { date: t.date, dateTime: null, timeZone: null };
      ev.end = { date: addDays(t.date, 1), dateTime: null, timeZone: null };
    }
  }
  if (includeRecurrence) ev.recurrence = recurrenceToRrule(t.recurrence, !!t.time) || [];
  ev.transparency = 'transparent'; // tasks don't mark you as "busy"
  return ev;
}

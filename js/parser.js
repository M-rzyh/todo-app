// Natural-language quick add, Todoist style.
//   "Submit report tomorrow 5pm p1 #lab every monday // attach the figures"
// → { name, description, date, time, priority, labels, recurrence, chips }

import { ymd, addDays, addMonths, parseYmd, today, weekday, WD_CODES, pad } from './dates.js';

const DAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|s)?';
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

const dayIdx = (word) => DAY_NAMES[word.toLowerCase().replace(/(day|nesday|sday|urday|s)$/, '')] ?? DAY_NAMES[word.toLowerCase().slice(0, 3)];

function nextWeekday(from, wd, includeToday = false) {
  let n = (wd - weekday(from) + 7) % 7;
  if (n === 0 && !includeToday) n = 7;
  return addDays(from, n);
}

export function parseQuickAdd(input, now = today()) {
  let text = ` ${input} `;
  const out = { name: '', description: '', date: null, time: null, priority: 4, labels: [], recurrence: null, chips: [] };

  const take = (re, fn) => {
    const m = text.match(re);
    if (!m) return false;
    const res = fn(m);
    if (res === false) return false;
    text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    return true;
  };

  // Description after " // "
  const di = text.indexOf(' // ');
  if (di >= 0) {
    out.description = text.slice(di + 4).trim();
    text = text.slice(0, di) + ' ';
  }

  // Priority: p1..p4 or !1..!4
  take(/\s(?:p|!!?)([1-4])(?=\s)/i, (m) => { out.priority = +m[1]; out.chips.push({ type: 'priority', text: `P${m[1]}` }); });

  // Labels: #label or @label (repeatable)
  let lm;
  while ((lm = text.match(/\s[#@]([\p{L}\p{N}_\-\/]+)/u))) {
    const l = lm[1];
    if (!out.labels.includes(l)) out.labels.push(l);
    text = text.slice(0, lm.index) + ' ' + text.slice(lm.index + lm[0].length);
  }
  out.labels.forEach((l) => out.chips.push({ type: 'label', text: `#${l}` }));

  // Recurrence
  const rec = (freq, extra = {}, label) => { out.recurrence = { freq, interval: 1, byday: [], until: null, ...extra }; out.chips.push({ type: 'repeat', text: label }); };
  take(/\s(?:every\s+(?:weekday|workday)s?|weekdays)(?=\s)/i, () => rec('WEEKLY', { byday: ['MO', 'TU', 'WE', 'TH', 'FR'] }, 'every weekday'))
  || take(/\s(?:every\s*day|daily)(?=\s)/i, () => rec('DAILY', {}, 'every day'))
  || take(/\severy\s+(?:other|(\d+))\s+(day|week|month|year)s?(?=\s)/i, (m) => {
    const n = m[1] ? +m[1] : 2;
    const freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[m[2].toLowerCase()];
    rec(freq, { interval: n }, `every ${n} ${m[2].toLowerCase()}s`);
  })
  || take(new RegExp(`\\severy\\s+(${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*)(?=\\s)`, 'i'), (m) => {
    const days = [...m[1].matchAll(new RegExp(DAY_RE, 'gi'))].map((x) => WD_CODES[dayIdx(x[0])]);
    rec('WEEKLY', { byday: [...new Set(days)] }, `every ${m[1].toLowerCase()}`);
  })
  || take(/\s(?:every\s+week|weekly)(?=\s)/i, () => rec('WEEKLY', {}, 'every week'))
  || take(/\s(?:every\s+month|monthly)(?=\s)/i, () => rec('MONTHLY', {}, 'every month'))
  || take(/\s(?:every\s+year|yearly|annually)(?=\s)/i, () => rec('YEARLY', {}, 'every year'));

  // "until Dec 20" / "until 2027-01-31" for recurring tasks
  if (out.recurrence) {
    take(new RegExp(`\\s(?:until|till|ending)\\s+(?:${MONTH_RE}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?|(\\d{4}-\\d{2}-\\d{2}))(?=\\s)`, 'i'), (m) => {
      out.recurrence.until = m[4] || mkDate(now, MONTH_IDX[m[1].toLowerCase()], +m[2], m[3]);
    });
  }

  // Time
  const setTime = (h, m) => { out.time = `${pad(h)}:${pad(m)}`; };
  take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s)/i, (m) => {
    let h = +m[1]; const mi = +(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return false;
    const pm = m[3].toLowerCase().startsWith('p');
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    setTime(h, mi);
  })
  || take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/i, (m) => setTime(+m[1], +m[2]))
  || take(/\s(?:at\s+)?noon(?=\s)/i, () => setTime(12, 0))
  || take(/\s(?:at\s+)?midnight(?=\s)/i, () => setTime(23, 59));

  // Date
  const PRE = '(?:on\\s+|by\\s+|due\\s+|for\\s+)?';
  const setDate = (d) => { out.date = d; };
  take(new RegExp(`\\s${PRE}(?:today|tod)(?=\\s)`, 'i'), () => setDate(now))
  || take(new RegExp(`\\s${PRE}tonight(?=\\s)`, 'i'), () => { setDate(now); if (!out.time) out.time = '20:00'; })
  || take(new RegExp(`\\s${PRE}(?:the\\s+)?day\\s+after\\s+tomorrow(?=\\s)`, 'i'), () => setDate(addDays(now, 2)))
  || take(new RegExp(`\\s${PRE}(?:tomorrow|tmrw?|tmw)(?=\\s)`, 'i'), () => setDate(addDays(now, 1)))
  || take(new RegExp(`\\s${PRE}next\\s+week(?=\\s)`, 'i'), () => setDate(nextWeekday(now, 1)))
  || take(new RegExp(`\\s${PRE}next\\s+month(?=\\s)`, 'i'), () => { const d = parseYmd(addMonths(now, 1)); d.setDate(1); setDate(ymd(d)); })
  || take(new RegExp(`\\s${PRE}(?:this\\s+)?weekend(?=\\s)`, 'i'), () => setDate(nextWeekday(now, 6, true)))
  || take(/\sin\s+(\d+|a|an|one|two|three)\s+(day|week|month)s?(?=\s)/i, (m) => {
    const n = { a: 1, an: 1, one: 1, two: 2, three: 3 }[m[1].toLowerCase()] ?? +m[1];
    const u = m[2].toLowerCase();
    setDate(u === 'day' ? addDays(now, n) : u === 'week' ? addDays(now, 7 * n) : addMonths(now, n));
  })
  || take(new RegExp(`\\s${PRE}(?:next\\s+|this\\s+)?${DAY_RE}(?=\\s)`, 'i'), (m) => setDate(nextWeekday(now, dayIdx(m[1]))))
  || take(/\s(?:on\s+|by\s+|due\s+)?(\d{4})-(\d{2})-(\d{2})(?=\s)/, (m) => setDate(`${m[1]}-${m[2]}-${m[3]}`))
  || take(new RegExp(`\\s${PRE}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s)`, 'i'), (m) => setDate(mkDate(now, MONTH_IDX[m[1].toLowerCase()], +m[2], m[3])))
  || take(new RegExp(`\\s${PRE}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?(?=\\s)`, 'i'), (m) => setDate(mkDate(now, MONTH_IDX[m[2].toLowerCase()], +m[1], m[3])))
  || take(/\s(?:on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/, (m) => {
    if (+m[1] > 12 || +m[2] > 31) return false;
    setDate(mkDate(now, +m[1] - 1, +m[2], m[3] && (m[3].length === 2 ? `20${m[3]}` : m[3])));
  });

  if (out.date) out.chips.unshift({ type: 'date', text: out.date });
  if (out.time) out.chips.push({ type: 'time', text: out.time });

  // A repeating task with no explicit date starts at its first occurrence
  if (out.recurrence && !out.date) {
    out.date = out.recurrence.byday.length
      ? out.recurrence.byday.map((c) => nextWeekday(now, WD_CODES.indexOf(c), true)).sort()[0]
      : now;
  }
  // Snap a weekly start date onto one of its chosen weekdays
  if (out.recurrence && out.recurrence.byday.length && !out.recurrence.byday.includes(WD_CODES[weekday(out.date)])) {
    out.date = out.recurrence.byday.map((c) => nextWeekday(out.date, WD_CODES.indexOf(c), true)).sort()[0];
  }
  if (out.time && !out.date) out.date = now;

  out.name = text.replace(/\s+/g, ' ').trim().replace(/\s+(?:on|at|by|due|for)$/i, '').trim();
  return out;
}

function mkDate(now, month, day, year) {
  const ref = parseYmd(now);
  let y = year ? +year : ref.getFullYear();
  let d = new Date(y, month, day);
  if (!year && ymd(d) < now) d = new Date(y + 1, month, day);
  return ymd(d);
}

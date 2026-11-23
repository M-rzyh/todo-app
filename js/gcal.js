// Storage backends. Both expose the same interface:
//   init()                     → ensures the To-Do calendar exists
//   list(timeMin, timeMax)     → events (recurring ones expanded into instances)
//   get(id) / insert(ev) / patch(id, partial) / remove(id)
//
// GoogleBackend talks to the Google Calendar API in the browser using a
// Google Identity Services access token. MockBackend keeps everything in
// localStorage (demo mode, and for testing without a Google account).

import { CONFIG } from './config.js';
import { addDays, addMonths, parseYmd, ymd, WD_CODES, localTimeZone } from './dates.js';
import { rruleToRecurrence } from './meta.js';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const LS = (k) => `todo.${k}`;

export class AuthError extends Error {}

export function getClientId() {
  return localStorage.getItem(LS('clientId')) || CONFIG.GOOGLE_CLIENT_ID || '';
}
export function getCalendarName() {
  return localStorage.getItem(LS('calendarName')) || CONFIG.CALENDAR_NAME;
}

// ---------------------------------------------------------------------------
export class GoogleBackend {
  constructor() {
    this.kind = 'google';
    this.calendarId = localStorage.getItem(LS('calendarId'));
    const saved = JSON.parse(localStorage.getItem(LS('token')) || 'null');
    this.token = saved && saved.expires_at > Date.now() + 60000 ? saved : null;
    this.tokenClient = null;
  }

  hasValidToken() { return !!(this.token && this.token.expires_at > Date.now() + 60000); }

  async loadGis() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - t0 > 10000) return reject(new Error('Could not load Google sign-in. Check your connection.'));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // Must be called from a user gesture (click) the first time.
  async signIn({ prompt = '' } = {}) {
    await this.loadGis();
    return new Promise((resolve, reject) => {
      const hint = localStorage.getItem(LS('email')) || undefined;
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: getClientId(),
        scope: SCOPE,
        login_hint: hint,
        callback: (resp) => {
          if (resp.error) return reject(new AuthError(resp.error_description || resp.error));
          this.token = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 60) * 1000 };
          localStorage.setItem(LS('token'), JSON.stringify(this.token));
          resolve();
        },
        error_callback: (err) => reject(new AuthError(err?.message || err?.type || 'Sign-in was cancelled')),
      });
      this.tokenClient.requestAccessToken({ prompt });
    });
  }

  signOut() {
    if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token.access_token, () => {});
    this.token = null;
    localStorage.removeItem(LS('token'));
  }

  async req(path, { method = 'GET', body, query } = {}) {
    if (!this.hasValidToken()) throw new AuthError('Session expired');
    const url = new URL(API + path);
    if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { this.token = null; localStorage.removeItem(LS('token')); throw new AuthError('Session expired'); }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Google Calendar error ${res.status}`);
    return data;
  }

  async init() {
    const name = getCalendarName();
    if (this.calendarId) {
      try { await this.req(`/calendars/${encodeURIComponent(this.calendarId)}`); return; } catch (e) { if (e instanceof AuthError) throw e; }
    }
    let pageToken; let found = null;
    do {
      const r = await this.req('/users/me/calendarList', { query: { minAccessRole: 'owner', pageToken } });
      found = r.items.find((c) => c.summary === name) || found;
      const primary = r.items.find((c) => c.primary);
      if (primary) localStorage.setItem(LS('email'), primary.id);
      pageToken = r.nextPageToken;
    } while (pageToken && !found);
    if (!found) {
      found = await this.req('/calendars', { method: 'POST', body: { summary: name, timeZone: localTimeZone(), description: 'Tasks from my To-Do app' } });
      // Give it Todoist-red in the calendar list
      await this.req(`/users/me/calendarList/${encodeURIComponent(found.id)}`, { method: 'PATCH', query: { colorRgbFormat: true }, body: { backgroundColor: '#dc4c3e', foregroundColor: '#ffffff' } }).catch(() => {});
    }
    this.calendarId = found.id;
    localStorage.setItem(LS('calendarId'), found.id);
  }

  cal() { return `/calendars/${encodeURIComponent(this.calendarId)}/events`; }

  async list(timeMin, timeMax) {
    const out = []; let pageToken;
    do {
      const r = await this.req(this.cal(), {
        query: { singleEvents: true, orderBy: 'startTime', maxResults: 2500, timeMin: new Date(parseYmd(timeMin)).toISOString(), timeMax: new Date(parseYmd(timeMax)).toISOString(), pageToken },
      });
      out.push(...r.items.filter((e) => e.status !== 'cancelled'));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  get(id) { return this.req(`${this.cal()}/${encodeURIComponent(id)}`); }
  insert(ev) { return this.req(this.cal(), { method: 'POST', body: clean(JSON.parse(JSON.stringify(ev))) }); }
  patch(id, ev) { return this.req(`${this.cal()}/${encodeURIComponent(id)}`, { method: 'PATCH', body: ev }); }
  remove(id) { return this.req(`${this.cal()}/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
}

// ---------------------------------------------------------------------------
// localStorage backend with a small RRULE expander (the subset this app writes)
export class MockBackend {
  constructor() { this.kind = 'demo'; this.key = LS('demoEvents'); }
  load() { return JSON.parse(localStorage.getItem(this.key) || '[]'); }
  save(list) { localStorage.setItem(this.key, JSON.stringify(list)); }
  hasValidToken() { return true; }
  async init() {}

  async list(timeMin, timeMax) {
    const all = this.load(); const out = [];
    const exceptions = new Map(all.filter((e) => e.recurringEventId).map((e) => [e.id, e]));
    for (const ev of all) {
      if (ev.recurringEventId) continue;
      if (!ev.recurrence?.length) { if (ev.status !== 'cancelled' && inRange(ev, timeMin, timeMax)) out.push(ev); continue; }
      for (const d of expand(ev, timeMin, timeMax)) {
        const id = `${ev.id}_${d.replace(/-/g, '')}`;
        const exc = exceptions.get(id);
        if (exc) { if (exc.status !== 'cancelled') out.push(exc); continue; }
        out.push(instanceOf(ev, d, id));
      }
    }
    return out.sort((a, b) => startKey(a).localeCompare(startKey(b)));
  }

  async get(id) {
    const all = this.load();
    const e = all.find((x) => x.id === id);
    if (e) return e;
    const m = id.match(/^(.*)_(\d{8})$/);
    const master = m && all.find((x) => x.id === m[1]);
    if (master) return instanceOf(master, `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6)}`, id);
    throw new Error('Not found');
  }

  async insert(ev) {
    const all = this.load();
    const e = clean({ ...ev, id: 'd' + Math.random().toString(36).slice(2, 12), status: 'confirmed' });
    all.push(e); this.save(all); return e;
  }

  async patch(id, partial) {
    const all = this.load();
    let i = all.findIndex((x) => x.id === id);
    if (i < 0) { all.push(await this.get(id)); i = all.length - 1; } // materialise an instance exception
    all[i] = clean({ ...all[i], ...partial });
    this.save(all); return all[i];
  }

  async remove(id) {
    let all = this.load();
    const e = all.find((x) => x.id === id);
    if (e && !e.recurringEventId) all = all.filter((x) => x.id !== id && x.recurringEventId !== id);
    else if (e) e.status = 'cancelled';
    else { const inst = await this.get(id); inst.status = 'cancelled'; all.push(inst); }
    this.save(all); return null;
  }
}

function clean(ev) {
  for (const k of ['start', 'end']) if (ev[k]) ev[k] = Object.fromEntries(Object.entries(ev[k]).filter(([, v]) => v != null));
  if (ev.colorId == null) delete ev.colorId;
  if (Array.isArray(ev.recurrence) && !ev.recurrence.length) delete ev.recurrence;
  return ev;
}
const startKey = (e) => e.start.date || e.start.dateTime;
const evDate = (e) => e.start.date || e.start.dateTime.slice(0, 10);
function inRange(ev, a, b) { const d = evDate(ev); return d >= a && d < b; }

function instanceOf(master, date, id) {
  const inst = JSON.parse(JSON.stringify(master));
  delete inst.recurrence;
  inst.id = id; inst.recurringEventId = master.id;
  if (master.start.date) { inst.start = { date }; inst.end = { date: addDays(date, 1) }; }
  else {
    const shift = (s) => date + s.slice(10);
    inst.start = { ...master.start, dateTime: shift(master.start.dateTime) };
    const dur = (new Date(master.end.dateTime) - new Date(master.start.dateTime)) / 60000;
    const end = new Date(new Date(inst.start.dateTime).getTime() + dur * 60000);
    inst.end = { ...master.end, dateTime: `${ymd(end)}T${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}:00` };
  }
  inst.originalStartTime = { ...inst.start };
  return inst;
}

function expand(master, from, to) {
  const rec = rruleToRecurrence(master.recurrence);
  const start = evDate(master);
  const until = rec.until && rec.until < to ? addDays(rec.until, 1) : to;
  const out = []; const n = rec.interval || 1;
  let guard = 0;
  if (rec.freq === 'WEEKLY' && rec.byday.length) {
    const days = rec.byday.map((c) => WD_CODES.indexOf(c));
    let weekStart = addDays(start, -parseYmd(start).getDay());
    while (weekStart < until && guard++ < 2000) {
      for (const wd of days) { const d = addDays(weekStart, wd); if (d >= start && d < until && d >= from) out.push(d); }
      weekStart = addDays(weekStart, 7 * n);
    }
    return out.sort();
  }
  let d = start; let k = 0;
  while (d < until && guard++ < 5000) {
    if (d >= from) out.push(d);
    k++;
    d = rec.freq === 'DAILY' ? addDays(start, k * n) : rec.freq === 'WEEKLY' ? addDays(start, 7 * k * n)
      : rec.freq === 'MONTHLY' ? addMonths(start, k * n) : addMonths(start, 12 * k * n);
  }
  return out;
}

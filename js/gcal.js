// Storage "sources". Every source exposes the same interface:
//   id, label, kind, init(), list(timeMin, timeMax), get(id), insert(ev), patch(id, partial), remove(id)
//
// - CalendarSource: a "To-Do" calendar in one Google account (Google Calendar API)
// - EventStore:     tasks kept as calendar-style events in a JSON blob, with the
//                   recurrence expanded locally. Persisted either in Google Drive's
//                   hidden app folder (synced "No account" tasks) or localStorage (demo).
//
// Accounts: several Google accounts can be connected. Each keeps its own access
// token (Google Identity Services, ~1 hour) and its own To-Do calendar. One of
// them (the "storage account") also holds the "No account" tasks in Drive.

import { CONFIG } from './config.js';
import { addDays, addMonths, parseYmd, ymd, WD_CODES, localTimeZone } from './dates.js';
import { rruleToRecurrence } from './meta.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar';
const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
const LS = (k) => `todo.${k}`;
export const NO_ACCOUNT = 'none';

export class AuthError extends Error {
  constructor(msg, email) { super(msg); this.email = email; }
}

export function getClientId() {
  return localStorage.getItem(LS('clientId')) || CONFIG.GOOGLE_CLIENT_ID || '';
}
export function getCalendarName() {
  return localStorage.getItem(LS('calendarName')) || CONFIG.CALENDAR_NAME;
}

const ACCOUNT_COLORS = ['#dc4c3e', '#246fe0', '#058527', '#692ec2', '#eb8909', '#b8255f'];

// ---------------------------------------------------------------------------
// Accounts registry
// ---------------------------------------------------------------------------
export function loadAccounts() {
  let list = JSON.parse(localStorage.getItem(LS('accounts')) || 'null');
  if (!list) {
    // Migrate from the single-account version
    const token = JSON.parse(localStorage.getItem(LS('token')) || 'null');
    const email = localStorage.getItem(LS('email'));
    list = [];
    // token is dropped on purpose: the account now also needs the Drive app-data
    // permission (for "No account" tasks), so it reconnects once.
    if (email || token) list.push({ email: email || '', calendarId: localStorage.getItem(LS('calendarId')), token: null, storage: true, color: ACCOUNT_COLORS[0] });
    ['token', 'calendarId'].forEach((k) => localStorage.removeItem(LS(k)));
    localStorage.setItem(LS('accounts'), JSON.stringify(list));
  }
  return list.map((a) => new GoogleAccount(a));
}

export function saveAccounts(accounts) {
  localStorage.setItem(LS('accounts'), JSON.stringify(accounts.map((a) => a.toJSON())));
}

export function nextColor(accounts) {
  return ACCOUNT_COLORS.find((c) => !accounts.some((a) => a.color === c)) || ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
}

async function loadGis() {
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

export class GoogleAccount {
  constructor({ email = '', calendarId = null, token = null, storage = false, color = ACCOUNT_COLORS[0] } = {}) {
    Object.assign(this, { email, calendarId, token, storage, color });
  }
  toJSON() { const { email, calendarId, token, storage, color } = this; return { email, calendarId, token, storage, color }; }
  get id() { return this.email; }
  hasValidToken() { return !!(this.token && this.token.expires_at > Date.now() + 60000); }
  scopes() { return [SCOPE_CAL, ...(this.storage ? [SCOPE_DRIVE] : [])].join(' '); }

  // Must run from a click (opens Google's popup). With `chooseAccount`, Google
  // shows its account picker so a different account can be added.
  async signIn({ chooseAccount = false } = {}) {
    await loadGis();
    await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: getClientId(),
        scope: this.scopes(),
        login_hint: !chooseAccount && this.email ? this.email : undefined,
        prompt: chooseAccount ? 'select_account' : '',
        callback: (resp) => {
          if (resp.error) return reject(new AuthError(resp.error_description || resp.error, this.email));
          if (this.storage && !google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE_DRIVE)) {
            return reject(new AuthError('Please tick the box allowing the app to store its own data in Google Drive (needed for “No account” tasks).', this.email));
          }
          this.token = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 60) * 1000 };
          resolve();
        },
        error_callback: (err) => reject(new AuthError(err?.message || err?.type || 'Sign-in was cancelled', this.email)),
      });
      client.requestAccessToken();
    });
    // Who did we just sign in as? The primary calendar's id is the account's email.
    const primary = await this.req(`${CAL_API}/calendars/primary`);
    this.email = primary.id;
  }

  signOut() {
    if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token.access_token, () => {});
    this.token = null;
  }

  async req(url, { method = 'GET', body, query, raw = false, headers = {} } = {}) {
    if (!this.hasValidToken()) throw new AuthError('Session expired', this.email);
    const u = new URL(url);
    if (query) Object.entries(query).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
    const isJson = body !== undefined && !raw;
    const res = await fetch(u, {
      method,
      headers: { Authorization: `Bearer ${this.token.access_token}`, ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
    });
    if (res.status === 401) { this.token = null; throw new AuthError('Session expired', this.email); }
    if (res.status === 204) return null;
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = data?.error?.message || `Google error ${res.status}`;
      if (res.status === 403 && /drive api has not been used|accessNotConfigured|is disabled/i.test(msg)) {
        throw new Error('The Google Drive API is not enabled in your Google Cloud project yet (needed for “No account” tasks). See the README.');
      }
      throw new Error(msg);
    }
    return data;
  }
}

// ---------------------------------------------------------------------------
// A To-Do calendar in one Google account
// ---------------------------------------------------------------------------
export class CalendarSource {
  constructor(account, onChange) {
    this.account = account; this.onChange = onChange; this.kind = 'google';
  }
  get id() { return this.account.email; }
  get label() { return this.account.email; }
  get color() { return this.account.color; }
  req(path, opts) { return this.account.req(CAL_API + path, opts); }

  async init() {
    const a = this.account;
    const name = getCalendarName();
    if (a.calendarId) {
      try { await this.req(`/calendars/${encodeURIComponent(a.calendarId)}`); return; } catch (e) { if (e instanceof AuthError) throw e; }
    }
    let pageToken; let found = null;
    do {
      const r = await this.req('/users/me/calendarList', { query: { minAccessRole: 'owner', pageToken } });
      found = r.items.find((c) => c.summary === name) || found;
      pageToken = r.nextPageToken;
    } while (pageToken && !found);
    if (!found) {
      found = await this.req('/calendars', { method: 'POST', body: { summary: name, timeZone: localTimeZone(), description: 'Tasks from my To-Do app' } });
      await this.req(`/users/me/calendarList/${encodeURIComponent(found.id)}`, { method: 'PATCH', query: { colorRgbFormat: true }, body: { backgroundColor: '#dc4c3e', foregroundColor: '#ffffff' } }).catch(() => {});
    }
    a.calendarId = found.id;
    this.onChange?.();
  }

  cal() { return `/calendars/${encodeURIComponent(this.account.calendarId)}/events`; }

  async list(timeMin, timeMax) {
    const out = []; let pageToken;
    do {
      const r = await this.req(this.cal(), {
        query: { singleEvents: true, orderBy: 'startTime', maxResults: 2500, timeMin: parseYmd(timeMin).toISOString(), timeMax: parseYmd(timeMax).toISOString(), pageToken },
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
// Event store with local recurrence expansion. Every write re-reads the latest
// copy first, so edits made on another device aren't overwritten.
// ---------------------------------------------------------------------------
export class EventStore {
  constructor({ id, label, kind, color, persistence }) {
    Object.assign(this, { id, label, kind, color, persistence });
  }
  async init() { await this.persistence.init?.(); }
  load() { return this.persistence.load(); }
  save(list) { return this.persistence.save(list); }
  async mutate(fn) { const all = await this.load(); const res = await fn(all); await this.save(all); return res; }

  async list(timeMin, timeMax) {
    const all = await this.load(); const out = [];
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

  async get(id) { return findOrInstance(await this.load(), id); }

  insert(ev) {
    return this.mutate((all) => {
      const e = clean({ ...JSON.parse(JSON.stringify(ev)), id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), status: 'confirmed' });
      all.push(e); return e;
    });
  }

  patch(id, partial) {
    return this.mutate((all) => {
      let i = all.findIndex((x) => x.id === id);
      if (i < 0) { all.push(findOrInstance(all, id)); i = all.length - 1; } // materialise an occurrence
      all[i] = clean({ ...all[i], ...JSON.parse(JSON.stringify(partial)) });
      return all[i];
    });
  }

  remove(id) {
    return this.mutate((all) => {
      const i = all.findIndex((x) => x.id === id);
      const e = all[i];
      if (e && !e.recurringEventId) { for (let k = all.length - 1; k >= 0; k--) if (all[k].id === id || all[k].recurringEventId === id) all.splice(k, 1); }
      else if (e) e.status = 'cancelled';
      else { const inst = findOrInstance(all, id); inst.status = 'cancelled'; all.push(inst); }
      return null;
    });
  }
}

export class LocalPersistence {
  constructor(key) { this.key = key; }
  async load() { return JSON.parse(localStorage.getItem(this.key) || '[]'); }
  async save(list) { localStorage.setItem(this.key, JSON.stringify(list)); }
}

// One JSON file in the hidden appDataFolder of the storage account's Drive.
// Only this app can see it; it never appears in the user's Drive or calendars.
export class DrivePersistence {
  constructor(account) { this.account = account; this.fileId = null; }
  async init() {
    if (this.fileId) return;
    const r = await this.account.req(`${DRIVE_API}/files`, { query: { spaces: 'appDataFolder', q: "name='tasks.json'", fields: 'files(id)' } });
    if (r.files.length) { this.fileId = r.files[0].id; return; }
    const boundary = 'todo' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'tasks.json', parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n[]\r\n--${boundary}--`;
    const f = await this.account.req(`${DRIVE_UPLOAD}/files`, { method: 'POST', query: { uploadType: 'multipart', fields: 'id' }, body, raw: true, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
    this.fileId = f.id;
  }
  async load() {
    await this.init();
    const data = await this.account.req(`${DRIVE_API}/files/${this.fileId}`, { query: { alt: 'media' } });
    return Array.isArray(data) ? data : [];
  }
  async save(list) {
    await this.init();
    await this.account.req(`${DRIVE_UPLOAD}/files/${this.fileId}`, { method: 'PATCH', query: { uploadType: 'media' }, body: JSON.stringify(list), raw: true, headers: { 'Content-Type': 'application/json' } });
  }
}

// ---------------------------------------------------------------------------
function findOrInstance(all, id) {
  const e = all.find((x) => x.id === id);
  if (e) return e;
  const m = id.match(/^(.*)_(\d{8})$/);
  const master = m && all.find((x) => x.id === m[1]);
  if (master) return instanceOf(master, `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6)}`, id);
  throw new Error('Task not found (it may have been deleted on another device)');
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
    inst.start = { ...master.start, dateTime: date + master.start.dateTime.slice(10) };
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

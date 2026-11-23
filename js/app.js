import { CONFIG } from './config.js';
import { today, addDays, diffDays, fmtRelative, fmtLong, fmtTime, parseYmd, weekday, WD_CODES, MONTHS } from './dates.js';
import { parseQuickAdd } from './parser.js';
import { eventToTask, taskToEvent, rruleToRecurrence, describeRecurrence, DONE_PREFIX } from './meta.js';
import {
  AuthError, getClientId, getCalendarName, NO_ACCOUNT,
  GoogleAccount, CalendarSource, EventStore, LocalPersistence, DrivePersistence,
  loadAccounts, saveAccounts, nextColor,
} from './gcal.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = (k) => `todo.${k}`;
const ICON = {
  check: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v10H5z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .6.2 1.1.6 1.4l9 9a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8zM6.5 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 21V4h9l.4 2H20v10h-7l-.4-2H7v7z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.2V21h3.8l11-11-3.8-3.8zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
  today: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#058527" d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v10H5z"/><text x="12" y="17.5" font-size="8" text-anchor="middle" fill="#058527" font-family="sans-serif" font-weight="700">TD</text></svg>',
  upcoming: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#692ec2" d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v10H5zm2 2h4v4H7z"/></svg>',
  all: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#246fe0" d="M4 5h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 6h2v2H4zm4 0h12v2H8z"/></svg>',
};
const PRIO_NAMES = { 1: 'Priority 1', 2: 'Priority 2', 3: 'Priority 3', 4: 'Priority 4' };
const PRIO_COLORS = { 1: 'var(--p1)', 2: 'var(--p2)', 3: 'var(--p3)', 4: 'var(--p4)' };
const NO_ACCOUNT_LABEL = 'No account';
const NO_ACCOUNT_COLOR = '#808080';

const state = {
  mode: null,              // 'google' | 'demo'
  accounts: [],            // GoogleAccount[]
  sources: new Map(),      // id → source (one per account, plus NO_ACCOUNT)
  ready: new Set(),        // source ids that finished init()
  bySource: new Map(),     // id → tasks[]
  expired: new Set(),      // account emails that need reconnecting
  tasks: [],
  view: { type: localStorage.getItem(LS('view')) || 'today' },
  showCompleted: localStorage.getItem(LS('showCompleted')) === '1',
  search: '',
  weekStart: null,
  lastSync: null,
  syncing: false,
};

// ===========================================================================
// Boot
// ===========================================================================
const params = new URLSearchParams(location.search);
if (params.get('add')) {
  const pending = JSON.parse(localStorage.getItem(LS('pendingAdds')) || '[]');
  pending.push(params.get('add'));
  localStorage.setItem(LS('pendingAdds'), JSON.stringify(pending));
}
const openNewOnStart = params.get('new') === '1';
if (params.get('view')) state.view = { type: params.get('view') };
if ([...params.keys()].length) history.replaceState(null, '', location.pathname);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function boot() {
  if (localStorage.getItem(LS('mode')) === 'demo') { state.mode = 'demo'; buildSources(); return start(); }
  if (!getClientId()) return showSetup();
  state.mode = 'google';
  state.accounts = loadAccounts();
  if (!state.accounts.length || !state.accounts.some((a) => a.hasValidToken())) return showSignIn();
  buildSources();
  start();
}

function buildSources() {
  const old = state.sources;
  state.sources = new Map();
  if (state.mode === 'demo') {
    const demo = [
      { id: 'me@gmail.com', color: '#dc4c3e', key: 'demoEvents' },
      { id: 'me@ualberta.ca', color: '#246fe0', key: 'demoEvents2' },
      { id: NO_ACCOUNT, label: NO_ACCOUNT_LABEL, color: NO_ACCOUNT_COLOR, key: 'demoNone' },
    ];
    for (const d of demo) state.sources.set(d.id, new EventStore({ id: d.id, label: d.label || d.id, kind: 'demo', color: d.color, persistence: new LocalPersistence(LS(d.key)) }));
  } else {
    for (const a of state.accounts) state.sources.set(a.email, old.get(a.email)?.account === a ? old.get(a.email) : new CalendarSource(a, persistAccounts));
    const storage = storageAccount();
    if (storage) {
      const prev = old.get(NO_ACCOUNT);
      state.sources.set(NO_ACCOUNT, prev?.account === storage ? prev : Object.assign(
        new EventStore({ id: NO_ACCOUNT, label: NO_ACCOUNT_LABEL, kind: 'drive', color: NO_ACCOUNT_COLOR, persistence: new DrivePersistence(storage) }),
        { account: storage }));
    }
  }
  for (const id of [...state.ready]) if (!state.sources.has(id)) state.ready.delete(id);
  for (const id of [...state.bySource.keys()]) if (!state.sources.has(id)) state.bySource.delete(id);
}

const storageAccount = () => state.accounts.find((a) => a.storage) || null;
const accountOf = (sourceId) => state.sources.get(sourceId)?.account || null;
function persistAccounts() { if (state.mode === 'google') saveAccounts(state.accounts); }

function sourceLabel(id) { return id === NO_ACCOUNT ? NO_ACCOUNT_LABEL : id; }
function sourceShort(id) { return id === NO_ACCOUNT ? NO_ACCOUNT_LABEL : id.split('@')[0] + '@' + (id.split('@')[1] || '').split('.')[0]; }
function sourceColor(id) { return state.sources.get(id)?.color || NO_ACCOUNT_COLOR; }

function defaultSource() {
  const saved = localStorage.getItem(LS('defaultSource'));
  if (saved && state.sources.has(saved)) return saved;
  return [...state.sources.keys()][0] || NO_ACCOUNT;
}

function showScreen(html) {
  $('#app').hidden = true;
  const s = $('#screen'); s.hidden = false; s.innerHTML = html;
  return s;
}

function showSetup(error = '') {
  const origin = location.origin;
  const s = showScreen(`
    <div class="card">
      <img src="icons/icon.svg" width="48" height="48" alt="">
      <h1>Connect Google Calendar</h1>
      <p>Your tasks are stored as events on a <b>“${esc(getCalendarName())}”</b> calendar in your Google account, so they sync everywhere automatically. One-time setup (about 10 minutes):</p>
      <ol>
        <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console</a> and create a project (e.g. “todo-app”).</li>
        <li>Enable the <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> and the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a>.</li>
        <li>Under <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a>, set up branding (app name “To-Do”, your email), audience <b>External</b>, and add every Google account you'll use as a <b>Test user</b>.</li>
        <li>Under <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Clients</a>, create an OAuth client of type <b>Web application</b> with the authorized JavaScript origin <code>${esc(origin)}</code>.</li>
        <li>Paste the Client ID below.</li>
      </ol>
      <div class="row">
        <input type="text" id="client-id" placeholder="xxxxxxxx.apps.googleusercontent.com">
        <button class="btn primary" id="save-client">Continue</button>
      </div>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <details><summary>Just want to look around first?</summary>
        <p>Demo mode stores tasks only in this browser, without touching Google Calendar.</p>
        <button class="btn ghost" id="demo">Try demo mode</button>
      </details>
    </div>`);
  $('#save-client', s).onclick = () => {
    const v = $('#client-id', s).value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) return showSetup('That doesn’t look like a Client ID (it ends with .apps.googleusercontent.com).');
    localStorage.setItem(LS('clientId'), v);
    boot();
  };
  $('#demo', s).onclick = enterDemo;
}

function enterDemo() { localStorage.setItem(LS('mode'), 'demo'); seedDemo(); boot(); }

function showSignIn() {
  const known = state.accounts;
  const s = showScreen(`
    <div class="card" style="text-align:center">
      <img src="icons/icon.svg" width="56" height="56" alt="">
      <h1>To-Do</h1>
      <p>${known.length ? 'Your Google session expired. Reconnect to load your tasks.' : 'Sign in with Google to load your tasks from Google Calendar.'}</p>
      ${pendingAdds().length ? `<p><b>Waiting to add:</b> ${pendingAdds().map(esc).join(', ')}</p>` : ''}
      <div class="row" style="justify-content:center;flex-direction:column;align-items:center">
        ${known.length
          ? known.map((a, i) => `<button class="btn primary big" data-i="${i}">Reconnect ${esc(a.email || 'Google account')}</button>`).join('')
          : '<button class="btn primary big" data-i="new">Connect Google Calendar</button>'}
      </div>
      <p id="err" class="error"></p>
      <details><summary>Other options</summary>
        <div class="row" style="justify-content:center">
          <button class="btn ghost" id="change-client">Change Client ID</button>
          <button class="btn ghost" id="demo">Demo mode</button>
        </div>
      </details>
    </div>`);
  $$('[data-i]', s).forEach((b) => b.onclick = async () => {
    try {
      if (b.dataset.i === 'new') await connectNewAccount({ first: true });
      else await reconnect(known[+b.dataset.i]);
      buildSources(); start();
    } catch (e) { $('#err', s).textContent = e.message; }
  });
  $('#change-client', s).onclick = () => { localStorage.removeItem(LS('clientId')); showSetup(); };
  $('#demo', s).onclick = enterDemo;
}

async function connectNewAccount({ first = false } = {}) {
  const acct = new GoogleAccount({ storage: first || !storageAccount(), color: nextColor(state.accounts) });
  await acct.signIn({ chooseAccount: true });
  const existing = state.accounts.find((a) => a.email === acct.email);
  if (existing) { existing.token = acct.token; state.expired.delete(existing.email); }
  else state.accounts.push(acct);
  persistAccounts();
  return existing || acct;
}

async function reconnect(acct) {
  const expected = acct.email;
  const backup = acct.token;
  await acct.signIn();
  if (expected && acct.email !== expected) {
    const other = acct.email; acct.email = expected; acct.token = backup;
    throw new Error(`You signed in as ${other}, but this button reconnects ${expected}. Please pick ${expected}.`);
  }
  state.expired.delete(acct.email);
  persistAccounts();
}

let started = false;
async function start() {
  $('#screen').hidden = true;
  $('#app').hidden = false;
  if (!started) {
    started = true; wireUi();
    setInterval(() => { if (!document.hidden) refresh(); }, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  render();
  await refresh();
  await processPendingAdds();
  if (openNewOnStart) openEditor();
}

function pendingAdds() { return JSON.parse(localStorage.getItem(LS('pendingAdds')) || '[]'); }

async function processPendingAdds() {
  const list = pendingAdds();
  if (!list.length) return;
  const target = defaultSource();
  if (!canWrite(target)) return; // wait until that account is reconnected
  localStorage.removeItem(LS('pendingAdds'));
  for (const text of list) {
    const p = parseQuickAdd(text);
    await createTask({ name: p.name || text, description: p.description, date: p.date || today(), time: p.time, priority: p.priority, labels: p.labels, recurrence: p.recurrence, done: false, source: target }, { quiet: true });
  }
  toast(list.length === 1 ? `Added “${parseQuickAdd(list[0]).name || list[0]}”` : `Added ${list.length} tasks`);
}

// ===========================================================================
// Data
// ===========================================================================
function canWrite(sourceId) {
  const acct = accountOf(sourceId);
  return !acct || (acct.hasValidToken() && !state.expired.has(acct.email));
}

async function refresh() {
  if (state.syncing) return;
  setSyncing(true);
  const t = today();
  const [from, to] = [addDays(t, -CONFIG.FETCH_DAYS_BACK), addDays(t, CONFIG.FETCH_DAYS_AHEAD)];
  await Promise.all([...state.sources.values()].map(async (src) => {
    const acct = src.account;
    if (acct && !acct.hasValidToken()) { state.expired.add(acct.email); return; }
    try {
      if (!state.ready.has(src.id)) { await src.init(); state.ready.add(src.id); }
      const events = await src.list(from, to);
      state.bySource.set(src.id, events.map((ev) => {
        const task = eventToTask(ev);
        task.source = src.id; task.key = `${src.id}::${task.id}`;
        task.seriesKey = task.seriesId ? `${src.id}::${task.seriesId}` : null;
        return task;
      }).filter((x) => x.date));
    } catch (e) {
      if (e instanceof AuthError) state.expired.add(acct?.email || e.email);
      else { console.error(e); toast(`${sourceLabel(src.id)}: ${e.message}`); }
    }
  }));
  rebuildTasks();
  state.lastSync = new Date();
  setSyncing(false);
  updateBanner();
  render();
}

function rebuildTasks() { state.tasks = [...state.bySource.values()].flat(); }

function handleError(e) {
  console.error(e);
  if (e instanceof AuthError) { state.expired.add(e.email); updateBanner(); toast(`Please reconnect ${e.email || 'your Google account'} and try again.`); }
  else toast(e.message || 'Something went wrong');
}

function updateBanner() {
  const list = state.accounts.filter((a) => state.expired.has(a.email));
  const b = $('#banner');
  if (!list.length) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<span>Reconnect to sync:</span>${list.map((a) => `<button data-email="${esc(a.email)}">${esc(a.email)}</button>`).join('')}`;
  $$('button', b).forEach((btn) => btn.onclick = async () => {
    const acct = state.accounts.find((a) => a.email === btn.dataset.email);
    try { await reconnect(acct); state.ready.delete(acct.email); if (acct.storage) state.ready.delete(NO_ACCOUNT); await refresh(); await processPendingAdds(); }
    catch (err) { toast(err.message); }
  });
}

function setSyncing(on) {
  state.syncing = on;
  $('[data-action="refresh"]')?.classList.toggle('spin', on);
  const el = $('#sync-status');
  if (!el) return;
  const where = state.mode === 'demo' ? 'Demo mode' : '';
  el.textContent = on ? 'Syncing…' : state.lastSync ? `${where ? where + ' · ' : ''}Synced ${state.lastSync.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : where;
}

const sortTasks = (a, b) =>
  (a.date || '').localeCompare(b.date || '') ||
  (a.done - b.done) ||
  ((a.time ? 0 : 1) - (b.time ? 0 : 1)) || (a.time || '').localeCompare(b.time || '') ||
  (a.priority - b.priority) || a.name.localeCompare(b.name);

const visible = (t) => state.showCompleted || !t.done;

// Overdue = undone and before today. For a repeating task, only its most
// recent past occurrence counts, and only if it has no occurrence today.
function overdue() {
  const td = today();
  const latestPast = new Map();
  const out = [];
  for (const t of state.tasks) {
    if (t.date >= td) continue;
    if (!t.recurring) { if (!t.done) out.push(t); continue; }
    const prev = latestPast.get(t.seriesKey);
    if (!prev || t.date > prev.date) latestPast.set(t.seriesKey, t);
  }
  for (const t of latestPast.values()) {
    if (!t.done && !state.tasks.some((x) => x.seriesKey === t.seriesKey && x.date === td)) out.push(t);
  }
  return out.sort(sortTasks);
}

const allLabels = () => [...new Set(state.tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));

// ===========================================================================
// Rendering
// ===========================================================================
function render() {
  renderSidebar();
  renderContent();
}

function navLink(type, label, icon, count, extra = '') {
  const active = viewKey(state.view) === type && !state.search;
  return `<a data-view="${esc(type)}" class="${active ? 'active' : ''}" ${extra}><span class="ico">${icon}</span>${esc(label)}${count ? `<span class="count">${count}</span>` : ''}</a>`;
}
const viewKey = (v) => v.type;

function renderSidebar() {
  const td = today();
  const todayCount = overdue().length + state.tasks.filter((t) => t.date === td && !t.done).length;
  const upcomingCount = dedupeRecurring(state.tasks.filter((t) => t.date > td && !t.done && diffDays(td, t.date) < 7)).length;
  $('#nav-main').innerHTML =
    navLink('today', 'Today', ICON.today, todayCount) +
    navLink('upcoming', 'Upcoming', ICON.upcoming, upcomingCount) +
    navLink('all', 'All tasks', ICON.all, '');
  // Open tasks (overdue + upcoming), counting each repeating task once
  const undone = dedupeRecurring([...overdue(), ...state.tasks.filter((t) => !t.done && t.date >= td)]);
  $('#nav-priorities').innerHTML = [1, 2, 3, 4].map((p) =>
    navLink(`priority:${p}`, PRIO_NAMES[p], `<span style="color:${PRIO_COLORS[p]};display:grid">${ICON.flag.replace('<svg', '<svg width="16" height="16"')}</span>`,
      undone.filter((t) => t.priority === p && !t.done).length || '')).join('');
  const labels = allLabels();
  $('#nav-labels').innerHTML = labels.length
    ? labels.map((l) => navLink(`label:${l}`, l, `<span style="color:var(--week);display:grid">${ICON.tag.replace('<svg', '<svg width="15" height="15"')}</span>`, undone.filter((t) => !t.done && t.labels.includes(l)).length || '')).join('')
    : '<div style="padding:4px 8px;color:var(--muted);font-size:12px">Add labels with #name when creating a task.</div>';
  const multi = state.sources.size > 1;
  $('#accounts-wrap').hidden = !multi;
  if (multi) {
    $('#nav-accounts').innerHTML = [...state.sources.keys()].map((id) => navLink(`source:${id}`, sourceLabel(id),
      `<span class="acct-dot" style="background:${sourceColor(id)}"></span>`,
      (state.expired.has(id) || (id === NO_ACCOUNT && storageAccount() && state.expired.has(storageAccount().email))) ? '⚠︎' : undone.filter((t) => t.source === id).length || '')).join('');
  }
  $('#show-completed').checked = state.showCompleted;
}

function renderContent() {
  const el = $('#content');
  const td = today();
  let html = '';
  const v = state.view;

  if (state.search) {
    const q = state.search.toLowerCase();
    const res = state.tasks.filter((t) => visible(t) && (t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.labels.some((l) => l.toLowerCase().includes(q))));
    html = title(`Search: “${state.search}”`, `${res.length} result${res.length === 1 ? '' : 's'}`) + groupedByDay(dedupeRecurring(res), { addButtons: false });
  } else if (v.type === 'today') {
    const od = overdue();
    const list = state.tasks.filter((t) => t.date === td && visible(t)).sort(sortTasks);
    html = title('Today', fmtLong(td));
    if (od.length) html += section('Overdue', '', od, { cls: 'overdue', action: '<button class="act" data-action="reschedule-overdue">Reschedule to today</button>', showDate: true });
    html += section(od.length ? `${fmtLong(td)} · Today` : '', '', list, { date: td, add: true, hideHead: !od.length });
    if (!od.length && !list.length) html += empty('You’re all done for today!', 'Enjoy the rest of your day.');
  } else if (v.type === 'upcoming') {
    if (!state.weekStart || state.weekStart < td && diffDays(state.weekStart, td) >= 7) state.weekStart = td;
    html = title('Upcoming', `${MONTHS[parseYmd(state.weekStart).getMonth()]} ${parseYmd(state.weekStart).getFullYear()}`) + weekStrip();
    const od = overdue();
    if (od.length && state.weekStart <= td) html += section('Overdue', '', od, { cls: 'overdue', action: '<button class="act" data-action="reschedule-overdue">Reschedule</button>', showDate: true });
    const startDay = state.weekStart < td ? td : state.weekStart;
    const shown = new Set();
    for (let i = 0; i < 14; i++) {
      const d = addDays(startDay, i); shown.add(d);
      html += section(dayHeading(d), '', state.tasks.filter((t) => t.date === d && visible(t)).sort(sortTasks), { date: d, add: true, id: `day-${d}` });
    }
    const later = state.tasks.filter((t) => t.date > addDays(startDay, 13) && visible(t) && !t.recurring);
    if (later.length) html += groupedByDay(later, { addButtons: true });
  } else if (v.type === 'all') {
    const od = overdue();
    html = title('All tasks', 'Everything ahead of you, by day');
    if (od.length) html += section('Overdue', '', od, { cls: 'overdue', showDate: true });
    const list = dedupeRecurring(state.tasks.filter((t) => t.date >= td && visible(t)));
    html += groupedByDay(list, { addButtons: true }) || empty('Nothing planned', 'Add a task to get started.');
  } else if (v.type.startsWith('priority:')) {
    const p = +v.type.split(':')[1];
    const list = [...overdue(), ...state.tasks.filter((t) => t.date >= td && visible(t))].filter((t) => t.priority === p);
    html = title(PRIO_NAMES[p], `${list.filter((t) => !t.done).length} open`) + (groupedByDay(dedupeRecurring(list), { addButtons: false, preset: { priority: p } }) || empty('No tasks with this priority', ''));
  } else if (v.type.startsWith('source:')) {
    const id = v.type.slice(7);
    const list = [...overdue(), ...state.tasks.filter((t) => t.date >= td && visible(t))].filter((t) => t.source === id);
    const sub = id === NO_ACCOUNT ? 'Private tasks, synced but not on any calendar' : `${list.filter((t) => !t.done).length} open · “${getCalendarName()}” calendar`;
    html = title(sourceLabel(id), sub) + (groupedByDay(dedupeRecurring(list), { addButtons: true, preset: { source: id } }) || empty('No tasks here yet', ''));
  } else if (v.type.startsWith('label:')) {
    const l = v.type.slice(6);
    const list = [...overdue(), ...state.tasks.filter((t) => t.date >= td && visible(t))].filter((t) => t.labels.includes(l));
    html = title(`#${l}`, `${list.filter((t) => !t.done).length} open`) + (groupedByDay(dedupeRecurring(list), { addButtons: false, preset: { labels: [l] } }) || empty('No tasks with this label', ''));
  }
  el.innerHTML = `<div class="content-inner">${html}</div>`;
}

// In filtered lists, show only the next occurrence of each repeating task
function dedupeRecurring(list) {
  const seen = new Set();
  return list.sort(sortTasks).filter((t) => {
    if (!t.recurring) return true;
    if (seen.has(t.seriesKey)) return false;
    seen.add(t.seriesKey); return true;
  });
}

function title(t, sub) { return `<div class="view-title"><h1>${esc(t)}</h1><span class="sub">${esc(sub)}</span></div>`; }
function empty(a, b) { return `<div class="empty"><div class="big">✓</div><div><b>${esc(a)}</b></div><div>${esc(b)}</div></div>`; }
function dayHeading(d) {
  const rel = fmtRelative(d);
  const long = fmtLong(d);
  return rel === 'Today' || rel === 'Tomorrow' ? `${long} · ${rel}` : long;
}

function groupedByDay(list, { addButtons, preset } = {}) {
  const td = today();
  const by = new Map();
  for (const t of list.sort(sortTasks)) {
    const key = t.date < td && !t.done ? 'overdue' : t.date;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(t);
  }
  let html = '';
  if (by.has('overdue')) { html += section('Overdue', '', by.get('overdue'), { cls: 'overdue', showDate: true }); by.delete('overdue'); }
  for (const [d, tasks] of [...by.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    html += section(dayHeading(d), '', tasks, { date: d, add: addButtons, preset, id: `day-${d}` });
  }
  return html;
}

function section(heading, sub, tasks, { cls = '', action = '', date, add, showDate, hideHead, id, preset } = {}) {
  const head = hideHead ? '' : `<div class="section-head"><h2>${esc(heading)}</h2><span class="sub">${esc(sub || (tasks.length ? '' : ''))}</span>${action}</div>`;
  const rows = tasks.map((t) => taskRow(t, { showDate })).join('');
  const addBtn = add ? `<button class="add-inline" data-action="new" data-date="${date || ''}" ${preset ? `data-preset='${esc(JSON.stringify(preset))}'` : ''}><span class="plus">+</span> Add task</button>` : '';
  return `<div class="section ${cls}" ${id ? `id="${id}"` : ''}>${head}${rows}${addBtn}</div>`;
}

function dateClass(d) {
  const td = today();
  if (d < td) return 'overdue';
  if (d === td) return 'today';
  if (d === addDays(td, 1)) return 'tomorrow';
  if (diffDays(td, d) < 7) return 'week';
  return '';
}

function taskRow(t, { showDate } = {}) {
  const meta = [];
  const td = today();
  if (showDate || t.date !== td || t.time) {
    const label = (showDate || t.date !== td ? fmtRelative(t.date) : '') + (t.time ? `${showDate || t.date !== td ? ' ' : ''}${fmtTime(t.time)}` : '');
    if (label) meta.push(`<span class="date ${t.done ? '' : dateClass(t.date)}">${ICON.cal}${esc(label)}</span>`);
  }
  if (t.recurring) meta.push(`<span title="Repeats">${ICON.repeat}</span>`);
  t.labels.forEach((l) => meta.push(`<span class="lbl">${ICON.tag}${esc(l)}</span>`));
  if (state.sources.size > 1 && !state.view.type.startsWith('source:')) meta.push(`<span class="acct" title="${esc(sourceLabel(t.source))}"><span class="acct-dot" style="background:${sourceColor(t.source)}"></span>${esc(sourceShort(t.source))}</span>`);
  const firstLine = t.description.split('\n').find((x) => x.trim()) || '';
  return `<div class="task p${t.priority} ${t.done ? 'done' : ''}" data-id="${esc(t.key)}">
    <button class="check" data-action="toggle" aria-label="${t.done ? 'Mark not done' : 'Complete'}">${ICON.check}</button>
    <div class="t-body">
      <div class="t-name">${esc(t.name)}</div>
      ${firstLine ? `<div class="t-desc">${esc(firstLine)}</div>` : ''}
      ${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}
    </div>
    <div class="task-actions">
      <button class="icon-btn" data-action="edit" aria-label="Edit">${ICON.edit}</button>
      <button class="icon-btn" data-action="delete" aria-label="Delete">${ICON.trash}</button>
    </div>
  </div>`;
}

function weekStrip() {
  const td = today();
  const ws = addDays(state.weekStart, -((weekday(state.weekStart) + 6) % 7)); // Monday
  let days = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const has = state.tasks.some((t) => t.date === d && !t.done);
    days += `<button class="day ${d === td ? 'is-today' : ''} ${d < td ? 'past' : ''} ${has ? 'has' : ''}" data-action="jump" data-date="${d}">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]}<b>${parseYmd(d).getDate()}</b><span class="dot"></span></button>`;
  }
  return `<div class="week">
    <button class="icon-btn" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
    <div class="days">${days}</div>
    <button class="icon-btn" data-action="week" data-dir="1" aria-label="Next week">›</button>
    <button class="btn ghost" data-action="week" data-dir="0" style="padding:4px 10px">Today</button>
  </div>`;
}

// ===========================================================================
// Actions
// ===========================================================================
const findTask = (key) => state.tasks.find((t) => t.key === key);
const src = (t) => state.sources.get(t.source);

function setSourceTasks(id, fn) {
  state.bySource.set(id, fn(state.bySource.get(id) || []));
  rebuildTasks();
}

async function createTask(data, { quiet } = {}) {
  const sourceId = data.source && state.sources.has(data.source) ? data.source : defaultSource();
  const temp = { ...data, source: sourceId, id: 'tmp' + Math.random(), recurring: !!data.recurrence, seriesId: null };
  temp.key = `${sourceId}::${temp.id}`; temp.seriesKey = null;
  setSourceTasks(sourceId, (l) => [...l, temp]); render();
  try {
    await state.sources.get(sourceId).insert(taskToEvent(data, { durationMin: CONFIG.DEFAULT_DURATION_MIN }));
    if (!quiet) toast(`Added “${data.name}”${data.date !== today() ? ` · ${fmtRelative(data.date)}` : ''}${state.sources.size > 1 ? ` · ${sourceShort(sourceId)}` : ''}`);
  } catch (e) {
    setSourceTasks(sourceId, (l) => l.filter((t) => t !== temp)); render(); handleError(e);
  }
  await refresh();
}

async function toggleDone(t) {
  const before = t.done;
  t.done = !t.done; render();
  try {
    await src(t).patch(t.id, {
      summary: (t.done ? DONE_PREFIX : '') + t.name,
      extendedProperties: { private: { todoApp: '1', done: t.done ? '1' : '0' } },
    });
    if (t.done) toast(`Completed “${t.name}”`, 'Undo', () => toggleDone(findTask(t.key) || t));
    refresh();
  } catch (e) { t.done = before; render(); handleError(e); }
}

async function deleteTask(t) {
  let scope = 'this';
  if (t.recurring) {
    scope = await choose(`Delete the repeating task “${t.name}”?`, [
      { value: 'this', label: 'Only this occurrence' },
      { value: 'all', label: 'All occurrences', cls: 'danger' },
      { value: '', label: 'Cancel' },
    ]);
    if (!scope) return false;
  } else {
    const ok = await choose(`Delete “${t.name}”?`, [{ value: 'yes', label: 'Delete', cls: 'danger' }, { value: '', label: 'Cancel' }]);
    if (!ok) return false;
  }
  const backup = state.bySource.get(t.source) || [];
  setSourceTasks(t.source, (l) => l.filter((x) => scope === 'all' ? x.seriesId !== t.seriesId : x.id !== t.id));
  render();
  try { await src(t).remove(scope === 'all' ? t.seriesId : t.id); toast('Task deleted'); refresh(); }
  catch (e) { state.bySource.set(t.source, backup); rebuildTasks(); render(); handleError(e); }
  return true;
}

async function rescheduleOverdue() {
  const td = today();
  const list = overdue();
  list.forEach((t) => { t.date = td; });
  render();
  try {
    for (const t of list) {
      const ev = taskToEvent({ ...t }, { durationMin: CONFIG.DEFAULT_DURATION_MIN, includeRecurrence: false });
      await src(t).patch(t.id, { start: ev.start, end: ev.end });
    }
    toast(`Moved ${list.length} task${list.length === 1 ? '' : 's'} to today`);
  } catch (e) { handleError(e); }
  refresh();
}

// Move a task (or a whole repeating series) to another account
async function moveTask(t, data, toId) {
  const from = src(t); const to = state.sources.get(toId);
  let payload = { ...data };
  if (t.recurring) {
    const master = ed.master || await from.get(t.seriesId);
    const masterDate = (master.start.date || master.start.dateTime).slice(0, 10);
    payload = { ...payload, done: false, date: data.date !== t.__origDate ? data.date : masterDate };
  }
  await to.insert(taskToEvent(payload, { durationMin: CONFIG.DEFAULT_DURATION_MIN }));
  await from.remove(t.recurring ? t.seriesId : t.id);
  toast(`Moved to ${sourceLabel(toId)}`);
}

// ===========================================================================
// Editor
// ===========================================================================
const ed = {
  mode: 'add', task: null, priority: 4, labels: [], byday: [], touched: new Set(), master: null,
};

function buildEditorStatic() {
  $('#f-priority').innerHTML = [1, 2, 3, 4].map((p) =>
    `<button type="button" data-p="${p}" style="color:${PRIO_COLORS[p]}" title="${PRIO_NAMES[p]}">${ICON.flag}P${p}</button>`).join('');
  $('#days-row').innerHTML = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((c) =>
    `<button type="button" data-d="${c}">${c[0]}${c[1].toLowerCase()}</button>`).join('');
}

function setPriority(p) { ed.priority = p; $$('#f-priority button').forEach((b) => b.classList.toggle('on', +b.dataset.p === p)); }
function renderLabels() {
  $('#f-labels').innerHTML = ed.labels.map((l) => `<span class="lbl-chip">#${esc(l)}<button type="button" data-rm="${esc(l)}" aria-label="Remove">×</button></span>`).join('');
  $('#label-list').innerHTML = allLabels().filter((l) => !ed.labels.includes(l)).map((l) => `<option value="${esc(l)}">`).join('');
}
function setDays(days) { ed.byday = [...days]; $$('#days-row button').forEach((b) => b.classList.toggle('on', ed.byday.includes(b.dataset.d))); }

function setRepeatFromRecurrence(rec) {
  const sel = $('#f-repeat');
  if (!rec) { sel.value = ''; }
  else if (rec.freq === 'WEEKLY' && rec.byday.join(',') === 'MO,TU,WE,TH,FR' && rec.interval === 1) sel.value = 'WEEKDAYS';
  else if (rec.interval === 1) sel.value = rec.freq;
  else sel.value = 'CUSTOM';
  $('#f-interval').value = rec?.interval || 1;
  $('#f-unit').value = rec?.freq || 'DAILY';
  setDays(rec?.byday || []);
  $('#f-until').value = rec?.until || '';
  updateRepeatUi();
}

function updateRepeatUi() {
  const v = $('#f-repeat').value;
  const unit = v === 'CUSTOM' ? $('#f-unit').value : v;
  $('#repeat-extra').hidden = !v;
  $('#custom-row').hidden = v !== 'CUSTOM';
  $('#days-row').hidden = unit !== 'WEEKLY';
  if (unit === 'WEEKLY' && !ed.byday.length && $('#f-date').value) setDays([WD_CODES[weekday($('#f-date').value)]]);
}

function readRecurrence() {
  const v = $('#f-repeat').value;
  if (!v) return null;
  const until = $('#f-until').value || null;
  if (v === 'WEEKDAYS') return { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'], until };
  const freq = v === 'CUSTOM' ? $('#f-unit').value : v;
  const interval = v === 'CUSTOM' ? Math.max(1, +$('#f-interval').value || 1) : 1;
  return { freq, interval, byday: freq === 'WEEKLY' ? ed.byday : [], until };
}

async function openEditor(task = null, defaults = {}) {
  const dlg = $('#editor');
  ed.mode = task ? 'edit' : 'add';
  ed.task = task; ed.touched = new Set(); ed.master = null;
  $('#f-name').value = task?.name || '';
  $('#f-desc').value = task?.description || '';
  $('#f-date').value = task?.date || defaults.date || today();
  $('#f-time').value = task?.time || '';
  setPriority(task?.priority || defaults.priority || 4);
  ed.labels = [...(task?.labels || defaults.labels || [])];
  renderLabels();
  setRepeatFromRecurrence(null);
  const accSel = $('#f-account');
  accSel.innerHTML = [...state.sources.keys()].map((id) => {
    const blocked = !canWrite(id);
    return `<option value="${esc(id)}" ${blocked ? 'disabled' : ''}>${esc(sourceLabel(id))}${id === NO_ACCOUNT ? ' (private, not on a calendar)' : ''}${blocked ? ' — reconnect first' : ''}</option>`;
  }).join('');
  accSel.value = task?.source || (defaults.source && state.sources.has(defaults.source) ? defaults.source : defaultSource());
  $('#account-field').hidden = state.sources.size < 2;
  $('#f-chips').innerHTML = '';
  $('#f-save').textContent = task ? 'Save' : 'Add task';
  $('#f-delete').hidden = !task;
  $('#scope').hidden = !task?.recurring;
  $$('input[name=scope]').forEach((r) => { r.checked = r.value === 'this'; });
  const gl = $('#f-gcal');
  gl.hidden = !task?.htmlLink; if (task?.htmlLink) gl.href = task.htmlLink;
  if (!dlg.open) dlg.showModal();
  $('#f-name').focus();
  if (task?.recurring && task.seriesId) {
    try {
      ed.master = await src(task).get(task.seriesId);
      if (ed.task === task) setRepeatFromRecurrence(rruleToRecurrence(ed.master.recurrence));
    } catch (e) { console.warn(e); }
  }
}

function onNameInput() {
  if (ed.mode !== 'add') return;
  const p = parseQuickAdd($('#f-name').value);
  const chips = [];
  if (p.date && p.chips.some((c) => c.type === 'date')) { if (!ed.touched.has('date')) $('#f-date').value = p.date; chips.push(['date', fmtRelative(p.date)]); }
  else if (p.recurrence && !ed.touched.has('date')) $('#f-date').value = p.date;
  if (p.time) { if (!ed.touched.has('time')) $('#f-time').value = p.time; chips.push(['date', fmtTime(p.time)]); }
  if (p.chips.some((c) => c.type === 'priority')) { if (!ed.touched.has('priority')) setPriority(p.priority); chips.push(['priority', `P${p.priority}`]); }
  if (p.labels.length) chips.push(...p.labels.map((l) => ['label', `#${l}`]));
  if (p.recurrence) { if (!ed.touched.has('repeat')) setRepeatFromRecurrence(p.recurrence); chips.push(['repeat', describeRecurrence(p.recurrence)]); }
  if (p.description) chips.push(['', 'description: ' + p.description.slice(0, 40)]);
  $('#f-chips').innerHTML = chips.map(([c, t]) => `<span class="chip ${c}">${esc(t)}</span>`).join('');
}

async function saveEditor() {
  let name = $('#f-name').value.trim();
  let description = $('#f-desc').value;
  let labels = [...ed.labels];
  const pending = $('#f-label-text').value.trim().replace(/^#/, '');
  if (pending && !labels.includes(pending)) labels.push(pending);
  if (ed.mode === 'add') {
    const p = parseQuickAdd(name);
    if (p.name) name = p.name;
    p.labels.forEach((l) => { if (!labels.includes(l)) labels.push(l); });
    if (p.description) description = description ? `${p.description}\n${description}` : p.description;
  }
  if (!name) return;
  const data = {
    name, description, labels,
    date: $('#f-date').value || today(),
    time: $('#f-time').value || null,
    priority: ed.priority,
    recurrence: readRecurrence(),
    done: ed.task?.done || false,
    source: $('#f-account').value || defaultSource(),
  };
  $('#editor').close();

  if (ed.mode === 'add') {
    localStorage.setItem(LS('defaultSource'), data.source);
    return createTask(data);
  }

  const t = ed.task;
  const scope = $('input[name=scope]:checked')?.value || 'this';
  const opts = { durationMin: CONFIG.DEFAULT_DURATION_MIN };
  const origDate = t.date;
  t.__origDate = origDate;
  const moving = data.source !== t.source;
  if (moving && t.recurring) {
    const ok = await choose(`Move all occurrences of “${t.name}” to ${sourceLabel(data.source)}?`, [{ value: 'yes', label: 'Move the whole repeating task' }, { value: '', label: 'Cancel' }]);
    if (!ok) return;
  }
  if (!moving) { Object.assign(t, { ...data, source: t.source }); render(); }
  try {
    if (moving) {
      await moveTask(t, data, data.source);
    } else if (!t.recurring) {
      await src(t).patch(t.id, taskToEvent(data, opts));
    } else if (scope === 'this') {
      await src(t).patch(t.id, taskToEvent(data, { ...opts, includeRecurrence: false }));
    } else {
      const master = ed.master || await src(t).get(t.seriesId);
      const masterDate = (master.start.date || master.start.dateTime).slice(0, 10);
      const seriesDate = data.date !== origDate ? data.date : masterDate;
      await src(t).patch(t.seriesId, taskToEvent({ ...data, done: false, date: seriesDate }, opts));
    }
    if (!moving) toast('Saved');
  } catch (e) { handleError(e); }
  refresh();
}

function choose(text, options) {
  return new Promise((resolve) => {
    const dlg = $('#chooser');
    $('#chooser-text').textContent = text;
    $('#chooser-buttons').innerHTML = options.map((o, i) => `<button class="btn ${o.value ? 'ghost' : ''} ${o.cls || ''}" value="${i}">${esc(o.label)}</button>`).join('');
    dlg.onclose = () => { const i = dlg.returnValue; resolve(i === '' || i == null ? '' : options[+i]?.value || ''); };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// ===========================================================================
// Settings
// ===========================================================================
function openSettings() {
  let dlg = $('#settings');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'settings'; dlg.className = 'settings'; document.body.appendChild(dlg); }
  const demo = state.mode === 'demo';
  const base = location.origin + location.pathname;
  const accountRows = demo
    ? [...state.sources.values()].filter((s) => s.id !== NO_ACCOUNT).map((s) => `<div class="acct-row"><span class="acct-dot" style="background:${s.color}"></span><span>${esc(s.id)}</span><small>demo</small></div>`).join('')
    : state.accounts.map((a) => `<div class="acct-row"><span class="acct-dot" style="background:${a.color}"></span>
        <span>${esc(a.email)}${state.expired.has(a.email) ? ' <small>(reconnect needed)</small>' : ''}${a.storage ? '<br><small>Also holds your “No account” tasks</small>' : ''}</span>
        <div class="spacer"></div>
        ${a.storage && state.accounts.length > 1 ? '' : `<button type="button" class="btn ghost danger" data-remove="${esc(a.email)}">Remove</button>`}
      </div>`).join('');
  dlg.innerHTML = `<form method="dialog">
    <h2>Settings</h2>
    ${demo ? '<div>Mode: <b>Demo</b> (tasks are stored only in this browser)</div>' : ''}
    <div class="field"><span>Google accounts</span>
      <div class="acct-list">${accountRows || '<small>No accounts connected</small>'}</div>
      ${demo ? '' : '<button type="button" class="btn ghost" id="s-add-account" style="align-self:flex-start;margin-top:6px">+ Add another Google account</button>'}
    </div>
    <label>New tasks go to (default)
      <select id="s-default">${[...state.sources.keys()].map((id) => `<option value="${esc(id)}" ${id === defaultSource() ? 'selected' : ''}>${esc(sourceLabel(id))}</option>`).join('')}</select>
    </label>
    <label>Calendar name (in each account)<input type="text" id="s-cal" value="${esc(getCalendarName())}"></label>
    <label>Google OAuth Client ID<input type="text" id="s-client" value="${esc(getClientId())}" placeholder="…apps.googleusercontent.com"></label>
    <div class="kbd">
      <b>Shortcuts:</b> <kbd>q</kbd> add task · <kbd>/</kbd> search · <kbd>t</kbd> Today · <kbd>u</kbd> Upcoming · <kbd>r</kbd> sync<br>
      <b>Quick add from anywhere:</b> open <code>${esc(base)}?add=Buy milk tomorrow p2</code> (goes to the default account)<br>
      <b>Quick add syntax:</b> dates (today, tomorrow, fri, Dec 15, in 3 days), times (5pm, 14:30), p1–p4, #label, every day / every mon, wed / every 2 weeks / until Dec 31, “// description”.
    </div>
    <p id="s-err" class="error"></p>
    <div class="editor-foot">
      ${demo ? '<button class="btn ghost" value="leave-demo">Leave demo mode</button>' : '<button class="btn ghost danger" value="signout">Sign out of all</button>'}
      <div class="spacer"></div>
      <button class="btn ghost" value="cancel">Close</button>
      <button class="btn primary" value="save">Save</button>
    </div></form>`;

  $('#s-add-account', dlg)?.addEventListener('click', async () => {
    try {
      const acct = await connectNewAccount();
      buildSources(); dlg.close('cancel');
      toast(`Connected ${acct.email}`);
      await refresh();
    } catch (e) { $('#s-err', dlg).textContent = e.message; }
  });
  $$('[data-remove]', dlg).forEach((b) => b.addEventListener('click', async () => {
    const email = b.dataset.remove;
    dlg.close('cancel');
    const ok = await choose(`Disconnect ${email}? Its tasks stay in its Google Calendar; they just won't show here.`, [{ value: 'yes', label: 'Disconnect', cls: 'danger' }, { value: '', label: 'Cancel' }]);
    if (!ok) return;
    const acct = state.accounts.find((a) => a.email === email);
    acct.signOut();
    state.accounts = state.accounts.filter((a) => a !== acct);
    state.expired.delete(email);
    if (localStorage.getItem(LS('defaultSource')) === email) localStorage.removeItem(LS('defaultSource'));
    persistAccounts();
    if (!state.accounts.length) return location.reload();
    buildSources(); rebuildTasks(); updateBanner(); render();
  }));

  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v === 'save') {
      localStorage.setItem(LS('defaultSource'), $('#s-default', dlg).value);
      const cal = $('#s-cal', dlg).value.trim(); const cid = $('#s-client', dlg).value.trim();
      const calChanged = cal && cal !== getCalendarName();
      if (cal) localStorage.setItem(LS('calendarName'), cal);
      if (cid && cid !== getClientId()) { localStorage.setItem(LS('clientId'), cid); state.accounts.forEach((a) => { a.token = null; }); persistAccounts(); location.reload(); return; }
      if (calChanged) { state.accounts.forEach((a) => { a.calendarId = null; }); persistAccounts(); location.reload(); }
    } else if (v === 'signout') {
      state.accounts.forEach((a) => a.signOut());
      localStorage.removeItem(LS('accounts')); localStorage.removeItem(LS('defaultSource'));
      location.reload();
    } else if (v === 'leave-demo') {
      localStorage.removeItem(LS('mode')); location.reload();
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ===========================================================================
// UI wiring
// ===========================================================================
function setView(type) {
  state.view = { type }; state.search = ''; $('#search').value = '';
  if (type === 'upcoming') state.weekStart = today();
  localStorage.setItem(LS('view'), type);
  $('#app').classList.remove('sidebar-open');
  render();
  $('#content').scrollTop = 0;
}

function wireUi() {
  buildEditorStatic();

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-view]');
    if (nav) { e.preventDefault(); return setView(nav.dataset.view); }
    const a = e.target.closest('[data-action]');
    const row = e.target.closest('.task');
    if (a) {
      const act = a.dataset.action;
      const t = row && findTask(row.dataset.id);
      if (act === 'new') {
        const preset = a.dataset.preset ? JSON.parse(a.dataset.preset) : {};
        if (state.view.type.startsWith('priority:')) preset.priority ??= +state.view.type.split(':')[1];
        if (state.view.type.startsWith('label:')) preset.labels ??= [state.view.type.slice(6)];
        if (state.view.type.startsWith('source:')) preset.source ??= state.view.type.slice(7);
        return openEditor(null, { date: a.dataset.date || undefined, ...preset });
      }
      if (act === 'toggle' && t) return toggleDone(t);
      if (act === 'edit' && t) return openEditor(t);
      if (act === 'delete' && t) return deleteTask(t);
      if (act === 'refresh') return refresh();
      if (act === 'settings') return openSettings();
      if (act === 'toggle-sidebar') return $('#app').classList.toggle('sidebar-open');
      if (act === 'close-sidebar') return $('#app').classList.remove('sidebar-open');
      if (act === 'reschedule-overdue') return rescheduleOverdue();
      if (act === 'week') {
        const dir = +a.dataset.dir;
        state.weekStart = dir === 0 ? today() : addDays(addDays(state.weekStart, -((weekday(state.weekStart) + 6) % 7)), 7 * dir);
        render(); $('#content').scrollTop = 0; return;
      }
      if (act === 'jump') {
        const d = a.dataset.date;
        if (d < today()) return;
        const target = document.getElementById(`day-${d}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    if (row && !e.target.closest('button')) { const t = findTask(row.dataset.id); if (t) openEditor(t); }
  });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value.trim(); renderContent(); renderSidebar(); });
  $('#show-completed').addEventListener('change', (e) => {
    state.showCompleted = e.target.checked; localStorage.setItem(LS('showCompleted'), e.target.checked ? '1' : '0'); render();
  });

  // Editor
  $('#f-name').addEventListener('input', onNameInput);
  $('#f-date').addEventListener('input', () => ed.touched.add('date'));
  $('#f-time').addEventListener('input', () => ed.touched.add('time'));
  $('#f-repeat').addEventListener('change', () => { ed.touched.add('repeat'); if ($('#f-repeat').value === 'WEEKLY') setDays([]); updateRepeatUi(); });
  $('#f-unit').addEventListener('change', updateRepeatUi);
  $('#f-priority').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ed.touched.add('priority'); setPriority(+b.dataset.p); } });
  $('#days-row').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    ed.touched.add('repeat');
    const d = b.dataset.d;
    const next = ed.byday.includes(d) ? ed.byday.filter((x) => x !== d) : [...ed.byday, d];
    setDays(WD_CODES.filter((c) => next.includes(c)));
    if ($('#f-repeat').value === 'WEEKLY' && next.length > 1) { /* keep WEEKLY with several days */ }
  });
  $$('[data-clear]').forEach((b) => b.addEventListener('click', () => { $('#' + b.dataset.clear).value = ''; ed.touched.add(b.dataset.clear === 'f-time' ? 'time' : 'repeat'); }));
  $('#f-label-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      const v = e.target.value.trim().replace(/^#/, '');
      if (v) { e.preventDefault(); if (!ed.labels.includes(v)) ed.labels.push(v); e.target.value = ''; renderLabels(); }
      else if (e.key === 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !e.target.value && ed.labels.length) { ed.labels.pop(); renderLabels(); }
  });
  $('#f-label-text').addEventListener('change', (e) => {
    const v = e.target.value.trim().replace(/^#/, '');
    if (v && allLabels().includes(v)) { if (!ed.labels.includes(v)) ed.labels.push(v); e.target.value = ''; renderLabels(); }
  });
  $('#f-labels').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { ed.labels = ed.labels.filter((l) => l !== b.dataset.rm); renderLabels(); } });
  $('#editor-form').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
  $('#f-cancel').addEventListener('click', () => $('#editor').close());
  $('#f-delete').addEventListener('click', async () => { const t = ed.task; $('#editor').close(); await deleteTask(t); });
  $('#editor').addEventListener('click', (e) => { if (e.target === $('#editor')) $('#editor').close(); });
  $('#f-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveEditor(); } });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'q' || e.key === 'a') { e.preventDefault(); openEditor(); }
    else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === 't') setView('today');
    else if (e.key === 'u') setView('upcoming');
    else if (e.key === 'r') refresh();
  });
}

// ===========================================================================
// Toast & banner
// ===========================================================================
let toastTimer;
function toast(msg, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) el.querySelector('button').onclick = () => { el.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 5000 : 2500);
}


// ===========================================================================
// Demo data
// ===========================================================================
function seedDemo() {
  if (localStorage.getItem(LS('demoEvents'))) return;
  const td = today();
  const mk = (str, d, extra = {}) => {
    const p = parseQuickAdd(str, td);
    const e = taskToEvent({ name: p.name, description: p.description, date: d ?? p.date ?? td, time: p.time, priority: p.priority, labels: p.labels, recurrence: p.recurrence, done: false, ...extra });
    for (const k of ['start', 'end']) e[k] = Object.fromEntries(Object.entries(e[k]).filter(([, v]) => v != null));
    if (!e.colorId) delete e.colorId;
    if (!e.recurrence.length) delete e.recurrence;
    return { ...e, id: 's' + Math.random().toString(36).slice(2, 10), status: 'confirmed' };
  };
  const put = (key, list) => localStorage.setItem(LS(key), JSON.stringify(list));
  put('demoEvents', [
    mk('Reply to supervisor’s email today p2'),
    mk('Gym every mon, wed and fri 7am #health'),
    mk('Groceries tomorrow #personal'),
    mk('Water plants every 3 days #personal'),
    mk('Read one paper', td, { done: true }),
  ]);
  put('demoEvents2', [
    mk('Finish literature review section p1 #research // Cover the 2024–2026 RL papers', addDays(td, -1)),
    mk('Lab meeting every monday 10am #lab'),
    mk('Submit expense report fri p3 #admin'),
    mk('Paper draft deadline in 10 days p1 #research'),
  ]);
  put('demoNone', [
    mk('Plan birthday surprise sat p2 #personal // Private: not on any calendar'),
    mk('Journal every day 9pm #personal'),
  ]);
}

boot();

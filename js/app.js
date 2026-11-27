// app.js — the whole DuoCal user interface (no framework, no build step).
// WEB VERSION: runs on GitHub Pages; all data lives in your Google calendars
// (see gstore.js). No DuoCal server. Sign-in is Google's (see gauth.js).
// Sections: 1 helpers · 2 data & sync · 3 shell · 4 calendar views ·
// 5 event editor · 6 alarms & ringing · 7 sleep · 8 counters ·
// 9 import/export · 10 settings · 11 auth · 12 background ticker · 13 boot
'use strict';

// ============ 1. helpers ============
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const DAY = 864e5;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PALETTE = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)'];
const PALETTE_NAMES = ['Navy', 'Blue', 'Cyan', 'Teal', 'Green', 'Amber', 'Orange', 'Red'];
const HOUR = 48;
// DuoCal's own icon set: simple line drawings that follow the theme colour (currentColor).
const I = (d, extra = '') => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICON = {
  calendar: I('<rect x="3.5" y="5" width="17" height="15.5" rx="4"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="M12 18.2c-2.2-1.4-3.4-2.6-3.4-3.9a1.6 1.6 0 0 1 3.4-.8 1.6 1.6 0 0 1 3.4.8c0 1.3-1.2 2.5-3.4 3.9z" fill="currentColor" stroke="none"/>'),
  alarm: I('<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.3 1.6"/><path d="M4.2 5.6 6.6 3.4M19.8 5.6l-2.4-2.2"/><path d="M1.8 11.5c.2-1 .6-1.9 1.1-2.7M22.2 11.5c-.2-1-.6-1.9-1.1-2.7"/><path d="M8 20.5l-1 1.5M16 20.5l1 1.5"/>'),
  sleep: I('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/><path d="M15 4.5h3.5L15 8.5h3.5" stroke-width="1.6"/><path d="M20.5 9.2l.5-.9.5.9.9.5-.9.5-.5.9-.5-.9-.9-.5z" fill="currentColor" stroke="none"/>'),
  counters: I('<path d="M7 3h10M7 21h10"/><path d="M8 3c0 4.5 4 5.5 4 9s-4 4.5-4 9M16 3c0 4.5-4 5.5-4 9s4 4.5 4 9"/><path d="M10 18.5h4" stroke-width="2.4"/><path d="M19.5 9.5l.4-.9.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4z" fill="currentColor" stroke="none"/>'),
  data: I('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 13h6M12 10v6"/><path d="M3 15l-1.5 1.5L3 18M21 15l1.5 1.5L21 18" stroke-width="1.6"/>'),
  settings: I('<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>', ' stroke-width="2.4"'),
  left: I('<path d="M14.5 6 8.5 12l6 6"/>', ' stroke-width="2.2"'),
  right: I('<path d="M9.5 6l6 6-6 6"/>', ' stroke-width="2.2"'),
  heart: I('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor" stroke="none"/>'),
  history: I('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4.5l3 1.5"/>'),
};
// Phone layout (narrow screens): compact toolbar, "3 days" instead of a week, dots in month view.
const phone = () => innerWidth < 760;
const weekDays = () => phone() ? 3 : 7; // px per hour in week/day view (matches --hour in CSS)

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtTime = d => use24h() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDateInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTimeInput = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseLocal = (date, time = '00:00') => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return new Date(y, m - 1, d, h, mi); };
const use24h = () => (S.data?.me.settings.clock24 ?? true);
function weekStart(d) { const ws = S.data?.me.settings.weekStart ?? 0; const s = startOfDay(d); return addDays(s, -((s.getDay() - ws + 7) % 7)); }
function durText(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
function toast(msg) {
  const t = document.createElement('div'); t.textContent = msg; $('#toast').append(t);
  setTimeout(() => t.remove(), 3200);
}

// ============ 2. data & sync ============
const S = {
  data: null, page: localStorage.getItem('duocal.page') || 'calendar',
  calView: localStorage.getItem('duocal.calView') || (innerWidth < 760 ? 'day' : 'week'),
  cursor: new Date(), filter: JSON.parse(localStorage.getItem('duocal.filter') || '{}'),
  busy: false, // true while dragging so live updates don't redraw under the mouse
};

// Every request goes to Google through gstore.js (same request names as the old PC server).
async function api(path, opts = {}) {
  try { return await GStore.handle(path, opts); }
  catch (e) { if (e.auth) needReconnect(); throw e; }
}
// Google's access pass lasts an hour. Renewing it is a quick hop to Google and back.
function needReconnect() {
  if ($('#reconnect')) return;
  const b = document.createElement('div'); b.id = 'reconnect';
  b.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:300;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 14px;box-shadow:var(--shadow);display:flex;gap:10px;align-items:center';
  b.innerHTML = '<span class="small">Google sign-in expired</span><button class="btn primary sm">Reconnect</button>';
  b.querySelector('button').onclick = () => GAuth.signIn({ silent: true, hint: GStore.me() || localStorage.getItem('duocal.lastEmail') || undefined });
  document.body.append(b);
}
async function reload() {
  S.data = await api('/api/data');
  applyTheme();
}
const me = () => S.data.me;
const partner = () => S.data.members.find(m => m.id !== me().id);
const member = id => S.data.members.find(m => m.id === id);
const personColor = id => id === me().id ? 'var(--accent)' : 'var(--accent2)'; // me = main colour, partner = second colour
const personInk = id => id === me().id ? 'var(--on-accent)' : 'var(--on-accent2)';
const initials = n => (n || '?').trim().slice(0, 1).toUpperCase();

// Changes from your partner arrive by checking Google every 30 seconds while the app is open
// (and right away when you come back to it).
let pollTimer, pollingBound = false;
async function poll() {
  if (document.hidden || S.busy || !S.data) return;
  if (!GAuth.current()) { needReconnect(); return; }
  try {
    const changed = await GStore.sync();
    if (changed) { await reload(); if (!$('.overlay')) render(); }
    GStore.maintain().catch(() => { });
    showTrustPrompt();
  } catch (e) { if (e.auth) needReconnect(); }
}
function connectStream() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 30000);
  if (!pollingBound) { pollingBound = true; document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); }); }
}
const stream = null;
// ---- time zones (you live in two countries) ----
const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const myTz = () => (S.data && me().settings.tz) || deviceTz();
const tzOf = id => (member(id) && member(id).settings.tz) || deviceTz();
// all-day events are pure dates (midnight UTC); show them on that date wherever you are
const localDay = d => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const utcDay = d => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
// what a clock in zone tz shows at instant d: { hm: '07:30', date: '2026-11-27', dow: 5 }
function clockIn(tz, d = new Date()) { const w = Recur.wallCal(tz).toWall(d); const iso = w.toISOString(); return { hm: iso.slice(11, 16), date: iso.slice(0, 10), dow: w.getUTCDay() }; }
const tzCity = tz => String(tz || '').split('/').pop().replace(/_/g, ' ');
function fmtIn(tz, d, withDay) {
  return d.toLocaleString([], { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: use24h() ? 'h23' : 'h12', ...(withDay ? { weekday: 'short' } : {}) });
}

// ============ 3. shell ============
const PAGES = [
  ['calendar', 'calendar', 'Calendar'], ['alarms', 'alarm', 'Alarms'], ['sleep', 'sleep', 'Sleep'],
  ['counters', 'counters', 'Counters'], ['transfer', 'data', 'Import / Export', 'Data'], ['settings', 'settings', 'Settings'],
];

function render() {
  if (!S.data) return renderAuth();
  const scroll = $('.calscroll')?.scrollTop;
  const p = partner();
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><img src="icon.svg" alt="">DuoCal</div>
      ${PAGES.map(([id, ico, label, short]) => `<button class="nav ${S.page === id ? 'active' : ''}" data-page="${id}"><span class="ico">${ICON[ico]}</span><span class="lbl">${label}</span><span class="lbl-s">${short || label}</span></button>`).join('')}
      <div class="grow"></div>
      <div class="people">
        <div class="muted small">${esc(S.data.household.name)}</div>
        ${S.data.members.map(m => `<div class="person"><span class="avatar" style="background:${personColor(m.id)};color:${personInk(m.id)}">${esc(initials(m.name))}</span><div>${esc(m.name)}${m.id === me().id ? ' <span class="muted">(you)</span>' : ''}<div class="status">${m.id !== me().id && tzOf(m.id) !== myTz() ? `🕐 <span data-tzclock="${esc(tzOf(m.id))}"></span> in ${esc(tzCity(tzOf(m.id)))} ` : ''}${sleepStatus(m.id)}</div></div></div>`).join('')}
        ${p ? '' : `<button class="btn sm" data-page="settings">+ Invite your partner</button>`}
      </div>
    </aside>
    <main class="main ${S.page === 'calendar' ? 'cal' : ''}">${renderPage()}</main>
  </div>`;
  $$('[data-page]').forEach(b => b.onclick = () => { S.page = b.dataset.page; localStorage.setItem('duocal.page', S.page); render(); });
  const bind = { calendar: bindCalendar, alarms: bindAlarms, sleep: bindSleep, counters: bindCounters, transfer: bindTransfer, settings: bindSettings }[S.page];
  bind && bind();
  if (scroll != null && $('.calscroll')) $('.calscroll').scrollTop = scroll;
  tick();
}
function renderPage() {
  return ({ calendar: renderCalendar, alarms: renderAlarms, sleep: renderSleep, counters: renderCounters, transfer: renderTransfer, settings: renderSettings }[S.page] || renderCalendar)();
}

// ============ 4. calendar ============
function visibleRange() {
  const c = S.cursor;
  if (S.calView === 'day') return [startOfDay(c), addDays(startOfDay(c), 1)];
  if (S.calView === 'week') { const s = phone() ? startOfDay(c) : weekStart(c); return [s, addDays(s, weekDays())]; }
  if (S.calView === 'month') { const first = new Date(c.getFullYear(), c.getMonth(), 1); const s = weekStart(first); return [s, addDays(s, 42)]; }
  return [startOfDay(c), addDays(startOfDay(c), 60)]; // agenda: next 60 days
}
function eventVisible(e) {
  const f = S.filter;
  const forU = e.forUsers && e.forUsers.length ? e.forUsers : [e.createdBy];
  return forU.some(id => f[id] !== false);
}
// All occurrences (repeats expanded) overlapping [from, to)
function occurrences(from, to) {
  const out = [], budget = { left: 200000 }; // total work limit for one screen
  for (const e of S.data.events) {
    if (!eventVisible(e)) continue;
    if (e.allDay) { // pure dates: compute in UTC, show on the same date locally
      for (const o of Recur.expand(e, addDays(from, -1), addDays(to, 1), budget)) {
        const st = localDay(o.start), en = localDay(o.end);
        if (en > from && st < to) out.push({ ev: e, start: st, end: en, raw: o.start });
      }
    } else for (const o of Recur.expand(e, from, to, budget)) out.push({ ev: e, start: o.start, end: o.end, raw: o.start });
  }
  return out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
}
function evColor(e) { return PALETTE[e.color ?? 1] || PALETTE[1]; }

function calTitle() {
  const c = S.cursor;
  if (S.calView === 'month') return `${MONTHS[c.getMonth()]} ${c.getFullYear()}`;
  if (S.calView === 'day') return c.toLocaleDateString([], phone() ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (S.calView === 'week') {
    const [s] = visibleRange(), e = addDays(s, weekDays() - 1);
    if (phone()) return `${s.getDate()} – ${e.getDate()} ${MONTHS[e.getMonth()].slice(0, 3)}`;
    return s.getMonth() === e.getMonth() ? `${MONTHS[s.getMonth()]} ${s.getFullYear()}` : `${MONTHS[s.getMonth()].slice(0, 3)} – ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getFullYear()}`;
  }
  return 'Upcoming';
}

function renderCalendar() {
  const views = [['day', 'Day'], ['week', phone() ? '3 Days' : 'Week'], ['month', 'Month'], ['agenda', 'List']];
  if (phone()) {
    const bar = `
  <div class="toolbar phone-bar">
    <div class="row" style="width:100%;gap:6px;flex-wrap:nowrap">
      <button class="btn icon" id="prev" aria-label="Previous">${ICON.left}</button>
      <button class="title" id="today" title="Go to today">${esc(calTitle())}</button>
      <button class="btn icon" id="next" aria-label="Next">${ICON.right}</button>
      <button class="btn icon" id="recent" aria-label="Recent changes">${ICON.history}</button>
    </div>
    <div class="seg" style="width:100%">${views.map(([v, l]) => `<button class="${S.calView === v ? 'on' : ''}" data-view="${v}" style="flex:1">${l}</button>`).join('')}</div>
  </div>`;
    const body = S.calView === 'month' ? renderMonth() : S.calView === 'agenda' ? renderAgenda() : renderTimeGrid(S.calView === 'day' ? 1 : weekDays());
    return bar + `<div class="calscroll">${body}</div><button class="fab" id="new-ev" aria-label="New event">${ICON.plus}</button>`;
  }
  const toolbar = `
  <div class="toolbar">
    <button class="btn primary" id="new-ev">${ICON.plus} New</button>
    <button class="btn" id="today">Today</button>
    <button class="btn icon" id="prev" aria-label="Previous">${ICON.left}</button><button class="btn icon" id="next" aria-label="Next">${ICON.right}</button>
    <div class="title">${esc(calTitle())}</div>
    <div class="spacer"></div>
    <button class="btn icon" id="recent" title="Recent changes">${ICON.history}</button>
    <div class="chips">${S.data.members.map(m => `<button class="chip ${S.filter[m.id] !== false ? 'on' : ''}" data-filter="${esc(m.id)}" style="${S.filter[m.id] !== false ? `background:${personColor(m.id)};border-color:transparent;color:${personInk(m.id)}` : ''}">${esc(m.name)}</button>`).join('')}</div>
    <div class="seg">${views.map(([v, l]) => `<button class="${S.calView === v ? 'on' : ''}" data-view="${v}">${l}</button>`).join('')}</div>
  </div>`;
  const body = S.calView === 'month' ? renderMonth() : S.calView === 'agenda' ? renderAgenda() : renderTimeGrid(S.calView === 'day' ? 1 : 7);
  return toolbar + `<div class="calscroll">${body}</div>`;
}

function renderMonth() {
  const [from] = visibleRange();
  const occ = occurrences(from, addDays(from, 42));
  const ws = S.data.me.settings.weekStart ?? 0;
  let html = `<div class="month">${[0, 1, 2, 3, 4, 5, 6].map(i => `<div class="dow">${DOW[(i + ws) % 7]}</div>`).join('')}`;
  const today = new Date();
  for (let i = 0; i < 42; i++) {
    const d = addDays(from, i), next = addDays(d, 1);
    const list = occ.filter(o => o.start < next && o.end > d);
    const shown = list.slice(0, 4);
    html += `<div class="day ${d.getMonth() !== S.cursor.getMonth() ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''}" data-day="${d.getTime()}">
      <span class="num">${d.getDate()}</span>
      ${phone() ? `<div class="dots">${list.slice(0, 4).map(o => `<i style="background:${evColor(o.ev)}"></i>`).join('')}${list.length > 4 ? '<b>+</b>' : ''}</div>`
      : shown.map(o => `<div class="pill" style="background:${evColor(o.ev)}" data-ev="${esc(o.ev.id)}" data-occ="${o.start.getTime()}">${o.ev.allDay ? '' : fmtTime(o.start) + ' '}${esc(o.ev.title)}</div>`).join('')
      + (list.length > 4 ? `<div class="more" data-goday="${d.getTime()}">+${list.length - 4} more</div>` : '')}
    </div>`;
  }
  return html + '</div>';
}

function renderAgenda() {
  const [from, to] = visibleRange();
  const occ = occurrences(new Date(), to);
  if (!occ.length) return `<div class="agenda"><p class="muted">Nothing in the next 60 days. Press <b>+ New</b> to add something.</p></div>`;
  let html = '<div class="agenda">', last = '';
  for (const o of occ) {
    const key = o.start.toDateString();
    if (key !== last) { html += `<div class="date">${o.start.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · in ${relDays(o.start)}</div>`; last = key; }
    html += `<div class="item" data-ev="${esc(o.ev.id)}" data-occ="${o.start.getTime()}"><div class="bar" style="background:${evColor(o.ev)}"></div>
      <div style="width:110px" class="small">${o.ev.allDay ? 'All day' : fmtTime(o.start) + ' – ' + fmtTime(o.end)}</div>
      <div style="flex:1"><b>${esc(o.ev.title)}</b>${o.ev.location ? `<div class="muted small">📍 ${esc(o.ev.location)}</div>` : ''}</div>
      <div class="small muted">${forText(o.ev)}</div></div>`;
  }
  return html + '</div>';
}
function relDays(d) { const n = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY); return n === 0 ? 'today' : n === 1 ? '1 day' : n + ' days'; }
function forText(e) {
  const ids = e.forUsers && e.forUsers.length ? e.forUsers : [e.createdBy];
  if (ids.length > 1) return 'Both of you';
  return ids[0] === me().id ? 'You' : esc(member(ids[0])?.name || '');
}

function renderTimeGrid(n) {
  const [from] = visibleRange();
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  // second hour column with your partner's clock when you're in different time zones
  const pt = partner() && tzOf(partner().id) !== myTz() ? tzOf(partner().id) : null;
  const cols = pt ? `48px 52px repeat(${n}, 1fr)` : `56px repeat(${n}, 1fr)`;
  const lead = pt ? `<div class="gutter small" style="padding-top:6px">you</div><div class="gutter small" style="padding-top:6px" title="${esc(pt)}">${esc(initials(partner().name))} · ${esc(tzCity(pt)).slice(0, 8)}</div>` : '<div></div>';
  const occ = occurrences(from, addDays(from, n));
  const today = new Date();
  const timed = occ.filter(o => !o.ev.allDay && (o.end - o.start) < DAY);
  const allday = occ.filter(o => o.ev.allDay || (o.end - o.start) >= DAY);
  let html = `<div class="wk ${phone() && n === 1 ? 'no-head' : ''}" style="grid-template-rows:auto auto 1fr">
  <div class="wk-head" style="grid-template-columns:${cols}">${pt ? '<div></div><div></div>' : '<div></div>'}
    ${days.map(d => `<div class="d ${sameDay(d, today) ? 'today' : ''}" data-goday="${d.getTime()}" style="cursor:pointer">${DOW[d.getDay()]}<b>${d.getDate()}</b></div>`).join('')}
  </div>
  <div class="allday" style="grid-template-columns:${cols}">${pt ? lead : '<div class="gutter small" style="padding-top:6px">all-day</div>'}
    ${days.map(d => `<div class="cell" data-allday="${d.getTime()}">${allday.filter(o => o.start < addDays(d, 1) && o.end > d).map(o => `<div class="pill" style="background:${evColor(o.ev)}" data-ev="${esc(o.ev.id)}" data-occ="${o.start.getTime()}">${esc(o.ev.title)}</div>`).join('')}</div>`).join('')}
  </div>
  <div class="body" style="grid-template-columns:${cols}">
    <div class="hours">${Array.from({ length: 24 }, (_, h) => `<div class="gutter">${h ? (use24h() ? pad(h) + ':00' : (h % 12 || 12) + (h < 12 ? ' am' : ' pm')) : ''}</div>`).join('')}</div>
    ${pt ? `<div class="hours" style="opacity:.75">${Array.from({ length: 24 }, (_, h) => `<div class="gutter">${h ? esc(fmtIn(pt, new Date(days[0].getFullYear(), days[0].getMonth(), days[0].getDate(), h))) : ''}</div>`).join('')}</div>` : ''}`;
  days.forEach((d, i) => {
    const list = timed.filter(o => o.start < addDays(d, 1) && o.end > d);
    html += `<div class="col ${sameDay(d, today) ? 'today' : ''}" data-col="${i}" data-date="${d.getTime()}">
      ${'<div class="slot"></div>'.repeat(48)}
      ${layoutDay(list, d).map(({ o, top, height, left, width }) => `
        <div class="ev ${o.ev.readOnly ? 'readonly' : ''}" data-ev="${esc(o.ev.id)}" data-occ="${o.start.getTime()}"
          style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${evColor(o.ev)}">
          <div class="t">${esc(o.ev.title)}</div>
          ${height > 30 ? `<div>${fmtTime(o.start)} – ${fmtTime(o.end)}</div>` : ''}
          ${height > 46 && o.ev.location ? `<div>📍 ${esc(o.ev.location)}</div>` : ''}
          ${o.ev.readOnly ? '' : '<div class="resize"></div>'}
        </div>`).join('')}
      ${sameDay(d, today) ? `<div class="nowline" style="top:${(today.getHours() * 60 + today.getMinutes()) / 60 * HOUR}px"></div>` : ''}
    </div>`;
  });
  return html + '</div></div>';
}
// Side-by-side layout for overlapping events (like Outlook): group overlapping
// events into clusters, give each event the first free column in its cluster.
function layoutDay(list, day) {
  const dayStart = day.getTime(), dayEnd = addDays(day, 1).getTime();
  const items = list.map(o => {
    const s = Math.max(o.start.getTime(), dayStart), e = Math.min(o.end.getTime(), dayEnd);
    return { o, s, e: Math.max(e, s + 15 * 60000) };
  }).sort((a, b) => a.s - b.s);
  const out = []; let cluster = [], clusterEnd = 0;
  const flush = () => {
    const colsEnd = [];
    for (const it of cluster) {
      let c = colsEnd.findIndex(end => end <= it.s);
      if (c < 0) { c = colsEnd.length; colsEnd.push(0); }
      colsEnd[c] = it.e; it.col = c;
    }
    for (const it of cluster) out.push({ o: it.o, top: (it.s - dayStart) / 36e5 * HOUR, height: Math.max(18, (it.e - it.s) / 36e5 * HOUR - 2), left: it.col / colsEnd.length * 100, width: 100 / colsEnd.length });
    cluster = [];
  };
  for (const it of items) { if (cluster.length && it.s >= clusterEnd) flush(); cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e); }
  flush();
  return out;
}

function bindCalendar() {
  $('#new-ev').onclick = () => { const s = new Date(); s.setMinutes(Math.ceil(s.getMinutes() / 30) * 30, 0, 0); openEventEditor(null, { start: s, end: new Date(s.getTime() + 36e5) }); };
  $('#today').onclick = () => { S.cursor = new Date(); render(); scrollToNow(); };
  $('#recent') && ($('#recent').onclick = openRecent);
  const step = dir => {
    const c = S.cursor;
    S.cursor = S.calView === 'month' ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : addDays(c, dir * (S.calView === 'day' ? 1 : S.calView === 'week' ? weekDays() : 30));
    render();
  };
  $('#prev').onclick = () => step(-1); $('#next').onclick = () => step(1);
  $$('[data-view]').forEach(b => b.onclick = () => { S.calView = b.dataset.view; localStorage.setItem('duocal.calView', S.calView); render(); if (S.calView !== 'month') scrollToNow(); });
  $$('[data-filter]').forEach(b => b.onclick = () => { const id = b.dataset.filter; S.filter[id] = S.filter[id] === false; localStorage.setItem('duocal.filter', JSON.stringify(S.filter)); render(); });
  $$('[data-goday]').forEach(el => el.onclick = e => { e.stopPropagation(); S.cursor = new Date(+el.dataset.goday); S.calView = 'day'; render(); });
  // clicking an event chip anywhere opens it
  $$('.pill[data-ev], .item[data-ev]').forEach(el => el.onclick = e => { e.stopPropagation(); openEventById(el.dataset.ev, +el.dataset.occ); });
  // month: double-click a day to add an all-day event; click goes to that day
  $$('.month .day').forEach(el => {
    el.ondblclick = () => { const d = new Date(+el.dataset.day); openEventEditor(null, { start: new Date(d.getTime() + 9 * 36e5), end: new Date(d.getTime() + 10 * 36e5) }); };
  });
  $$('[data-allday]').forEach(el => el.ondblclick = () => { const d = new Date(+el.dataset.allday); openEventEditor(null, { start: d, end: addDays(d, 1), allDay: true }); });
  if (phone()) {
    // tap a day in the month to open it
    $$('.month .day').forEach(el => el.onclick = () => { S.cursor = new Date(+el.dataset.day); S.calView = 'day'; localStorage.setItem('duocal.calView', 'day'); render(); scrollToNow(); });
    // swipe left/right to move through days/months
    const sc = $('.calscroll'); let x0 = null, y0 = null;
    sc.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    sc.addEventListener('touchend', e => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 50 && S.calView !== 'agenda') step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  bindTimeGridDrag();
  if (!bindCalendar.didScroll) { bindCalendar.didScroll = true; scrollToNow(); }
}
function scrollToNow() {
  requestAnimationFrame(() => { const m = $('.calscroll'); if (m && $('.body')) m.scrollTop = Math.max(0, (new Date().getHours() - 2) * HOUR); });
}
function openEventById(id, occStart) {
  const ev = S.data.events.find(e => e.id === id);
  if (ev) openEventEditor(ev, null, occStart);
}

// Drag on empty slots = create. Drag an event = move. Drag its bottom edge = resize.
function bindTimeGridDrag() {
  const cols = $$('.col');
  if (!cols.length) return;
  const SNAP = 15; // minutes
  const minutesAt = (col, clientY) => {
    const r = col.getBoundingClientRect();
    return Math.max(0, Math.min(1440, Math.round(((clientY - r.top) / HOUR * 60) / SNAP) * SNAP));
  };
  const colAt = x => cols.find(c => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });

  cols.forEach(col => col.addEventListener('pointerdown', down => {
    if (down.button !== 0) return;
    const evEl = down.target.closest('.ev');
    const day = new Date(+col.dataset.date);
    if (!evEl && down.pointerType === 'touch') { // phones: tap = new 1-hour event; swiping still scrolls
      const y0 = down.clientY;
      col.addEventListener('pointerup', e => {
        if (Math.abs(e.clientY - y0) > 8) return;
        const m = Math.floor(minutesAt(col, y0 - HOUR / 4) / 30) * 30;
        openEventEditor(null, { start: new Date(day.getTime() + m * 6e4), end: new Date(day.getTime() + (m + 60) * 6e4) });
      }, { once: true });
      return;
    }
    if (!evEl) { // ---- create ----
      const m0 = Math.floor(minutesAt(col, down.clientY - HOUR / 8) / 30) * 30;
      const ghost = document.createElement('div'); ghost.className = 'ghost'; col.append(ghost);
      let m1 = m0 + 30;
      const draw = () => { const a = Math.min(m0, m1), b = Math.max(m0, m1); ghost.style.top = a / 60 * HOUR + 'px'; ghost.style.height = (b - a) / 60 * HOUR + 'px'; ghost.textContent = `${fmtTime(new Date(day.getTime() + a * 6e4))} – ${fmtTime(new Date(day.getTime() + b * 6e4))}`; };
      draw(); S.busy = true;
      const move = e => { m1 = minutesAt(col, e.clientY); if (m1 === m0) m1 = m0 + SNAP; draw(); };
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); S.busy = false; ghost.remove();
        const a = Math.min(m0, m1), b = Math.max(m0, m1);
        openEventEditor(null, { start: new Date(day.getTime() + a * 6e4), end: new Date(day.getTime() + b * 6e4) });
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      return;
    }
    // ---- move / resize an existing event ----
    const ev = S.data.events.find(e => e.id === evEl.dataset.ev);
    const occStart = +evEl.dataset.occ;
    if (!ev) return;
    if (ev.readOnly || down.pointerType === 'touch') { // phones: tap opens it (change times in the editor)
      const y0 = down.clientY;
      evEl.addEventListener('pointerup', e => { if (Math.abs(e.clientY - y0) < 8) openEventEditor(ev, null, occStart); }, { once: true });
      return;
    }
    const resizing = down.target.classList.contains('resize');
    const base = { start: new Date(ev.start), end: new Date(ev.end) };
    const occ = Recur.expand(ev, new Date(occStart), new Date(occStart + 1)).find(o => o.start.getTime() === occStart) || { start: new Date(occStart), end: new Date(occStart + (base.end - base.start)) };
    const grabOffset = minutesAt(col, down.clientY) - (occ.start.getHours() * 60 + occ.start.getMinutes());
    let moved = false, delta = 0, newEnd = occ.end;
    S.busy = true; evEl.classList.add('dragging'); evEl.setPointerCapture(down.pointerId);
    const move = e => {
      if (!moved && Math.abs(e.clientY - down.clientY) < 4 && Math.abs(e.clientX - down.clientX) < 4) return;
      moved = true;
      if (resizing) {
        const m = Math.max(occ.start.getHours() * 60 + occ.start.getMinutes() + SNAP, minutesAt(col, e.clientY));
        newEnd = new Date(startOfDay(occ.start).getTime() + m * 6e4);
        evEl.style.height = (newEnd - occ.start) / 36e5 * HOUR - 2 + 'px';
      } else {
        const target = colAt(e.clientX) || col;
        const tDay = new Date(+target.dataset.date);
        const m = minutesAt(target, e.clientY) - grabOffset;
        const newStart = new Date(tDay.getTime() + m * 6e4);
        delta = newStart - occ.start;
        if (target !== evEl.parentElement) target.append(evEl);
        evEl.style.top = (m / 60 * HOUR) + 'px'; evEl.style.left = '2px'; evEl.style.width = 'calc(100% - 4px)';
      }
    };
    const up = async () => {
      evEl.removeEventListener('pointermove', move); evEl.removeEventListener('pointerup', up);
      S.busy = false;
      if (!moved) { render(); openEventEditor(ev, null, occStart); return; }
      // The occurrence's new times
      const nStart = resizing ? occ.start : new Date(occ.start.getTime() + delta);
      const nEnd = resizing ? newEnd : new Date(occ.end.getTime() + delta);
      try {
        if (ev.rrule) {
          const choice = await choose('Move repeating event', 'Move only this date, or every date in the series?', [['one', 'Only this one'], ['all', 'All of them']]);
          if (!choice) { render(); return; }
          const { id, householdId, createdBy, updatedAt, updatedBy, source, ...copy } = ev;
          await saveRepeating(ev, occ, { ...copy, start: nStart.toISOString(), end: nEnd.toISOString() }, choice);
          await reload(); render(); toast(choice === 'one' ? 'Moved this date only' : 'Moved the whole series');
        } else {
          const patch = { start: nStart.toISOString(), end: nEnd.toISOString() };
          Object.assign(ev, patch); render();
          await api('/api/events/' + ev.id, { method: 'PUT', body: patch }); toast('Saved');
        }
      } catch (err) { toast(err.message); await reload(); render(); }
    };
    evEl.addEventListener('pointermove', move); evEl.addEventListener('pointerup', up);
  }));
}

// ============ 5. event editor ============
const REMINDER_CHOICES = [[0, 'At start'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [1440, '1 day'], [10080, '1 week']];

function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`;
  const ov = $('.overlay', root);
  ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { root.innerHTML = ''; document.removeEventListener('keydown', onKey); }
  onMount && onMount($('.modal', root), close);
  return close;
}
function repeatOptions(rrule, start) {
  const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][start.getDay()];
  const opts = [['', 'Does not repeat'], ['FREQ=DAILY', 'Every day'], ['FREQ=DAILY;INTERVAL=2', 'Every 2 days'], ['FREQ=DAILY;INTERVAL=3', 'Every 3 days'], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday (Mon–Fri)'],
    [`FREQ=WEEKLY;BYDAY=${wd}`, `Every week on ${DOW[start.getDay()]}`], [`FREQ=WEEKLY;INTERVAL=2;BYDAY=${wd}`, `Every 2 weeks on ${DOW[start.getDay()]}`],
    ['FREQ=MONTHLY', `Every month on day ${start.getDate()}`], ['FREQ=YEARLY', `Every year on ${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()}`]];
  const known = opts.some(o => o[0] === (rrule || ''));
  return opts.map(([v, l]) => `<option value="${v}" ${v === (rrule || '') ? 'selected' : ''}>${l}</option>`).join('')
    + `<option value="custom" ${!known ? 'selected' : ''}>${!known ? 'Custom: ' + esc(Recur.describe(rrule)) : 'Custom rule…'}</option>`;
}

function openEventEditor(ev, preset, occStart) {
  const isNew = !ev;
  const e = ev ? { ...ev } : { title: '', start: (preset.allDay ? utcDay(preset.start) : preset.start).toISOString(), end: (preset.allDay ? utcDay(preset.end) : preset.end).toISOString(), allDay: !!preset.allDay, color: 1, forUsers: [me().id], reminders: [15], notes: '', location: '', rrule: null };
  // For a repeating event opened from one of its dates, show *that* date's times.
  const occ = ev && ev.rrule && occStart ? Recur.expand(ev, new Date(occStart - 2 * DAY), new Date(occStart + 2 * DAY)).find(o => (ev.allDay ? localDay(o.start) : o.start).getTime() === occStart) : null;
  let s = occ ? occ.start : new Date(e.start), en = occ ? occ.end : new Date(e.end);
  if (e.allDay) { s = localDay(s); en = localDay(en); } // a date, shown as that date here
  const endShown = e.allDay ? addDays(en, -1) : en; // all-day end is exclusive in storage, inclusive on screen
  const ro = !!e.readOnly;
  const close = modal(`
    <h3>${isNew ? 'New event' : ro ? 'Event (from a subscribed calendar)' : 'Edit event'}</h3>
    <label class="f">Title<input type="text" id="e-title" value="${esc(e.title)}" placeholder="What's happening?" ${ro ? 'disabled' : ''}></label>
    <div class="row" style="margin-bottom:12px"><button class="switch ${e.allDay ? 'on' : ''}" id="e-allday"></button> All day</div>
    <div class="two">
      <label class="f">Starts<input type="date" id="e-sd" value="${fmtDateInput(s)}"></label>
      <label class="f time-f">&nbsp;<input type="time" id="e-st" value="${fmtTimeInput(s)}"></label>
      <label class="f">Ends<input type="date" id="e-ed" value="${fmtDateInput(endShown)}"></label>
      <label class="f time-f">&nbsp;<input type="time" id="e-et" value="${fmtTimeInput(en)}"></label>
    </div>
    <div class="small muted" id="e-ptime" style="margin:-4px 0 10px"></div>
    <label class="f">Who is it for?<div class="chips" id="e-for">${S.data.members.map(m => `<button class="chip ${(e.forUsers || []).includes(m.id) ? 'on' : ''}" data-id="${esc(m.id)}">${m.id === me().id ? 'Me' : esc(m.name)}</button>`).join('')}</div></label>
    <label class="f">Color (cold → warm)<div class="swatches" id="e-color">${PALETTE.map((c, i) => `<button class="sw ${i === (e.color ?? 1) ? 'on' : ''}" style="background:${c}" data-i="${i}" title="${PALETTE_NAMES[i]}"></button>`).join('')}</div></label>
    <label class="f">Repeat<select id="e-rep">${repeatOptions(e.rrule, s)}</select></label>
    <label class="f hidden" id="e-rrule-wrap">Custom repeat rule (iCalendar RRULE, e.g. FREQ=MONTHLY;BYDAY=2SA)<input type="text" id="e-rrule" value="${esc(e.rrule || '')}"></label>
    <label class="f">Remind ${S.data.members.length > 1 ? 'the people it\'s for' : 'me'}<div class="chips" id="e-rem">${REMINDER_CHOICES.map(([m, l]) => `<button class="chip ${(e.reminders || []).includes(m) ? 'on' : ''}" data-m="${m}">${l}</button>`).join('')}</div></label>
    <label class="f">Location<input type="text" id="e-loc" value="${esc(e.location)}"></label>
    <label class="f">Notes<textarea id="e-notes" rows="3">${esc(e.notes)}</textarea></label>
    ${!isNew ? `<p class="muted small">${ICON.history} Added by ${esc(member(e.createdBy)?.name || 'someone')}${e.updatedAt ? ` · last changed${e.updatedBy ? ' by ' + esc(member(e.updatedBy)?.name || '') : ''} ${esc(ago(e.updatedAt))}` : ''}.</p>` : ''}
    <div class="actions">
      ${!isNew && !ro ? `<button class="btn danger" id="e-del">Delete</button>` : ''}
      ${!isNew ? `<button class="btn" id="e-count" title="Make a live countdown for this">⏳ Countdown</button>` : ''}
      <div class="spacer"></div>
      <button class="btn" id="e-cancel">Cancel</button>
      ${ro ? '' : `<button class="btn primary" id="e-save">${isNew ? 'Add' : 'Save'}</button>`}
    </div>`, (m, close) => {
    const allBtn = $('#e-allday', m);
    const syncAllDay = () => $$('.time-f', m).forEach(x => x.classList.toggle('hidden', allBtn.classList.contains('on')));
    allBtn.onclick = () => { allBtn.classList.toggle('on'); syncAllDay(); }; syncAllDay();
    $$('#e-for .chip, #e-rem .chip', m).forEach(c => c.onclick = () => c.classList.toggle('on'));
    $$('#e-color .sw', m).forEach(c => c.onclick = () => { $$('#e-color .sw', m).forEach(x => x.classList.remove('on')); c.classList.add('on'); });
    const rep = $('#e-rep', m), wrap = $('#e-rrule-wrap', m);
    rep.onchange = () => wrap.classList.toggle('hidden', rep.value !== 'custom');
    // keep duration when the start moves
    const dur = en - s;
    $('#e-sd', m).onchange = $('#e-st', m).onchange = () => {
      const ns = parseLocal($('#e-sd', m).value, $('#e-st', m).value);
      const ne = new Date(ns.getTime() + dur);
      $('#e-ed', m).value = fmtDateInput(allBtn.classList.contains('on') ? addDays(ne, -1) : ne); $('#e-et', m).value = fmtTimeInput(ne);
    };
    // "For Sam that's Fri 02:00 – 03:00 (Tokyo)"
    const showPartnerTime = () => {
      const pt = partner() && tzOf(partner().id) !== myTz() ? tzOf(partner().id) : null, el = $('#e-ptime', m);
      if (!pt || !el || allBtn.classList.contains('on')) { if (el) el.textContent = ''; return; }
      const a = parseLocal($('#e-sd', m).value, $('#e-st', m).value), b = parseLocal($('#e-ed', m).value, $('#e-et', m).value);
      if (isNaN(a) || isNaN(b)) return;
      el.textContent = `For ${partner().name} that's ${fmtIn(pt, a, true)} – ${fmtIn(pt, b, true)} (${tzCity(pt)})`;
    };
    ['#e-sd', '#e-st', '#e-ed', '#e-et'].forEach(sel => $(sel, m).addEventListener('input', showPartnerTime));
    allBtn.addEventListener('click', showPartnerTime); showPartnerTime();
    $('#e-cancel', m).onclick = close;
    if (isNew) setTimeout(() => $('#e-title', m).focus(), 50);
    $('#e-title', m).onkeydown = k => { if (k.key === 'Enter') $('#e-save', m)?.click(); };
    $('#e-count', m) && ($('#e-count', m).onclick = async () => {
      const when = occStart ? new Date(occStart) : new Date(e.start);
      await api('/api/counters', { method: 'POST', body: { title: e.title, date: when.toISOString(), color: e.color ?? 1 } });
      toast('Countdown added to Counters'); close();
    });
    $('#e-save', m) && ($('#e-save', m).onclick = async () => {
      const allDay = allBtn.classList.contains('on');
      let start = parseLocal($('#e-sd', m).value, allDay ? '00:00' : $('#e-st', m).value);
      let end = parseLocal($('#e-ed', m).value, allDay ? '00:00' : $('#e-et', m).value);
      if (allDay) end = addDays(end, 1);
      if (end <= start) end = new Date(start.getTime() + (allDay ? DAY : 36e5));
      if (allDay) { start = utcDay(start); end = utcDay(end); } // store all-day events as pure dates
      let rrule = rep.value === 'custom' ? ($('#e-rrule', m).value.trim().replace(/^RRULE:/i, '') || null) : (rep.value || null);
      const body = {
        title: $('#e-title', m).value.trim() || '(no title)', start: start.toISOString(), end: end.toISOString(), allDay,
        forUsers: $$('#e-for .chip.on', m).map(c => c.dataset.id), color: +($('#e-color .sw.on', m)?.dataset.i ?? 1),
        reminders: $$('#e-rem .chip.on', m).map(c => +c.dataset.m), rrule, location: $('#e-loc', m).value, notes: $('#e-notes', m).value,
      };
      if (!body.forUsers.length) body.forUsers = [me().id];
      try {
        if (isNew) await api('/api/events', { method: 'POST', body });
        else if (occ) {
          const choice = await choose('Change repeating event', 'Change only this date, or every date in the series?', [['one', 'Only this one'], ['all', 'All of them']]);
          if (!choice) return;
          await saveRepeating(ev, occ, body, choice);
        }
        else await api('/api/events/' + ev.id, { method: 'PUT', body });
        close(); await reload(); render();
        const p = partner();
        toast(p && body.forUsers.includes(p.id) && !body.forUsers.includes(me().id) ? `Added to ${p.name}'s calendar` : 'Saved');
      } catch (err) { toast(err.message); }
    });
    $('#e-del', m) && ($('#e-del', m).onclick = async () => {
      if (ev.rrule && occStart) {
        const choice = await choose('Delete repeating event', 'Delete only this one, or every occurrence?', [['one', 'Only this one'], ['all', 'All of them']]);
        if (!choice) return;
        if (choice === 'one') {
          await api('/api/events/' + ev.id, { method: 'PUT', body: { exdates: [...(ev.exdates || []), new Date(occStart).toISOString()] } });
          close(); await reload(); render(); return;
        }
      }
      await api('/api/events/' + ev.id, { method: 'DELETE' });
      close(); await reload(); render(); toast('Deleted');
    });
  });
}
// Save a change to one date of a repeating event.
//  'one': that date is skipped in the series (exdate) and becomes its own event.
//  'all': the whole series moves by the same amount the date was moved.
async function saveRepeating(ev, occ, body, choice) {
  if (choice === 'one') {
    await api('/api/events/' + ev.id, { method: 'PUT', body: { exdates: [...(ev.exdates || []), occ.start.toISOString()] } });
    await api('/api/events', { method: 'POST', body: { ...body, rrule: null, exdates: [] } });
    return;
  }
  const delta = new Date(body.start) - occ.start, len = new Date(body.end) - new Date(body.start);
  const start = new Date(new Date(ev.start).getTime() + delta);
  const exdates = (ev.exdates || []).map(d => new Date(new Date(d).getTime() + delta).toISOString()); // skipped dates move with the series
  await api('/api/events/' + ev.id, { method: 'PUT', body: { ...body, exdates, start: start.toISOString(), end: new Date(start.getTime() + len).toISOString() } });
}
// "5 min ago", "yesterday", "3 Nov"
function ago(iso) {
  const ms = Date.now() - new Date(iso);
  if (isNaN(ms)) return '';
  if (ms < 60e3) return 'just now';
  if (ms < 36e5) return Math.round(ms / 6e4) + ' min ago';
  if (ms < DAY) return Math.round(ms / 36e5) + ' h ago';
  if (ms < 2 * DAY) return 'yesterday';
  if (ms < 7 * DAY) return Math.round(ms / DAY) + ' days ago';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
// Recent changes: the newest edits to events, alarms and counters, and who made them.
function openRecent() {
  const rows = [
    ...S.data.events.filter(e => !e.readOnly && e.updatedAt).map(e => ({ kind: 'Event', title: e.title, when: e.updatedAt, who: e.updatedBy, open: () => openEventById(e.id) })),
    ...S.data.alarms.filter(a => a.updatedAt).map(a => ({ kind: 'Alarm', title: `${a.label} · ${a.time}` + (a.forUser !== me().id ? ` (for ${member(a.forUser)?.name || ''})` : ''), when: a.updatedAt, who: a.updatedBy })),
    ...S.data.counters.filter(c => c.updatedAt).map(c => ({ kind: 'Counter', title: c.title, when: c.updatedAt, who: c.updatedBy })),
  ].sort((x, y) => String(y.when).localeCompare(String(x.when))).slice(0, 40);
  modal(`<h3>${ICON.history} Recent changes</h3>
    ${rows.length ? rows.map((r, i) => `<div class="recent" data-i="${i}"><span class="avatar" style="background:${r.who ? personColor(r.who) : 'var(--line)'};color:${r.who ? personInk(r.who) : 'var(--text)'}">${esc(initials(member(r.who)?.name || '?'))}</span>
      <div style="flex:1;min-width:0"><b>${esc(member(r.who)?.name || 'Someone')}</b> <span class="muted small">changed ${/^[aeiou]/i.test(r.kind) ? "an" : "a"} ${r.kind.toLowerCase()}</span><div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</div></div>
      <span class="muted small">${esc(ago(r.when))}</span></div>`).join('') : '<p class="muted">No changes yet.</p>'}
    <div class="actions"><div class="spacer"></div><button class="btn primary" id="rc-close">Close</button></div>`, (m, close) => {
    $('#rc-close', m).onclick = close;
    $$('.recent', m).forEach(el => el.onclick = () => { const r = rows[+el.dataset.i]; if (r.open) { close(); r.open(); } });
  });
}
// small "pick one" dialog stacked above the current modal
function choose(title, text, options) {
  return new Promise(resolve => {
    const d = document.createElement('div'); d.className = 'overlay'; d.style.zIndex = 60;
    d.innerHTML = `<div class="modal" style="width:min(380px,92vw)"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions"><button class="btn" data-v="">Cancel</button><div class="spacer"></div>${options.map(([v, l]) => `<button class="btn primary" data-v="${v}">${esc(l)}</button>`).join('')}</div></div>`;
    document.body.append(d);
    $$('[data-v]', d).forEach(b => b.onclick = () => { d.remove(); resolve(b.dataset.v || null); });
  });
}

// ============ 6. alarms & ringing ============
function renderAlarms() {
  const mine = S.data.alarms.sort((a, b) => a.time.localeCompare(b.time));
  const card = a => {
    const days = a.every ? EVERY_LABEL[a.every] : a.days && a.days.length ? (a.days.length === 7 ? 'Every day' : a.days.length === 5 && !a.days.includes(0) && !a.days.includes(6) ? 'Weekdays' : a.days.map(d => DOW[d]).join(' ')) : (a.date ? new Date(a.date + 'T00:00').toLocaleDateString() : 'Once');
    const who = a.forUser === me().id ? (a.createdBy === me().id ? '' : `set for you by ${esc(member(a.createdBy)?.name)}`) : `for ${esc(member(a.forUser)?.name)}`;
    return `<div class="card alarm-card ${a.enabled ? '' : 'off'}">
      <div style="flex:1;cursor:pointer" data-edit-alarm="${esc(a.id)}">
        <div class="time">${fmtTime(parseLocal('2000-01-01', a.time))}</div>
        <div><b>${esc(a.label || 'Alarm')}</b> <span class="muted small">· ${days} ${who ? '· ' + who : ''}${a.forUser !== me().id && tzOf(a.forUser) !== myTz() ? ` · their time (${esc(tzCity(tzOf(a.forUser)))})` : ''}</span></div>
      </div>
      <button class="switch ${a.enabled ? 'on' : ''}" data-toggle-alarm="${esc(a.id)}"></button>
    </div>`;
  };
  const s = me().settings;
  return `<div class="page">
    <div class="row"><h1>Alarms</h1><div class="spacer"></div><button class="btn primary" id="add-alarm">+ New alarm</button></div>
    <div class="card" style="text-align:center"><div class="clock" data-clock="hms"></div><div class="muted" data-clock="date"></div></div>
    ${s.wakeAlarm ? `<h2>From your sleep schedule</h2><div class="card alarm-card"><div style="flex:1"><div class="time">${fmtTime(parseLocal('2000-01-01', s.waketime))}</div><b>Wake up</b> <span class="muted small">· every day · change it on the Sleep page</span></div></div>` : ''}
    <h2>Yours</h2>
    <div class="grid">${mine.filter(a => a.forUser === me().id).map(card).join('') || '<p class="muted">No alarms yet.</p>'}</div>
    ${partner() ? `<h2>${esc(partner().name)}'s alarms</h2><div class="grid">${mine.filter(a => a.forUser !== me().id).map(card).join('') || '<p class="muted">None. You can set one for them — it will ring on their devices.</p>'}</div>` : ''}
    <p class="muted small" style="margin-top:24px">Each alarm rings at that time <b>on its owner's clock</b>, in their country. It also goes to their "⏰ DuoCal alarms" Google calendar, so their iPhone or Mac alerts them even when DuoCal is closed. While DuoCal is open, it rings here with sound.</p>
  </div>`;
}
function bindAlarms() {
  $('#add-alarm').onclick = () => openAlarmEditor(null);
  $$('[data-edit-alarm]').forEach(el => el.onclick = () => openAlarmEditor(S.data.alarms.find(a => a.id === el.dataset.editAlarm)));
  $$('[data-toggle-alarm]').forEach(el => el.onclick = async () => {
    const a = S.data.alarms.find(x => x.id === el.dataset.toggleAlarm);
    await api('/api/alarms/' + a.id, { method: 'PUT', body: { enabled: !a.enabled } }); await reload(); render();
  });
}
const EVERY_LABEL = { '': 'Once', '1d': 'Every day', '2d': 'Every 2 days', '3d': 'Every 3 days', '1w': 'Every week', '1m': 'Every month', '1y': 'Every year' };
// A wheel you can scroll (like the iPhone clock) plus a box you can type in. Both stay in sync.
function timeWheel(m, initial) {
  const h24 = use24h(), ITEM = 44;
  const hours = h24 ? Array.from({ length: 24 }, (_, i) => pad(i)) : Array.from({ length: 12 }, (_, i) => String(i === 0 ? 12 : i));
  const mins = Array.from({ length: 60 }, (_, i) => pad(i));
  const col = (id, items) => `<div class="wheel" id="${id}"><div class="wheel-pad"></div>${items.map(x => `<div class="wheel-item">${x}</div>`).join('')}<div class="wheel-pad"></div></div>`;
  $('#a-wheel', m).innerHTML = `<div class="wheels">${col('w-h', hours)}<div class="wheel-colon">:</div>${col('w-m', mins)}${h24 ? '' : col('w-ap', ['AM', 'PM'])}<div class="wheel-band"></div></div>`;
  const wh = $('#w-h', m), wm = $('#w-m', m), wap = $('#w-ap', m), box = $('#a-time', m);
  const idx = el => Math.max(0, Math.round(el.scrollTop / ITEM));
  const read = () => {
    let h = idx(wh), mi = idx(wm);
    if (!h24) { h = h % 12 + (idx(wap) === 1 ? 12 : 0); }
    return `${pad(Math.min(23, h))}:${pad(Math.min(59, mi))}`;
  };
  const show = (t, smooth) => {
    const [h, mi] = t.split(':').map(Number);
    const go = (el, i) => el.scrollTo({ top: i * ITEM, behavior: smooth ? 'smooth' : 'auto' });
    go(wh, h24 ? h : h % 12); go(wm, mi); if (wap) go(wap, h >= 12 ? 1 : 0);
  };
  let typing = false, timer;
  [wh, wm, wap].filter(Boolean).forEach(el => el.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!typing) box.value = read(); }, 90);
  }));
  // typing: "730", "7:30", "19.30", "7:30 pm" all work
  const parse = v => {
    v = String(v).trim().toLowerCase();
    const pm = /p/.test(v), am = /a/.test(v);
    const digits = v.replace(/[^0-9]/g, '');
    let h, mi;
    if (/[:.\s]/.test(v.replace(/\s*[ap]\.?m?\.?$/, ''))) { const [a, b] = v.split(/[:.\s]/); h = +a.replace(/\D/g, ''); mi = +(b || '0').replace(/\D/g, ''); }
    else if (digits.length <= 2) { h = +digits; mi = 0; }
    else { h = +digits.slice(0, digits.length - 2); mi = +digits.slice(-2); }
    if (pm && h < 12) h += 12; if (am && h === 12) h = 0;
    return Number.isFinite(h) && Number.isFinite(mi) && h >= 0 && h < 24 && mi >= 0 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null;
  };
  box.addEventListener('focus', () => { typing = true; box.select(); });
  box.addEventListener('input', () => { const t = parse(box.value); box.classList.toggle('bad', !t && box.value.length > 2); if (t) show(t, true); });
  box.addEventListener('blur', () => { typing = false; const t = parse(box.value) || read(); box.value = t; show(t); });
  box.value = initial; requestAnimationFrame(() => show(initial));
  return () => parse(box.value) || read();
}
function openAlarmEditor(a) {
  const isNew = !a;
  a = a || { time: fmtTimeInput(new Date(Date.now() + 36e5)).slice(0, 3) + '00', label: '', days: [], enabled: true, forUser: me().id, snooze: 9, every: '' };
  const mode = a.every ? a.every : (a.days && a.days.length ? 'days' : '');
  modal(`<h3>${isNew ? 'New alarm' : 'Edit alarm'}</h3>
    <label class="f">Time — scroll the wheel or type it<input type="text" id="a-time" inputmode="numeric" autocomplete="off" class="time-box" aria-label="Alarm time"></label>
    <div id="a-wheel"></div>
    <label class="f" style="margin-top:12px">Label<input type="text" id="a-label" value="${esc(a.label)}" placeholder="Wake up, Gym, Pills…" maxlength="80"></label>
    <label class="f">Repeat<select id="a-rep">
      ${[['', 'Once'], ['1d', 'Every day'], ['2d', 'Every 2 days'], ['3d', 'Every 3 days'], ['1w', 'Every week'], ['1m', 'Every month'], ['1y', 'Every year'], ['days', 'On chosen weekdays…']].map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label class="f ${mode === 'days' ? '' : 'hidden'}" id="a-days-wrap">Weekdays<div class="chips" id="a-days">${DOW.map((d, i) => `<button class="chip ${(a.days || []).includes(i) ? 'on' : ''}" data-d="${i}">${d}</button>`).join('')}</div></label>
    <label class="f ${mode && mode !== 'days' ? '' : 'hidden'}" id="a-from-wrap">Starting on<input type="date" id="a-from" value="${esc(a.date || '')}"></label>
    ${S.data.members.length > 1 ? `<label class="f">Rings for<div class="chips" id="a-for">${S.data.members.map(m => `<button class="chip ${a.forUser === m.id ? 'on' : ''}" data-id="${esc(m.id)}">${m.id === me().id ? 'Me' : esc(m.name)}</button>`).join('')}</div></label>` : ''}
    <p class="small muted" id="a-tznote"></p>
    <label class="f">Snooze length (minutes)<input type="number" id="a-snooze" min="1" max="60" value="${a.snooze || 9}"></label>
    <div class="actions">${isNew ? '' : '<button class="btn danger" id="a-del">Delete</button>'}<button class="btn" id="a-test">▶ Sound</button><div class="spacer"></div><button class="btn" id="a-cancel">Cancel</button><button class="btn primary" id="a-save">Save</button></div>`,
    (m, close) => {
      const getTime = timeWheel(m, a.time);
      $$('#a-days .chip', m).forEach(c => c.onclick = () => c.classList.toggle('on'));
      const rep = $('#a-rep', m);
      const forUserNow = () => $('#a-for .chip.on', m)?.dataset.id || me().id;
      const syncRep = () => {
        $('#a-days-wrap', m).classList.toggle('hidden', rep.value !== 'days');
        $('#a-from-wrap', m).classList.toggle('hidden', !rep.value || rep.value === 'days');
        if (rep.value && rep.value !== 'days' && !$('#a-from', m).value) $('#a-from', m).value = clockIn(tzOf(forUserNow())).date;
      };
      rep.onchange = syncRep; syncRep();
      const tzNote = () => { const id = forUserNow(); const z = tzOf(id); $('#a-tznote', m).textContent = id !== me().id && z !== myTz() ? `This time is ${member(id).name}'s local time in ${tzCity(z)} (now ${clockIn(z).hm} there).` : ''; };
      $$('#a-for .chip', m).forEach(c => c.onclick = () => { $$('#a-for .chip', m).forEach(x => x.classList.remove('on')); c.classList.add('on'); tzNote(); });
      tzNote();
      $('#a-cancel', m).onclick = close;
      $('#a-test', m).onclick = () => { Sound.start(); setTimeout(() => Sound.stop(), 4000); };
      $('#a-save', m).onclick = async () => {
        const time = getTime();
        const forUser = forUserNow();
        const mode = rep.value;
        const days = mode === 'days' ? $$('#a-days .chip.on', m).map(c => +c.dataset.d) : [];
        if (mode === 'days' && !days.length) return toast('Pick at least one weekday');
        let date = null;
        if (mode && mode !== 'days') date = $('#a-from', m).value || clockIn(tzOf(forUser)).date;
        if (!mode) { // once: today on *their* clock if the time is still ahead there, otherwise tomorrow
          const c = clockIn(tzOf(forUser));
          const d = new Date(c.date + 'T00:00:00Z'); if (time <= c.hm) d.setUTCDate(d.getUTCDate() + 1);
          date = d.toISOString().slice(0, 10);
        }
        const body = { time, label: $('#a-label', m).value.trim() || 'Alarm', days, date, every: mode === 'days' ? '' : mode, enabled: true, snooze: +$('#a-snooze', m).value || 9, forUser };
        try {
          if (isNew) await api('/api/alarms', { method: 'POST', body }); else await api('/api/alarms/' + a.id, { method: 'PUT', body });
          close(); await reload(); render(); toast(body.forUser !== me().id ? `Alarm set for ${member(body.forUser).name}` : `Alarm saved · ${EVERY_LABEL[body.every] || (days.length ? 'chosen days' : 'once')} at ${time}`);
        } catch (e) { toast(e.message); }
      };
      $('#a-del', m) && ($('#a-del', m).onclick = async () => { await api('/api/alarms/' + a.id, { method: 'DELETE' }); close(); await reload(); render(); });
    });
}
// Does a repeating alarm ring on day `ymd` (its owner's calendar date)?
function alarmOnDay(a, ymd, dow) {
  if (a.every) {
    if (!a.date || ymd < a.date) return false;
    const diff = Math.round((Date.parse(ymd + 'T00:00:00Z') - Date.parse(a.date + 'T00:00:00Z')) / DAY);
    return { '1d': true, '2d': diff % 2 === 0, '3d': diff % 3 === 0, '1w': diff % 7 === 0, '1m': ymd.slice(8) === a.date.slice(8), '1y': ymd.slice(5) === a.date.slice(5) }[a.every] || false;
  }
  return a.days && a.days.length ? a.days.includes(dow) : (!a.date || a.date === ymd);
}

// Alarm sound made in code (no audio file): a repeating three-beep pattern.
const Sound = {
  ctx: null, timer: null,
  unlock() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); },
  // a soft bell: sine tone with a quick attack and a long gentle fade
  beep(freq, at, len, vol = 0.35) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(this.ctx.destination);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.start(at); o.stop(at + len + 0.05);
  },
  // gentle wake-up: a three-note chime every 2.5 s, starting very quiet and
  // growing to a moderate level over ~30 s; it stops by itself after 60 s
  start() {
    this.unlock(); this.stop();
    const began = Date.now();
    const play = () => {
      if (Date.now() - began > 60e3) return this.stop();
      const vol = 0.04 + Math.min(1, (Date.now() - began) / 30e3) * 0.16; // 0.04 → 0.20
      const t = this.ctx.currentTime;
      [[523, 0], [659, 0.35], [784, 0.7]].forEach(([f, d]) => this.beep(f, t + d, 1.4, vol)); // C-E-G
    };
    play(); this.timer = setInterval(play, 2500);
  },
  stop() { clearInterval(this.timer); this.timer = null; },
};
addEventListener('pointerdown', () => Sound.unlock(), { once: true }); // browsers need one click before sound

function notify(title, body) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: 'icon.svg' }); } catch { }
}
function ring(label, snoozeMin = 9) {
  if ($('.ringing')) return;
  notify('⏰ ' + label, 'Alarm');
  Sound.start();
  const d = document.createElement('div'); d.className = 'ringing';
  d.innerHTML = `<div style="font-size:22px">⏰ ${esc(label)}</div><div class="clock" data-clock="hm"></div>
    <button class="btn" id="r-stop" style="font-size:26px;padding:18px 60px">Stop</button>
    <button class="btn" id="r-snooze" style="font-size:16px;padding:10px 24px">Snooze ${snoozeMin} min</button>
    <div class="small" style="opacity:.85">Tap anywhere or press Esc to stop</div>`;
  document.body.append(d); tick();
  // Easy to stop: the Stop button, a tap anywhere else, Esc — and it ends by itself after a minute.
  const onKey = e => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') stop(); };
  const auto = setTimeout(() => stop(), 60e3);
  function stop() { Sound.stop(); clearTimeout(auto); document.removeEventListener('keydown', onKey); d.remove(); }
  document.addEventListener('keydown', onKey);
  d.addEventListener('click', e => { if (!e.target.closest('#r-snooze')) stop(); });
  $('#r-snooze', d).onclick = () => {
    const sn = JSON.parse(localStorage.getItem('duocal.snoozes') || '[]');
    sn.push({ at: Date.now() + snoozeMin * 6e4, label, snoozeMin });
    localStorage.setItem('duocal.snoozes', JSON.stringify(sn)); stop(); toast(`Snoozed for ${snoozeMin} minutes`);
  };
}

// ============ 7. sleep ============
function openSleep(userId) { return S.data.sleepLogs.find(s => s.userId === userId && !s.end); }
function sleepStatus(userId) {
  const o = S.data && openSleep(userId);
  return o ? `😴 asleep <span data-since="${o.start}"></span>` : '';
}
function renderSleep() {
  const s = me().settings, cur = openSleep(me().id), p = partner();
  const logs = S.data.sleepLogs.filter(l => l.userId === me().id && l.end).sort((a, b) => b.start.localeCompare(a.start));
  const hours = l => (new Date(l.end) - new Date(l.start)) / 36e5;
  const last7 = logs.filter(l => new Date(l.end) > Date.now() - 7 * DAY);
  const avg = last7.length ? last7.reduce((t, l) => t + hours(l), 0) / last7.length : 0;
  const target = ((parseLocal('2000-01-02', s.waketime) - parseLocal('2000-01-01', s.bedtime)) / 36e5) % 24;
  // bar chart: last 14 nights (by wake-up date)
  const bars = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(startOfDay(new Date()), i - 13);
    const h = logs.filter(l => sameDay(new Date(l.end), d)).reduce((t, l) => t + hours(l), 0);
    return { d, h };
  });
  const max = Math.max(10, ...bars.map(b => b.h));
  const barColor = h => h === 0 ? 'var(--line)' : h < target - 1.5 ? 'var(--c7)' : h < target - 0.5 ? 'var(--c5)' : 'var(--c3)';
  const pSleep = p && openSleep(p.id);
  return `<div class="page">
    <h1>Sleep</h1>
    <div class="grid">
      <div class="card" style="text-align:center">
        ${cur ? `<div class="muted">Sleeping for</div><div class="big" data-since="${cur.start}" data-long="1"></div><div class="muted small">since ${fmtTime(new Date(cur.start))}</div><br><button class="btn primary" id="wake" style="font-size:17px;padding:12px 26px">☀️ I'm awake</button>`
        : `<div class="muted">Bedtime ${fmtTime(parseLocal('2000-01-01', s.bedtime))} · wake ${fmtTime(parseLocal('2000-01-01', s.waketime))}</div><div class="big" data-until-bed="1"></div><br><button class="btn primary" id="sleep" style="font-size:17px;padding:12px 26px">🌙 Going to sleep</button>`}
      </div>
      <div class="card">
        <div class="muted small">Last night</div><div class="big">${logs[0] ? durText(hours(logs[0]) * 36e5) : '—'}</div>
        <div class="muted small" style="margin-top:8px">7-day average: <b>${avg ? durText(avg * 36e5) : '—'}</b> · goal ${durText(target * 36e5)}</div>
        ${p ? `<div style="margin-top:12px" class="small">${pSleep ? `😴 ${esc(p.name)} has been asleep for <b data-since="${pSleep.start}"></b>` : `${esc(p.name)} is awake`}</div>` : ''}
      </div>
    </div>
    <h2>Last 14 nights</h2>
    <div class="card"><div class="bars">${bars.map(b => `<div class="b" style="height:${b.h / max * 100}%;background:${barColor(b.h)}" title="${b.h.toFixed(1)} h"><em>${b.h ? b.h.toFixed(1) : ''}</em><span>${b.d.getDate()}</span></div>`).join('')}</div><div style="height:18px"></div></div>
    <h2>Sleep schedule</h2>
    <div class="card">
      <div class="two">
        <label class="f">Bedtime<input type="time" id="s-bed" value="${s.bedtime}"></label>
        <label class="f">Wake-up time<input type="time" id="s-wake" value="${s.waketime}"></label>
      </div>
      <div class="row"><button class="switch ${s.wakeAlarm ? 'on' : ''}" id="s-alarm"></button> Ring a wake-up alarm at wake-up time</div>
      <div class="row" style="margin-top:10px">Remind me <input type="number" id="s-rem" min="0" max="180" value="${s.bedtimeReminder}" style="width:80px"> minutes before bedtime (0 = off)</div>
      <div class="actions"><div class="spacer"></div><button class="btn primary" id="s-save">Save schedule</button></div>
    </div>
    <h2>History</h2>
    <div class="card">${logs.slice(0, 20).map(l => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line2)"><div style="flex:1">${new Date(l.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtTime(new Date(l.start))} → ${fmtTime(new Date(l.end))}</div><b>${durText(hours(l) * 36e5)}</b><button class="btn sm" data-del-sleep="${esc(l.id)}">✕</button></div>`).join('') || '<span class="muted">Press "Going to sleep" tonight and "I\'m awake" in the morning — or add a past night:</span>'}
      <div class="row" style="margin-top:12px"><span class="muted small">Add a night:</span><input type="datetime-local" id="h-from" style="width:auto"><span>→</span><input type="datetime-local" id="h-to" style="width:auto"><button class="btn sm" id="h-add">Add</button></div>
    </div>
  </div>`;
}
function bindSleep() {
  $('#sleep') && ($('#sleep').onclick = async () => { await api('/api/sleepLogs', { method: 'POST', body: { userId: me().id, start: new Date().toISOString() } }); await reload(); render(); toast('Good night 🌙'); });
  $('#wake') && ($('#wake').onclick = async () => { const o = openSleep(me().id); await api('/api/sleepLogs/' + o.id, { method: 'PUT', body: { end: new Date().toISOString() } }); await reload(); render(); toast('Good morning ☀️  You slept ' + durText(Date.now() - new Date(o.start))); });
  $('#s-alarm').onclick = e => e.currentTarget.classList.toggle('on');
  $('#s-save').onclick = async () => {
    await api('/api/me', { method: 'PUT', body: { settings: { bedtime: $('#s-bed').value, waketime: $('#s-wake').value, wakeAlarm: $('#s-alarm').classList.contains('on'), bedtimeReminder: +$('#s-rem').value || 0 } } });
    await reload(); render(); toast('Sleep schedule saved');
  };
  $$('[data-del-sleep]').forEach(b => b.onclick = async () => { await api('/api/sleepLogs/' + b.dataset.delSleep, { method: 'DELETE' }); await reload(); render(); });
  $('#h-add').onclick = async () => {
    const a = $('#h-from').value, b = $('#h-to').value;
    if (!a || !b || new Date(b) <= new Date(a)) return toast('Pick a start and a later end');
    await api('/api/sleepLogs', { method: 'POST', body: { userId: me().id, start: new Date(a).toISOString(), end: new Date(b).toISOString() } }); await reload(); render();
  };
}

// ============ 8. counters ============
// Calendar-accurate difference: years, months, days, then h/m/s.
function breakdown(a, b) {
  if (a > b) [a, b] = [b, a];
  let y = b.getFullYear() - a.getFullYear(), mo = b.getMonth() - a.getMonth(), d = b.getDate() - a.getDate();
  let rest = (b.getHours() * 3600 + b.getMinutes() * 60 + b.getSeconds()) - (a.getHours() * 3600 + a.getMinutes() * 60 + a.getSeconds());
  if (rest < 0) { rest += 86400; d--; }
  if (d < 0) { mo--; d += new Date(b.getFullYear(), b.getMonth(), 0).getDate(); }
  if (mo < 0) { y--; mo += 12; }
  return { y, mo, w: Math.floor(d / 7), d: d % 7, h: Math.floor(rest / 3600), mi: Math.floor(rest % 3600 / 60), s: rest % 60 };
}
function counterHTML(c) {
  const date = new Date(c.date), now = new Date(), future = date > now;
  const b = breakdown(date, now), ms = Math.abs(now - date);
  const units = [['y', 'years'], ['mo', 'months'], ['w', 'weeks'], ['d', 'days'], ['h', 'hours'], ['mi', 'minutes'], ['s', 'seconds']];
  return `<div class="u-wrap">
    <div class="muted small">${future ? 'Time left until' : 'Time since'} ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
    <div class="units">${units.map(([k, l]) => `<div class="u"><b>${b[k]}</b><small>${l}</small></div>`).join('')}<div class="u"><b>${future ? '⏳' : '✓'}</b><small>${future ? 'to go' : 'passed'}</small></div></div>
    <div class="totals">or in total: <b>${(ms / (DAY * 365.2425)).toFixed(2)}</b> years · <b>${(ms / (DAY * 30.436875)).toFixed(1)}</b> months · <b>${Math.floor(ms / (7 * DAY)).toLocaleString()}</b> weeks · <b>${Math.floor(ms / DAY).toLocaleString()}</b> days · <b>${Math.floor(ms / 36e5).toLocaleString()}</b> hours · <b>${Math.floor(ms / 6e4).toLocaleString()}</b> minutes · <b>${Math.floor(ms / 1e3).toLocaleString()}</b> seconds</div>
  </div>`;
}
function renderCounters() {
  const list = [...S.data.counters].sort((a, b) => a.date.localeCompare(b.date));
  return `<div class="page">
    <div class="row"><h1>Counters</h1><div class="spacer"></div><button class="btn primary" id="add-counter">+ New counter</button></div>
    <p class="muted">Count the time since something happened (your wedding, quitting sugar) or until something comes (a trip, a birthday). Shared with ${partner() ? esc(partner().name) : 'your partner'}.</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">
    ${list.map(c => `<div class="card counter"><div class="head"><span class="dot" style="background:${PALETTE[c.color ?? 3]}"></span><b style="flex:1">${esc(c.title)}</b><button class="btn sm" data-edit-counter="${esc(c.id)}">Edit</button></div><div data-counter="${esc(c.id)}">${counterHTML(c)}</div></div>`).join('') || '<p class="muted">No counters yet.</p>'}
    </div></div>`;
}
function bindCounters() {
  $('#add-counter').onclick = () => openCounterEditor(null);
  $$('[data-edit-counter]').forEach(b => b.onclick = () => openCounterEditor(S.data.counters.find(c => c.id === b.dataset.editCounter)));
}
function openCounterEditor(c) {
  const isNew = !c;
  c = c || { title: '', date: new Date().toISOString(), color: 3 };
  const d = new Date(c.date);
  modal(`<h3>${isNew ? 'New counter' : 'Edit counter'}</h3>
    <label class="f">Name<input type="text" id="c-title" value="${esc(c.title)}" placeholder="Together since, Next vacation…"></label>
    <div class="two"><label class="f">Date<input type="date" id="c-d" value="${fmtDateInput(d)}"></label><label class="f">Time<input type="time" id="c-t" value="${fmtTimeInput(d)}"></label></div>
    <label class="f">Color<div class="swatches" id="c-color">${PALETTE.map((p, i) => `<button class="sw ${i === (c.color ?? 3) ? 'on' : ''}" style="background:${p}" data-i="${i}"></button>`).join('')}</div></label>
    <div class="actions">${isNew ? '' : '<button class="btn danger" id="c-del">Delete</button>'}<div class="spacer"></div><button class="btn" id="c-cancel">Cancel</button><button class="btn primary" id="c-save">Save</button></div>`,
    (m, close) => {
      $$('#c-color .sw', m).forEach(s => s.onclick = () => { $$('#c-color .sw', m).forEach(x => x.classList.remove('on')); s.classList.add('on'); });
      $('#c-cancel', m).onclick = close;
      $('#c-save', m).onclick = async () => {
        const body = { title: $('#c-title', m).value.trim() || 'Counter', date: parseLocal($('#c-d', m).value, $('#c-t', m).value || '00:00').toISOString(), color: +$('#c-color .sw.on', m).dataset.i };
        if (isNew) await api('/api/counters', { method: 'POST', body }); else await api('/api/counters/' + c.id, { method: 'PUT', body });
        close(); await reload(); render();
      };
      $('#c-del', m) && ($('#c-del', m).onclick = async () => { await api('/api/counters/' + c.id, { method: 'DELETE' }); close(); await reload(); render(); });
    });
}

// ============ 9. import / export ============
function renderTransfer() {
  const today = new Date();
  const shown = me().settings.extraCals || [];
  const cals = S.data.extraCalendars || [];
  const how = (title, steps) => `<details class="how"><summary>${title}</summary><ol class="small">${steps.map(s => `<li>${s}</li>`).join('')}</ol></details>`;
  return `<div class="page">
    <h1>Import / Export</h1>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      <div class="card">
        <h2 style="margin-top:0">${ICON.data} Bring events in</h2>
        <p class="small">Pick one or more files. DuoCal reads <b>.ics</b>, Google's <b>.zip</b>, <b>.csv</b> and <b>Excel (.xlsx)</b>. They're copied into "Us · DuoCal". Files stay on your device; nothing is uploaded anywhere.</p>
        <label class="btn primary" style="width:100%;margin:6px 0 10px">${ICON.plus} Choose files<input type="file" id="imp-file" accept=".ics,.ical,.zip,.csv,.txt,.xlsx" multiple hidden></label>
        <div class="row" style="margin-bottom:8px"><span class="small muted">The events are for:</span><div class="chips" id="imp-for">${S.data.members.map(m => `<button class="chip ${m.id === me().id ? 'on' : ''}" data-id="${esc(m.id)}">${m.id === me().id ? 'Me' : esc(m.name)}</button>`).join('')}</div></div>
        ${how('From Outlook', ['Windows Outlook: open your calendar → <b>File → Save Calendar</b> → save the <b>.ics</b> file.', 'Or: <b>File → Open &amp; Export → Import/Export → Export to a file → Comma Separated Values</b> → pick Calendar → save the <b>.csv</b>.', 'Outlook.com: Settings → Calendar → Shared calendars → Publish → copy the ICS link, then add it in Google (see "Show your other calendars").'])}
        ${how('From Google Calendar', ['On a computer: calendar.google.com → ⚙ Settings → <b>Import &amp; export → Export</b>.', 'Pick the downloaded <b>.zip</b> here as it is; DuoCal unpacks it.'])}
        ${how('From iPhone / Apple Calendar', ['iPhone calendars live in iCloud. On a Mac: Calendar → select a calendar → <b>File → Export → Export…</b> → the <b>.ics</b> file.', 'Without a Mac: on the iPhone, Calendar → Calendars → (i) next to the calendar → <b>Public Calendar</b> on → Share Link. Add that link in Google (see "Show your other calendars").'])}
        ${how('From Excel', ['First row = headings: <b>Subject</b> (or Title), <b>Start Date</b>, <b>Start Time</b>, <b>End Date</b>, <b>End Time</b>, and optionally <b>All Day Event</b>, <b>Location</b>, <b>Description</b>.', 'Dates like 2026-11-27 or 11/27/2026; times like 14:30 or 2:30 PM.', 'DuoCal\'s own Excel export can be imported back too.'])}
      </div>
      <div class="card">
        <h2 style="margin-top:0">${ICON.calendar} Send events out</h2>
        <div class="two"><label class="f">From<input type="date" id="x-from" value="${fmtDateInput(new Date(today.getFullYear(), today.getMonth() - 1, 1))}"></label><label class="f">To<input type="date" id="x-to" value="${fmtDateInput(new Date(today.getFullYear(), today.getMonth() + 3, 0))}"></label></div>
        <div class="export-grid">
          <button class="btn" id="x-xlsx"><b>Excel</b><span class="small muted">.xlsx · events, alarms, sleep, counters</span></button>
          <button class="btn" id="x-ics"><b>Calendar file</b><span class="small muted">.ics · iPhone/Apple, Google, Outlook</span></button>
          <button class="btn" id="x-csv"><b>Outlook / Google sheet</b><span class="small muted">.csv · their import format</span></button>
        </div>
        <p class="muted small" style="margin-top:10px">Tip: you don't need to export to see DuoCal on iPhone, Mac or Outlook. "Us · DuoCal" is a normal Google calendar, so add your Gmail account there and it stays in sync.</p>
      </div>
      <div class="card">
        <h2 style="margin-top:0">${ICON.history} Show your other calendars</h2>
        <p class="small">Pick any of <b>your</b> Google calendars to show here (read-only, only on your devices). To show an <b>Outlook or iCloud</b> calendar that keeps updating: in Google Calendar on a computer, <i>Other calendars → + → From URL</i>, paste its link, and it appears below.</p>
        ${cals.length ? cals.map(c => `<label class="row small" style="padding:6px 0"><input type="checkbox" data-extra="${esc(c.id)}" ${shown.includes(c.id) ? 'checked' : ''} style="width:20px;height:20px"> ${esc(c.name)}${c.primary ? ' <span class="muted">(main)</span>' : ''}</label>`).join('') : '<p class="muted small">No other calendars found.</p>'}
      </div>
    </div></div>`;
}
function bindTransfer() {
  $$('#imp-for .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
  $('#imp-file').onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    const forUsers = $$('#imp-for .chip.on').map(c => c.dataset.id);
    let added = 0; const problems = [];
    toast(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
    for (const f of files) {
      try {
        const r = await Importers.readFile(f);
        for (const text of r.ics) added += (await api('/api/import/ics', { method: 'POST', body: { text, forUsers } })).added;
        if (r.events.length) added += (await api('/api/import/rows', { method: 'POST', body: { items: r.events, forUsers } })).added;
      } catch (err) { problems.push(`${f.name}: ${err.message}`); }
    }
    await reload(); render();
    toast(problems.length ? problems.join(' · ') : `Imported ${added} event${added === 1 ? '' : 's'}`);
  };
  $$('[data-extra]').forEach(cb => cb.onchange = async () => {
    const ids = $$('[data-extra]').filter(x => x.checked).map(x => x.dataset.extra);
    try { await api('/api/me', { method: 'PUT', body: { settings: { extraCals: ids } } }); await reload(); render(); toast('Updated'); } catch (err) { toast(err.message); }
  });
  const range = () => [parseLocal($('#x-from').value), addDays(parseLocal($('#x-to').value), 1)];
  const stamp = () => fmtDateInput(new Date());
  $('#x-xlsx').onclick = async () => {
    try { const [from, to] = range(); const buf = await ExportXlsx.build(S.data, from, to, myTz()); Importers.download(`DuoCal-${stamp()}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
    catch (err) { toast('Export failed: ' + err.message); }
  };
  $('#x-ics').onclick = () => { // whole events, repeats kept as repeats
    const evs = S.data.events.filter(e => !e.readOnly);
    Importers.download(`DuoCal-${stamp()}.ics`, ICS.buildICS(evs, S.data.household.name || 'DuoCal'), 'text/calendar');
  };
  $('#x-csv').onclick = () => { // CSV has no repeats: every date in the range becomes its own row
    const [from, to] = range();
    Importers.download(`DuoCal-${stamp()}.csv`, Importers.buildCSV(occurrences(from, to).filter(o => !o.ev.readOnly)), 'text/csv');
  };
}

// ============ 10. settings ============
function renderSettings() {
  const s = me().settings, p = partner();
  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [deviceTz()]);
  return `<div class="page">
    <h1>Settings</h1>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
      <div class="card">
        <h2 style="margin-top:0">Appearance</h2>
        <div class="seg" id="theme">${[['light', '☀ Light'], ['dark', '🌙 Dark'], ['system', '🖥 Match device']].map(([v, l]) => `<button class="${s.theme === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
        <div class="row" style="margin-top:14px"><button class="switch ${s.clock24 ?? true ? 'on' : ''}" id="clock24"></button> 24-hour clock</div>
        <label class="f" style="margin-top:14px">Week starts on<select id="wkstart">${[0, 1, 6].map(i => `<option value="${i}" ${(s.weekStart ?? 0) === i ? 'selected' : ''}>${DOW[i]}</option>`).join('')}</select></label>
        <button class="btn" id="notif">🔔 ${'Notification' in window && Notification.permission === 'granted' ? 'Notifications are on' : 'Turn on notifications'}</button>
      </div>
      <div class="card">
        <h2 style="margin-top:0">🌍 Your time zone</h2>
        <div class="row"><button class="switch ${s.tzAuto !== false ? 'on' : ''}" id="tz-auto"></button><span class="small">Follow this device automatically</span></div>
        <label class="f" style="margin-top:10px">Time zone<select id="tz" ${s.tzAuto !== false ? 'disabled' : ''}>${zones.map(z => `<option ${z === myTz() ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        <p class="muted small">Your alarms, wake-up and bedtime follow this clock. ${p ? `${esc(p.name)} is on ${esc(tzOf(p.id))} (now ${esc(clockIn(tzOf(p.id)).hm)}).` : ''}</p>
      </div>
      <div class="card">
        <h2 style="margin-top:0">You</h2>
        <label class="f">Your name<input type="text" id="my-name" value="${esc(me().name)}" maxlength="40"></label>
        <div class="muted small">Signed in with Google as ${esc(me().email)}</div>
        <div class="actions"><button class="btn danger" id="logout">Sign out on this device</button><div class="spacer"></div><button class="btn primary" id="save-me">Save</button></div>
        <p class="muted small" style="margin-top:12px">To remove DuoCal's access completely: <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google account → Third-party access</a>.</p>
      </div>
      <div class="card">
        <h2 style="margin-top:0">💑 Your partner</h2>
        ${p ? `<p>Shared with <b>${esc(p.name)}</b> (${esc(p.email)}). You both see and edit everything.</p>
           <p class="small">${(me().trust || []).includes(p.id) ? `✓ ${esc(p.name)} can set alarms that alert you.` : `${esc(p.name)} can't set alarms for you yet.`}
           ${(p.trust || []).includes(me().id) ? `<br>✓ You can set alarms that alert ${esc(p.name)}.` : `<br>You can't set alarms for ${esc(p.name)} yet: they need to tap "Allow" in their DuoCal (Settings → Your partner).`}</p>
           ${(me().trust || []).includes(p.id) ? '' : `<button class="btn primary sm" id="p-trust">Let ${esc(p.name)} set my alarms</button>`}`
        : `<p class="small"><b>1.</b> Share with your partner's Gmail (Google emails them):</p>
           <div class="row"><input type="email" id="p-email" placeholder="partner@gmail.com" style="flex:1"><button class="btn primary" id="p-share">Share</button></div>
           <p class="small" style="margin-top:12px"><b>2.</b> Send them this link (WhatsApp, email…). They open it on their phone and sign in with that Gmail:</p>
           <code class="copy" id="invite">${esc(S.data.household.invite || '')}</code>
           <p class="muted small">The link alone gives no access: Google only lets in the Gmail you shared with.</p>`}
      </div>
      <div class="card">
        <h2 style="margin-top:0">📱 Install on iPhone, Mac, PC</h2>
        <p class="small"><b>iPhone:</b> open this page in <b>Safari</b> → Share → <b>Add to Home Screen</b>.<br><b>Mac:</b> Safari → File → <b>Add to Dock</b>.<br><b>Windows:</b> Edge/Chrome → ⋯ → Apps → <b>Install DuoCal</b>.</p>
        <p class="muted small">For alerts when DuoCal is closed, add your Gmail to the phone's Calendar app and keep "⏰ DuoCal alarms" and "Us · DuoCal" ticked. Allow Calendar notifications and turn on <i>Time Sensitive</i>.</p>
      </div>
    </div></div>`;
}
function bindSettings() {
  $$('#theme button').forEach(b => b.onclick = () => saveSettings({ theme: b.dataset.v }));
  $('#clock24').onclick = () => saveSettings({ clock24: !(me().settings.clock24 ?? true) });
  $('#wkstart').onchange = e => saveSettings({ weekStart: +e.target.value });
  $('#tz-auto').onclick = () => { const auto = me().settings.tzAuto === false; saveSettings(auto ? { tzAuto: true, tz: deviceTz() } : { tzAuto: false }); };
  $('#tz').onchange = e => saveSettings({ tz: e.target.value, tzAuto: false });
  $('#notif').onclick = async () => { if ('Notification' in window) { await Notification.requestPermission(); render(); notify('DuoCal', 'Notifications work!'); } else toast('On iPhone, install DuoCal to the Home Screen first'); };
  $('#save-me').onclick = async () => { try { await api('/api/me', { method: 'PUT', body: { name: $('#my-name').value } }); await reload(); render(); toast('Saved'); } catch (e) { toast(e.message); } };
  $('#logout').onclick = async () => {
    const c = await choose('Sign out?', 'This device forgets your calendars. Nothing is deleted. You can also cancel DuoCal\'s access at Google (you then allow it again at the next sign-in).', [['revoke', 'Sign out + cancel access'], ['yes', 'Sign out']]);
    if (c) signOut(c === 'revoke');
  };
  $('#p-trust') && ($('#p-trust').onclick = async () => { try { localStorage.removeItem('duocal.notnow.' + me().id + '.' + partner().id); await GStore.trustPartner(partner().id, true); await reload(); render(); toast('Done'); } catch (e) { toast(e.message); } });
  $('#p-share') && ($('#p-share').onclick = async () => { try { await api('/api/household', { method: 'PUT', body: { partner: $('#p-email').value } }); toast('Shared. Now send them the link below.'); } catch (e) { toast(e.message); } });
  $('#invite') && ($('#invite').onclick = () => { navigator.clipboard?.writeText($('#invite').textContent); toast('Link copied'); });
}
async function saveSettings(patch) {
  Object.assign(me().settings, patch); applyTheme(); render();
  try { await api('/api/me', { method: 'PUT', body: { settings: patch } }); } catch (e) { toast(e.message); }
}
function applyTheme() {
  const t = S.data?.me.settings.theme || localStorage.getItem('duocal.theme') || 'system';
  localStorage.setItem('duocal.theme', t);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // the phone's status bar / browser bar takes the theme's background colour
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#07060c' : '#f4f1ea';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ============ 11. sign-in and first-time setup ============
function renderAuth() {
  const joining = /join=/.test(location.hash) || sessionStorage.getItem('duocal.pendingJoin');
  $('#app').innerHTML = `<div class="auth"><div class="card">
    <h1><img src="icon.svg" alt="">DuoCal</h1>
    <p class="muted">${joining ? 'Your partner invited you. Sign in with the Gmail they shared with.' : 'One calendar for the two of you, kept in your own Google Calendar.'}</p>
    <button class="btn primary" id="g-in" style="width:100%;padding:12px;font-size:16px">Sign in with Google</button>
    <p class="muted small" style="margin-top:14px">DuoCal never sees your password. Google handles sign-in, and your data stays in your Google calendars. Google may say "hasn't verified this app": tap <b>Advanced → Go to DuoCal</b>. It's your own app.</p>
  </div></div>`;
  $('#g-in').onclick = () => GAuth.signIn({ hint: localStorage.getItem('duocal.lastEmail') || undefined });
}
function renderSetup(email) {
  $('#app').innerHTML = `<div class="auth"><div class="card">
    <h1><img src="icon.svg" alt="">Welcome</h1>
    <p>Signed in as <b>${esc(email)}</b>.</p>
    <p class="small"><b>First of the two of you?</b> Create your shared calendar. You can add your partner now or later.</p>
    <label class="f">Partner's Gmail (optional)<input type="email" id="s-partner" placeholder="partner@gmail.com"></label>
    <button class="btn primary" id="s-create" style="width:100%;padding:11px">Create "Us · DuoCal"</button>
    <p class="muted small" style="margin-top:14px"><b>Your partner already set it up?</b> Open the invite link they sent you, on this device.</p>
    <button class="btn sm" id="s-out">Use a different Google account</button>
  </div></div>`;
  $('#s-create').onclick = async () => {
    $('#s-create').disabled = true; $('#s-create').textContent = 'Creating…';
    try { await GStore.createHousehold($('#s-partner').value.trim() || null); await afterInit(); }
    catch (e) { toast(e.message); $('#s-create').disabled = false; $('#s-create').textContent = 'Create "Us · DuoCal"'; }
  };
  $('#s-out').onclick = () => signOut();
}
async function startWith(email, join) {
  $('#app').innerHTML = '<div class="auth"><div class="card"><h1><img src="icon.svg" alt="">DuoCal</h1><p class="muted">Loading your calendars…</p></div></div>';
  try {
    const r = await GStore.init(email, join);
    sessionStorage.removeItem('duocal.pendingJoin');
    if (r.confirmJoin) return renderConfirmJoin(email, r.confirmJoin);
    if (r.lost) return renderLost(email);
    if (r.setup) return renderSetup(email);
    await afterInit();
  } catch (e) {
    if (e.auth) return renderAuth();
    $('#app').innerHTML = `<div class="auth"><div class="card"><h1>DuoCal</h1><p>${esc(e.message)}</p><button class="btn primary" id="retry">Try again</button> <button class="btn" id="out">Sign out</button></div></div>`;
    $('#retry').onclick = () => startWith(email, join); $('#out').onclick = () => signOut();
  }
}
// Joining is never automatic: show exactly whose household this is.
function renderConfirmJoin(email, j) {
  $('#app').innerHTML = `<div class="auth"><div class="card">
    <h1><img src="icon.svg" alt="">Join this household?</h1>
    <p>Signed in as <b>${esc(email)}</b>. This invite leads to the DuoCal of:</p>
    ${j.people.map(p => `<div class="row" style="margin:6px 0"><span class="avatar" style="background:var(--c6)">${esc(initials(p.name))}</span><div><b>${esc(p.name)}</b><div class="muted small">${esc(p.email)}</div></div></div>`).join('')}
    <p class="small">Only join if this is your partner. Your events and sleep log will be shared with them.</p>
    <div class="actions"><button class="btn" id="j-no">No</button><div class="spacer"></div><button class="btn primary" id="j-yes">Yes, join</button></div>
  </div></div>`;
  $('#j-no').onclick = () => renderSetup(email);
  $('#j-yes').onclick = async () => { $('#j-yes').disabled = true; try { const r = await GStore.confirmJoin(j); if (r.ok) await afterInit(); } catch (e) { toast(e.message); $('#j-yes').disabled = false; } };
}
function renderLost(email) {
  $('#app').innerHTML = `<div class="auth"><div class="card">
    <h1><img src="icon.svg" alt="">Calendars not found</h1>
    <p class="small">The DuoCal calendars this device used are no longer available to <b>${esc(email)}</b>: they were unshared or deleted. DuoCal won't switch to other calendars on its own.</p>
    <div class="actions"><button class="btn" id="l-out">Sign out</button><div class="spacer"></div><button class="btn primary" id="l-reset">Start over</button></div>
  </div></div>`;
  $('#l-out').onclick = () => signOut();
  $('#l-reset').onclick = async () => { if (await choose('Start over?', 'This device forgets the old household. Nothing in Google is deleted.', [['yes', 'Start over']])) { GStore.forgetHousehold(); startWith(email, null); } };
}
// "Sam joined. Let Sam set alarms for you?" (your alarm calendar is shared only after you say yes)
function showTrustPrompt() {
  const p = GStore.pendingTrust && GStore.pendingTrust();
  if (!p || $('#trust')) return;
  const b = document.createElement('div'); b.id = 'trust';
  b.style.cssText = 'position:fixed;bottom:84px;left:50%;transform:translateX(-50%);z-index:250;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:var(--shadow);max-width:92vw;width:420px';
  b.innerHTML = `<b>${esc(p.name)}</b> <span class="muted small">(${esc(p.email)})</span> is in your household. Let them set alarms that ring on your phone?<div class="actions" style="margin-top:10px"><button class="btn sm" data-a="0">Not now</button><div class="spacer"></div><button class="btn primary sm" data-a="1">Allow</button></div>`;
  b.querySelectorAll('[data-a]').forEach(x => x.onclick = async () => { b.remove(); try { await GStore.trustPartner(p.email, x.dataset.a === '1'); await reload(); render(); if (x.dataset.a === '1') toast('Done'); } catch (e) { toast(e.message); } });
  document.body.append(b);
}
async function afterInit() {
  await reload();
  // keep my time zone in step with this device (unless I picked one by hand)
  if (me().settings.tzAuto !== false && me().settings.tz !== deviceTz()) await api('/api/me', { method: 'PUT', body: { settings: { tz: deviceTz(), tzAuto: true } } }).then(reload).catch(() => { });
  connectStream(); render(); showTrustPrompt();
}
async function signOut(revoke = false) {
  await GStore.signOutEverything({ revoke });
  S.data = null; clearInterval(pollTimer); $('#modal-root').innerHTML = ''; renderAuth();
}

// ============ 12. background ticker (every second) ============
// Updates live clocks/counters and fires alarms, snoozes and reminders.
function fired(key) { const k = 'duocal.fired.' + key; if (localStorage.getItem(k)) return true; localStorage.setItem(k, Date.now()); return false; }
function cleanupFired() { for (const k of Object.keys(localStorage)) if (k.startsWith('duocal.fired.') && Date.now() - +localStorage.getItem(k) > 3 * DAY) localStorage.removeItem(k); }

let lastMinuteCheck = '';
function tick() {
  const now = new Date();
  $$('[data-clock]').forEach(el => {
    const t = el.dataset.clock;
    // clocks show *my* time zone (it can differ from the device's when travelling)
    const tz = S.data ? myTz() : deviceTz();
    el.textContent = t === 'date' ? now.toLocaleDateString([], { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })
      : t === 'hm' ? fmtIn(tz, now) : now.toLocaleTimeString([], { timeZone: tz, hourCycle: use24h() ? 'h23' : 'h12' });
  });
  $$('[data-since]').forEach(el => {
    const ms = now - new Date(el.dataset.since);
    el.textContent = el.dataset.long ? `${Math.floor(ms / 36e5)}:${pad(Math.floor(ms / 6e4) % 60)}:${pad(Math.floor(ms / 1e3) % 60)}` : durText(ms);
  });
  $$('[data-until-bed]').forEach(el => {
    const s = me().settings; let bed = parseLocal(fmtDateInput(now), s.bedtime); if (bed < now) bed = addDays(bed, 1);
    el.textContent = durText(bed - now) + ' to bedtime';
  });
  $$('[data-tzclock]').forEach(el => { try { el.textContent = fmtIn(el.dataset.tzclock, now); } catch { } });
  if (S.page === 'counters') $$('[data-counter]').forEach(el => { const c = S.data.counters.find(x => x.id === el.dataset.counter); if (c) el.innerHTML = counterHTML(c); });
  if (!S.data) return;

  // snoozed alarms
  const sn = JSON.parse(localStorage.getItem('duocal.snoozes') || '[]');
  const due = sn.filter(x => x.at <= Date.now());
  if (due.length) { localStorage.setItem('duocal.snoozes', JSON.stringify(sn.filter(x => x.at > Date.now()))); ring(due[0].label, due[0].snoozeMin); }

  const minuteKey = `${fmtDateInput(now)} ${fmtTimeInput(now)}`;
  if (minuteKey === lastMinuteCheck) return; // the rest only needs to run once a minute
  lastMinuteCheck = minuteKey;
  const mine = clockIn(myTz(), now), hm = mine.hm, today = mine.date; // my own clock, wherever this device is

  for (const a of S.data.alarms) {
    if (!a.enabled || a.forUser !== me().id || a.time !== hm) continue;
    const repeatHit = alarmOnDay(a, today, mine.dow);
    if (!repeatHit || fired(`alarm.${a.id}.${minuteKey}`)) continue;
    ring(a.label || 'Alarm', a.snooze || 9);
    if (!a.every && (!a.days || !a.days.length)) api('/api/alarms/' + a.id, { method: 'PUT', body: { enabled: false } }).then(reload).catch(() => { });
  }
  const s = me().settings;
  if (s.wakeAlarm && s.waketime === hm && !fired(`wake.${minuteKey}`)) ring('Wake up ☀️', 9);
  if (s.bedtimeReminder > 0) {
    const [bh, bm] = s.bedtime.split(':').map(Number), rm = ((bh * 60 + bm - s.bedtimeReminder) % 1440 + 1440) % 1440;
    const remindAt = `${pad(Math.floor(rm / 60))}:${pad(rm % 60)}`;
    if (remindAt === hm && !openSleep(me().id) && !fired(`bed.${minuteKey}`)) { notify('🌙 Bedtime soon', `Bedtime in ${s.bedtimeReminder} minutes (${s.bedtime})`); toast(`🌙 Bedtime in ${s.bedtimeReminder} minutes`); }
  }
  // event reminders for events that are for me (look ahead up to a week for "1 week before")
  for (const o of occurrences(new Date(now - 6e4), new Date(+now + 8 * DAY))) {
    const forU = o.ev.forUsers && o.ev.forUsers.length ? o.ev.forUsers : [o.ev.createdBy];
    if (!forU.includes(me().id)) continue;
    for (const m of o.ev.reminders || []) {
      const at = o.start - m * 6e4;
      if (now >= at && now - at < 120000 && !fired(`rem.${o.ev.id}.${o.start.getTime()}.${m}`)) {
        const when = m === 0 ? 'now' : `in ${m >= 1440 ? Math.round(m / 1440) + ' day(s)' : m >= 60 ? Math.round(m / 60) + ' hour(s)' : m + ' min'}`;
        notify('📅 ' + o.ev.title, `Starts ${when} · ${fmtTime(o.start)}${o.ev.location ? ' · ' + o.ev.location : ''}`);
        toast(`📅 ${o.ev.title} starts ${when}`);
        Sound.unlock(); if (Sound.ctx) Sound.beep(880, Sound.ctx.currentTime, 0.3);
      }
    }
  }
  if (now.getMinutes() === 0) cleanupFired();
  // keep the red "now" line moving
  if (S.page === 'calendar' && !S.busy && !$('.overlay')) $$('.nowline').forEach(l => l.style.top = (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR + 'px');
}
setInterval(tick, 1000);
let wasPhone = phone();
addEventListener('resize', () => { if (phone() !== wasPhone) { wasPhone = phone(); if (S.data && !$('.overlay')) render(); } });

// ============ 13. boot ============
(async function boot() {
  // Refuse to run inside someone else's page (clickjacking): GitHub Pages can't send X-Frame-Options.
  if (window.top !== window.self) { document.body.innerHTML = ''; return; }
  applyTheme();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { });
  const r = await GAuth.handleRedirect();
  if (r && r.error) {
    const msg = { access_denied: 'Google sign-in was cancelled.', interaction_required: '', login_required: '', consent_required: '', scope: 'Please allow DuoCal to see and edit your calendars (tick the box).', audience: 'That sign-in was not for DuoCal.', state: 'That sign-in link was old or not started here. Try again.' }[r.error];
    if (msg) setTimeout(() => toast(msg), 300);
    if (r.join) sessionStorage.setItem('duocal.pendingJoin', r.join);
  }
  // an invite link opened while already signed in
  const hj = location.hash.match(/(?:^#|&)join=([^&]+)/);
  if (hj) { sessionStorage.setItem('duocal.pendingJoin', decodeURIComponent(hj[1]).slice(0, 600)); history.replaceState(null, '', location.pathname + location.search); }
  const t = GAuth.current();
  if (!t) return renderAuth();
  await startWith(t.email, (r && r.join) || sessionStorage.getItem('duocal.pendingJoin'));
})();

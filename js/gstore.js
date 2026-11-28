// gstore.js — DuoCal's storage, living entirely in Google Calendar.
//
// There is no DuoCal server. Each phone/Mac/PC talks to Google directly, so it
// works from any country, on any internet (Starlink included), with this PC off.
//
// Calendars (created once by whoever sets up DuoCal, shared with the partner by Google):
//   "Us · DuoCal"            [duocal:us]    your shared events — shows in iPhone/Mac/Outlook calendars
//   "DuoCal · data"          [duocal:data]  people, alarms, counters, sleep — hidden, used by the app
//   "⏰ DuoCal alarms · Name" [duocal:alarms:<email>]  one per person, owned by that person;
//                            every event alerts at its start, so phones notify even with DuoCal closed
//
// Who can see what is decided by Google's sharing, not by DuoCal. This file answers
// the same requests the old PC server did (handle('/api/...')), so the UI barely changed.
(function (root) {
  const API = 'https://www.googleapis.com/calendar/v3';
  const MARK = { us: '[duocal2:us]', data: '[duocal2:data]', alarms: e => `[duocal2:alarms:${e}]` };
  const OLD_MARK = /\[duocal:(us|data|alarms:[^\]]*)\]/; // calendars from before pairing (to wipe)
  const TO_GCOLOR = ['9', '1', '7', '2', '10', '5', '6', '11'];
  const FROM_GCOLOR = { 1: 1, 2: 3, 3: 1, 4: 7, 5: 5, 6: 6, 7: 2, 8: 0, 9: 0, 10: 4, 11: 7 };
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { validate } = root.Validate;
  // Strict shapes for anything that ends up inside the page's markup (ids, emails)
  const SAFE_EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;
  const SAFE_ID = /^[A-Za-z0-9_@.#:-]{1,300}$/;
  // TRUST RULE: anyone can *invite* a calendar to an event, and invitations show up inside it.
  // So we only trust an event that was really made inside our calendar (its organizer IS that
  // calendar) and whose creator is one of the two of you.
  const lower = x => String(x || '').toLowerCase();
  const madeIn = (g, calId) => !!calId && lower(g.organizer && g.organizer.email) === lower(calId);
  const creatorOf = g => lower(g.creator && g.creator.email);
  const PIN = () => 'duocal.home.' + S.me; // this device remembers which household is yours

  // ---------- state ----------
  let S = blank();
  function blank() { return { me: null, usId: null, dataId: null, myAlarmCal: null, usName: 'Us', raw: { us: {}, data: {}, extra: {} }, tokens: {}, extraMeta: [] }; }
  const cacheKey = () => 'duocal.cache.' + S.me;
  function saveCache() {
    try { localStorage.setItem(cacheKey(), JSON.stringify({ v: 1, usId: S.usId, dataId: S.dataId, myAlarmCal: S.myAlarmCal, usName: S.usName, raw: S.raw, tokens: S.tokens })); } catch { /* storage full: run without cache */ }
  }
  function loadCache() {
    try { const c = JSON.parse(localStorage.getItem(cacheKey()) || 'null'); if (c && c.v === 1) Object.assign(S, c); } catch { }
  }
  function clearAllCaches() { for (const k of Object.keys(localStorage)) if (k.startsWith('duocal.cache.')) localStorage.removeItem(k); }

  // ---------- Google Calendar API ----------
  class AuthNeeded extends Error { constructor() { super('Please sign in to Google again'); this.auth = true; } }
  async function gapi(method, path, body, query) {
    const t = GAuth.current();
    if (!t) throw new AuthNeeded();
    const url = API + path + (query ? '?' + new URLSearchParams(query) : '');
    let r;
    try { r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + t.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', referrerPolicy: 'no-referrer' }); }
    catch { const e = new Error("Can't reach Google — check the internet connection"); e.offline = true; throw e; }
    if (r.status === 401) { await GAuth.signOut({ byUser: false }); throw new AuthNeeded(); }
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error('Google Calendar: ' + String((j.error && j.error.message) || r.status).slice(0, 160)); e.status = r.status; throw e; }
    return j;
  }
  const cal = id => '/calendars/' + encodeURIComponent(id);
  async function listAll(path, query) {
    const out = []; let pageToken = null, next = null;
    do {
      const j = await gapi('GET', path, null, { ...query, ...(pageToken ? { pageToken } : {}) });
      out.push(...(j.items || [])); pageToken = j.nextPageToken; next = j.nextSyncToken || next;
      if (out.length > 50000) break;
    } while (pageToken);
    return { items: out, nextSyncToken: next };
  }

  // ---------- start-up: find (or join) the household ----------
  async function init(email, joinParam) {
    S = blank(); S.me = email;
    loadCache();
    const list = (await listAll('/users/me/calendarList', { minAccessRole: 'reader', showHidden: 'true', maxResults: '250' })).items;
    S.extraMeta = list.filter(c => !/\[duocal2?:/.test(c.description || '')).map(c => ({ id: c.id, name: String(c.summaryOverride || c.summary || c.id).slice(0, 100), primary: !!c.primary }));
    const writable = id => list.find(c => c.id === id && ['owner', 'writer'].includes(c.accessRole));
    S.list = list;
    let pin = null; try { pin = JSON.parse(localStorage.getItem(PIN()) || 'null'); } catch { }
    if (!pin && !joinParam) {
      // A device that doesn't know the household yet (new phone, or an iPhone Home Screen app,
      // which has its own storage separate from Safari). Look at every household this account
      // can see. Exactly one with *my own* record in it → that's mine. Several, or only ones I'm
      // not in yet → let the person choose. Never create a second household silently.
      const all = await households();
      const mine = all.filter(h => h.mine && h.usId);
      if (mine.length === 1 && !all.some(h => !h.mine)) { pin = { usId: mine[0].usId, dataId: mine[0].dataId }; localStorage.setItem(PIN(), JSON.stringify(pin)); }
      else if (all.length) return { choose: all };
    }
    if (!pin) { S.usId = S.dataId = null; return { setup: true }; }
    const us = writable(pin.usId), data = writable(pin.dataId);
    if (!us || !data) return { lost: true }; // never switch households on our own
    if (S.usId !== us.id) { S.raw = { us: {}, data: {}, extra: {} }; S.tokens = {}; } // different household than the cache
    S.usId = us.id; S.dataId = data.id; S.usName = String(us.summaryOverride || us.summary || 'Us').slice(0, 60);
    // my alarms calendar: one that I OWN (a calendar someone shared with me doesn't count)
    const mineAl = list.find(c => c.accessRole === 'owner' && (c.description || '').includes(MARK.alarms(email)));
    S.myAlarmCal = mineAl ? mineAl.id : null;
    await sync();
    await ensureMe();
    await reconcile();
    saveCache();
    return { ok: true };
  }

  // Every DuoCal household this account can open, with the people in it (by the trust rule).
  async function households() {
    const list = S.list || (await listAll('/users/me/calendarList', { minAccessRole: 'reader', showHidden: 'true', maxResults: '250' })).items;
    const writable = id => list.find(c => c.id === id && ['owner', 'writer'].includes(c.accessRole));
    const usCals = list.filter(c => (c.description || '').includes(MARK.us) && ['owner', 'writer'].includes(c.accessRole));
    const out = [];
    for (const c of list.filter(c => (c.description || '').includes(MARK.data) && ['owner', 'writer'].includes(c.accessRole)).slice(0, 10)) {
      const people = await trustedMembersOf(c.id).catch(() => []);
      if (!people.length) continue;
      // the shared calendar of this household: as written in a member record, else the only candidate
      let usId = (people.find(m => m.us && writable(m.us)) || {}).us || null;
      if (!usId && usCals.length === 1) usId = usCals[0].id;
      if (!usId) continue;
      out.push({ dataId: c.id, usId, people: people.map(m => ({ name: m.name, email: m.email })), mine: people.some(m => m.email === S.me),
        owner: c.accessRole === 'owner' && (writable(usId) || {}).accessRole === 'owner', current: c.id === S.dataId });
    }
    return out;
  }
  // Delete a household that only I am in and that I own (e.g. one made by mistake).
  async function deleteHousehold({ usId, dataId }) {
    const all = await households();
    const h = all.find(x => x.dataId === dataId && x.usId === usId);
    if (!h || !h.owner || h.people.some(m => m.email !== S.me) || h.current) throw new Error("This household can't be deleted here.");
    await gapi('DELETE', cal(usId)); await gapi('DELETE', cal(dataId));
    S.list = null;
  }

  // Member records of a data calendar, by the trust rule (for the join confirmation)
  async function trustedMembersOf(dataId) {
    const r = await listAll(cal(dataId) + '/events', { sharedExtendedProperty: 't=member', maxResults: '50' });
    return r.items.filter(g => madeIn(g, dataId) && SAFE_EMAIL.test(P(g).email || '') && creatorOf(g) === P(g).email)
      .map(g => ({ email: P(g).email, name: String(P(g).name || P(g).email).slice(0, 40), us: P(g).us || null })).slice(0, 2);
  }
  async function confirmJoin({ usId, dataId }) {
    try {
      await gapi('POST', '/users/me/calendarList', { id: usId, selected: true });
      await gapi('POST', '/users/me/calendarList', { id: dataId, selected: false, hidden: true });
    } catch (e) { if (e.status !== 409) throw new Error("Couldn't open the shared calendars. Ask your partner to share them with this Gmail address first."); }
    localStorage.setItem(PIN(), JSON.stringify({ usId, dataId }));
    clearAllCaches(); S.list = null;
    return init(S.me, null);
  }
  function forgetHousehold() { localStorage.removeItem(PIN()); clearAllCaches(); }

  // First person: create the calendars and share them with the partner.
  async function createHousehold(partnerEmail) {
    if (!S.me) throw new Error('Please sign in again.');
    const tz = deviceTz();
    // Reuse an empty pair I made earlier (e.g. a setup that stopped half-way) instead of piling up calendars.
    const list = (await listAll('/users/me/calendarList', { minAccessRole: 'owner', showHidden: 'true', maxResults: '250' })).items.filter(c => c.accessRole === 'owner');
    let us = list.find(c => (c.description || '').includes(MARK.us)), data = null;
    for (const c of list.filter(c => (c.description || '').includes(MARK.data))) {
      const people = await trustedMembersOf(c.id).catch(() => null);
      if (people && !people.some(m => m.email !== S.me)) { data = c; break; }
    }
    if (!us || !data) { us = null; data = null; }
    if (!us) us = await gapi('POST', '/calendars', { summary: 'Us · DuoCal', description: MARK.us + ' Shared calendar kept by DuoCal.', timeZone: tz });
    if (!data) data = await gapi('POST', '/calendars', { summary: 'DuoCal · data', description: MARK.data + ' DuoCal app data (alarms, sleep, counters). You can hide this calendar.', timeZone: tz });
    await gapi('PATCH', '/users/me/calendarList/' + encodeURIComponent(data.id), { hidden: true, selected: false }).catch(() => { });
    if (partnerEmail) await sharePartner(partnerEmail, [us.id, data.id]);
    localStorage.setItem(PIN(), JSON.stringify({ usId: us.id, dataId: data.id }));
    return init(S.me, null);
  }
  async function sharePartner(email, ids = [S.usId, S.dataId, S.myAlarmCal].filter(Boolean), notify = true) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter your partner's Gmail address.");
    if (email === S.me) throw new Error("That's your own address.");
    for (const id of ids) await gapi('POST', cal(id) + '/acl', { role: 'writer', scope: { type: 'user', value: email } }, { sendNotifications: notify ? 'true' : 'false' });
  }
  const inviteLink = () => null; // links are gone: partners pair with a code (see "pairing")

  // ---------- sync (polling: every 30 s while open) ----------
  async function pullCalendar(key, id) {
    const store = S.raw[key];
    const q = S.tokens[key] ? { syncToken: S.tokens[key] } : { timeMin: new Date(Date.now() - 400 * 864e5).toISOString() };
    let res;
    try { res = await listAll(cal(id) + '/events', { ...q, showDeleted: 'true', singleEvents: 'false', maxResults: '2500' }); }
    catch (e) { if (e.status === 410) { S.tokens[key] = null; S.raw[key] = {}; return pullCalendar(key, id); } throw e; }
    let changed = false;
    for (const g of res.items) {
      if (!SAFE_ID.test(g.id || '')) continue;
      if (g.status === 'cancelled' && !g.recurringEventId) { if (store[g.id]) { delete store[g.id]; changed = true; } continue; }
      store[g.id] = g; changed = true;
    }
    if (res.nextSyncToken) S.tokens[key] = res.nextSyncToken;
    return changed;
  }
  let syncing = null;
  async function sync() {
    if (!S.usId) return false;
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const a = await pullCalendar('us', S.usId), b = await pullCalendar('data', S.dataId);
        await pullExtras();
        saveCache();
        return a || b;
      } finally { syncing = null; }
    })();
    return syncing;
  }
  // The user's other Google calendars they chose to show (read-only): e.g. an Outlook or iCloud
  // calendar added to Google with "From URL". Refreshed every 10 minutes.
  let extrasAt = 0;
  async function pullExtras(force) {
    const ids = (myMember() && myMember().settings.extraCals) || [];
    if (!force && Date.now() - extrasAt < 10 * 60e3) return;
    extrasAt = Date.now();
    const next = {};
    for (const id of ids.slice(0, 10)) {
      try {
        // Google expands repeats into single dates here, so a hostile rule can't make us do the work
        const r = await listAll(cal(id) + '/events', { timeMin: new Date(Date.now() - 60 * 864e5).toISOString(), timeMax: new Date(Date.now() + 400 * 864e5).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
        next[id] = r.items.filter(g => g.status !== 'cancelled' && SAFE_ID.test(g.id || '')).slice(0, 5000);
      } catch { next[id] = S.raw.extra[id] || []; }
    }
    S.raw.extra = next;
  }

  // ---------- reading records out of Google events ----------
  const P = g => (g.extendedProperties && g.extendedProperties.shared) || {};
  function parseGDate(x, zoneHint) {
    if (!x) return null;
    if (x.date) { const [y, m, d] = x.date.split('-').map(Number); return { date: new Date(Date.UTC(y, m - 1, d)), allDay: true }; }
    if (x.dateTime) {
      const m = String(x.dateTime).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
      const z = validTz(x.timeZone) || validTz(zoneHint);
      if (m && z) return { date: Recur.wallCal(z).fromWall(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]))), allDay: false };
      return { date: new Date(x.dateTime), allDay: false };
    }
    return null;
  }
  const validTz = z => typeof z === 'string' && !validate('settings', { tz: z }, { partial: true }).error ? z : null;
  const wallString = (d, z) => Recur.wallCal(z).toWall(d).toISOString().slice(0, 19);

  function members() {
    const out = [];
    for (const g of Object.values(S.raw.data)) {
      const p = P(g);
      if (p.t !== 'member' || !SAFE_EMAIL.test(p.email || '')) continue;
      if (!madeIn(g, S.dataId) || creatorOf(g) !== p.email) continue; // only the person themself can make their record
      let settings = {}; try { settings = JSON.parse(p.s || '{}'); } catch { }
      const trust = String(p.trust || '').split(',').filter(x => SAFE_EMAIL.test(x));
      out.push({ id: p.email, email: p.email, name: String(p.name || p.email.split('@')[0]).slice(0, 40), alarmCal: p.alarmCal || null, us: p.us || null, trust, settings: cleanSettings(settings), _gid: g.id, _upd: g.updated || '' });
    }
    // one record per person (the newest wins), at most 2 people (the earliest two)
    const seen = new Map();
    for (const m of out.sort((a, b) => a._upd.localeCompare(b._upd))) seen.set(m.id, m);
    return [...seen.values()].slice(0, 2);
  }
  const myMember = () => members().find(m => m.id === S.me);
  function cleanSettings(s) {
    const r = validate('settings', s || {}, { partial: true });
    const v = r.error ? {} : r.value;
    if (Array.isArray(s && s.extraCals)) v.extraCals = s.extraCals.filter(x => typeof x === 'string' && x.length < 300).slice(0, 10);
    return { theme: 'system', bedtime: '23:00', waketime: '07:00', wakeAlarm: false, bedtimeReminder: 30, weekStart: 0, clock24: true, ...v };
  }

  function usEvents() {
    const ms = members().map(m => m.id);
    const masters = [], parentsEx = new Map();
    for (const g of Object.values(S.raw.us)) {
      if (g.recurringEventId) { // one changed or cancelled date of a repeating event
        const o = parseGDate(g.originalStartTime, g.start && g.start.timeZone);
        if (o) { if (!parentsEx.has(g.recurringEventId)) parentsEx.set(g.recurringEventId, []); parentsEx.get(g.recurringEventId).push(o.date.toISOString()); }
        if (g.status === 'cancelled') continue;
      }
      masters.push(g);
    }
    const out = [];
    for (const g of masters) {
      const e = fromGoogle(g, ms);
      if (!e) continue;
      if (!madeIn(g, S.usId)) { e.readOnly = true; e.reminders = []; e.source = 'invite'; } // an outside invitation
      const inst = parentsEx.get(g.id) || [];
      if (inst.length) { e._instEx = inst; e.exdates = [...new Set([...(e.exdates || []), ...inst])].slice(-500); }
      if (g.recurringEventId) e.rrule = null;
      out.push(e);
    }
    return out;
  }
  function fromGoogle(g, memberIds, readOnly) {
    const s = parseGDate(g.start), en = parseGDate(g.end, g.start && g.start.timeZone);
    if (!s || !en || isNaN(s.date) || isNaN(en.date)) return null;
    let rrule = null; const exdates = [];
    for (const line of g.recurrence || []) {
      if (/^RRULE:/i.test(line)) rrule = line.slice(6);
      else if (/^EXDATE/i.test(line)) {
        const head = line.slice(0, line.indexOf(':')), vals = line.slice(line.indexOf(':') + 1);
        const tzid = validTz((head.match(/TZID=([^;:]+)/) || [])[1]);
        for (const v of vals.split(',').slice(0, 500)) {
          const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
          if (!m) continue;
          const d = !m[4] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3])) : m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
            : Recur.wallCal(tzid || validTz(g.start.timeZone) || null).fromWall(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
          if (!isNaN(d)) exdates.push(d.toISOString());
        }
      }
    }
    const p = P(g);
    const forUsers = String(p.duocalFor || '').split(',').filter(id => memberIds.includes(id));
    const rem = String(p.duocalRem || '').split(',').filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n >= 0);
    const raw = {
      title: g.summary || '(no title)', notes: g.description || '', location: g.location || '',
      start: s.date.toISOString(), end: en.date.toISOString(), allDay: s.allDay, rrule, exdates,
      tz: s.allDay ? null : (validTz(g.start.timeZone) || null),
      color: p.duocalColor !== undefined ? +p.duocalColor : (g.colorId ? (FROM_GCOLOR[g.colorId] ?? 1) : 1),
      forUsers: forUsers.length ? forUsers : memberIds.slice(),
      reminders: p.duocalRem !== undefined ? rem : ((g.reminders && g.reminders.overrides) || []).map(r => r.minutes),
    };
    let v = validate('events', raw, { partial: false });
    if (v.error) v = validate('events', { ...raw, rrule: null, tz: null }, { partial: false });
    if (v.error) return null;
    const creator = String((g.creator && g.creator.email) || '').toLowerCase();
    const editor = lower(p.duocalBy);
    return { ...v.value, id: g.id, createdBy: memberIds.includes(creator) ? creator : null, updatedBy: memberIds.includes(editor) ? editor : (memberIds.includes(creator) ? creator : null), updatedAt: g.updated, readOnly: !!readOnly, source: readOnly ? 'extra' : 'google' };
  }
  function toGoogle(e) {
    const s = new Date(e.start), en = new Date(e.end), z = e.tz || deviceTz();
    const inst = new Set(e._instEx || []);
    const exd = (e.exdates || []).filter(x => !inst.has(x));
    return {
      summary: e.title, description: e.notes || '', location: e.location || '',
      start: e.allDay ? { date: s.toISOString().slice(0, 10) } : { dateTime: wallString(s, z), timeZone: z },
      end: e.allDay ? { date: en.toISOString().slice(0, 10) } : { dateTime: wallString(en, z), timeZone: z },
      colorId: TO_GCOLOR[e.color ?? 1] || '9',
      recurrence: e.rrule ? ['RRULE:' + e.rrule, ...exd.map(x => e.allDay ? `EXDATE;VALUE=DATE:${x.slice(0, 10).replace(/-/g, '')}` : `EXDATE;TZID=${z}:${wallString(new Date(x), z).replace(/[-:]/g, '')}`)] : [],
      extendedProperties: { shared: { duocalBy: S.me, duocalFor: (e.forUsers || []).join(',').slice(0, 500), duocalRem: (e.reminders || []).join(','), duocalColor: String(e.color ?? 1) } },
      // Google keeps reminders per person: this sets *mine*. My partner's app sets theirs.
      reminders: myReminders(e),
    };
  }
  function myReminders(e) {
    const forMe = !(e.forUsers && e.forUsers.length) || e.forUsers.includes(S.me);
    return { useDefault: false, overrides: forMe ? (e.reminders || []).slice(0, 5).map(m => ({ method: 'popup', minutes: Math.min(m, 40320) })) : [] };
  }

  function dataRecords() {
    const alarms = [], counters = [], sleepLogs = [];
    const ms = members().map(m => m.id);
    for (const g of Object.values(S.raw.data)) {
      const p = P(g);
      if (!madeIn(g, S.dataId) || !ms.includes(creatorOf(g))) continue; // trust rule
      if (p.t === 'counter') {
        const s = parseGDate(g.start); if (!s) continue;
        const v = validate('counters', { title: g.summary || 'Counter', date: s.date.toISOString(), color: +p.color || 0 }, { partial: false });
        if (!v.error) counters.push({ ...v.value, id: g.id, updatedBy: ms.includes(p.ed) ? p.ed : creatorOf(g), updatedAt: g.updated || null });
      } else if (p.t === 'sleep') {
        const s = parseGDate(g.start), e = parseGDate(g.end); if (!s || !e || !ms.includes(p.who)) continue;
        sleepLogs.push({ id: g.id, userId: p.who, start: s.date.toISOString(), end: p.open === '1' ? null : e.date.toISOString() });
      } else if (p.t === 'alarm') {
        const v = validate('alarms', { time: p.time, label: g.summary || 'Alarm', days: String(p.days || '').split(',').filter(Boolean).map(Number), date: p.date || null, enabled: p.enabled === '1', snooze: +p.snooze || 9, forUser: p.forUser, every: p.every || '' }, { partial: false });
        if (!v.error && ms.includes(v.value.forUser)) alarms.push({ ...v.value, id: g.id, createdBy: ms.includes(p.by) ? p.by : null, updatedBy: ms.includes(p.ed) ? p.ed : (ms.includes(p.by) ? p.by : null), updatedAt: g.updated || null, _ev: p.ev || null });
      }
    }
    return { alarms, counters, sleepLogs };
  }
  function extraEvents() {
    const out = [], ms = members().map(m => m.id);
    for (const [id, items] of Object.entries(S.raw.extra || {})) for (const g of items) {
      if (!SAFE_ID.test(id)) continue;
      const e = fromGoogle(g, ms, true);
      if (e) out.push({ ...e, rrule: null, reminders: [], id: 'x:' + id + ':' + g.id, color: 2, forUsers: [S.me] });
    }
    return out;
  }

  // ---------- my member record, my alarms calendar, reminders ----------
  async function ensureMe() {
    let me = myMember();
    if (!S.myAlarmCal) {
      const name = (me && me.name) || S.me.split('@')[0];
      const c = await gapi('POST', '/calendars', { summary: '⏰ DuoCal alarms · ' + name, description: MARK.alarms(S.me) + ' Alarms set in DuoCal. Keep notifications on for this calendar.', timeZone: deviceTz() });
      S.myAlarmCal = c.id;
      // every event in this calendar alerts me at its start time
      await gapi('PATCH', '/users/me/calendarList/' + encodeURIComponent(c.id), { defaultReminders: [{ method: 'popup', minutes: 0 }], selected: true }).catch(() => { });
    }
    const settings = me ? me.settings : cleanSettings({ tz: deviceTz(), tzAuto: true });
    if (!me || me.alarmCal !== S.myAlarmCal || me.us !== S.usId) await writeMember({ name: me ? me.name : S.me.split('@')[0], settings });
  }
  // My partner may set alarms for me only after I said yes once (never automatic, never re-granted).
  function pendingTrust() {
    const me = myMember(); if (!me) return null;
    const p = members().find(m => m.id !== S.me && !me.trust.includes(m.id) && !localStorage.getItem('duocal.notnow.' + S.me + '.' + m.id));
    return p ? { name: p.name, email: p.email } : null;
  }
  async function trustPartner(email, allow) {
    const me = myMember(), p = members().find(m => m.id === email && m.id !== S.me);
    if (!me || !p) throw new Error('Unknown person');
    if (!allow) { localStorage.setItem('duocal.notnow.' + S.me + '.' + email, '1'); return; }
    await gapi('POST', cal(S.myAlarmCal) + '/acl', { role: 'writer', scope: { type: 'user', value: email } }, { sendNotifications: 'false' });
    await writeMember({ name: me.name, settings: me.settings, trust: [...me.trust, email] });
  }
  async function writeMember({ name, settings, trust }) {
    const me = myMember();
    const body = {
      summary: 'DuoCal member: ' + name, start: { date: '2000-01-01' }, end: { date: '2000-01-02' }, transparency: 'transparent',
      extendedProperties: { shared: { t: 'member', email: S.me, name: String(name).slice(0, 40), alarmCal: S.myAlarmCal || '', us: S.usId || '', trust: (trust || (me && me.trust) || []).join(',').slice(0, 500), s: JSON.stringify(settings).slice(0, 1000) } },
    };
    const g = me ? await gapi('PUT', cal(S.dataId) + '/events/' + encodeURIComponent(me._gid), body) : await gapi('POST', cal(S.dataId) + '/events', body);
    S.raw.data[g.id] = g;
  }

  // Runs after each sync on *my* device: keeps my alerts and my alarm calendar right.
  let reconciling = false;
  async function reconcile() {
    if (reconciling || !S.myAlarmCal) return;
    reconciling = true;
    try {
      // 1) my personal reminders on shared events (Google stores them per person)
      let n = 0;
      for (const e of usEvents()) {
        const g = S.raw.us[e.id]; if (!g || e.readOnly || P(g).duocalRem === undefined) continue; // only events DuoCal manages
        const want = myReminders(e).overrides.map(o => o.minutes).sort().join(',');
        const have = g.reminders && !g.reminders.useDefault ? (g.reminders.overrides || []).map(o => o.minutes).sort().join(',') : 'default';
        if (want !== have && n++ < 25) S.raw.us[e.id] = await gapi('PATCH', cal(S.usId) + '/events/' + encodeURIComponent(e.id), { reminders: myReminders(e) }).catch(() => g);
      }
      // 2) my alarms calendar = my enabled alarms + wake-up + bedtime
      const me = myMember(); if (!me) return;
      const want = new Map();
      for (const a of dataRecords().alarms) if (a.forUser === S.me && a.enabled) want.set('a:' + a.id, withKey(alarmEventBody(a.label, a.time, a.days, a.date, 0, me.settings.tz, a.every || ''), 'a:' + a.id));
      if (me.settings.wakeAlarm) want.set('wake', withKey(alarmEventBody('Wake up', me.settings.waketime, [0, 1, 2, 3, 4, 5, 6], null, 0, me.settings.tz), 'wake'));
      if (me.settings.bedtimeReminder > 0) want.set('bed', withKey(alarmEventBody('🌙 Bedtime', me.settings.bedtime, [0, 1, 2, 3, 4, 5, 6], null, me.settings.bedtimeReminder, me.settings.tz), 'bed'));
      const have = (await listAll(cal(S.myAlarmCal) + '/events', { singleEvents: 'false', maxResults: '2500', privateExtendedProperty: 'duocal=1' })).items;
      for (const g of have) {
        const key = g.extendedProperties.private.key, w = want.get(key);
        if (w && g.extendedProperties.private.h === w.extendedProperties.private.h) { want.delete(key); continue; }
        if (w) { await gapi('PUT', cal(S.myAlarmCal) + '/events/' + encodeURIComponent(g.id), w); want.delete(key); }
        else await gapi('DELETE', cal(S.myAlarmCal) + '/events/' + encodeURIComponent(g.id)).catch(() => { });
      }
      for (const w of want.values()) await gapi('POST', cal(S.myAlarmCal) + '/events', w);
    } finally { reconciling = false; }
  }
  const EVERY_RULE = { '1d': 'FREQ=DAILY', '2d': 'FREQ=DAILY;INTERVAL=2', '3d': 'FREQ=DAILY;INTERVAL=3', '1w': 'FREQ=WEEKLY', '1m': 'FREQ=MONTHLY', '1y': 'FREQ=YEARLY' };
  function alarmEventBody(label, time, days, date, alertBefore, tz, every = '') {
    const z = validTz(tz) || deviceTz();
    const [hh, mm] = time.split(':').map(Number);
    const todayW = Recur.wallCal(z).toWall(new Date());
    let day = null;
    if (days && days.length && !every) { for (let i = 0; i < 7 && !day; i++) { const d = new Date(Date.UTC(todayW.getUTCFullYear(), todayW.getUTCMonth(), todayW.getUTCDate() + i, hh, mm)); if (days.includes(d.getUTCDay())) day = d; } }
    else { const [y, m, d] = String(date || todayW.toISOString().slice(0, 10)).split('-').map(Number); day = new Date(Date.UTC(y, m - 1, d, hh, mm)); }
    const ws = d => d.toISOString().slice(0, 19);
    const spec = { label, time, days, date, alertBefore, z, every };
    return {
      summary: (label.startsWith('🌙') ? '' : '⏰ ') + label, transparency: 'transparent', visibility: 'private',
      start: { dateTime: ws(day), timeZone: z }, end: { dateTime: ws(new Date(day.getTime() + 5 * 60e3)), timeZone: z },
      recurrence: EVERY_RULE[every] ? ['RRULE:' + EVERY_RULE[every]] : days && days.length ? ['RRULE:FREQ=WEEKLY;BYDAY=' + days.map(d => BYDAY[d]).join(',')] : [],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: alertBefore }] },
      extendedProperties: { private: { duocal: '1', key: '', h: hash(JSON.stringify(spec)) } },
    };
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  // alarmEventBody leaves key empty; set it where we know it
  const withKey = (body, key) => { body.extendedProperties.private.key = key; return body; };

  // ---------- the request handler the UI calls ----------
  function snapshot() {
    const ms = members();
    const me = ms.find(m => m.id === S.me) || { id: S.me, email: S.me, name: S.me.split('@')[0], settings: cleanSettings({}) };
    const recs = dataRecords();
    return {
      me: { id: me.id, name: me.name, email: me.email, settings: me.settings, trust: me.trust || [] },
      members: ms.map(m => ({ id: m.id, name: m.name, email: m.email, settings: m.settings, trust: m.trust })),
      household: { id: S.usId, name: S.usName, full: ms.length >= 2, pairing: pendingPairing() },
      events: [...usEvents(), ...extraEvents()], alarms: recs.alarms, counters: recs.counters, sleepLogs: recs.sleepLogs,
      subscriptions: [], extraCalendars: S.extraMeta,
    };
  }
  const err = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
  function checked(kind, body, partial) {
    const r = validate(kind, body, { partial });
    if (r.error) throw err(r.error);
    const ids = members().map(m => m.id);
    if (r.value.forUsers) r.value.forUsers = r.value.forUsers.filter(id => ids.includes(id));
    if ('forUser' in r.value && !ids.includes(r.value.forUser)) throw err('Unknown person');
    return r.value;
  }
  const evPath = id => cal(S.usId) + '/events/' + encodeURIComponent(id);
  const dataPath = id => cal(S.dataId) + '/events/' + encodeURIComponent(id);

  async function handle(path, { method = 'GET', body } = {}) {
    const m = path.match(/^\/api\/(\w+)(?:\/([\w@.:-]{1,300}))?/);
    if (!m) throw err('Unknown request', 404);
    const [, kind, id] = m;
    if (kind === 'data') return snapshot();
    if (kind === 'config') return {};

    if (kind === 'events') {
      if (id && id.startsWith('x:')) throw err('This event comes from another of your calendars and is read-only here.', 403);
      if (method === 'POST') {
        const v = checked('events', body, false);
        if (!v.forUsers || !v.forUsers.length) v.forUsers = [S.me];
        if (!v.tz && !v.allDay) v.tz = myMember() ? myMember().settings.tz || deviceTz() : deviceTz();
        const g = await gapi('POST', cal(S.usId) + '/events', toGoogle(v));
        S.raw.us[g.id] = g; saveCache(); return { id: g.id };
      }
      const cur = usEvents().find(e => e.id === id);
      if (!cur) throw err('Not found', 404);
      if (cur.readOnly) throw err('This is an invitation from outside your household, so DuoCal leaves it alone.', 403);
      if (method === 'PUT') {
        const v = { ...cur, ...checked('events', body, true) };
        const gb = toGoogle(v);
        if (S.raw.us[id] && S.raw.us[id].recurringEventId) delete gb.recurrence; // one date of a series: Google keeps the rule on the series
        const g = await gapi('PUT', evPath(id), gb);
        S.raw.us[g.id] = g; saveCache(); return { id: g.id };
      }
      if (method === 'DELETE') { await gapi('DELETE', evPath(id)).catch(e => { if (e.status !== 410 && e.status !== 404) throw e; }); delete S.raw.us[id]; saveCache(); return {}; }
    }

    if (kind === 'counters') {
      const put = v => ({ summary: v.title, start: { dateTime: v.date, timeZone: 'UTC' }, end: { dateTime: new Date(new Date(v.date).getTime() + 60e3).toISOString(), timeZone: 'UTC' }, transparency: 'transparent', extendedProperties: { shared: { t: 'counter', color: String(v.color ?? 3), ed: S.me } } });
      if (method === 'POST') { const v = checked('counters', body, false); const g = await gapi('POST', cal(S.dataId) + '/events', put(v)); S.raw.data[g.id] = g; saveCache(); return { id: g.id }; }
      const cur = dataRecords().counters.find(c => c.id === id); if (!cur) throw err('Not found', 404);
      if (method === 'PUT') { const g = await gapi('PUT', dataPath(id), put({ ...cur, ...checked('counters', body, true) })); S.raw.data[g.id] = g; saveCache(); return { id: g.id }; }
      if (method === 'DELETE') { await gapi('DELETE', dataPath(id)).catch(() => { }); delete S.raw.data[id]; saveCache(); return {}; }
    }

    if (kind === 'sleepLogs') {
      const put = v => ({ summary: 'Sleep', start: { dateTime: v.start, timeZone: 'UTC' }, end: { dateTime: v.end || new Date(new Date(v.start).getTime() + 60e3).toISOString(), timeZone: 'UTC' }, transparency: 'transparent', extendedProperties: { shared: { t: 'sleep', who: v.userId, open: v.end ? '0' : '1' } } });
      if (method === 'POST') { const v = checked('sleepLogs', body, false); const g = await gapi('POST', cal(S.dataId) + '/events', put({ ...v, userId: S.me })); S.raw.data[g.id] = g; saveCache(); return { id: g.id }; }
      const cur = dataRecords().sleepLogs.find(c => c.id === id); if (!cur) throw err('Not found', 404);
      if (cur.userId !== S.me) throw err('You can only change your own sleep log.', 403);
      if (method === 'PUT') { const g = await gapi('PUT', dataPath(id), put({ ...cur, ...checked('sleepLogs', body, true) })); S.raw.data[g.id] = g; saveCache(); return { id: g.id }; }
      if (method === 'DELETE') { await gapi('DELETE', dataPath(id)).catch(() => { }); delete S.raw.data[id]; saveCache(); return {}; }
    }

    if (kind === 'alarms') {
      const put = (v, by) => ({ summary: v.label || 'Alarm', start: { date: '2000-01-02' }, end: { date: '2000-01-03' }, transparency: 'transparent', extendedProperties: { shared: { t: 'alarm', forUser: v.forUser, time: v.time, days: (v.days || []).join(','), date: v.date || '', every: v.every || '', enabled: v.enabled ? '1' : '0', snooze: String(v.snooze || 9), by, ed: S.me } } });
      let res, after = null, removed = null;
      if (method === 'POST') { const v = checked('alarms', { forUser: S.me, ...body }, false); const g = await gapi('POST', cal(S.dataId) + '/events', put(v, S.me)); S.raw.data[g.id] = g; res = { id: g.id }; after = { ...v, id: g.id }; }
      else {
        const cur = dataRecords().alarms.find(c => c.id === id); if (!cur) throw err('Not found', 404);
        if (method === 'PUT') { const v = { ...cur, ...checked('alarms', body, true) }; const g = await gapi('PUT', dataPath(id), put(v, cur.createdBy || S.me)); S.raw.data[g.id] = g; res = { id: g.id }; after = { ...v, id: g.id }; }
        else if (method === 'DELETE') { await gapi('DELETE', dataPath(id)).catch(() => { }); delete S.raw.data[id]; res = {}; removed = cur; }
      }
      saveCache();
      reconcileSoon(); // my own alarms go to my phone right away
      // an alarm for my partner goes straight into *their* alarm calendar (if they allowed me),
      // so their phone alerts even if they don't open DuoCal. Their app keeps it right later too.
      await pushToPartnerPhone(after || removed, !!removed).catch(e => console.warn('partner alarm:', e.message));
      return res;
    }

    if (kind === 'me' && method === 'PUT') {
      const me = myMember();
      const name = body.name !== undefined ? String(body.name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || me.name : me.name;
      let settings = me.settings;
      if (body.settings) {
        const extra = body.settings.extraCals;
        settings = { ...settings, ...checked('settings', body.settings, true) };
        if (Array.isArray(extra)) settings.extraCals = extra.filter(x => typeof x === 'string' && S.extraMeta.some(c => c.id === x)).slice(0, 10);
      }
      await writeMember({ name, settings }); saveCache(); reconcileSoon();
      if (body.settings && body.settings.extraCals) await pullExtras(true);
      return { ok: true };
    }
    if (kind === 'household' && method === 'PUT' && body.partner) { await sharePartner(body.partner); return { ok: true }; }
    if (kind === 'import' && method === 'POST') {
      const items = (id === 'rows' && Array.isArray(body.items) ? body.items : ICS.parseICS(String(body.text || '').slice(0, 15e6))).slice(0, 2000);
      const ids = members().map(x => x.id);
      const forUsers = (Array.isArray(body.forUsers) ? body.forUsers : [S.me]).filter(x => ids.includes(x));
      let added = 0;
      for (const it of items) {
        let r = validate('events', it, { partial: false });
        if (r.error) r = validate('events', { ...it, tz: null }, { partial: false });
        if (r.error) r = validate('events', { ...it, tz: null, rrule: null }, { partial: false });
        if (r.error) continue;
        const g = await gapi('POST', cal(S.usId) + '/events', toGoogle({ ...r.value, color: 1, forUsers: forUsers.length ? forUsers : [S.me] }));
        S.raw.us[g.id] = g; added++;
      }
      saveCache();
      return { added, updated: 0 };
    }
    throw err('Not available in the web version', 404);
  }
  async function pushToPartnerPhone(a, remove) {
    if (!a) return;
    const owner = members().find(m => m.id === a.forUser);
    if (!owner || owner.id === S.me || !owner.alarmCal || !owner.trust.includes(S.me)) return; // not allowed: their own app will do it
    const key = 'a:' + a.id, path = cal(owner.alarmCal) + '/events';
    const found = (await listAll(path, { privateExtendedProperty: 'key=' + key, maxResults: '10' })).items.filter(g => g.status !== 'cancelled');
    if (remove || !a.enabled) { for (const g of found) await gapi('DELETE', path + '/' + encodeURIComponent(g.id)).catch(() => { }); return; }
    // same body (and fingerprint) their own app would write, on *their* clock
    const body = withKey(alarmEventBody(a.label || 'Alarm', a.time, a.days || [], a.date || null, 0, owner.settings.tz, a.every || ''), key);
    if (found[0]) await gapi('PUT', path + '/' + encodeURIComponent(found[0].id), body);
    else await gapi('POST', path, body);
  }
  let rTimer;
  function reconcileSoon() { clearTimeout(rTimer); rTimer = setTimeout(() => reconcile().catch(() => { }), 1500); }

  async function signOutEverything({ revoke }) { clearAllCaches(); S = blank(); await GAuth.signOut({ revoke }); }

  // ===================== PAIRING (like an authenticator code) =====================
  // The first person ("host") creates the household, shares it with the partner's Gmail
  // only, and sends a pairing request to that Gmail as a calendar invitation. The host's
  // screen shows a 6-digit code that changes every 30 s. The request holds only a slow,
  // salted fingerprint of the code (PBKDF2-SHA256, 200 000 rounds), never the code itself.
  // The partner's app finds the request in their own calendar and checks the typed code.
  // When it matches, they're paired for good: both apps trust each other's alarms, the
  // request is removed, and nobody else keeps access.
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const unhex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
  async function fingerprint(code, saltHex) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(code)), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: 200000 }, key, 256));
  }
  function newCode() { const a = new Uint32Array(1); let n; do { crypto.getRandomValues(a); n = a[0]; } while (n >= 4294000000); return String(n % 1000000).padStart(6, '0'); }
  const PAIR_KEY = () => 'duocal.pairing.' + S.me;
  function pendingPairing() { try { const p = JSON.parse(localStorage.getItem(PAIR_KEY()) || 'null'); return p && p.exp > Date.now() ? { for: p.for, exp: p.exp } : null; } catch { return null; } }
  const pairBody = (partner, code, salt, h, h0, exp) => ({
    summary: '🔗 DuoCal pairing request', description: 'Open DuoCal and type the 6-digit code shown on your partner\'s screen.',
    start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date(exp).toISOString() },
    attendees: [{ email: partner }], guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false,
    transparency: 'transparent', reminders: { useDefault: false, overrides: [] },
    extendedProperties: { shared: { t: 'pair', host: S.me, for: partner, us: S.usId, data: S.dataId, salt, h, h0: h0 || '', exp: String(exp) } },
  });
  // Host: start (or continue) pairing with this Gmail. Returns { code, until } — call again every 30 s for a fresh code.
  async function pairingCode(partnerEmail) {
    partnerEmail = String(partnerEmail || '').trim().toLowerCase();
    if (!SAFE_EMAIL.test(partnerEmail)) throw new Error("Type your partner's Gmail address.");
    if (partnerEmail === S.me) throw new Error("That's your own address.");
    if (!S.usId) await createHousehold(null);
    if (members().length >= 2) throw new Error('You are already paired.');
    let p = null; try { p = JSON.parse(localStorage.getItem(PAIR_KEY()) || 'null'); } catch { }
    const fresh = !p || p.for !== partnerEmail || p.exp < Date.now() || !p.eventId;
    if (fresh) { await sharePartner(partnerEmail, [S.usId, S.dataId], false); p = { for: partnerEmail, exp: Date.now() + 15 * 60e3, cur: '', eventId: null }; }
    const code = newCode(), salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const h = await fingerprint(code, salt);
    const body = pairBody(partnerEmail, code, salt, h, p.cur, p.exp); // the code from 30 s ago still counts
    let g;
    if (p.eventId) { try { g = await gapi('PUT', cal(S.dataId) + '/events/' + encodeURIComponent(p.eventId), body, { sendUpdates: 'none' }); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; } }
    if (!g) g = await gapi('POST', cal(S.dataId) + '/events', body, { sendUpdates: 'all' }); // first time: Google tells the partner
    S.raw.data[g.id] = g;
    localStorage.setItem(PAIR_KEY(), JSON.stringify({ for: partnerEmail, exp: p.exp, cur: salt + ':' + h, eventId: g.id }));
    return { code, until: Date.now() + 30e3, expires: p.exp };
  }
  async function cancelPairing() {
    let p = null; try { p = JSON.parse(localStorage.getItem(PAIR_KEY()) || 'null'); } catch { }
    localStorage.removeItem(PAIR_KEY());
    if (p && p.eventId) await gapi('DELETE', cal(S.dataId) + '/events/' + encodeURIComponent(p.eventId), null, { sendUpdates: 'none' }).catch(() => { });
  }
  // Host: has the partner finished? (their own member record appears in our household)
  async function pairingDone() {
    let p = null; try { p = JSON.parse(localStorage.getItem(PAIR_KEY()) || 'null'); } catch { }
    if (!p) return members().length >= 2;
    await pullCalendar('data', S.dataId);
    const partner = members().find(m => m.id === p.for);
    if (!partner) return false;
    // paired: they can set my alarms, the request goes, and only the two of us keep access
    const meRec = myMember();
    if (meRec && !meRec.trust.includes(partner.id)) await trustPartner(partner.id, true);
    await cancelPairing();
    await onlyTheTwoOfUs();
    saveCache();
    return true;
  }
  async function onlyTheTwoOfUs() {
    const keep = new Set(members().map(m => m.id));
    for (const id of [S.usId, S.dataId, S.myAlarmCal]) {
      if (!id) continue;
      let acl; try { acl = await gapi('GET', cal(id) + '/acl'); } catch { continue; } // only the owner can read sharing
      for (const r of acl.items || []) if (r.scope && r.scope.type === 'user' && r.role !== 'owner' && !keep.has(lower(r.scope.value)))
        await gapi('DELETE', cal(id) + '/acl/' + encodeURIComponent(r.id)).catch(() => { });
    }
  }
  // Partner: requests addressed to me — in my own calendar (Google added the invitation),
  // or inside a DuoCal calendar I added from Google's "shared a calendar" email.
  async function findPairingRequests() {
    const reqs = new Map();
    const take = g => {
      const x = P(g);
      if (x.t !== 'pair' || lower(x.for) !== S.me || !(+x.exp > Date.now()) || !SAFE_EMAIL.test(lower(x.host))) return;
      if (lower(creatorOf(g)) !== lower(x.host) && creatorOf(g)) return; // made by the person it claims
      if (!/^[\w.@+-]{5,200}$/.test(x.us || '') || !/^[\w.@+-]{5,200}$/.test(x.data || '')) return;
      reqs.set(x.data, { host: lower(x.host), us: x.us, data: x.data, salt: x.salt, h: x.h, h0: x.h0, exp: +x.exp, eventId: g.id });
    };
    try { (await listAll('/calendars/primary/events', { sharedExtendedProperty: 't=pair', maxResults: '50', timeMin: new Date(Date.now() - 864e5).toISOString() })).items.forEach(take); } catch { }
    const list = (await listAll('/users/me/calendarList', { minAccessRole: 'reader', showHidden: 'true', maxResults: '250' })).items;
    for (const c of list.filter(c => (c.description || '').includes(MARK.data)).slice(0, 5)) {
      try { (await listAll(cal(c.id) + '/events', { sharedExtendedProperty: 't=pair', maxResults: '10' })).items.filter(g => madeIn(g, c.id)).forEach(take); } catch { }
    }
    return [...reqs.values()].map(r => ({ ...r, name: r.host.split('@')[0] }));
  }
  // Partner: check the code. Tries are limited on this device.
  async function acceptPairing(req, code) {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) throw new Error('Type all 6 digits.');
    const lockKey = 'duocal.pairtries.' + S.me, tries = JSON.parse(localStorage.getItem(lockKey) || '[]').filter(t => Date.now() - t < 5 * 60e3);
    if (tries.length >= 6) throw new Error('Too many wrong codes. Wait 5 minutes, then ask for a new code.');
    // always check against the newest request (the code changes every 30 s)
    const fresh = (await findPairingRequests()).find(r => r.data === req.data) || req;
    let match = (await fingerprint(code, fresh.salt)) === fresh.h;   // the code on screen now
    if (!match && fresh.h0) match = await prevMatches(code, fresh);
    if (!match) { tries.push(Date.now()); localStorage.setItem(lockKey, JSON.stringify(tries)); throw new Error('That code is not right. Check the code on your partner\'s screen (it changes every 30 seconds).'); }
    localStorage.removeItem(lockKey);
    try {
      await gapi('POST', '/users/me/calendarList', { id: fresh.us, selected: true }).catch(e => { if (e.status !== 409) throw e; });
      await gapi('POST', '/users/me/calendarList', { id: fresh.data, selected: false, hidden: true }).catch(e => { if (e.status !== 409) throw e; });
    } catch { throw new Error('Your partner has not shared DuoCal with this Gmail address. Check that they typed it correctly.'); }
    localStorage.setItem(PIN(), JSON.stringify({ usId: fresh.us, dataId: fresh.data }));
    clearAllCaches(); S.list = null;
    const r = await init(S.me, null);
    if (!r.ok) throw new Error('Could not open the shared calendars.');
    await trustPartner(fresh.host, true).catch(() => { }); // pairing = permission to set each other's alarms
    return r;
  }
  // the previous code (shown up to 30 s ago) is still accepted; its salt rides along in h0 as "salt:hash"
  async function prevMatches(code, r) { const [salt, h] = String(r.h0).split(':'); return !!(salt && h && (await fingerprint(code, salt)) === h); }

  // ===================== FRESH START =====================
  // Old DuoCal calendars (from before pairing) that this account owns or has in its list.
  async function oldCalendars() {
    const list = (await listAll('/users/me/calendarList', { minAccessRole: 'reader', showHidden: 'true', maxResults: '250' })).items;
    return list.filter(c => OLD_MARK.test(c.description || '') || (c.description || '').includes(MARK.data) || (c.description || '').includes(MARK.us) || (c.description || '').includes('[duocal2:alarms:'))
      .map(c => ({ id: c.id, name: String(c.summaryOverride || c.summary || c.id).slice(0, 80), owner: c.accessRole === 'owner', old: OLD_MARK.test(c.description || '') }));
  }
  // Delete the calendars I own; drop the ones others shared with me from my list. Then forget this device.
  async function wipeEverything() {
    for (const c of await oldCalendars()) {
      if (c.owner) await gapi('DELETE', cal(c.id)).catch(() => { });
      else await gapi('DELETE', '/users/me/calendarList/' + encodeURIComponent(c.id)).catch(() => { });
    }
    const keep = ['duocal.theme', 'duocal.gtoken', 'duocal.lastEmail', 'duocal.appVersion']; // stay signed in
    for (const k of Object.keys(localStorage)) if (k.startsWith('duocal.') && !keep.includes(k)) localStorage.removeItem(k);
    const me = S.me; S = blank(); S.me = me; // still signed in as the same person
  }

  // after each sync: my partner may have joined (share my alarms with them), alarms/reminders may have changed
  async function maintain() { if (!S.usId) return; await ensureMe(); await reconcile(); saveCache(); }

  root.GStore = { pairingCode, cancelPairing, pairingDone, findPairingRequests, acceptPairing, oldCalendars, wipeEverything, households, deleteHousehold, confirmJoin, forgetHousehold, pendingTrust, trustPartner, maintain, init, createHousehold, sharePartner, sync, reconcile, handle, inviteLink, signOutEverything, me: () => S.me, state: () => S, _test: { toGoogle, fromGoogle, alarmEventBody, withKey } };
})(window);

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
  const MARK = { us: '[duocal:us]', data: '[duocal:data]', alarms: e => `[duocal:alarms:${e}]` };
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
    if (r.status === 401) { await GAuth.signOut(); throw new AuthNeeded(); }
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
    S.extraMeta = list.filter(c => !/\[duocal:/.test(c.description || '')).map(c => ({ id: c.id, name: String(c.summaryOverride || c.summary || c.id).slice(0, 100), primary: !!c.primary }));
    const writable = id => list.find(c => c.id === id && ['owner', 'writer'].includes(c.accessRole));
    let pin = null; try { pin = JSON.parse(localStorage.getItem(PIN()) || 'null'); } catch { }
    if (!pin) {
      // A new device: find the household through MY OWN member record (nobody can fake one made by me).
      for (const c of list.filter(c => (c.description || '').includes(MARK.data) && ['owner', 'writer'].includes(c.accessRole))) {
        const recs = await trustedMembersOf(c.id).catch(() => []);
        const mine = recs.find(m => m.email === email);
        if (mine && mine.us && writable(mine.us)) { pin = { usId: mine.us, dataId: c.id }; localStorage.setItem(PIN(), JSON.stringify(pin)); break; }
      }
    }
    if (!pin && joinParam) { // an invite link: show who is in that household and wait for a click
      const [usId, dataId] = joinParam.split(',').map(s => s.trim());
      if (!/^[\w.@+-]{5,200}$/.test(usId || '') || !/^[\w.@+-]{5,200}$/.test(dataId || '')) throw new Error('That invite link looks broken. Ask for a new one.');
      let people;
      try { people = await trustedMembersOf(dataId); } catch { throw new Error("Couldn't open the shared calendars. Ask your partner to share them with this Gmail address first (DuoCal → Settings → Your partner)."); }
      if (!people.length) throw new Error("That invite link doesn't lead to a DuoCal household.");
      return { confirmJoin: { usId, dataId, people: people.map(m => ({ name: m.name, email: m.email })) } };
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
    return init(S.me, null);
  }
  function forgetHousehold() { localStorage.removeItem(PIN()); clearAllCaches(); }

  // First person: create the calendars and share them with the partner.
  async function createHousehold(partnerEmail) {
    const tz = deviceTz();
    const us = await gapi('POST', '/calendars', { summary: 'Us · DuoCal', description: MARK.us + ' Shared calendar kept by DuoCal.', timeZone: tz });
    const data = await gapi('POST', '/calendars', { summary: 'DuoCal · data', description: MARK.data + ' DuoCal app data (alarms, sleep, counters). You can hide this calendar.', timeZone: tz });
    await gapi('PATCH', '/users/me/calendarList/' + encodeURIComponent(data.id), { hidden: true, selected: false }).catch(() => { });
    if (partnerEmail) await sharePartner(partnerEmail, [us.id, data.id]);
    localStorage.setItem(PIN(), JSON.stringify({ usId: us.id, dataId: data.id }));
    return init(S.me, null);
  }
  async function sharePartner(email, ids = [S.usId, S.dataId, S.myAlarmCal].filter(Boolean)) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter your partner's Gmail address.");
    if (email === S.me) throw new Error("That's your own address.");
    for (const id of ids) await gapi('POST', cal(id) + '/acl', { role: 'writer', scope: { type: 'user', value: email } }, { sendNotifications: 'true' });
  }
  const inviteLink = () => S.usId ? `${GAuth.appUrl()}#join=${encodeURIComponent(S.usId)},${encodeURIComponent(S.dataId)}` : null;

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
    return { ...v.value, id: g.id, createdBy: memberIds.includes(creator) ? creator : null, updatedAt: g.updated, readOnly: !!readOnly, source: readOnly ? 'extra' : 'google' };
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
      extendedProperties: { shared: { duocalFor: (e.forUsers || []).join(',').slice(0, 500), duocalRem: (e.reminders || []).join(','), duocalColor: String(e.color ?? 1) } },
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
        if (!v.error) counters.push({ ...v.value, id: g.id });
      } else if (p.t === 'sleep') {
        const s = parseGDate(g.start), e = parseGDate(g.end); if (!s || !e || !ms.includes(p.who)) continue;
        sleepLogs.push({ id: g.id, userId: p.who, start: s.date.toISOString(), end: p.open === '1' ? null : e.date.toISOString() });
      } else if (p.t === 'alarm') {
        const v = validate('alarms', { time: p.time, label: g.summary || 'Alarm', days: String(p.days || '').split(',').filter(Boolean).map(Number), date: p.date || null, enabled: p.enabled === '1', snooze: +p.snooze || 9, forUser: p.forUser }, { partial: false });
        if (!v.error && ms.includes(v.value.forUser)) alarms.push({ ...v.value, id: g.id, createdBy: ms.includes(p.by) ? p.by : null, _ev: p.ev || null });
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
      for (const a of dataRecords().alarms) if (a.forUser === S.me && a.enabled) want.set('a:' + a.id, withKey(alarmEventBody(a.label, a.time, a.days, a.date, 0, me.settings.tz), 'a:' + a.id));
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
  function alarmEventBody(label, time, days, date, alertBefore, tz) {
    const z = validTz(tz) || deviceTz();
    const [hh, mm] = time.split(':').map(Number);
    const todayW = Recur.wallCal(z).toWall(new Date());
    let day = null;
    if (days && days.length) { for (let i = 0; i < 7 && !day; i++) { const d = new Date(Date.UTC(todayW.getUTCFullYear(), todayW.getUTCMonth(), todayW.getUTCDate() + i, hh, mm)); if (days.includes(d.getUTCDay())) day = d; } }
    else { const [y, m, d] = String(date || todayW.toISOString().slice(0, 10)).split('-').map(Number); day = new Date(Date.UTC(y, m - 1, d, hh, mm)); }
    const ws = d => d.toISOString().slice(0, 19);
    const spec = { label, time, days, date, alertBefore, z };
    return {
      summary: (label.startsWith('🌙') ? '' : '⏰ ') + label, transparency: 'transparent', visibility: 'private',
      start: { dateTime: ws(day), timeZone: z }, end: { dateTime: ws(new Date(day.getTime() + 5 * 60e3)), timeZone: z },
      recurrence: days && days.length ? ['RRULE:FREQ=WEEKLY;BYDAY=' + days.map(d => BYDAY[d]).join(',')] : [],
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
      household: { id: S.usId, name: S.usName, invite: inviteLink(), full: ms.length >= 2 },
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
      const put = v => ({ summary: v.title, start: { dateTime: v.date, timeZone: 'UTC' }, end: { dateTime: new Date(new Date(v.date).getTime() + 60e3).toISOString(), timeZone: 'UTC' }, transparency: 'transparent', extendedProperties: { shared: { t: 'counter', color: String(v.color ?? 3) } } });
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
      const put = (v, by) => ({ summary: v.label || 'Alarm', start: { date: '2000-01-02' }, end: { date: '2000-01-03' }, transparency: 'transparent', extendedProperties: { shared: { t: 'alarm', forUser: v.forUser, time: v.time, days: (v.days || []).join(','), date: v.date || '', enabled: v.enabled ? '1' : '0', snooze: String(v.snooze || 9), by } } });
      let res;
      if (method === 'POST') { const v = checked('alarms', { forUser: S.me, ...body }, false); const g = await gapi('POST', cal(S.dataId) + '/events', put(v, S.me)); S.raw.data[g.id] = g; res = { id: g.id }; }
      else {
        const cur = dataRecords().alarms.find(c => c.id === id); if (!cur) throw err('Not found', 404);
        if (method === 'PUT') { const g = await gapi('PUT', dataPath(id), put({ ...cur, ...checked('alarms', body, true) }, cur.createdBy || S.me)); S.raw.data[g.id] = g; res = { id: g.id }; }
        else if (method === 'DELETE') { await gapi('DELETE', dataPath(id)).catch(() => { }); delete S.raw.data[id]; res = {}; }
      }
      saveCache();
      reconcileSoon(); // my own alarms go to my phone right away; my partner's phone updates when their app syncs
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
      const items = ICS.parseICS(String(body.text || '').slice(0, 15e6)).slice(0, 2000);
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
  let rTimer;
  function reconcileSoon() { clearTimeout(rTimer); rTimer = setTimeout(() => reconcile().catch(() => { }), 1500); }

  async function signOutEverything({ revoke }) { clearAllCaches(); S = blank(); await GAuth.signOut({ revoke }); }

  // after each sync: my partner may have joined (share my alarms with them), alarms/reminders may have changed
  async function maintain() { if (!S.usId) return; await ensureMe(); await reconcile(); saveCache(); }

  root.GStore = { confirmJoin, forgetHousehold, pendingTrust, trustPartner, maintain, init, createHousehold, sharePartner, sync, reconcile, handle, inviteLink, signOutEverything, me: () => S.me, state: () => S, _test: { toGoogle, fromGoogle, alarmEventBody, withKey } };
})(window);

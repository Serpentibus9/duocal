// ics.js (browser copy of server/ics.js): read .ics calendar files from Outlook, Google and Apple.
(function (root) {

// Lines longer than 75 chars are "folded": continued on the next line that
// starts with a space. Unfold first, then split into "NAME;PARAMS:VALUE".
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = findValueColon(line);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}
// The first colon not inside a quoted parameter separates name from value.
function findValueColon(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) return i;
  }
  return -1;
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Time zone handling: UTC ("Z") and floating/local times are exact.
// For TZID times we use Intl to find that zone's offset at that moment.
const FMT_CACHE = new Map(); // building a formatter is slow; reuse one per zone
function formatterFor(tz) {
  if (!FMT_CACHE.has(tz)) {
    if (FMT_CACHE.size > 200) FMT_CACHE.clear();
    let f = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: mapWindowsTz(tz), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { }
    FMT_CACHE.set(tz, f);
  }
  return FMT_CACHE.get(tz);
}
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  try {
    const fmt = formatterFor(String(tz).slice(0, 100));
    if (!fmt) throw new Error('unknown zone');
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return new Date(guess - (asIfUtc - guess));
  } catch {
    return new Date(y, mo, d, h, mi, s); // unknown zone: treat as local time
  }
}
// Outlook writes Windows zone names ("Central Standard Time"); map common ones.
const WIN_TZ = {
  'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai',
  'UTC': 'UTC', 'Romance Standard Time': 'Europe/Paris', 'Tokyo Standard Time': 'Asia/Tokyo',
  'India Standard Time': 'Asia/Kolkata', 'AUS Eastern Standard Time': 'Australia/Sydney',
};
function mapWindowsTz(tz) { return WIN_TZ[tz] || tz; }

function parseDate(prop) {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h || prop.params.VALUE === 'DATE') {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: true }; // all-day = a pure date (midnight UTC)
  }
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), allDay: false };
  if (prop.params.TZID) return { date: zonedToUtc(+y, +mo - 1, +d, +h, +mi, +(s || 0), prop.params.TZID), allDay: false };
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false };
}

// Returns plain event objects ready to store.
function parseICS(text) {
  const events = [];
  let cur = null, inAlarm = false;
  for (const raw of unfold(text)) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = { reminders: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) { const e = finish(cur); if (e) events.push(e); }
      cur = null;
      if (events.length >= 20000) break; // more than anyone's real calendar: stop
      continue;
    }
    if (!cur) continue;
    if (line === 'BEGIN:VALARM') { inAlarm = true; continue; }
    if (line === 'END:VALARM') { inAlarm = false; continue; }
    const p = parseLine(line);
    if (!p) continue;
    if (inAlarm) {
      if (p.name === 'TRIGGER') {
        const mins = durationToMinutes(p.value);
        if (mins != null) cur.reminders.push(Math.abs(mins));
      }
      continue;
    }
    switch (p.name) {
      case 'UID': cur.externalUid = p.value; break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.notes = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DTSTART': { const d = parseDate(p); if (d) { cur.start = d.date; cur.allDay = d.allDay; if (p.params.TZID) cur.tz = mapWindowsTz(p.params.TZID); } break; }
      case 'DTEND': { const d = parseDate(p); if (d) cur.end = d.date; break; }
      case 'DURATION': cur.durationMin = durationToMinutes(p.value); break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'EXDATE': {
        cur.exdates = cur.exdates || [];
        for (const v of p.value.split(',', 500)) { if (cur.exdates.length >= 500) break; const d = parseDate({ value: v, params: p.params }); if (d && !isNaN(d.date)) cur.exdates.push(d.date.toISOString()); }
        break;
      }
      case 'STATUS': if (p.value === 'CANCELLED') cur.cancelled = true; break;
    }
  }
  return events.filter(e => !e.cancelled);

  function finish(e) {
    try { return finishOne(e); } catch { return null; } // one broken event shouldn't sink the whole import
  }
  function finishOne(e) {
    if (isNaN(e.start)) return null;
    let end = e.end;
    if (!end) end = new Date(e.start.getTime() + (e.durationMin ?? (e.allDay ? 1440 : 60)) * 60000);
    return {
      title: e.title || '(no title)', notes: e.notes || '', location: e.location || '',
      start: e.start.toISOString(), end: end.toISOString(), allDay: !!e.allDay, tz: e.allDay ? null : (e.tz || null),
      rrule: e.rrule || null, exdates: e.exdates || [], externalUid: e.externalUid || null,
      reminders: [...new Set(e.reminders)].slice(0, 3),
    };
  }
}

// "-PT15M", "P1D", "-P1DT2H" → minutes (negative = before)
function durationToMinutes(v) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, sign, w, d, h, mi] = m;
  const total = (+w || 0) * 10080 + (+d || 0) * 1440 + (+h || 0) * 60 + (+mi || 0);
  return sign === '-' ? -total : total;
}

// ---------- writing ----------
function esc(s) { return String(s || '').replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
function fmtUtc(iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function fmtDate(iso) { const d = new Date(iso); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; } // all-day dates are midnight UTC
function fold(line) {
  const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line); return out.join('\r\n');
}

function buildICS(events, calName) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DuoCal//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(calName)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@duocal`, `DTSTAMP:${fmtUtc(e.updatedAt || e.start)}`);
    if (e.allDay) { lines.push(`DTSTART;VALUE=DATE:${fmtDate(e.start)}`, `DTEND;VALUE=DATE:${fmtDate(e.end)}`); }
    else { lines.push(`DTSTART:${fmtUtc(e.start)}`, `DTEND:${fmtUtc(e.end)}`); }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    for (const m of e.reminders || []) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

  root.ICS = { parseICS, buildICS };
})(window);

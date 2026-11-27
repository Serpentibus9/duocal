// validate.js (browser copy of the whitelists in server/security.js).
// Everything typed in DuoCal AND everything read back from Google passes through here:
// only known fields, the right types, sane lengths. Unknown fields are dropped.
(function (root) {
const net = { isIP: s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':') ? 1 : 0 };
const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const V = {
  str: max => v => typeof v === 'string' ? v.slice(0, max) : undefined,
  bool: () => v => typeof v === 'boolean' ? v : undefined,
  int: (min, max) => v => Number.isInteger(v) && v >= min && v <= max ? v : undefined,
  iso: () => v => {
    if (typeof v !== 'string' || !isoRe.test(v) || isNaN(Date.parse(v))) return undefined;
    const y = new Date(v).getUTCFullYear();
    return y >= 1900 && y <= 2200 ? new Date(v).toISOString() : undefined;
  },
  isoOrNull: () => v => v === null ? null : V.iso()(v),
  ymdOrNull: () => v => v === null ? null : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined,
  hm: () => v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined,
  rrule: () => v => v === null || v === '' ? null : typeof v === 'string' && v.length <= 300 && /^[A-Z0-9=;,:+\-]+$/.test(v) && /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(v) ? v : undefined,
  arr: (item, max) => v => Array.isArray(v) ? [...new Set(v.map(item).filter(x => x !== undefined))].slice(0, max) : undefined,
  // an IANA time zone name like "America/Chicago" that this computer knows
  tz: () => v => {
    if (v === null) return null;
    if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(v)) return undefined;
    try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return v; } catch { return undefined; }
  },
  url: () => v => {
    if (typeof v !== 'string' || v.length > 2000 || !/^(https?|webcal):\/\/[^\s]+$/i.test(v)) return undefined;
    try {
      const u = new URL(v.replace(/^webcal:/i, 'https:'));
      if (u.username || u.password || net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return undefined; // no raw IPs, no passwords in links
      return v;
    } catch { return undefined; }
  },
};
// Fields a client may set, per collection. Anything else is dropped.
const SCHEMAS = {
  events: {
    title: V.str(200), notes: V.str(5000), location: V.str(300), start: V.iso(), end: V.iso(), allDay: V.bool(),
    color: V.int(0, 7), forUsers: V.arr(V.str(40), 2), reminders: V.arr(V.int(0, 40320), 6), rrule: V.rrule(), exdates: V.arr(V.iso(), 500), tz: V.tz(),
  },
  alarms: { time: V.hm(), label: V.str(80), days: V.arr(V.int(0, 6), 7), date: V.ymdOrNull(), enabled: V.bool(), snooze: V.int(1, 60), forUser: V.str(40) },
  counters: { title: V.str(120), date: V.iso(), color: V.int(0, 7) },
  subscriptions: { url: V.url(), name: V.str(80), color: V.int(0, 7), forUsers: V.arr(V.str(40), 2) },
  sleepLogs: { start: V.iso(), end: V.isoOrNull() },
  settings: {
    theme: v => ['light', 'dark', 'system'].includes(v) ? v : undefined, bedtime: V.hm(), waketime: V.hm(), wakeAlarm: V.bool(),
    bedtimeReminder: V.int(0, 180), weekStart: V.int(0, 6), clock24: V.bool(), alarmsToGoogle: V.bool(), tz: V.tz(), tzAuto: V.bool(),
  },
};
const REQUIRED = { events: ['start', 'end'], alarms: ['time'], counters: ['date'], subscriptions: ['url'], sleepLogs: ['start'] };
function validate(kind, body, { partial }) {
  const schema = SCHEMAS[kind], out = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Bad request' };
  for (const [k, check] of Object.entries(schema)) {
    if (!(k in body)) continue;
    const v = check(body[k]);
    if (v === undefined) return { error: `Invalid value for "${k}"` };
    out[k] = v;
  }
  if (!partial) for (const k of REQUIRED[kind] || []) if (out[k] === undefined) return { error: `"${k}" is required` };
  return { value: out };
}

root.Validate = { validate, V, SCHEMAS };
})(window);

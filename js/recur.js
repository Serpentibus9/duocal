// recur.js — expand repeating events (RRULE) into concrete occurrences.
// Shared by the browser (window.Recur) and the server (require()).
// Supports: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
// BYDAY (MO,TU.. and for monthly "2MO" / "-1FR"), BYMONTHDAY.
//
// Time zones (you two live in different countries):
//   * A timed event repeats on the wall clock of the zone it was made in (ev.tz).
//     "Every Monday 9:00 Chicago" stays 9:00 in Chicago across daylight-saving
//     changes, and the browser shows each date in the viewer's own local time.
//   * An all-day event is a pure date, stored as midnight UTC of that date
//     ("2026-12-24T00:00:00Z" means 24 December everywhere).
// To do this, all the date arithmetic below runs on "wall time": a Date whose
// UTC fields hold the clock reading in the event's zone. wallCal() converts.
(function (root) {
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  // ---------- wall-clock <-> real instant ----------
  const FMT = new Map();
  function fmt(tz) {
    if (!FMT.has(tz)) {
      if (FMT.size > 100) FMT.clear();
      let f = null;
      try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { }
      FMT.set(tz, f);
    }
    return FMT.get(tz);
  }
  function wallCal(zone) {
    if (zone === 'UTC') return { toWall: d => new Date(d.getTime()), fromWall: w => new Date(w.getTime()) };
    const f = zone && fmt(zone);
    if (!f) { // the viewer's own local time
      return {
        toWall: d => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())),
        fromWall: w => new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds()),
      };
    }
    const toWall = d => {
      const p = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
      return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second));
    };
    return {
      toWall,
      // guess the instant, see what the clock says there, correct; twice handles DST edges
      fromWall: w => { let t = w.getTime(); for (let i = 0; i < 2; i++) t += w.getTime() - toWall(new Date(t)).getTime(); return new Date(t); },
    };
  }
  const W = (y, m, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m, d, h, mi, s));
  const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  function parseRule(rule) {
    const r = {};
    for (const part of String(rule).split(';')) {
      const [k, v] = part.split('=');
      if (k && v) r[k.toUpperCase()] = v;
    }
    r.INTERVAL = Math.max(1, +r.INTERVAL || 1);
    if (r.COUNT) r.COUNT = +r.COUNT;
    if (r.UNTIL) {
      const m = r.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/);
      if (m && m[4]) r.UNTIL = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])); // exact moment
      else if (m) { r.UNTIL_WALL = W(+m[1], m[2] - 1, +m[3], 23, 59, 59); delete r.UNTIL; } // a date: end of that day on the event's clock
      else delete r.UNTIL;
    }
    // de-duplicate and cap the lists so a crafted rule can't multiply the work
    if (r.BYDAY) r.BYDAY = [...new Set(r.BYDAY.split(','))].slice(0, 14).map(s => {
      const m = s.match(/^([+-]?\d{1,2})?([A-Z]{2})$/);
      return m && DAYS.includes(m[2]) && Math.abs(+(m[1] || 0)) <= 5 ? { n: m[1] ? +m[1] : 0, wd: DAYS.indexOf(m[2]) } : null;
    }).filter(Boolean);
    if (r.BYMONTHDAY) r.BYMONTHDAY = [...new Set(r.BYMONTHDAY.split(',').map(Number))].filter(n => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31).slice(0, 31);
    r.INTERVAL = Math.min(r.INTERVAL, 1000);
    return r;
  }

  // nth weekday of a month: n=2,wd=1 → 2nd Monday; n=-1 → last
  function nthWeekday(y, m, wd, n) {
    if (n > 0) {
      const first = W(y, m, 1).getUTCDay();
      const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
      return day <= daysIn(y, m) ? day : null;
    }
    const lastDate = daysIn(y, m);
    const lastWd = W(y, m, lastDate).getUTCDay();
    const day = lastDate - ((lastWd - wd + 7) % 7) + (n + 1) * 7;
    return day >= 1 ? day : null;
  }

  // The zone an event's dates are counted in.
  const zoneOf = ev => ev.allDay ? 'UTC' : (ev.tz || null);

  // Returns [{start: Date, end: Date}] (real instants) that overlap [from, to].
  // budget (optional): { left: N } shared by many calls, so the whole screen has a work limit
  function expand(ev, from, to, budget) {
    const start = new Date(ev.start), end = new Date(ev.end);
    const dur = end - start;
    if (!ev.rrule) return (end > from && start < to) ? [{ start, end }] : [];
    const r = parseRule(ev.rrule);
    const cal = wallCal(zoneOf(ev));
    const ex = new Set((ev.exdates || []).map(d => new Date(d).getTime()));
    const out = [];
    let count = 0, guard = 0;
    const MAX_STEPS = 1500, MAX_OUT = 1000;
    const sW = cal.toWall(start), fromW = cal.toWall(from);
    // Without COUNT we can jump close to the visible range instead of walking from the start date.
    const skip = !r.COUNT && from > start;
    const h = sW.getUTCHours(), mi = sW.getUTCMinutes(), s = sW.getUTCSeconds();
    const push = (dW) => {
      if (budget && --budget.left < 0) return false;
      if (r.UNTIL_WALL && dW > r.UNTIL_WALL) return false;
      const d = cal.fromWall(dW);
      if (d < start) return true;
      if (r.UNTIL && d > r.UNTIL) return false;
      if (r.COUNT && count >= r.COUNT) return false;
      count++;
      if (d >= to) return false;
      const e = new Date(d.getTime() + dur);
      if (e > from && !ex.has(d.getTime())) out.push({ start: d, end: e });
      return out.length < MAX_OUT;
    };

    const periodsBefore = unitMs => skip ? Math.max(0, Math.floor((fromW - sW - dur) / unitMs / r.INTERVAL) - 1) : 0;
    if (r.FREQ === 'DAILY') {
      const k = periodsBefore(864e5) * r.INTERVAL;
      for (let d = W(sW.getUTCFullYear(), sW.getUTCMonth(), sW.getUTCDate() + k, h, mi, s); guard++ < MAX_STEPS; d = W(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + r.INTERVAL, h, mi, s)) {
        if (!push(d)) break;
      }
    } else if (r.FREQ === 'WEEKLY') {
      const wds = r.BYDAY && r.BYDAY.length ? r.BYDAY.map(b => b.wd).sort() : [sW.getUTCDay()];
      // walk week by week starting with the week of DTSTART (weeks start Sunday)
      const k = periodsBefore(7 * 864e5) * r.INTERVAL;
      let weekStart = W(sW.getUTCFullYear(), sW.getUTCMonth(), sW.getUTCDate() - sW.getUTCDay() + 7 * k);
      outer: while (guard++ < MAX_STEPS) {
        for (const wd of wds) {
          if (!push(W(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + wd, h, mi, s))) break outer;
        }
        weekStart = W(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7 * r.INTERVAL);
      }
    } else if (r.FREQ === 'MONTHLY') {
      let y = sW.getUTCFullYear(), m = sW.getUTCMonth();
      if (skip) { const months = Math.max(0, Math.floor(((fromW.getUTCFullYear() - y) * 12 + fromW.getUTCMonth() - m - Math.ceil(dur / (28 * 864e5))) / r.INTERVAL) - 1) * r.INTERVAL; m += months; y += Math.floor(m / 12); m %= 12; }
      outer: while (guard++ < MAX_STEPS) {
        let days = [];
        if (r.BYDAY && r.BYDAY.length) days = r.BYDAY.map(b => nthWeekday(y, m, b.wd, b.n || 1));
        else if (r.BYMONTHDAY) days = r.BYMONTHDAY.map(n => n > 0 ? n : daysIn(y, m) + n + 1);
        else days = [sW.getUTCDate()];
        days = days.filter(d => d && d <= daysIn(y, m)).sort((a, b) => a - b);
        for (const day of days) if (!push(W(y, m, day, h, mi, s))) break outer;
        m += r.INTERVAL; if (m > 11) { y += Math.floor(m / 12); m %= 12; }
      }
    } else if (r.FREQ === 'YEARLY') {
      const y0 = sW.getUTCFullYear() + (skip ? Math.max(0, Math.floor((fromW.getUTCFullYear() - sW.getUTCFullYear() - Math.ceil(dur / (365 * 864e5))) / r.INTERVAL) - 1) * r.INTERVAL : 0);
      for (let y = y0; guard++ < MAX_STEPS; y += r.INTERVAL) {
        const d = W(y, sW.getUTCMonth(), sW.getUTCDate(), h, mi, s);
        if (d.getUTCMonth() !== sW.getUTCMonth()) continue; // Feb 29 in non-leap years
        if (!push(d)) break;
      }
    } else {
      return (end > from && start < to) ? [{ start, end }] : [];
    }
    return out;
  }

  // Human text for the UI: "Every 2 weeks on Mon, Wed"
  function describe(rule) {
    if (!rule) return 'Does not repeat';
    const r = parseRule(rule);
    const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.FREQ] || '?';
    let s = r.INTERVAL > 1 ? `Every ${r.INTERVAL} ${unit}s` : `Every ${unit}`;
    if (r.BYDAY) s += ' on ' + r.BYDAY.map(b => (b.n ? b.n + ' ' : '') + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][b.wd]).join(', ');
    if (r.COUNT) s += `, ${r.COUNT} times`;
    if (r.UNTIL) s += `, until ${r.UNTIL.toLocaleDateString()}`;
    if (r.UNTIL_WALL) s += `, until ${r.UNTIL_WALL.toISOString().slice(0, 10)}`;
    return s;
  }

  const api = { expand, describe, parseRule, wallCal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recur = api;
})(typeof window !== 'undefined' ? window : globalThis);

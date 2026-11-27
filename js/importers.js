// importers.js — bring calendars IN from other apps and send them OUT again.
// Everything happens inside your browser: files are never uploaded anywhere.
//
//  IN:  .ics  (Outlook "Save Calendar", Apple/iPhone/Mac Calendar, Google)
//       .zip  (Google Calendar's "Export" — a zip of .ics files)
//       .csv  (Outlook "Export to a file", Google, any spreadsheet)
//       .xlsx (Excel — including DuoCal's own Excel export)
//  OUT: .ics  (opens in Apple/iPhone Calendar, Google Calendar, Outlook)
//       .csv  (Outlook / Google Calendar import format)
(function (root) {
  const MAX_ROWS = 2000;

  // ---------- files in ----------
  // Returns { ics: [text...], events: [event...] } ready for DuoCal's importer.
  async function readFile(file) {
    const name = file.name.toLowerCase();
    if (file.size > 15e6) throw new Error(`${file.name} is too large (15 MB max)`);
    if (name.endsWith('.ics') || name.endsWith('.ical') || name.endsWith('.ifb')) return { ics: [await file.text()], events: [] };
    if (name.endsWith('.zip')) {
      const parts = await unzip(await file.arrayBuffer(), n => /\.ics$/i.test(n));
      if (!parts.length) throw new Error('No calendar (.ics) files inside that zip');
      return { ics: parts.map(p => p.text), events: [] };
    }
    if (name.endsWith('.csv') || name.endsWith('.txt')) return { ics: [], events: rowsToEvents(parseCSV(await file.text())) };
    if (name.endsWith('.xlsx')) return { ics: [], events: rowsToEvents(await xlsxRows(await file.arrayBuffer())) };
    if (name.endsWith('.xls')) throw new Error('Old .xls files: open in Excel and "Save As" .xlsx or .csv first');
    throw new Error(`Don't know how to read ${file.name}`);
  }

  // Minimal ZIP reader (stored or deflated entries) using the browser's own decompressor.
  async function unzip(buf, wanted) {
    const v = new DataView(buf), out = [];
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That zip file looks damaged');
    const count = Math.min(v.getUint16(eocd + 10, true), 500);
    let p = v.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
      const fname = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      p += 46 + nlen + xlen + clen;
      if (!wanted(fname) || usize > 15e6) continue;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = new Uint8Array(buf, start, csize);
      let bytes;
      if (method === 0) bytes = data;
      else if (method === 8) bytes = await inflateCapped(data, 20e6);
      else continue;
      out.push({ name: fname, text: new TextDecoder().decode(bytes) });
    }
    return out;
  }

  // Unpack, but stop at `cap` bytes whatever the file claims (protects against "zip bombs").
  async function inflateCapped(data, cap) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { reader.cancel(); throw new Error('A file inside that zip is too large'); }
      parts.push(value);
    }
    const out = new Uint8Array(total); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // CSV with quotes, commas/semicolons/tabs, Windows line ends and a UTF-8 BOM.
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; if (rows.length > MAX_ROWS + 1) break; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
  }

  // First sheet of an Excel file → rows of plain values (ExcelJS loads in the browser).
  async function xlsxRows(buf) {
    if (!root.ExcelJS) throw new Error('Excel support is still loading — try again in a second');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets.find(w => w.rowCount > 1) || wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, r => {
      if (rows.length > MAX_ROWS) return;
      const vals = [];
      for (let c = 1; c <= Math.min(r.cellCount, 40); c++) {
        let v = r.getCell(c).value;
        if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? (v.richText ? v.richText.map(t => t.text).join('') : v.text ?? '');
        vals.push(v ?? '');
      }
      rows.push(vals);
    });
    return rows;
  }

  // Which column is which (Outlook, Google, DuoCal's export, or a simple sheet).
  const COLS = {
    title: ['subject', 'title', 'summary', 'event', 'name', 'what'],
    sdate: ['start date', 'startdate', 'date', 'start', 'day', 'from'],
    stime: ['start time', 'starttime', 'time', 'begins'],
    edate: ['end date', 'enddate', 'end', 'to', 'until'],
    etime: ['end time', 'endtime', 'ends'],
    allday: ['all day event', 'all day', 'allday', 'all-day'],
    loc: ['location', 'place', 'where'],
    notes: ['description', 'notes', 'note', 'details'],
  };
  function rowsToEvents(rows) {
    if (rows.length < 2) return [];
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const col = {};
    for (const [k, names] of Object.entries(COLS)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[k] = i; }
    // DuoCal's own export: Date | Start | End | Hours | Title …  ("Start"/"End" are times there)
    if (head[0] === 'date' && head[1] === 'start' && head[2] === 'end') Object.assign(col, { sdate: 0, stime: 1, edate: undefined, etime: 2 });
    if (col.title === undefined || col.sdate === undefined) throw new Error('Could not find the columns. The first row needs headings like "Subject" or "Title" and "Start Date" (Outlook/Google style).');
    const out = [];
    for (const r of rows.slice(1, MAX_ROWS + 1)) {
      const get = k => col[k] === undefined ? '' : r[col[k]];
      const title = String(get('title') || '').trim(); if (!title) continue;
      const sd = parseDay(get('sdate')); if (!sd) continue;
      const ed = parseDay(get('edate')) || sd;
      const stRaw = get('stime'), etRaw = get('etime');
      const allFlag = /^(true|yes|1|y|wahr|oui|ja)$/i.test(String(get('allday')).trim()) || /all\s*day/i.test(String(stRaw));
      const st = allFlag ? null : parseClock(stRaw), et = allFlag ? null : parseClock(etRaw);
      let ev;
      if (allFlag || !st) {
        // Outlook/Google write an all-day end as the day AFTER (exclusive); a sheet may repeat the same day
        const s = new Date(Date.UTC(sd.y, sd.m, sd.d)), endDay = new Date(Date.UTC(ed.y, ed.m, ed.d));
        const e = endDay > s ? endDay : new Date(Date.UTC(sd.y, sd.m, sd.d + 1));
        ev = { allDay: true, start: s.toISOString(), end: (e > s ? e : new Date(s.getTime() + 864e5)).toISOString() };
      } else {
        const s = new Date(sd.y, sd.m, sd.d, st.h, st.mi);
        let e = et ? new Date(ed.y, ed.m, ed.d, et.h, et.mi) : new Date(s.getTime() + 36e5);
        if (e <= s) e = new Date(s.getTime() + 36e5);
        ev = { allDay: false, start: s.toISOString(), end: e.toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      out.push({ ...ev, title: title.slice(0, 200), location: String(get('loc') || '').slice(0, 300), notes: String(get('notes') || '').slice(0, 5000), rrule: null, exdates: [], reminders: [15] });
    }
    return out;
  }
  // A calendar day from Excel dates, "2026-11-27", "11/27/2026" (US/Outlook) or "27.11.2026".
  function parseDay(v) {
    if (v instanceof Date && !isNaN(v)) return { y: v.getUTCFullYear(), m: v.getUTCMonth(), d: v.getUTCDate() }; // Excel stores wall time
    if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; }
    const s = String(v || '').trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ok(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) return ok(year(+m[3]), +m[1] - 1, +m[2]);
    if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/))) return ok(year(+m[3]), +m[2] - 1, +m[1]);
    const t = Date.parse(s); if (!isNaN(t)) { const d = new Date(t); return ok(d.getFullYear(), d.getMonth(), d.getDate()); }
    return null;
    function year(y) { return y < 100 ? 2000 + y : y; }
    function ok(y, mo, d) { return y > 1900 && y < 2200 && mo >= 0 && mo < 12 && d >= 1 && d <= 31 ? { y, m: mo, d } : null; }
  }
  // "9:00:00 AM", "14:30", Excel time fractions or Date objects.
  function parseClock(v) {
    if (v instanceof Date && !isNaN(v)) return { h: v.getUTCHours(), mi: v.getUTCMinutes() };
    if (typeof v === 'number' && v >= 0 && v < 1) { const t = Math.round(v * 1440); return { h: Math.floor(t / 60), mi: t % 60 }; }
    const m = String(v || '').trim().match(/^(\d{1,2})(?::|\.|h)?(\d{2})?(?::\d{2})?\s*([ap])?\.?m?\.?$/i);
    if (!m) return null;
    let h = +m[1]; const mi = +(m[2] || 0), ap = (m[3] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
    return h < 24 && mi < 60 ? { h, mi } : null;
  }

  // ---------- files out ----------
  const pad = n => String(n).padStart(2, '0');
  // Outlook and Google Calendar both import this CSV layout.
  function buildCSV(occurrences) {
    const safe = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    const day = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    const clock = d => { const h = d.getHours() % 12 || 12; return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`; };
    const lines = ['Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description,Location,Private'];
    for (const o of occurrences) {
      const e = o.ev;
      const s = o.start, en = o.end; // all-day: end date is the day after, like Outlook's own export
      lines.push([safe(e.title), day(s), e.allDay ? '' : clock(s), day(en), e.allDay ? '' : clock(o.end), e.allDay ? 'True' : 'False', safe(e.notes), safe(e.location), 'True'].join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  root.Importers = { readFile, parseCSV, rowsToEvents, buildCSV, download, _test: { parseDay, parseClock, unzip } };
})(window);

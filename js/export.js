// export.js — build the Excel file (.xlsx) right in the browser (no server).
// Uses ExcelJS (vendor/exceljs.min.js, MIT licence, served from this site — no CDN).
// Sheets: Events (repeats expanded, color-coded), Alarms, Sleep, Counters.
// Times are shown on the exporting person's clock. ExcelJS stores a JS Date as UTC,
// so we hand it "wall time" dates (UTC fields = the clock reading in that zone).
(function (root) {
  const PALETTE = ['1E3A8A', '2563EB', '0891B2', '0D9488', '65A30D', 'CA8A04', 'EA580C', 'DC2626'];
  const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  async function build({ events, alarms, sleepLogs, counters, members }, from, to, tz) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'DuoCal';
    const wall = Recur.wallCal(tz);
    const cell = d => wall.toWall(d);
    const hm = d => cell(d).toISOString().slice(11, 16);
    const nameOf = id => (members.find(m => m.id === id) || {}).name || '';
    // Text that starts with = + - @ could be read as a formula by Excel: keep it plain text.
    const txt = v => { v = String(v ?? ''); return /^[=+\-@\t\r]/.test(v) ? "'" + v : v; };
    const header = ws => {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
    };

    const ev = wb.addWorksheet('Events');
    ev.columns = [
      { header: 'Date', key: 'date', width: 12 }, { header: 'Start', key: 'start', width: 8 }, { header: 'End', key: 'end', width: 8 },
      { header: 'Hours', key: 'hours', width: 7 }, { header: 'Title', key: 'title', width: 32 }, { header: 'For', key: 'for', width: 18 },
      { header: 'Location', key: 'loc', width: 20 }, { header: 'Repeats', key: 'rep', width: 24 }, { header: 'Notes', key: 'notes', width: 40 },
    ];
    const rows = [];
    for (const e of events) for (const o of Recur.expand(e, from, to)) rows.push({ e, o });
    rows.sort((a, b) => a.o.start - b.o.start);
    for (const { e, o } of rows.slice(0, 20000)) {
      const row = ev.addRow({
        date: e.allDay ? o.start : cell(o.start), start: e.allDay ? 'all day' : hm(o.start), end: e.allDay ? '' : hm(o.end),
        hours: e.allDay ? '' : Math.round((o.end - o.start) / 36e5 * 100) / 100,
        title: txt(e.title), for: txt((e.forUsers || []).map(nameOf).join(' & ')), loc: txt(e.location), rep: e.rrule ? Recur.describe(e.rrule) : '', notes: txt(e.notes),
      });
      row.getCell('date').numFmt = 'yyyy-mm-dd';
      const c = PALETTE[e.color ?? 1] || PALETTE[1];
      row.getCell('title').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + c } };
      row.getCell('title').font = { color: { argb: 'FFFFFFFF' }, bold: true };
    }
    header(ev);

    const al = wb.addWorksheet('Alarms');
    al.columns = [{ header: 'Label', key: 'label', width: 24 }, { header: 'Time', key: 'time', width: 8 }, { header: 'Days', key: 'days', width: 24 }, { header: 'For', key: 'for', width: 14 }, { header: 'On', key: 'on', width: 6 }];
    for (const a of alarms) al.addRow({ label: txt(a.label), time: a.time, days: a.days && a.days.length ? a.days.map(d => D[d]).join(' ') : (a.date || 'once'), for: txt(nameOf(a.forUser)), on: a.enabled ? 'yes' : 'no' });
    header(al);

    const sl = wb.addWorksheet('Sleep');
    sl.columns = [{ header: 'Person', key: 'who', width: 14 }, { header: 'Went to bed', key: 'start', width: 18 }, { header: 'Woke up', key: 'end', width: 18 }, { header: 'Hours slept', key: 'hours', width: 11 }];
    for (const s of [...sleepLogs].sort((a, b) => a.start.localeCompare(b.start))) {
      const r = sl.addRow({ who: txt(nameOf(s.userId)), start: cell(new Date(s.start)), end: s.end ? cell(new Date(s.end)) : 'still sleeping', hours: s.end ? Math.round((new Date(s.end) - new Date(s.start)) / 36e5 * 100) / 100 : '' });
      r.getCell('start').numFmt = 'yyyy-mm-dd hh:mm'; if (s.end) r.getCell('end').numFmt = 'yyyy-mm-dd hh:mm';
    }
    header(sl);

    const co = wb.addWorksheet('Counters');
    co.columns = [{ header: 'Name', key: 'name', width: 26 }, { header: 'Date', key: 'date', width: 18 }, { header: 'Type', key: 'type', width: 8 }, { header: 'Days', key: 'days', width: 10 }, { header: 'Weeks', key: 'weeks', width: 10 }, { header: 'Hours', key: 'hours', width: 12 }];
    const now = Date.now();
    for (const c of counters) {
      const ms = Math.abs(now - new Date(c.date));
      const r = co.addRow({ name: txt(c.title), date: cell(new Date(c.date)), type: new Date(c.date) > now ? 'until' : 'since', days: Math.floor(ms / 864e5), weeks: Math.round(ms / 6048e5 * 10) / 10, hours: Math.floor(ms / 36e5) });
      r.getCell('date').numFmt = 'yyyy-mm-dd hh:mm';
    }
    header(co);
    return wb.xlsx.writeBuffer();
  }
  root.ExportXlsx = { build };
})(window);

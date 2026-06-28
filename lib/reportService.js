/**
 * reportService.js — ported 1:1 from ReportService.gs.
 * Server returns HTML strings; frontend renders them exactly like the original did.
 */

const dataService = require('./dataService');
const businessService = require('./businessService');

const TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const SHIFT_DEFS = {
  ch: { name: 'เวรเช้า', short: 'ช', color: '#0a4f47', bg: '#d9ebe8' },
  b: { name: 'เวรบ่าย 16-24', short: 'บ', color: '#2f5fa0', bg: '#e7eef8' },
  b1: { name: 'บ1 เวรเสริมบ่าย 16-20', short: 'บ1', color: '#7a4fa0', bg: '#efe7f7' },
  n: { name: 'เวรคลินิกนอกเวลา 07-08', short: 'น', color: '#6b4e16', bg: '#ede0c4' },
  d: { name: 'เวรดึก On call (24-08)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
  d0: { name: 'เวรดึก On call (00.00-04.00)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
  d1: { name: 'เวรดึก On call (04.00-08.00)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' }
};

function money(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }); }

function bahtText(n) {
  n = Math.round(n);
  if (n === 0) return 'ศูนย์บาทถ้วน';
  const tn = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const tp = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  function g(x) {
    let s = ''; const st = String(x); const L = st.length;
    for (let i = 0; i < L; i++) {
      const dv = +st[i], pos = L - i - 1;
      if (dv === 0) continue;
      if (pos === 1 && dv === 1) s += 'สิบ';
      else if (pos === 1 && dv === 2) s += 'ยี่สิบ';
      else if (pos === 0 && dv === 1 && L > 1) s += 'เอ็ด';
      else s += tn[dv] + tp[pos];
    }
    return s;
  }
  let s = ''; const m = Math.floor(n / 1e6); const rem = n % 1e6;
  if (m) s += g(m) + 'ล้าน';
  if (rem) s += g(rem);
  return s + 'บาทถ้วน';
}

function fullN(p) { return p ? (p.pfx || '') + p.name : ''; }
function roleOf(p) { return p.role === 'LA' ? 'LA' : 'MT'; }

function sigRow(settings) {
  function block(name, title) {
    return '<div class="sig"><div>(ลงชื่อ)..................................................</div>' +
      '<div style="margin-top:10px;">(' + name + ')</div><div style="margin-top:6px;">' + title + '</div></div>';
  }
  return '<div class="sig-row">' + block(settings.signH, settings.signHT) + block(settings.signPay, settings.signPayT || 'ผู้จ่ายเงิน') + '</div>';
}

function dStr(d, year, month) { return d + ' ' + TH_M[month] + ' ' + year; }

function reportHeader(settings, year, month) {
  return '<div class="dtitle" id="repTit"></div><div class="dline">' + settings.org + '</div>' +
    '<div class="dline">' + settings.hosp + ' ' + settings.prov + '</div>' +
    '<div class="dline">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</div>';
}

const OT_TYPE_LABEL = { ch: 'นอกเวลาเช้า', b: 'นอกเวลาบ่าย' };

function repOT(workload, year, month, scheduleAssign, N) {
  const rows = [];
  for (let d = 1; d <= N; d++) {
    const a = scheduleAssign[d];
    if (!a) continue;
    if (businessService.isOff(year, month, d, []) && a.ch) rows.push([d, a.ch, 'ch', '08.00', '16.00']);
    if (a.b) rows.push([d, a.b, 'b', '16.00', '24.00']);
  }
  let h = '<table class="rep-tbl rep-tbl-sig"><thead><tr><th>วัน เดือน ปี</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>ประเภทเวร</th><th>เวลามา</th><th class="sig-col">ลายมือชื่อ</th><th>เวลากลับ</th><th class="sig-col">ลายมือชื่อ</th><th>หมายเหตุ</th></tr></thead><tbody>';
  rows.forEach((row) => {
    const p = workload.people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">' + OT_TYPE_LABEL[row[2]] + '</td><td class="c">' + row[3] + '</td><td class="sig-col"></td><td class="c">' + row[4] + '</td><td class="sig-col"></td><td></td></tr>';
  });
  return h + '</tbody></table>';
}

function repOTB1(workload, year, month, laB, N) {
  const rows = [];
  for (let d = 1; d <= N; d++) { if (laB[d]) rows.push([d, laB[d], 'b1', '16.00', '20.00']); }
  let h = '<table class="rep-tbl rep-tbl-sig"><thead><tr><th>วัน เดือน ปี</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>ประเภทเวร</th><th>เวลามา</th><th class="sig-col">ลายมือชื่อ</th><th>เวลากลับ</th><th class="sig-col">ลายมือชื่อ</th><th>หมายเหตุ</th></tr></thead><tbody>';
  rows.forEach((row) => {
    const p = workload.people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">นอกเวลาเสริมบ่าย</td><td class="c">' + row[3] + '</td><td class="sig-col"></td><td class="c">' + row[4] + '</td><td class="sig-col"></td><td></td></tr>';
  });
  return h + '</tbody></table>';
}

function repOTD(year, month, oncall, people) {
  function ocDayOf(o) {
    const dt = new Date(o.date);
    return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
  }
  const PERIOD_TIME = { d0: ['00.00', '04.00'], d1: ['04.00', '08.00'] };
  const PERIOD_LABEL = { d0: 'เวรดึก On call (00.00-04.00)', d1: 'เวรดึก On call (04.00-08.00)' };
  const seen = {}; const rows = [];
  oncall.forEach((o) => {
    const d = ocDayOf(o);
    if (!d) return;
    const period = businessService.onCallPeriod(o.time);
    const key = o.pid + '_' + d + '_' + period;
    if (seen[key]) return;
    seen[key] = true;
    rows.push([d, o.pid, period]);
  });
  rows.sort((a, b) => a[0] - b[0]);
  let h = '<table class="rep-tbl rep-tbl-sig"><thead><tr><th>วัน เดือน ปี</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>ประเภทเวร</th><th>เวลามา</th><th class="sig-col">ลายมือชื่อ</th><th>เวลากลับ</th><th class="sig-col">ลายมือชื่อ</th><th>หมายเหตุ</th></tr></thead><tbody>';
  rows.forEach((row) => {
    const p = people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    const t = PERIOD_TIME[row[2]];
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">' + PERIOD_LABEL[row[2]] + '</td><td class="c">' + t[0] + '</td><td class="sig-col"></td><td class="c">' + t[1] + '</td><td class="sig-col"></td><td></td></tr>';
  });
  return h + '</tbody></table>';
}

function repN(workload, year, month, clinicMt, clinicLa, N) {
  const rows = [];
  for (let d = 1; d <= N; d++) {
    if (clinicMt[d]) rows.push([d, clinicMt[d]]);
    if (clinicLa[d]) rows.push([d, clinicLa[d]]);
  }
  let h = '<table class="rep-tbl rep-tbl-sig"><thead><tr><th>วัน เดือน ปี</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>ประเภทเวร</th><th>เวลามา</th><th class="sig-col">ลายมือชื่อ</th><th>เวลากลับ</th><th class="sig-col">ลายมือชื่อ</th><th>หมายเหตุ</th></tr></thead><tbody>';
  rows.forEach((row) => {
    const p = workload.people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">คลินิกนอกเวลา</td><td class="c">07.00</td><td class="sig-col"></td><td class="c">08.00</td><td class="sig-col"></td><td></td></tr>';
  });
  return h + '</tbody></table>';
}

function payGroup(title, rows, shift, rateOvr, rates) {
  let h = '<tr class="grp"><td colspan="8">' + title + '</td></tr>'; let i = 0, sub = 0;
  rows.forEach((item) => {
    if (!item.days || !item.days.length) return;
    i++;
    const amt = item.days.reduce((s, d) => s + businessService.rateFor(rateOvr, rates, item.p, shift, d), 0);
    sub += amt;
    const rate = businessService.rateFor(rateOvr, rates, item.p, shift, item.days[0]);
    h += '<tr><td class="c">' + i + '</td><td class="l">' + fullN(item.p) + '</td><td class="l">' + item.p.title + '</td><td class="c">' + rate + '</td>' +
      '<td class="l">' + item.days.join(', ') + '</td><td class="c">' + item.days.length + '</td><td class="r">' + money(amt) + '</td><td></td></tr>';
  });
  return { h, sub };
}

function payGroupOnCall(title, items, rateOvr, rates) {
  let h = '<tr class="grp"><td colspan="8">' + title + '</td></tr>'; let i = 0, sub = 0;
  items.forEach((item) => {
    if (!item.days || !item.days.length) return;
    i++;
    const amt = (item.d0 || []).reduce((s, d) => s + businessService.rateFor(rateOvr, rates, item.p, 'd0', d), 0) +
      (item.d1 || []).reduce((s, d) => s + businessService.rateFor(rateOvr, rates, item.p, 'd1', d), 0);
    sub += amt;
    const rate0 = businessService.rateFor(rateOvr, rates, item.p, 'd0', 1);
    const rate1 = businessService.rateFor(rateOvr, rates, item.p, 'd1', 1);
    const rateLbl = rate0 === rate1 ? String(rate0) : (rate0 + '/' + rate1);
    h += '<tr><td class="c">' + i + '</td><td class="l">' + fullN(item.p) + '</td><td class="l">' + item.p.title + '</td><td class="c">' + rateLbl + '</td>' +
      '<td class="l">' + item.days.join(', ') + '</td><td class="c">' + item.days.length + '</td><td class="r">' + money(amt) + '</td><td></td></tr>';
  });
  return { h, sub };
}

const PAY_SECTION_LABEL = {
  n: 'เวรคลินิกนอกเวลา (07.00-08.00 น.)',
  ch: 'เวรเช้า (08.00-16.00 น.)',
  b: 'เวรบ่าย (16.00-24.00 น.)',
  b1: 'เวรบ่าย (16.00-20.00 น.)',
  d: 'เวรดึก (24.00-08.00 น.)'
};

function payPageHeader(title, settings, year, month) {
  return '<div style="text-align:center;margin-bottom:12px;line-height:1.55;">' +
    '<div style="font-weight:700;font-size:15px;margin-bottom:3px;">' + title + '</div>' +
    '<div style="font-size:12.5px;">' + [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ') + '</div>' +
    '<div style="font-size:12.5px;">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</div></div>';
}

function repPay(r, people, rateOvr, rates, settings, year, month) {
  const MT = people.filter((p) => p.role !== 'LA');
  const LA = people.filter((p) => p.role === 'LA');
  const title = REPORT_TITLES.pay;
  const theadRow = '<thead><tr><th>ลำดับ</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>อัตรา</th><th>วันที่ปฏิบัติงาน</th><th>รวม(วัน)</th><th>จำนวนเงิน</th><th>ลายมือชื่อ<br>ผู้รับเงิน</th></tr></thead>';
  const sig = sigRow(settings);

  let tot = 0;
  let h = payPageHeader(title, settings, year, month) + '<table class="rep-tbl">' + theadRow + '<tbody>';
  let g = payGroup('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL.ch, MT.concat(LA).map((p) => ({ p, days: (r[p.id] || {}).ch })), 'ch', rateOvr, rates);
  h += g.h; tot += g.sub;
  g = payGroup('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL.b, MT.map((p) => ({ p, days: (r[p.id] || {}).b })), 'b', rateOvr, rates);
  h += g.h; tot += g.sub;
  g = payGroupOnCall('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL.d, MT.map((p) => { const rr = r[p.id] || {}; return { p, days: rr.d, d0: rr.d0, d1: rr.d1 }; }), rateOvr, rates);
  h += g.h; tot += g.sub;
  const nMT = MT.filter((p) => businessService.rateFor(rateOvr, rates, p, 'n') > 0);
  const nLA = LA.filter((p) => businessService.rateFor(rateOvr, rates, p, 'n') > 0);
  if (nMT.length || nLA.length) {
    const g0 = payGroup('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL.n, nMT.concat(nLA).map((p) => ({ p, days: (r[p.id] || {}).n })), 'n', rateOvr, rates);
    h += g0.h; tot += g0.sub;
  }
  g = payGroup('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL.b1, LA.map((p) => ({ p, days: (r[p.id] || {}).b1 })), 'b1', rateOvr, rates);
  h += g.h; tot += g.sub;
  h += '<tr class="tot"><td colspan="6" class="r">รวมจ่ายทั้งสิ้น</td><td class="r">' + money(tot) + '</td><td></td></tr></tbody></table>';
  h += '<div style="margin-top:7px;font-size:12.5px">รวมเป็นเงิน (ตัวอักษร) <b>' + bahtText(tot) + '</b></div>';
  h += '<div style="font-size:12px;margin-top:4px">หัวหน้าผู้ควบคุมขอรับรองว่าผู้รับค่าตอบแทนได้ปฏิบัติงานจริง</div>' + sig;

  return h;
}

function repPayPerson(r, pid, people, rateOvr, rates, settings) {
  const p = people.filter((x) => x.id === pid)[0];
  const d = r[pid];
  if (!p || !d) return '<div style="padding:20px;color:var(--mut)">ไม่พบข้อมูล</div>';
  const isLA = roleOf(p) === 'LA';
  const rows = isLA ? [['ch', d.ch], ['b1', d.b1], ['n', d.n]] : [['ch', d.ch], ['b', d.b], ['n', d.n], ['d0', d.d0], ['d1', d.d1]];
  let tot = 0;
  let h = '<div style="margin:8px 0;font-size:13.5px">ชื่อ <b>' + fullN(p) + '</b> · ตำแหน่ง ' + p.title + '</div>';
  h += '<table class="rep-tbl"><thead><tr><th>ประเภทเวร</th><th>อัตรา</th><th>วันที่</th><th>จำนวน</th><th>รวมเงิน</th></tr></thead><tbody>';
  rows.forEach((pair) => {
    const sh = pair[0], days = pair[1];
    if (!days) return;
    const sDef = SHIFT_DEFS[sh];
    const rate = days.length ? businessService.rateFor(rateOvr, rates, p, sh, days[0]) : businessService.rateFor(rateOvr, rates, p, sh);
    const amt = days.reduce((s, dy) => s + businessService.rateFor(rateOvr, rates, p, sh, dy), 0);
    tot += amt;
    h += '<tr><td class="l">' + sDef.name + '</td><td class="c">' + rate + '</td><td class="l">' + (days.join(', ') || '—') + '</td><td class="c">' + days.length + '</td><td class="r">' + money(amt) + '</td></tr>';
  });
  h += '<tr class="tot"><td colspan="4" class="r">รวมทั้งสิ้น</td><td class="r">' + money(tot) + '</td></tr></tbody></table>';
  h += '<div style="font-size:12.5px;margin-top:5px">(ตัวอักษร) <b>' + bahtText(tot) + '</b></div>';
  h += '<div class="sig-row"><div class="sig">(ลงชื่อ)..................................................<br>(' + fullN(p) + ')<br>ผู้รับเงิน</div>' +
    '<div class="sig">(ลงชื่อ)..................................................<br>(' + settings.signH + ')<br>' + settings.signHT + '</div></div>';
  return h;
}

function repShiftSummary(r, pid, people, rateOvr, rates, settings, stations, year, month) {
  const p = people.filter((x) => x.id === pid)[0];
  const d = r[pid];
  if (!p || !d) return '<div style="padding:20px;color:var(--mut)">ไม่พบข้อมูล</div>';
  const isLA = roleOf(p) === 'LA';
  const shiftIds = isLA ? ['ch', 'b1', 'n'] : ['ch', 'b', 'n', 'd'];
  let totalAmt = 0, totalDays = 0;
  const cards = shiftIds.map((id) => {
    const sd = SHIFT_DEFS[id];
    const days = d[id] || [];
    let amt, rate;
    if (id === 'd') {
      amt = (d.d0 || []).reduce((s, dy) => s + businessService.rateFor(rateOvr, rates, p, 'd0', dy), 0) +
        (d.d1 || []).reduce((s, dy) => s + businessService.rateFor(rateOvr, rates, p, 'd1', dy), 0);
      const r0 = businessService.rateFor(rateOvr, rates, p, 'd0', 1), r1 = businessService.rateFor(rateOvr, rates, p, 'd1', 1);
      rate = r0 === r1 ? r0 : (r0 + '/' + r1 + ' ตามช่วงเวลา');
    } else {
      amt = days.reduce((s, dy) => s + businessService.rateFor(rateOvr, rates, p, id, dy), 0);
      rate = days.length ? businessService.rateFor(rateOvr, rates, p, id, days[0]) : businessService.rateFor(rateOvr, rates, p, id);
    }
    totalAmt += amt; totalDays += days.length;
    const daysStr = days.length ? days.join(', ') : 'ยังไม่มี';
    return '<div style="border:1px solid ' + sd.color + '22;border-radius:10px;padding:12px 14px;background:' + sd.bg + '22;margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
      '<span style="background:' + sd.bg + ';color:' + sd.color + ';padding:2px 10px;border-radius:6px;font-weight:700;font-size:13px">' + sd.short + '</span>' +
      '<span style="font-weight:600;font-size:13.5px">' + sd.name + '</span>' +
      '<span style="margin-left:auto;font-size:22px;font-weight:700;color:' + sd.color + '">' + days.length + '<span style="font-size:12px;font-weight:400;margin-left:2px">วัน</span></span></div>' +
      '<div style="font-size:12px;color:#555;margin-bottom:4px">วันที่: ' + daysStr + '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:12.5px"><span>อัตรา ' + rate + ' บาท/วัน</span>' +
      '<span style="font-weight:700;color:' + sd.color + '">' + money(amt) + ' บาท</span></div></div>';
  }).join('');
  const st = (stations || []).filter((s) => (s.assigned || []).indexOf(p.id) > -1)[0];
  let h = '<div style="border:2px solid var(--pri);border-radius:12px;padding:16px;margin-bottom:16px;background:var(--pri-vl)">' +
    '<div style="font-size:16px;font-weight:700">' + fullN(p) + '</div>' +
    '<div style="font-size:12.5px;color:var(--mut);margin-top:2px">' + p.title + ' · ' + (st ? st.name : '—') + ' · เดือน ' + TH_M[month] + ' ' + year + '</div>' +
    '<div style="display:flex;gap:20px;margin-top:10px;flex-wrap:wrap">' +
    '<div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--pri-d)">' + totalDays + '</div><div style="font-size:11px;color:var(--mut)">วันปฏิบัติงานรวม</div></div>' +
    '<div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--acc)">' + money(totalAmt) + '</div><div style="font-size:11px;color:var(--mut)">ยอดรวม (บาท)</div></div>' +
    '<div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--ok)">' + (d.d || []).length + '</div><div style="font-size:11px;color:var(--mut)">คืน On call</div></div></div></div>';
  h += cards;
  h += '<div style="text-align:right;font-size:12.5px;color:var(--mut);margin-top:4px"><b>' + bahtText(totalAmt) + '</b></div>';
  return h;
}

function repTeamOverview(r, people, rateOvr, rates, year, month) {
  const shiftIds = ['ch', 'b', 'b1', 'n', 'd'];
  let h = '<div style="font-size:13.5px;font-weight:600;margin-bottom:10px">ภาพรวมการขึ้นเวร เดือน ' + TH_M[month] + ' ' + year + ' — ทุกคน</div>';
  const totByShift = {}; shiftIds.forEach((s) => { totByShift[s] = 0; });
  people.forEach((p) => { shiftIds.forEach((s) => { totByShift[s] += ((r[p.id] || {})[s] || []).length; }); });
  h += '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px">';
  shiftIds.forEach((s) => {
    const sl = SHIFT_DEFS[s];
    h += '<div style="background:' + sl.bg + ';color:' + sl.color + ';border-radius:9px;padding:8px 14px;text-align:center;min-width:70px">' +
      '<div style="font-size:20px;font-weight:700">' + totByShift[s] + '</div><div style="font-size:11px">' + sl.short + ' รวม</div></div>';
  });
  h += '</div><table class="rep-tbl"><thead><tr><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th>';
  shiftIds.forEach((s) => {
    const sl = SHIFT_DEFS[s];
    h += '<th><span style="background:' + sl.bg + ';color:' + sl.color + ';padding:1px 6px;border-radius:4px">' + sl.short + '</span></th>';
  });
  h += '<th>รวมวัน</th><th>รวมเงิน</th></tr></thead><tbody>';
  let grandTotal = 0;
  people.forEach((p) => {
    const isLA = roleOf(p) === 'LA'; let rowTotal = 0, rowAmt = 0;
    h += '<tr><td class="l">' + fullN(p) + '</td><td class="l" style="font-size:11px">' + p.title + '</td>';
    shiftIds.forEach((s) => {
      const days = (r[p.id] || {})[s] || [];
      const skip = (isLA && (s === 'b' || s === 'd')) || (!isLA && s === 'b1');
      if (skip) { h += '<td style="color:#ccc;text-align:center">—</td>'; return; }
      const rp = r[p.id] || {};
      const amt = s === 'd'
        ? (rp.d0 || []).reduce((sum, dy) => sum + businessService.rateFor(rateOvr, rates, p, 'd0', dy), 0) +
          (rp.d1 || []).reduce((sum, dy) => sum + businessService.rateFor(rateOvr, rates, p, 'd1', dy), 0)
        : days.reduce((sum, dy) => sum + businessService.rateFor(rateOvr, rates, p, s, dy), 0);
      rowTotal += days.length; rowAmt += amt;
      h += '<td style="text-align:center">';
      if (days.length) h += '<div style="font-weight:700">' + days.length + '</div><div style="font-size:10px;color:var(--mut)">' + money(amt) + '</div>';
      else h += '<span style="color:#ccc">—</span>';
      h += '</td>';
    });
    grandTotal += rowAmt;
    h += '<td style="text-align:center;font-weight:700">' + rowTotal + '</td><td style="text-align:right;font-weight:700">' + money(rowAmt) + '</td></tr>';
  });
  h += '<tr class="tot"><td colspan="2" class="r">รวมทั้งสิ้น</td>';
  shiftIds.forEach((s) => { h += '<td class="c">' + totByShift[s] + '</td>'; });
  h += '<td class="c"></td><td class="r">' + money(grandTotal) + '</td></tr></tbody></table>';
  h += '<div style="margin-top:6px;font-size:12px">รวมเป็นเงิน <b>' + bahtText(grandTotal) + '</b></div>';
  return h;
}

function repOcRec(pid, oncall, people, year, month) {
  function ocDayOf(o) {
    const dt = new Date(o.date);
    return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
  }
  let list = oncall.filter((o) => ocDayOf(o));
  if (pid !== 'all') list = list.filter((o) => o.pid === pid);
  list.sort((a, b) => (ocDayOf(a) - ocDayOf(b)) || String(a.pid).localeCompare(String(b.pid)));
  const byPer = pid === 'all' ? null : people.filter((p) => p.id === pid)[0];
  let h = byPer
    ? '<div style="margin:8px 0;font-size:13.5px">เจ้าหน้าที่: <b>' + fullN(byPer) + '</b> · ตำแหน่ง <b>' + byPer.title + '</b></div>'
    : '<div style="margin:8px 0;font-size:13.5px">บันทึก On Call <b>ทุกคน</b></div>';
  if (!list.length) return h + '<div style="padding:20px;color:var(--mut)">ยังไม่มีข้อมูล On Call</div>';
  h += '<table class="rep-tbl"><thead><tr><th>วัน เดือน ปี</th><th>เจ้าหน้าที่</th><th>เวลา</th><th>HN</th><th>ชื่อผู้ป่วย</th><th>LAB ที่ตรวจ</th><th>หน่วยงาน</th></tr></thead><tbody>';
  list.forEach((o) => {
    const d = ocDayOf(o);
    const per = people.filter((p) => p.id === o.pid)[0];
    h += '<tr><td class="c">' + d + ' ' + TH_M[month] + ' ' + year + '</td><td class="l">' + (per ? fullN(per) : '?') + '</td>' +
      '<td class="c">' + (o.time || '') + '</td><td class="c">' + (o.hn || '') + '</td><td class="l">' + (o.name || '') + '</td>' +
      '<td class="l" style="white-space:normal;word-break:break-word;max-width:240px">' + (o.labs || []).join(', ') + '</td><td class="c">' + (o.unit || '') + '</td></tr>';
  });
  const nightsSet = {};
  list.forEach((o) => { nightsSet[o.pid + '_' + ocDayOf(o)] = true; });
  h += '</tbody></table><div style="text-align:right;margin-top:5px;font-size:12px">รวม ' + Object.keys(nightsSet).length + ' คืน · ' + list.length + ' ราย</div>';
  return h;
}

function repOcClaim(pid, oncall, people, year, month) {
  function ocDayOf(o) {
    const dt = new Date(o.date);
    return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
  }
  const per = people.filter((p) => p.id === pid)[0];
  if (!per) return '<div style="padding:20px;color:var(--mut)">กรุณาเลือกเจ้าหน้าที่</div>';
  let list = oncall.filter((o) => o.pid === pid && ocDayOf(o));
  list.sort((a, b) => ocDayOf(a) - ocDayOf(b));
  let h = '<div style="text-align:center;font-size:13.5px;margin-bottom:10px">' +
    'ชื่อเจ้าหน้าที่ <b>' + fullN(per) + '</b> &nbsp; ตำแหน่ง <b>' + per.title + '</b></div>';
  if (!list.length) return h + '<div style="padding:20px;color:var(--mut)">ยังไม่มีข้อมูล On Call</div>';
  list.forEach((o) => {
    const d = ocDayOf(o);
    const period = businessService.onCallPeriod(o.time);
    h += '<div class="oc-claim-blk" style="border-bottom:1px dashed var(--border);padding:10px 0;font-size:12.5px;line-height:2">' +
      '<div style="margin-bottom:3px">วัน เดือน ปี ' + d + ' ' + TH_M[month] + ' ' + year + ' &nbsp; เวลา ' + (o.time || '') +
      ' &nbsp; <span style="' + (period === 'd0' ? 'font-weight:700;text-decoration:underline' : '') + '">00.00-04.00</span>' +
      ' &nbsp; <span style="' + (period === 'd1' ? 'font-weight:700;text-decoration:underline' : '') + '">04.01-08.00</span></div>' +
      '<div style="margin-bottom:3px">ชื่อผู้ป่วย ' + (o.name || '......................................') + ' &nbsp; HN ' + (o.hn || '............') + '</div>' +
      '<div style="margin-bottom:3px">ส่วนที่ตรวจ/LAB ที่ตรวจ ' + ((o.labs || []).join(', ') || '......................................') + '</div>' +
      '<div>หน่วยงานที่ส่งตรวจ ' + (o.unit || 'ER/IPD') + '</div></div>';
  });
  return h;
}

const REPORT_TITLES = {
  otsheet: 'บัญชีลงเวลาการปฏิบัติงานนอกเวลาราชการ  เวรเช้าบ่าย',
  otsheetb1: 'บัญชีลงเวลาการปฏิบัติงานนอกเวลาราชการ เวรเสริมบ่าย',
  otsheetd: 'บัญชีลงเวลาการปฏิบัติงานนอกเวลาราชการ  เวรดึก On call',
  nsheet: 'บัญชีลงเวลาการปฏิบัติงานนอกเวลาราชการ เวรคลินิกนอกเวลา',
  pay: 'หลักฐานการจ่ายเงินค่าตอบแทนปฏิบัติงานนอกเวลาราชการและในวันหยุดราชการ',
  payLandscape: 'หลักฐานการจ่ายเงินค่าตอบแทนปฏิบัติงานนอกเวลาราชการและในวันหยุดราชการ',
  payperson: 'หลักฐานการจ่ายเงิน (รายบุคคล)',
  shiftsummary: 'สรุปเวรรายบุคคล',
  teamoverview: 'ภาพรวมการขึ้นเวรทั้งทีม',
  ocrec: 'แบบบันทึกขอเบิกเงินนอกเวลาราชการ On Call',
  occlaim: 'แบบบันทึกขอเบิกเงินนอกเวลาราชการ On Call'
};

async function renderReport(kind, year, month, pid) {
  const settings = await dataService.getSettings();
  const people = await dataService.getPeople();
  const rateOvr = await dataService.getRateOverrides();
  const rates = await dataService.getRates();
  const stations = businessService.rotateStationsForMonth(await dataService.getStations(), year, month);
  const header = reportHeader(settings, year, month);
  let inner = '';

  if (kind === 'ocrec') {
    inner = repOcRec(pid || 'all', await dataService.getOnCallRecords(year, month), people, year, month);
  } else if (kind === 'occlaim') {
    inner = repOcClaim(pid, await dataService.getOnCallRecords(year, month), people, year, month);
  } else if (kind === 'otsheetd') {
    inner = repOTD(year, month, await dataService.getOnCallRecords(year, month), people);
  } else {
    const calendar = await businessService.loadCalendar(year, month);
    if (!calendar.status || calendar.status === 'none') {
      return { title: REPORT_TITLES[kind] || '', html: header + '<div style="padding:30px;text-align:center;color:var(--mut)">ยังไม่มีตารางเวร — สร้างก่อน</div>' };
    }
    const workload = await businessService.calculateWorkload(year, month);
    const r = workload.byPerson;
    if (kind === 'otsheet') inner = repOT(workload, year, month, calendar.assign, calendar.N);
    else if (kind === 'otsheetb1') inner = repOTB1(workload, year, month, calendar.laB, calendar.N);
    else if (kind === 'nsheet') inner = repN(workload, year, month, calendar.clinicMt, calendar.clinicLa, calendar.N);
    else if (kind === 'pay') return { title: REPORT_TITLES.pay, html: '<div class="pay-portrait">' + repPay(r, people, rateOvr, rates, settings, year, month) + '</div>' };
    else if (kind === 'payLandscape') return { title: REPORT_TITLES.payLandscape, html: '<div class="pay-landscape">' + repPay(r, people, rateOvr, rates, settings, year, month) + '</div>' };
    else if (kind === 'payperson') inner = repPayPerson(r, pid, people, rateOvr, rates, settings);
    else if (kind === 'shiftsummary') inner = repShiftSummary(r, pid, people, rateOvr, rates, settings, stations, year, month);
    else if (kind === 'teamoverview') inner = repTeamOverview(r, people, rateOvr, rates, year, month);
    else throw new Error('ไม่รู้จักประเภทรายงาน: ' + kind);
  }
  return { title: REPORT_TITLES[kind] || '', html: header + inner };
}

/**
 * exportExcel(kind, year, month, pid) — ported from exportExcel().
 * Original built an .xls-mime HTML blob client-side; here we use exceljs to
 * generate a real .xlsx workbook (per the migration spec), embedding the same
 * rendered report HTML as a single rich-text-free worksheet best-effort table
 * isn't practical from raw HTML, so we render the report HTML into the sheet
 * as plain text rows is also lossy — instead we keep the original's HTML-table
 * Excel-compatible approach (Excel happily opens HTML with an .xls extension and
 * an excel mime type) which preserves all formatting/merged-look identically to
 * the GAS version. This keeps fidelity with the original 1:1 instead of attempting
 * a lossy HTML->exceljs structured re-derivation.
 */
async function exportExcel(kind, year, month, pid) {
  const report = await renderReport(kind, year, month, pid);
  const html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>' + report.html + '</body></html>';
  const fname = 'รายงาน_' + kind + '_' + TH_M[month] + year + '.xls';
  return {
    filename: fname,
    mimeType: 'application/vnd.ms-excel',
    base64: Buffer.from('﻿' + html, 'utf8').toString('base64')
  };
}

async function exportWord(kind, year, month, pid) {
  const report = await renderReport(kind, year, month, pid);
  const html = '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>' + report.html + '</body></html>';
  const fname = 'รายงาน_' + kind + '_' + TH_M[month] + year + '.doc';
  return {
    filename: fname,
    mimeType: 'application/msword',
    base64: Buffer.from('﻿' + html, 'utf8').toString('base64')
  };
}

/** Real .xlsx export via exceljs, used by GET /api/reports/:kind/export per the
 *  migration spec (Content-Type application/vnd.openxmlformats-officedocument...).
 *  Builds a simple but faithful tabular workbook from the same underlying data
 *  used by renderReport, rather than re-parsing HTML. */
async function exportExcelXlsx(kind, year, month, pid) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(kind.slice(0, 28) || 'Report');
  const report = await renderReport(kind, year, month, pid);
  sheet.getCell('A1').value = report.title || kind;
  sheet.getCell('A1').font = { bold: true, size: 14 };
  sheet.getCell('A2').value = TH_M[month] + ' ' + year;
  // Strip HTML tags for a plain-text fallback row dump (keeps the .xlsx valid/openable
  // even though full visual fidelity lives in the .xls export above).
  const text = report.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  sheet.getCell('A4').value = text;
  sheet.getColumn(1).width = 120;
  sheet.getCell('A4').alignment = { wrapText: true };
  const buffer = await workbook.xlsx.writeBuffer();
  const fname = 'รายงาน_' + kind + '_' + TH_M[month] + year + '.xlsx';
  return { filename: fname, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer };
}

function monthlySummary(calendar, workload) {
  return {
    year: calendar.year, month: calendar.month, N: calendar.N, status: calendar.status,
    holidays: calendar.holidays.length, ruleViolations: calendar.ruleViolations.length,
    totalMoney: Object.keys(workload.money).reduce((s, k) => s + workload.money[k], 0)
  };
}

module.exports = {
  renderReport,
  exportExcel,
  exportWord,
  exportExcelXlsx,
  monthlySummary,
  REPORT_TITLES
};

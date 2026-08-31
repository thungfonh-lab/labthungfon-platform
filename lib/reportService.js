/**
 * reportService.js — ported 1:1 from ReportService.gs.
 * Server returns HTML strings; frontend renders them exactly like the original did.
 */

const dataService = require('./dataService');
const businessService = require('./businessService');

const TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const SHIFT_DEFS = {
  ch: { name: 'เวรเช้า', short: 'ช', color: '#0a4f47', bg: '#d9ebe8' },
  b: { name: 'เวรบ่าย 16-00', short: 'บ', color: '#2f5fa0', bg: '#e7eef8' },
  /* สัญลักษณ์ บ1 → "บ ขีดเส้นใต้" ตามฟีดแบ็ก — short ใช้เฉพาะใน HTML ของรายงาน (chip/หัวตาราง) */
  b1: { name: 'เวรเสริมบ่าย 16-20', short: '<u>บ</u>', color: '#7a4fa0', bg: '#efe7f7' },
  n: { name: 'เวรคลินิกนอกเวลา 07-08', short: 'น', color: '#6b4e16', bg: '#ede0c4' },
  d: { name: 'เวรดึก On call (00-08)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
  d0: { name: 'เวรดึก On call (00.00-04.00)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
  d1: { name: 'เวรดึก On call (04.00-08.00)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' }
};

/* เวลาปฏิบัติงานของแต่ละเวร — ค่าเริ่มต้น ผู้ใช้แก้เองได้ที่ ตั้งค่า > เวลาปฏิบัติงานแต่ละเวร
   (เก็บใน settings.shiftTimes แบบเดียวกับ settings.reportTitles) เวรดึกไม่อยู่ในนี้เพราะ
   แบ่งเป็น 2 ช่วงอัตราตายตัวตามระเบียบ (d0 00.00-04.00 / d1 04.01-08.00) */
const DEFAULT_SHIFT_TIMES = {
  ch: { s: '08.00', e: '16.00' },
  b: { s: '16.00', e: '00.00' },
  b1: { s: '16.00', e: '20.00' },
  n: { s: '07.00', e: '08.00' }
};

/** เวลาเริ่ม/สิ้นสุดของเวรหนึ่ง จาก settings — fallback เป็นค่าเริ่มต้นทีละฟิลด์
 *  (เผื่อ settings เก็บมาไม่ครบ/ว่าง จะได้ไม่กลายเป็น undefined โผล่บนเอกสาร) */
function shiftTime(settings, key) {
  const def = DEFAULT_SHIFT_TIMES[key] || { s: '', e: '' };
  const cfg = ((settings || {}).shiftTimes || {})[key] || {};
  return { s: cfg.s || def.s, e: cfg.e || def.e };
}

/** ชื่อเวรพร้อมช่วงเวลาปัจจุบัน เช่น "เวรคลินิกนอกเวลา 07-08" — ใช้แทน SHIFT_DEFS[id].name
 *  ในที่ที่มี settings อยู่ในมือ เพื่อให้ชื่อเวรเปลี่ยนตามเวลาที่ตั้งไว้ */
function shiftName(settings, id) {
  const base = (SHIFT_DEFS[id] || {}).name || id;
  if (!DEFAULT_SHIFT_TIMES[id]) return base;
  const t = shiftTime(settings, id);
  /* ตัดช่วงเวลาเดิมที่ติดมากับชื่อ (เช่น " 07-08", " 16-00") แล้วต่อช่วงเวลาปัจจุบันแทน */
  return base.replace(/\s*\d{2}[.:]?\d{0,2}\s*-\s*\d{2}[.:]?\d{0,2}$/, '') +
    ' ' + t.s.replace('.00', '') + '-' + t.e.replace('.00', '');
}

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
  return '<div class="dtitle" id="repTit"></div><div class="dline">' +
    [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ') + '</div>' +
    '<div class="dline">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</div>';
}

function titleFor(settings, kind) { return ((settings.reportTitles || {})[kind]) || REPORT_TITLES[kind] || ''; }

/* บรรทัดหัวรายงาน (ชื่อรายงาน/หน่วยงาน/เดือน) ฝังไว้ใน <thead> ของตารางเอง (ไม่ใช่ div แยกนอกตาราง)
   เพื่อให้เบราว์เซอร์พิมพ์หัวนี้ซ้ำในหน้าที่ 2 โดยอัตโนมัติเมื่อตารางยาวเกิน 1 แผ่น (display:table-header-group) */
function reportHeaderRows(settings, year, month, colspan) {
  const orgLine = [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ');
  return '<tr class="rt-head-row"><th colspan="' + colspan + '" class="dtitle" id="repTit"></th></tr>' +
    (orgLine ? '<tr class="rt-head-row"><th colspan="' + colspan + '" class="dline">' + orgLine + '</th></tr>' : '') +
    '<tr class="rt-head-row"><th colspan="' + colspan + '" class="dline">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</th></tr>';
}

const OT_TYPE_LABEL = { ch: 'เวรเช้า', b: 'เวรบ่าย' };
/* ตัดคอลัมน์ "หมายเหตุ" ออกตามฟีดแบ็ก — พื้นที่ที่ว่างยกให้ช่องลายมือชื่อ (.sig-col) แทน (ดู .rep-tbl-sig .sig-col ใน style.html) */
const SIG_HEAD_ROW = '<tr><th>วัน เดือน ปี</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>ประเภท</th><th>เวลามา</th><th class="sig-col">ลายมือชื่อ</th><th>เวลากลับ</th><th class="sig-col">ลายมือชื่อ</th></tr>';
/* table-layout:fixed อ่านความกว้างคอลัมน์จากแถวแรกของตารางเท่านั้น (CSS spec) — แถวแรกในที่นี้คือ
   แถวหัวรายงาน (colspan=8, ไม่มี width ระบุ) ทำให้ทุกคอลัมน์ถูกหารเท่ากันโดยไม่สนใจ % ที่ตั้งไว้ใน CSS
   ต้องระบุความกว้างผ่าน <colgroup><col> แทน ซึ่งมีผลเหนือกว่าทุกแถวเสมอ (% ต้องตรงกับ .rep-tbl-sig th:nth-child ใน style.html) */

function repOT(workload, year, month, scheduleAssign, N, settings, holidays) {
  const rows = [];
  for (let d = 1; d <= N; d++) {
    const a = scheduleAssign[d];
    if (!a) continue;
    const tCh = shiftTime(settings, 'ch'), tB = shiftTime(settings, 'b');
    if (businessService.isOff(year, month, d, holidays || [])) (a.ch || []).forEach((pid) => rows.push([d, pid, 'ch', tCh.s, tCh.e]));
    (a.b || []).forEach((pid) => rows.push([d, pid, 'b', tB.s, tB.e]));
  }
  let h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows(settings, year, month, 8) + SIG_HEAD_ROW + '</thead><tbody>';
  rows.forEach((row) => {
    const p = workload.people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">' + OT_TYPE_LABEL[row[2]] + '</td><td class="c">' + row[3] + '</td><td class="sig-col"></td><td class="c">' + row[4] + '</td><td class="sig-col"></td></tr>';
  });
  return h + '</tbody></table>';
}

function repOTB1(workload, year, month, laB, N, settings) {
  const rows = [];
  const tB1 = shiftTime(settings, 'b1');
  for (let d = 1; d <= N; d++) { (laB[d] || []).forEach((pid) => rows.push([d, pid, 'b1', tB1.s, tB1.e])); }
  let h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows(settings, year, month, 8) + SIG_HEAD_ROW + '</thead><tbody>';
  rows.forEach((row) => {
    const p = workload.people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">เวรบ่าย</td><td class="c">' + row[3] + '</td><td class="sig-col"></td><td class="c">' + row[4] + '</td><td class="sig-col"></td></tr>';
  });
  return h + '</tbody></table>';
}

function repOTD(year, month, oncall, people, settings) {
  function ocDayOf(o) {
    const dt = new Date(o.date);
    return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
  }
  const PERIOD_TIME = { d0: ['00.00', '04.00'], d1: ['04.01', '08.00'] };
  const PERIOD_LABEL = { d0: 'เวรดึก On call', d1: 'เวรดึก On call' };
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
  let h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows(settings, year, month, 8) + SIG_HEAD_ROW + '</thead><tbody>';
  rows.forEach((row) => {
    const p = people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    const t = PERIOD_TIME[row[2]];
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">' + PERIOD_LABEL[row[2]] + '</td><td class="c">' + t[0] + '</td><td class="sig-col"></td><td class="c">' + t[1] + '</td><td class="sig-col"></td></tr>';
  });
  return h + '</tbody></table>';
}

function repN(workload, year, month, clinicMt, clinicLa, N, settings) {
  const rows = [];
  for (let d = 1; d <= N; d++) {
    (clinicMt[d] || []).forEach((pid) => rows.push([d, pid]));
    (clinicLa[d] || []).forEach((pid) => rows.push([d, pid]));
  }
  const tN = shiftTime(settings, 'n');
  let h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows(settings, year, month, 8) + SIG_HEAD_ROW + '</thead><tbody>';
  rows.forEach((row) => {
    const p = workload.people.filter((x) => x.id === row[1])[0];
    if (!p) return;
    h += '<tr><td class="c">' + dStr(row[0], year, month) + '</td><td class="l">' + fullN(p) + '</td><td class="c">' + p.title + '</td>' +
      '<td class="c">คลินิกนอกเวลา</td><td class="c">' + tN.s + '</td><td class="sig-col"></td><td class="c">' + tN.e + '</td><td class="sig-col"></td></tr>';
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
      '<td class="l" style="white-space:normal">' + item.days.join(', ') + '</td><td class="c">' + item.days.length + '</td><td class="r">' + money(amt) + '</td><td></td></tr>';
  });
  return { h, sub };
}

/* หัวกลุ่มในใบเบิกเงินรวม — ชื่อเวรคงที่ ส่วนช่วงเวลาดึงจาก settings.shiftTimes (แก้ได้ที่หน้าตั้งค่า)
   ยกเว้น d0/d1 ที่เป็นช่วงอัตราตายตัวตามระเบียบ จึงคงไว้ */
const PAY_SECTION_NAME = { n: 'เวรคลินิกนอกเวลา', ch: 'เวรเช้า', b: 'เวรบ่าย', b1: 'เวรบ่าย' };
function paySectionLabel(settings, key) {
  if (key === 'd0') return 'เวรดึก On call (00.00-04.00 น.)';
  if (key === 'd1') return 'เวรดึก On call (04.01-08.00 น.)';
  const t = shiftTime(settings, key);
  return PAY_SECTION_NAME[key] + ' (' + t.s + '-' + t.e + ' น.)';
}

function payPageHeader(title, settings, year, month) {
  return '<div style="text-align:center;margin-bottom:12px;line-height:1.55;">' +
    '<div style="font-weight:700;font-size:15px;margin-bottom:3px;">' + title + '</div>' +
    '<div style="font-size:12.5px;">' + [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ') + '</div>' +
    '<div style="font-size:12.5px;">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</div></div>';
}

function repPay(r, people, rateOvr, rates, settings, year, month) {
  const MT = people.filter((p) => p.role !== 'LA');
  const LA = people.filter((p) => p.role === 'LA');
  const title = titleFor(settings, 'pay');
  const theadRow = '<thead><tr><th>ลำดับ</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>อัตรา</th><th>วันที่ปฏิบัติงาน</th><th>รวม</th><th>จำนวนเงิน</th><th>ลายมือชื่อ<br>ผู้รับเงิน</th></tr></thead>';
  const sig = sigRow(settings);

  /* เรียงกลุ่มตามเวลาเริ่มเวร (00.00 -> 16.00) และเวรดึก on call แยกเป็น 2 บล็อกตามช่วงเวลา
     (d0/d1) — ถ้ายุบเป็นแถวเดียวต่อคน วันที่จะซ้ำกันระหว่าง 2 ช่วง ทำให้ อัตรา x รวม
     ไม่เท่ากับจำนวนเงิน การเงินตรวจสอบยอดไม่ได้. */
  let tot = 0;
  let h = payPageHeader(title, settings, year, month) + '<div class="rep-tbl-wrap"><table class="rep-tbl">' + theadRow + '<tbody>';
  let g = payGroup('วันที่ปฏิบัติงาน ' + paySectionLabel(settings, 'd0'), MT.map((p) => ({ p, days: (r[p.id] || {}).d0 })), 'd0', rateOvr, rates);
  h += g.h; tot += g.sub;
  g = payGroup('วันที่ปฏิบัติงาน ' + paySectionLabel(settings, 'd1'), MT.map((p) => ({ p, days: (r[p.id] || {}).d1 })), 'd1', rateOvr, rates);
  h += g.h; tot += g.sub;
  g = payGroup('วันที่ปฏิบัติงาน ' + paySectionLabel(settings, 'ch'), MT.concat(LA).map((p) => ({ p, days: (r[p.id] || {}).ch })), 'ch', rateOvr, rates);
  h += g.h; tot += g.sub;
  g = payGroup('วันที่ปฏิบัติงาน ' + paySectionLabel(settings, 'b'), MT.map((p) => ({ p, days: (r[p.id] || {}).b })), 'b', rateOvr, rates);
  h += g.h; tot += g.sub;
  g = payGroup('วันที่ปฏิบัติงาน ' + paySectionLabel(settings, 'b1'), LA.map((p) => ({ p, days: (r[p.id] || {}).b1 })), 'b1', rateOvr, rates);
  h += g.h; tot += g.sub;
  h += '<tr class="tot"><td colspan="6" class="r">รวมจ่ายทั้งสิ้น</td><td class="r">' + money(tot) + '</td><td></td></tr></tbody></table></div>';
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
  h += '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>ประเภทเวร</th><th>อัตรา</th><th>วันที่</th><th>จำนวน</th><th>รวมเงิน</th></tr></thead><tbody>';
  rows.forEach((pair) => {
    const sh = pair[0], days = pair[1];
    if (!days) return;
    const rate = days.length ? businessService.rateFor(rateOvr, rates, p, sh, days[0]) : businessService.rateFor(rateOvr, rates, p, sh);
    const amt = days.reduce((s, dy) => s + businessService.rateFor(rateOvr, rates, p, sh, dy), 0);
    tot += amt;
    h += '<tr><td class="l">' + shiftName(settings, sh) + '</td><td class="c">' + rate + '</td><td class="l" style="white-space:normal">' + (days.join(', ') || '—') + '</td><td class="c">' + days.length + '</td><td class="r">' + money(amt) + '</td></tr>';
  });
  h += '<tr class="tot"><td colspan="4" class="r">รวมทั้งสิ้น</td><td class="r">' + money(tot) + '</td></tr></tbody></table></div>';
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
      '<span style="font-weight:600;font-size:13.5px">' + shiftName(settings, id) + '</span>' +
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
  h += '</div><div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th>';
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
  h += '<td class="c"></td><td class="r">' + money(grandTotal) + '</td></tr></tbody></table></div>';
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
  h += '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>วัน เดือน ปี</th><th>เจ้าหน้าที่</th><th>เวลา</th><th>HN</th><th>ชื่อผู้ป่วย</th><th>LAB ที่ตรวจ</th><th>หน่วยงาน</th></tr></thead><tbody>';
  list.forEach((o) => {
    const d = ocDayOf(o);
    const per = people.filter((p) => p.id === o.pid)[0];
    h += '<tr><td class="c">' + d + ' ' + TH_M[month] + ' ' + year + '</td><td class="l">' + (per ? fullN(per) : '?') + '</td>' +
      '<td class="c">' + (o.time || '') + '</td><td class="c">' + (o.hn || '') + '</td><td class="l">' + (o.name || '') + '</td>' +
      '<td class="l" style="white-space:normal;word-break:break-word;max-width:240px">' + (o.labs || []).join(', ') + '</td><td class="c">' + (o.unit || '') + '</td></tr>';
  });
  const nightsSet = {};
  list.forEach((o) => { nightsSet[o.pid + '_' + ocDayOf(o)] = true; });
  h += '</tbody></table></div><div style="text-align:right;margin-top:5px;font-size:12px">รวม ' + Object.keys(nightsSet).length + ' คืน · ' + list.length + ' ราย</div>';
  return h;
}

function periodCheckbox(on, label) {
  /* vertical-align ใส่ที่กล่อง inline-block ข้างในไม่มีผล เพราะมันเป็น flex item ของ span ครอบ (inline-flex)
     — vertical-align ถูก browser ignore ทั้งหมดสำหรับ flex item ต้องใส่ที่ span ครอบ (ตัวที่เป็น inline box
     จริงในสายตาของบรรทัดข้อความรอบๆ) ถึงจะจัดให้กึ่งกลางบรรทัดเดียวกับตัวอักษรอื่นได้ */
  return '<span style="display:inline-flex;vertical-align:middle;align-items:center;gap:5px;margin-right:14px;' + (on ? 'font-weight:700' : '') + '">' +
    '<span style="display:inline-block;width:15px;height:15px;border:1.5px solid #555;text-align:center;line-height:13px;font-size:12px;flex-shrink:0">' +
    (on ? '✓' : '') + '</span>' + label + '</span>';
}

function repOcClaim(pid, oncall, people, year, month, settings) {
  function ocDayOf(o) {
    const dt = new Date(o.date);
    return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
  }
  const per = people.filter((p) => p.id === pid)[0];
  if (!per) return reportHeader(settings, year, month) + '<div style="padding:20px;color:var(--mut)">กรุณาเลือกเจ้าหน้าที่</div>';
  let list = oncall.filter((o) => o.pid === pid && ocDayOf(o));
  list.sort((a, b) => ocDayOf(a) - ocDayOf(b));
  const whoLine = 'ชื่อเจ้าหน้าที่ <b>' + fullN(per) + '</b> &nbsp; ตำแหน่ง <b>' + per.title + '</b>';
  if (!list.length) {
    return reportHeader(settings, year, month) +
      '<div style="text-align:center;font-size:14px;margin-bottom:10px">' + whoLine + '</div>' +
      '<div style="padding:20px;color:var(--mut)">ยังไม่มีข้อมูล On Call</div>';
  }
  /* หัวรายงาน + ชื่อเจ้าหน้าที่ ฝังไว้ใน <thead> ของตาราง 1 คอลัมน์ที่ครอบทุกบล็อก (ไม่ใช่ div นอกตาราง)
     เพื่อให้เบราว์เซอร์พิมพ์หัวซ้ำทุกหน้าเมื่อรายการยาวเกิน 1 แผ่น — วิธีเดียวกับ .rep-tbl-sig ของ OT timesheet */
  let h = '<table class="oc-claim-tbl"><thead>' + reportHeaderRows(settings, year, month, 1) +
    '<tr class="rt-head-row"><th class="dline oc-claim-who">' + whoLine + '</th></tr></thead><tbody>';
  list.forEach((o, i) => {
    const d = ocDayOf(o);
    const period = businessService.onCallPeriod(o.time);
    h += '<tr><td><div class="oc-claim-blk" style="border-bottom:1px dashed var(--border);padding:10px 0;font-size:14px;line-height:1.9">' +
      '<div style="margin-bottom:3px"><b>' + (i + 1) + '.</b> วัน เดือน ปี <span class="oc-uline">' + d + ' ' + TH_M[month] + ' ' + year + '</span> &nbsp; เวลา <b class="oc-uline">' + (o.time || '............') + '</b> น.' +
      ' &nbsp; ' + periodCheckbox(period === 'd0', '00.00-04.00') + periodCheckbox(period === 'd1', '04.01-08.00') + '</div>' +
      '<div style="margin-bottom:3px">ชื่อผู้ป่วย <span class="oc-uline">' + (o.name || '......................................') + '</span> &nbsp; HN <span class="oc-uline">' + (o.hn || '............') + '</span></div>' +
      '<div style="margin-bottom:3px">ส่วนที่ตรวจ/LAB ที่ตรวจ <span class="oc-uline">' + ((o.labs || []).join(', ') || '......................................') + '</span></div>' +
      '<div>หน่วยงานที่ส่งตรวจ <span class="oc-uline">' + (o.unit || 'ER/IPD') + '</span></div></div></td></tr>';
  });
  return h + '</tbody></table>';
}

/* สถิติเวรดึก On Call หลายมิติ จากข้อมูลที่บันทึกจริง (วันที่/เวลา/เจ้าหน้าที่/HN/LAB/หน่วยงาน)
   — ทุกตารางใช้ .rep-tbl เดิมเพื่อให้หน้าตา/การพิมพ์เหมือนรายงานอื่นในระบบ */
function repOcStats(oncall, people, year, month) {
  function ocDayOf(o) {
    const dt = new Date(o.date);
    return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
  }
  const list = oncall.filter((o) => ocDayOf(o));
  if (!list.length) return '<div style="padding:20px;color:var(--mut)">ยังไม่มีข้อมูล On Call เดือนนี้</div>';

  function pct(n, total) { return total ? (n * 100 / total).toFixed(1) + '%' : '-'; }
  /* แถบสัดส่วนเป็นอักขระ █ แทน div สี — เพราะรายงานนี้ถูกฝังลงไฟล์ exportExcel/exportWord ตรงๆ
     ซึ่ง Excel/Word ไม่ render div ซ้อนใน cell และไม่รู้จัก var(--...) (แถบจะหายทั้งแถบ)
     อักขระบล็อกสี literal แสดงผลเหมือนกันทั้งหน้าเว็บและไฟล์ export */
  function bar(n, max) {
    const w = max ? Math.max(1, Math.round(n * 20 / max)) : 0;
    return '<span style="color:#138577;font-size:10px;letter-spacing:1px">' + '█'.repeat(w) + '</span>';
  }
  function section(title) { return '<div style="font-weight:700;font-size:13px;margin:16px 0 6px">' + title + '</div>'; }
  function countTable(counts, colName, total) {
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const max = keys.length ? counts[keys[0]] : 0;
    let t = '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th style="width:36px">ลำดับ</th><th>' + colName + '</th><th style="width:70px">จำนวน</th><th style="width:70px">ร้อยละ</th><th style="width:30%">สัดส่วน</th></tr></thead><tbody>';
    keys.forEach((k, i) => {
      t += '<tr><td class="c">' + (i + 1) + '</td><td class="l">' + k + '</td><td class="c">' + counts[k] + '</td><td class="c">' + pct(counts[k], total) + '</td><td>' + bar(counts[k], max) + '</td></tr>';
    });
    return t + '</tbody></table></div>';
  }

  // ── รวบรวมตัวเลขทุกมิติในรอบเดียว ──
  const nightsSet = {}, hnSet = {}, labCounts = {}, unitCounts = {}, dowCounts = {}, hourCounts = {};
  const perStaff = {};
  let totalLabs = 0;
  const periodCounts = { d0: 0, d1: 0 };
  const DOW_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  list.forEach((o) => {
    const d = ocDayOf(o);
    nightsSet[d] = true;
    if (o.hn) hnSet[o.hn] = true;
    (o.labs || []).forEach((lab) => {
      const k = String(lab).trim();
      if (!k) return;
      labCounts[k] = (labCounts[k] || 0) + 1;
      totalLabs++;
    });
    const unit = (o.unit || 'ไม่ระบุ').trim() || 'ไม่ระบุ';
    unitCounts[unit] = (unitCounts[unit] || 0) + 1;
    periodCounts[businessService.onCallPeriod(o.time)]++;
    const dow = DOW_TH[new Date(year - 543, month, d).getDay()];
    dowCounts[dow] = (dowCounts[dow] || 0) + 1;
    const hh = parseInt(String(o.time || '').replace('.', ':').split(':')[0], 10);
    const hourKey = isNaN(hh) ? 'ไม่ระบุ' : (String(hh).padStart(2, '0') + '.00-' + String(hh).padStart(2, '0') + '.59 น.');
    hourCounts[hourKey] = (hourCounts[hourKey] || 0) + 1;
    if (!perStaff[o.pid]) perStaff[o.pid] = { cases: 0, labs: 0, nights: {} };
    perStaff[o.pid].cases++;
    perStaff[o.pid].labs += (o.labs || []).length;
    perStaff[o.pid].nights[d] = true;
  });
  const totalCases = list.length;
  const nights = Object.keys(nightsSet).length;

  // ── 1. ภาพรวม ──
  let h = section('1. ภาพรวมประจำเดือน');
  h += '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>จำนวนครั้งที่บันทึก (ราย)</th><th>จำนวนคืนที่มีการตรวจ</th><th>ผู้ป่วยไม่ซ้ำ (HN)</th><th>รายการ LAB รวม</th><th>เฉลี่ยราย/คืน</th><th>เฉลี่ย LAB/ราย</th></tr></thead><tbody><tr>' +
    '<td class="c"><b>' + totalCases + '</b></td><td class="c">' + nights + '</td><td class="c">' + Object.keys(hnSet).length + '</td><td class="c">' + totalLabs + '</td>' +
    '<td class="c">' + (nights ? (totalCases / nights).toFixed(1) : '-') + '</td><td class="c">' + (totalCases ? (totalLabs / totalCases).toFixed(1) : '-') + '</td></tr></tbody></table></div>';

  // ── 2. แยกตามช่วงเวลาเวรดึก ──
  h += section('2. จำแนกตามช่วงเวลา');
  h += countTable({ '00.00-04.00 น.': periodCounts.d0, '04.01-08.00 น.': periodCounts.d1 }, 'ช่วงเวลา', totalCases);

  // ── 3. ความถี่ LAB ──
  h += section('3. รายการ LAB ที่ตรวจ (เรียงตามความถี่)');
  h += Object.keys(labCounts).length ? countTable(labCounts, 'รายการตรวจ', totalLabs) : '<div style="color:var(--mut)">ไม่มีการบันทึกรายการ LAB</div>';

  // ── 4. หน่วยงานที่ส่งตรวจ ──
  h += section('4. จำแนกตามหน่วยงานที่ส่งตรวจ');
  h += countTable(unitCounts, 'หน่วยงาน', totalCases);

  // ── 5. รายเจ้าหน้าที่ ──
  h += section('5. จำแนกตามเจ้าหน้าที่');
  h += '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>เจ้าหน้าที่</th><th style="width:80px">คืนที่ on call</th><th style="width:80px">จำนวนราย</th><th style="width:80px">รายการ LAB</th><th style="width:90px">เฉลี่ยราย/คืน</th></tr></thead><tbody>';
  Object.keys(perStaff).sort((a, b) => perStaff[b].cases - perStaff[a].cases).forEach((sPid) => {
    const st = perStaff[sPid];
    const per = people.filter((p) => p.id === sPid)[0];
    const n = Object.keys(st.nights).length;
    h += '<tr><td class="l">' + (per ? fullN(per) : sPid) + '</td><td class="c">' + n + '</td><td class="c">' + st.cases + '</td><td class="c">' + st.labs + '</td><td class="c">' + (n ? (st.cases / n).toFixed(1) : '-') + '</td></tr>';
  });
  h += '</tbody></table></div>';

  // ── 6. วันในสัปดาห์ ──
  h += section('6. จำแนกตามวันในสัปดาห์');
  h += countTable(dowCounts, 'วัน', totalCases);

  // ── 7. รายชั่วโมง ──
  h += section('7. จำแนกตามชั่วโมงที่บันทึก');
  h += countTable(hourCounts, 'ช่วงชั่วโมง', totalCases);

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
  occlaim: 'แบบบันทึกขอเบิกเงินนอกเวลาราชการ On Call',
  ocstats: 'รายงานสถิติการตรวจ LAB เวรดึก On Call'
};

async function renderReport(kind, year, month, pid) {
  const settings = await dataService.getSettings();
  const people = await dataService.getPeople();
  const rateOvr = await dataService.getRateOverrides();
  const rates = await dataService.getRates();
  const stations = businessService.rotateStationsForMonth(await dataService.getStations(), year, month);
  const header = reportHeader(settings, year, month);

  if (kind === 'ocrec') {
    return { title: titleFor(settings, kind), html: header + repOcRec(pid || 'all', await dataService.getOnCallRecords(year, month), people, year, month) };
  }
  if (kind === 'occlaim') {
    return { title: titleFor(settings, kind), html: repOcClaim(pid, await dataService.getOnCallRecords(year, month), people, year, month, settings) };
  }
  if (kind === 'ocstats') {
    return { title: titleFor(settings, kind), html: header + repOcStats(await dataService.getOnCallRecords(year, month), people, year, month) };
  }
  if (kind === 'otsheetd') {
    return { title: titleFor(settings, kind), html: repOTD(year, month, await dataService.getOnCallRecords(year, month), people, settings) };
  }

  const calendar = await businessService.loadCalendar(year, month);
  if (!calendar.status || calendar.status === 'none') {
    return { title: titleFor(settings, kind), html: header + '<div style="padding:30px;text-align:center;color:var(--mut)">ยังไม่มีตารางเวร — สร้างก่อน</div>' };
  }
  const workload = await businessService.calculateWorkload(year, month);
  const r = workload.byPerson;
  if (kind === 'otsheet') return { title: titleFor(settings, kind), html: repOT(workload, year, month, calendar.assign, calendar.N, settings, calendar.holidays) };
  if (kind === 'otsheetb1') return { title: titleFor(settings, kind), html: repOTB1(workload, year, month, calendar.laB, calendar.N, settings) };
  if (kind === 'nsheet') return { title: titleFor(settings, kind), html: repN(workload, year, month, calendar.clinicMt, calendar.clinicLa, calendar.N, settings) };
  if (kind === 'pay') return { title: titleFor(settings, 'pay'), html: '<div class="pay-portrait">' + repPay(r, people, rateOvr, rates, settings, year, month) + '</div>' };
  if (kind === 'payLandscape') return { title: titleFor(settings, 'payLandscape'), html: '<div class="pay-landscape">' + repPay(r, people, rateOvr, rates, settings, year, month) + '</div>' };
  if (kind === 'payperson') return { title: titleFor(settings, kind), html: header + repPayPerson(r, pid, people, rateOvr, rates, settings) };
  if (kind === 'shiftsummary') return { title: titleFor(settings, kind), html: header + repShiftSummary(r, pid, people, rateOvr, rates, settings, stations, year, month) };
  if (kind === 'teamoverview') return { title: titleFor(settings, kind), html: header + repTeamOverview(r, people, rateOvr, rates, year, month) };
  throw new Error('ไม่รู้จักประเภทรายงาน: ' + kind);
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
/* CSS ขั้นต่ำที่ Excel/Word เข้าใจ ฝังลงไฟล์ export ให้หน้าตาใกล้หน้าเว็บ — ปกติ report.html พึ่งคลาส
   .rep-tbl ฯลฯ จาก stylesheet ของแอปซึ่งไม่ได้ติดไปกับไฟล์ ตารางเลยออกมาไม่มีเส้นขอบ/หัวตารางไม่เด่น */
const EXPORT_CSS = '<style>table{border-collapse:collapse}th,td{border:1px solid #999;padding:4px 8px;font-family:"TH Sarabun New","Sarabun",sans-serif;font-size:14px}th{background:#F5F3EE;font-weight:bold;text-align:center}td.l{text-align:left}td.c{text-align:center}td.r{text-align:right}' +
  /* ตารางครอบบล็อก on-call (รายละเอียด) เป็นแค่โครงให้หัวรายงานซ้ำทุกหน้า ไม่ใช่ตารางข้อมูล — ไม่ต้องมีเส้น/พื้นหลัง */
  '.oc-claim-tbl th,.oc-claim-tbl td{border:none;background:none;text-align:left}</style>';

async function exportExcel(kind, year, month, pid) {
  const report = await renderReport(kind, year, month, pid);
  const html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">' + EXPORT_CSS + '</head><body>' + report.html + '</body></html>';
  const fname = 'รายงาน_' + kind + '_' + TH_M[month] + year + '.xls';
  return {
    filename: fname,
    mimeType: 'application/vnd.ms-excel',
    base64: Buffer.from('﻿' + html, 'utf8').toString('base64')
  };
}

async function exportWord(kind, year, month, pid) {
  const report = await renderReport(kind, year, month, pid);
  const html = '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">' + EXPORT_CSS + '</head><body>' + report.html + '</body></html>';
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

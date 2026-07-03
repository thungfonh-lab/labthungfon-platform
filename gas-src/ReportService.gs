/**
 * ReportService.gs — ported 1:1 from renderRep()/repOT()/repN()/repPay()/
 * repPayPerson()/repShiftSummary()/repTeamOverview()/repOcRec()/sigRow()/
 * bahtText()/exportWord()/exportExcel() (lines ~2694-3151 of source file).
 * Server now returns HTML strings; frontend renders them into #repBody
 * exactly like the original did, and triggers the same Blob-download pattern.
 */

var TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
var TH_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
var SHIFT_DEFS = {
  ch: { name: 'เวรเช้า', short: 'ช', color: '#0a4f47', bg: '#d9ebe8' },
  b: { name: 'เวรบ่าย 16-00', short: 'บ', color: '#2f5fa0', bg: '#e7eef8' },
  b1: { name: 'บ1 เวรเสริมบ่าย 16-20', short: 'บ1', color: '#7a4fa0', bg: '#efe7f7' },
  n: { name: 'เวรคลินิกนอกเวลา 07-08', short: 'น', color: '#6b4e16', bg: '#ede0c4' },
  d: { name: 'เวรดึก On call (00-08)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
  d0: { name: 'เวรดึก On call (00.00-04.00)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
  d1: { name: 'เวรดึก On call (04.00-08.00)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' }
};

var ReportService = (function () {

  function money_(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }); }

  /** Ported from bahtText() (lines 2695-2700). */
  function bahtText_(n) {
    n = Math.round(n);
    if (n === 0) return 'ศูนย์บาทถ้วน';
    var tn = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
    var tp = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
    function g(x) {
      var s = '', st = String(x), L = st.length;
      for (var i = 0; i < L; i++) {
        var dv = +st[i], pos = L - i - 1;
        if (dv === 0) continue;
        if (pos === 1 && dv === 1) s += 'สิบ';
        else if (pos === 1 && dv === 2) s += 'ยี่สิบ';
        else if (pos === 0 && dv === 1 && L > 1) s += 'เอ็ด';
        else s += tn[dv] + tp[pos];
      }
      return s;
    }
    var s = '', m = Math.floor(n / 1e6), rem = n % 1e6;
    if (m) s += g(m) + 'ล้าน';
    if (rem) s += g(rem);
    return s + 'บาทถ้วน';
  }

  function fullN_(p) { return p ? (p.pfx || '') + p.name : ''; }
  function roleOf_(p) { return p.role === 'LA' ? 'LA' : 'MT'; }

  function sigRow_(settings) {
    function block_(name, title) {
      return '<div class="sig"><div>(ลงชื่อ)..................................................</div>' +
        '<div style="margin-top:10px;">(' + name + ')</div><div style="margin-top:6px;">' + title + '</div></div>';
    }
    /* ผู้ลงนามคนที่ 2 ของใบเบิกเงินรวม = ผู้จ่ายเงิน (ตั้งค่า > ผู้ลงนาม) แทนผู้อำนวยการ ตามฟีดแบ็ก */
    return '<div class="sig-row">' + block_(settings.signH, settings.signHT) + block_(settings.signPay, settings.signPayT || 'ผู้จ่ายเงิน') + '</div>';
  }

  function dStr_(d, year, month) {
    return d + ' ' + TH_M[month] + ' ' + year;
  }

  function reportHeader_(settings, year, month) {
    return '<div class="dtitle" id="repTit"></div><div class="dline">' +
      [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ') + '</div>' +
      '<div class="dline">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</div>';
  }

  function titleFor_(settings, kind) { return ((settings.reportTitles || {})[kind]) || REPORT_TITLES[kind] || ''; }

  /** บรรทัดหัวรายงาน ฝังไว้ใน <thead> ของตารางเอง (ไม่ใช่ div แยกนอกตาราง) เพื่อให้เบราว์เซอร์พิมพ์
   *  หัวนี้ซ้ำในหน้าที่ 2 โดยอัตโนมัติเมื่อตารางยาวเกิน 1 แผ่น (display:table-header-group) */
  function reportHeaderRows_(settings, year, month, colspan) {
    var orgLine = [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ');
    return '<tr class="rt-head-row"><th colspan="' + colspan + '" class="dtitle" id="repTit"></th></tr>' +
      (orgLine ? '<tr class="rt-head-row"><th colspan="' + colspan + '" class="dline">' + orgLine + '</th></tr>' : '') +
      '<tr class="rt-head-row"><th colspan="' + colspan + '" class="dline">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</th></tr>';
  }

  var OT_TYPE_LABEL_ = { ch: 'นอกเวลาเช้า', b: 'นอกเวลาบ่าย' };
  /* ตัดคอลัมน์ "หมายเหตุ" ออกตามฟีดแบ็ก — พื้นที่ที่ว่างยกให้ช่องลายมือชื่อ (.sig-col) แทน (ดู .rep-tbl-sig .sig-col ใน style.html) */
  var SIG_HEAD_ROW_ = '<tr><th>วัน เดือน ปี</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>ประเภทเวร</th><th>เวลามา</th><th class="sig-col">ลายมือชื่อ</th><th>เวลากลับ</th><th class="sig-col">ลายมือชื่อ</th></tr>';
  /* table-layout:fixed อ่านความกว้างคอลัมน์จากแถวแรกของตารางเท่านั้น (CSS spec) — แถวแรกในที่นี้คือ
     แถวหัวรายงาน (colspan=8, ไม่มี width ระบุ) ทำให้ทุกคอลัมน์ถูกหารเท่ากันโดยไม่สนใจ % ที่ตั้งไว้ใน CSS
     ต้องระบุความกว้างผ่าน <colgroup><col> แทน ซึ่งมีผลเหนือกว่าทุกแถวเสมอ (% ต้องตรงกับ .rep-tbl-sig th:nth-child ใน style.html) */

  /** Ported from repOT() (2735-2744). */
  function repOT_(workload, year, month, scheduleAssign, N, settings) {
    var rows = [];
    for (var d = 1; d <= N; d++) {
      var a = scheduleAssign[d];
      if (!a) continue;
      if (BusinessService.isOff_(year, month, d, [])) (a.ch || []).forEach(function (pid) { rows.push([d, pid, 'ch', '08.00', '16.00']); });
      (a.b || []).forEach(function (pid) { rows.push([d, pid, 'b', '16.00', '00.00']); });
    }
    var h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows_(settings, year, month, 8) + SIG_HEAD_ROW_ + '</thead><tbody>';
    rows.forEach(function (row) {
      var p = workload.people.filter(function (x) { return x.id === row[1]; })[0];
      if (!p) return;
      h += '<tr><td class="c">' + dStr_(row[0], year, month) + '</td><td class="l">' + fullN_(p) + '</td><td class="c">' + p.title + '</td>' +
        '<td class="c">' + OT_TYPE_LABEL_[row[2]] + '</td><td class="c">' + row[3] + '</td><td class="sig-col"></td><td class="c">' + row[4] + '</td><td class="sig-col"></td></tr>';
    });
    return h + '</tbody></table>';
  }

  /** OT timesheet สำหรับเวร บ1 เวรเสริมบ่าย — รูปแบบจัดวางเดียวกับ repOT_ (otsheet) ทุกอย่าง
   *  ต่างกันแค่ดึงข้อมูลจาก calendar.laB แทน assign.ch/assign.b */
  function repOTB1_(workload, year, month, laB, N, settings) {
    var rows = [];
    for (var d = 1; d <= N; d++) {
      (laB[d] || []).forEach(function (pid) { rows.push([d, pid, 'b1', '16.00', '20.00']); });
    }
    var h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows_(settings, year, month, 8) + SIG_HEAD_ROW_ + '</thead><tbody>';
    rows.forEach(function (row) {
      var p = workload.people.filter(function (x) { return x.id === row[1]; })[0];
      if (!p) return;
      h += '<tr><td class="c">' + dStr_(row[0], year, month) + '</td><td class="l">' + fullN_(p) + '</td><td class="c">' + p.title + '</td>' +
        '<td class="c">นอกเวลาเสริมบ่าย</td><td class="c">' + row[3] + '</td><td class="sig-col"></td><td class="c">' + row[4] + '</td><td class="sig-col"></td></tr>';
    });
    return h + '</tbody></table>';
  }

  /** OT timesheet สำหรับเวรดึก (on call) — รูปแบบจัดวางเดียวกับ repOT_ (otsheet) ทุกอย่าง
   *  แยกเป็น 2 ช่วงเวลาตามฟีดแบ็ก: ด (00.00-04.00) และ ด (04.00-08.00) — ดึงจากบันทึก on call จริง
   *  (ไม่ใช่ตารางเวร) นับ 1 แถวต่อคน/วัน/ช่วงเวลา ไม่ซ้ำแม้มีหลาย LAB ในช่วงเดียวกัน */
  function repOTD_(year, month, oncall, people, settings) {
    function ocDayOf(o) {
      var dt = new Date(o.date);
      return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
    }
    var PERIOD_TIME_ = { d0: ['00.00', '04.00'], d1: ['04.00', '08.00'] };
    var PERIOD_LABEL_ = { d0: 'เวรดึก On call', d1: 'เวรดึก On call' };
    var seen = {}, rows = [];
    oncall.forEach(function (o) {
      var d = ocDayOf(o);
      if (!d) return;
      var period = BusinessService.onCallPeriod_(o.time);
      var key = o.pid + '_' + d + '_' + period;
      if (seen[key]) return;
      seen[key] = true;
      rows.push([d, o.pid, period]);
    });
    rows.sort(function (a, b) { return a[0] - b[0]; });
    var h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows_(settings, year, month, 8) + SIG_HEAD_ROW_ + '</thead><tbody>';
    rows.forEach(function (row) {
      var p = people.filter(function (x) { return x.id === row[1]; })[0];
      if (!p) return;
      var t = PERIOD_TIME_[row[2]];
      h += '<tr><td class="c">' + dStr_(row[0], year, month) + '</td><td class="l">' + fullN_(p) + '</td><td class="c">' + p.title + '</td>' +
        '<td class="c">' + PERIOD_LABEL_[row[2]] + '</td><td class="c">' + t[0] + '</td><td class="sig-col"></td><td class="c">' + t[1] + '</td><td class="sig-col"></td></tr>';
    });
    return h + '</tbody></table>';
  }

  /** Ported from repN() (2745-2751). */
  function repN_(workload, year, month, clinicMt, clinicLa, N, settings) {
    var rows = [];
    for (var d = 1; d <= N; d++) {
      (clinicMt[d] || []).forEach(function (pid) { rows.push([d, pid]); });
      (clinicLa[d] || []).forEach(function (pid) { rows.push([d, pid]); });
    }
    var h = '<table class="rep-tbl rep-tbl-sig"><thead>' + reportHeaderRows_(settings, year, month, 8) + SIG_HEAD_ROW_ + '</thead><tbody>';
    rows.forEach(function (row) {
      var p = workload.people.filter(function (x) { return x.id === row[1]; })[0];
      if (!p) return;
      h += '<tr><td class="c">' + dStr_(row[0], year, month) + '</td><td class="l">' + fullN_(p) + '</td><td class="c">' + p.title + '</td>' +
        '<td class="c">คลินิกนอกเวลา</td><td class="c">07.00</td><td class="sig-col"></td><td class="c">08.00</td><td class="sig-col"></td></tr>';
    });
    return h + '</tbody></table>';
  }

  /** Ported from pg() helper (2752-2757). คอลัมน์สุดท้ายเป็นช่องเซ็นชื่อผู้รับเงินเปล่าๆ ให้กรอกด้วยมือ
   *  ต่อจาก "จำนวนเงิน" ตามตัวอย่างฟอร์มที่หน่วยงานแนบมา. */
  function payGroup_(title, rows, shift, rateOvr, rates) {
    var h = '<tr class="grp"><td colspan="8">' + title + '</td></tr>', i = 0, sub = 0;
    rows.forEach(function (item) {
      if (!item.days || !item.days.length) return;
      i++;
      var amt = item.days.reduce(function (s, d) { return s + BusinessService.rateFor_(rateOvr, rates, item.p, shift, d); }, 0);
      sub += amt;
      var rate = BusinessService.rateFor_(rateOvr, rates, item.p, shift, item.days[0]);
      h += '<tr><td class="c">' + i + '</td><td class="l">' + fullN_(item.p) + '</td><td class="l">' + item.p.title + '</td><td class="c">' + rate + '</td>' +
        '<td class="l" style="white-space:normal">' + item.days.join(', ') + '</td><td class="c">' + item.days.length + '</td><td class="r">' + money_(amt) + '</td><td></td></tr>';
    });
    return { h: h, sub: sub };
  }

  /** เวร ด (on call) มี 2 อัตราตามช่วงเวลา (d0=00.00-04.00, d1=04.00-08.00) — แสดงเป็น
   *  แถวเดียวต่อคนเหมือนเวรอื่น (รวมวันที่ของทั้ง 2 ช่วง) แต่คิดเงินแยกตามช่วงที่เกิดขึ้นจริง. */
  function payGroupOnCall_(title, items, rateOvr, rates) {
    var h = '<tr class="grp"><td colspan="8">' + title + '</td></tr>', i = 0, sub = 0;
    items.forEach(function (item) {
      if (!item.days || !item.days.length) return;
      i++;
      var amt = (item.d0 || []).reduce(function (s, d) { return s + BusinessService.rateFor_(rateOvr, rates, item.p, 'd0', d); }, 0) +
        (item.d1 || []).reduce(function (s, d) { return s + BusinessService.rateFor_(rateOvr, rates, item.p, 'd1', d); }, 0);
      sub += amt;
      var rate0 = BusinessService.rateFor_(rateOvr, rates, item.p, 'd0', 1);
      var rate1 = BusinessService.rateFor_(rateOvr, rates, item.p, 'd1', 1);
      var rateLbl = rate0 === rate1 ? String(rate0) : (rate0 + '/' + rate1);
      h += '<tr><td class="c">' + i + '</td><td class="l">' + fullN_(item.p) + '</td><td class="l">' + item.p.title + '</td><td class="c">' + rateLbl + '</td>' +
        '<td class="l" style="white-space:normal">' + item.days.join(', ') + '</td><td class="c">' + item.days.length + '</td><td class="r">' + money_(amt) + '</td><td></td></tr>';
    });
    return { h: h, sub: sub };
  }

  var PAY_SECTION_LABEL_ = {
    n: 'เวรคลินิกนอกเวลา (07.00-08.00 น.)',
    ch: 'เวรเช้า (08.00-16.00 น.)',
    b: 'เวรบ่าย (16.00-00.00 น.)',
    b1: 'เวรเสริมบ่าย (16.00-20.00 น.)',
    d: 'เวรดึก (00.00-08.00 น.)'
  };

  /** หัวรายงานเฉพาะใบเบิกเงินรวม — ชื่อรายงาน (ตัวหนา) อยู่บรรทัดเดียวกับชื่อหน่วยงาน/เดือน
   *  (ต่างจาก reportHeader_ ทั่วไปที่วางซ้อนกึ่งกลาง) ใช้ซ้ำทั้งหน้า 1 และหน้า 2. */
  function payPageHeader_(title, settings, year, month) {
    return '<div style="text-align:center;margin-bottom:12px;line-height:1.55;">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:3px;">' + title + '</div>' +
      '<div style="font-size:12.5px;">' + [settings.org, settings.hosp, settings.prov].filter(Boolean).join(' ') + '</div>' +
      '<div style="font-size:12.5px;">ประจำเดือน ' + TH_M[month] + ' พ.ศ.' + year + '</div></div>';
  }

  /** Ported from repPay() (2758-2773). ตามฟีดแบ็กล่าสุด: รวมทุกประเภทเวร (ช/บ/ด/น/บ1)
   *  เป็นชุดเดียว — หัวรายงาน/ยอดรวม/ลงนามปรากฏครั้งเดียวที่ท้ายเอกสาร (ไม่แยกหน้า/ไม่ซ้ำหัว). */
  function repPay_(r, people, rateOvr, rates, settings, year, month) {
    var MT = people.filter(function (p) { return p.role !== 'LA'; });
    var LA = people.filter(function (p) { return p.role === 'LA'; });
    var title = titleFor_(settings, 'pay');
    var theadRow = '<thead><tr><th>ลำดับ</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th>อัตรา</th><th>วันที่ปฏิบัติงาน</th><th>รวม(วัน)</th><th>จำนวนเงิน</th><th>ลายมือชื่อ<br>ผู้รับเงิน</th></tr></thead>';
    var sig = sigRow_(settings);

    var tot = 0;
    var h = payPageHeader_(title, settings, year, month) + '<div class="rep-tbl-wrap"><table class="rep-tbl">' + theadRow + '<tbody>';
    var g = payGroup_('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL_.ch, MT.concat(LA).map(function (p) { return { p: p, days: (r[p.id] || {}).ch }; }), 'ch', rateOvr, rates);
    h += g.h; tot += g.sub;
    g = payGroup_('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL_.b, MT.map(function (p) { return { p: p, days: (r[p.id] || {}).b }; }), 'b', rateOvr, rates);
    h += g.h; tot += g.sub;
    g = payGroupOnCall_('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL_.d, MT.map(function (p) { var rr = r[p.id] || {}; return { p: p, days: rr.d, d0: rr.d0, d1: rr.d1 }; }), rateOvr, rates);
    h += g.h; tot += g.sub;
    g = payGroup_('วันที่ปฏิบัติงาน ' + PAY_SECTION_LABEL_.b1, LA.map(function (p) { return { p: p, days: (r[p.id] || {}).b1 }; }), 'b1', rateOvr, rates);
    h += g.h; tot += g.sub;
    h += '<tr class="tot"><td colspan="6" class="r">รวมจ่ายทั้งสิ้น</td><td class="r">' + money_(tot) + '</td><td></td></tr></tbody></table></div>';
    h += '<div style="margin-top:7px;font-size:12.5px">รวมเป็นเงิน (ตัวอักษร) <b>' + bahtText_(tot) + '</b></div>';
    h += '<div style="font-size:12px;margin-top:4px">หัวหน้าผู้ควบคุมขอรับรองว่าผู้รับค่าตอบแทนได้ปฏิบัติงานจริง</div>' + sig;

    return h;
  }

  /** Ported from repPayPerson() (2774-2790). */
  function repPayPerson_(r, pid, people, rateOvr, rates, settings) {
    var p = people.filter(function (x) { return x.id === pid; })[0];
    var d = r[pid];
    if (!p || !d) return '<div style="padding:20px;color:var(--mut)">ไม่พบข้อมูล</div>';
    var isLA = roleOf_(p) === 'LA';
    var rows = isLA ? [['ch', d.ch], ['b1', d.b1], ['n', d.n]] : [['ch', d.ch], ['b', d.b], ['n', d.n], ['d0', d.d0], ['d1', d.d1]];
    var tot = 0;
    var h = '<div style="margin:8px 0;font-size:13.5px">ชื่อ <b>' + fullN_(p) + '</b> · ตำแหน่ง ' + p.title + '</div>';
    h += '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>ประเภทเวร</th><th>อัตรา</th><th>วันที่</th><th>จำนวน</th><th>รวมเงิน</th></tr></thead><tbody>';
    rows.forEach(function (pair) {
      var sh = pair[0], days = pair[1];
      if (!days) return;
      var sDef = SHIFT_DEFS[sh];
      var rate = days.length ? BusinessService.rateFor_(rateOvr, rates, p, sh, days[0]) : BusinessService.rateFor_(rateOvr, rates, p, sh);
      var amt = days.reduce(function (s, dy) { return s + BusinessService.rateFor_(rateOvr, rates, p, sh, dy); }, 0);
      tot += amt;
      h += '<tr><td class="l">' + sDef.name + '</td><td class="c">' + rate + '</td><td class="l" style="white-space:normal">' + (days.join(', ') || '—') + '</td><td class="c">' + days.length + '</td><td class="r">' + money_(amt) + '</td></tr>';
    });
    h += '<tr class="tot"><td colspan="4" class="r">รวมทั้งสิ้น</td><td class="r">' + money_(tot) + '</td></tr></tbody></table></div>';
    h += '<div style="font-size:12.5px;margin-top:5px">(ตัวอักษร) <b>' + bahtText_(tot) + '</b></div>';
    h += '<div class="sig-row"><div class="sig">(ลงชื่อ)..................................................<br>(' + fullN_(p) + ')<br>ผู้รับเงิน</div>' +
      '<div class="sig">(ลงชื่อ)..................................................<br>(' + settings.signH + ')<br>' + settings.signHT + '</div></div>';
    return h;
  }

  /** Ported from repShiftSummary() (2793-2833). */
  function repShiftSummary_(r, pid, people, rateOvr, rates, settings, stations, year, month) {
    var p = people.filter(function (x) { return x.id === pid; })[0];
    var d = r[pid];
    if (!p || !d) return '<div style="padding:20px;color:var(--mut)">ไม่พบข้อมูล</div>';
    var isLA = roleOf_(p) === 'LA';
    var shiftIds = isLA ? ['ch', 'b1', 'n'] : ['ch', 'b', 'n', 'd'];
    var totalAmt = 0, totalDays = 0;
    var cards = shiftIds.map(function (id) {
      var sd = SHIFT_DEFS[id];
      var days = d[id] || [];
      var amt, rate;
      if (id === 'd') {
        amt = (d.d0 || []).reduce(function (s, dy) { return s + BusinessService.rateFor_(rateOvr, rates, p, 'd0', dy); }, 0) +
          (d.d1 || []).reduce(function (s, dy) { return s + BusinessService.rateFor_(rateOvr, rates, p, 'd1', dy); }, 0);
        var r0 = BusinessService.rateFor_(rateOvr, rates, p, 'd0', 1), r1 = BusinessService.rateFor_(rateOvr, rates, p, 'd1', 1);
        rate = r0 === r1 ? r0 : (r0 + '/' + r1 + ' ตามช่วงเวลา');
      } else {
        amt = days.reduce(function (s, dy) { return s + BusinessService.rateFor_(rateOvr, rates, p, id, dy); }, 0);
        rate = days.length ? BusinessService.rateFor_(rateOvr, rates, p, id, days[0]) : BusinessService.rateFor_(rateOvr, rates, p, id);
      }
      totalAmt += amt; totalDays += days.length;
      var daysStr = days.length ? days.join(', ') : 'ยังไม่มี';
      return '<div style="border:1px solid ' + sd.color + '22;border-radius:10px;padding:12px 14px;background:' + sd.bg + '22;margin-bottom:10px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
        '<span style="background:' + sd.bg + ';color:' + sd.color + ';padding:2px 10px;border-radius:6px;font-weight:700;font-size:13px">' + sd.short + '</span>' +
        '<span style="font-weight:600;font-size:13.5px">' + sd.name + '</span>' +
        '<span style="margin-left:auto;font-size:22px;font-weight:700;color:' + sd.color + '">' + days.length + '<span style="font-size:12px;font-weight:400;margin-left:2px">วัน</span></span></div>' +
        '<div style="font-size:12px;color:#555;margin-bottom:4px">วันที่: ' + daysStr + '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12.5px"><span>อัตรา ' + rate + ' บาท/วัน</span>' +
        '<span style="font-weight:700;color:' + sd.color + '">' + money_(amt) + ' บาท</span></div></div>';
    }).join('');
    var st = (stations || []).filter(function (s) { return (s.assigned || []).indexOf(p.id) > -1; })[0];
    var h = '<div style="border:2px solid var(--pri);border-radius:12px;padding:16px;margin-bottom:16px;background:var(--pri-vl)">' +
      '<div style="font-size:16px;font-weight:700">' + fullN_(p) + '</div>' +
      '<div style="font-size:12.5px;color:var(--mut);margin-top:2px">' + p.title + ' · ' + (st ? st.name : '—') + ' · เดือน ' + TH_M[month] + ' ' + year + '</div>' +
      '<div style="display:flex;gap:20px;margin-top:10px;flex-wrap:wrap">' +
      '<div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--pri-d)">' + totalDays + '</div><div style="font-size:11px;color:var(--mut)">วันปฏิบัติงานรวม</div></div>' +
      '<div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--acc)">' + money_(totalAmt) + '</div><div style="font-size:11px;color:var(--mut)">ยอดรวม (บาท)</div></div>' +
      '<div style="text-align:center"><div style="font-size:26px;font-weight:700;color:var(--ok)">' + (d.d || []).length + '</div><div style="font-size:11px;color:var(--mut)">คืน On call</div></div></div></div>';
    h += cards;
    h += '<div style="text-align:right;font-size:12.5px;color:var(--mut);margin-top:4px"><b>' + bahtText_(totalAmt) + '</b></div>';
    return h;
  }

  /** Ported from repTeamOverview() (2835-2888), excluding calendar heatmap (kept as separate frontend grid view). */
  function repTeamOverview_(r, people, rateOvr, rates, year, month) {
    var shiftIds = ['ch', 'b', 'b1', 'n', 'd'];
    var h = '<div style="font-size:13.5px;font-weight:600;margin-bottom:10px">ภาพรวมการขึ้นเวร เดือน ' + TH_M[month] + ' ' + year + ' — ทุกคน</div>';
    var totByShift = {}; shiftIds.forEach(function (s) { totByShift[s] = 0; });
    people.forEach(function (p) { shiftIds.forEach(function (s) { totByShift[s] += ((r[p.id] || {})[s] || []).length; }); });
    h += '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px">';
    shiftIds.forEach(function (s) {
      var sl = SHIFT_DEFS[s];
      h += '<div style="background:' + sl.bg + ';color:' + sl.color + ';border-radius:9px;padding:8px 14px;text-align:center;min-width:70px">' +
        '<div style="font-size:20px;font-weight:700">' + totByShift[s] + '</div><div style="font-size:11px">' + sl.short + ' รวม</div></div>';
    });
    h += '</div><div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th>';
    shiftIds.forEach(function (s) {
      var sl = SHIFT_DEFS[s];
      h += '<th><span style="background:' + sl.bg + ';color:' + sl.color + ';padding:1px 6px;border-radius:4px">' + sl.short + '</span></th>';
    });
    h += '<th>รวมวัน</th><th>รวมเงิน</th></tr></thead><tbody>';
    var grandTotal = 0;
    people.forEach(function (p) {
      var isLA = roleOf_(p) === 'LA', rowTotal = 0, rowAmt = 0;
      h += '<tr><td class="l">' + fullN_(p) + '</td><td class="l" style="font-size:11px">' + p.title + '</td>';
      shiftIds.forEach(function (s) {
        var days = (r[p.id] || {})[s] || [];
        var skip = (isLA && (s === 'b' || s === 'd')) || (!isLA && s === 'b1');
        if (skip) { h += '<td style="color:#ccc;text-align:center">—</td>'; return; }
        var rp = r[p.id] || {};
        var amt = s === 'd'
          ? (rp.d0 || []).reduce(function (sum, dy) { return sum + BusinessService.rateFor_(rateOvr, rates, p, 'd0', dy); }, 0) +
            (rp.d1 || []).reduce(function (sum, dy) { return sum + BusinessService.rateFor_(rateOvr, rates, p, 'd1', dy); }, 0)
          : days.reduce(function (sum, dy) { return sum + BusinessService.rateFor_(rateOvr, rates, p, s, dy); }, 0);
        rowTotal += days.length; rowAmt += amt;
        h += '<td style="text-align:center">';
        if (days.length) h += '<div style="font-weight:700">' + days.length + '</div><div style="font-size:10px;color:var(--mut)">' + money_(amt) + '</div>';
        else h += '<span style="color:#ccc">—</span>';
        h += '</td>';
      });
      grandTotal += rowAmt;
      h += '<td style="text-align:center;font-weight:700">' + rowTotal + '</td><td style="text-align:right;font-weight:700">' + money_(rowAmt) + '</td></tr>';
    });
    h += '<tr class="tot"><td colspan="2" class="r">รวมทั้งสิ้น</td>';
    shiftIds.forEach(function (s) { h += '<td class="c">' + totByShift[s] + '</td>'; });
    h += '<td class="c"></td><td class="r">' + money_(grandTotal) + '</td></tr></tbody></table></div>';
    h += '<div style="margin-top:6px;font-size:12px">รวมเป็นเงิน <b>' + bahtText_(grandTotal) + '</b></div>';
    return h;
  }

  /** Ported from repOcRec() (3109-3123). */
  function repOcRec_(pid, oncall, people, year, month, settings) {
    function ocDayOf(o) {
      var dt = new Date(o.date);
      return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
    }
    var list = oncall.filter(function (o) { return ocDayOf(o); });
    if (pid !== 'all') list = list.filter(function (o) { return o.pid === pid; });
    list.sort(function (a, b) {
      var da = ocDayOf(a), db = ocDayOf(b);
      return (da - db) || String(a.pid).localeCompare(String(b.pid));
    });
    var byPer = pid === 'all' ? null : people.filter(function (p) { return p.id === pid; })[0];
    var h = byPer
      ? '<div style="margin:8px 0;font-size:13.5px">เจ้าหน้าที่: <b>' + fullN_(byPer) + '</b> · ตำแหน่ง <b>' + byPer.title + '</b></div>'
      : '<div style="margin:8px 0;font-size:13.5px">บันทึก On Call <b>ทุกคน</b></div>';
    if (!list.length) return h + '<div style="padding:20px;color:var(--mut)">ยังไม่มีข้อมูล On Call</div>';
    h += '<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>วัน เดือน ปี</th><th>เจ้าหน้าที่</th><th>เวลา</th><th>HN</th><th>ชื่อผู้ป่วย</th><th>LAB ที่ตรวจ</th><th>หน่วยงาน</th></tr></thead><tbody>';
    list.forEach(function (o) {
      var d = ocDayOf(o);
      var per = people.filter(function (p) { return p.id === o.pid; })[0];
      h += '<tr><td class="c">' + d + ' ' + TH_M[month] + ' ' + year + '</td><td class="l">' + (per ? fullN_(per) : '?') + '</td>' +
        '<td class="c">' + (o.time || '') + '</td><td class="c">' + (o.hn || '') + '</td><td class="l">' + (o.name || '') + '</td>' +
        '<td class="l" style="white-space:normal;word-break:break-word;max-width:240px">' + (o.labs || []).join(', ') + '</td><td class="c">' + (o.unit || '') + '</td></tr>';
    });
    var nightsSet = {};
    list.forEach(function (o) { nightsSet[o.pid + '_' + ocDayOf(o)] = true; });
    h += '</tbody></table></div><div style="text-align:right;margin-top:5px;font-size:12px">รวม ' + Object.keys(nightsSet).length + ' คืน · ' + list.length + ' ราย</div>';
    return h;
  }

  function periodCheckbox_(on, label) {
    /* vertical-align ใส่ที่กล่อง inline-block ข้างในไม่มีผล เพราะมันเป็น flex item ของ span ครอบ (inline-flex)
       — vertical-align ถูก browser ignore ทั้งหมดสำหรับ flex item ต้องใส่ที่ span ครอบ (ตัวที่เป็น inline box
       จริงในสายตาของบรรทัดข้อความรอบๆ) ถึงจะจัดให้กึ่งกลางบรรทัดเดียวกับตัวอักษรอื่นได้ */
    return '<span style="display:inline-flex;vertical-align:middle;align-items:center;gap:5px;margin-right:14px;' + (on ? 'font-weight:700' : '') + '">' +
      '<span style="display:inline-block;width:15px;height:15px;border:1.5px solid #555;text-align:center;line-height:13px;font-size:12px;flex-shrink:0">' +
      (on ? '✓' : '') + '</span>' + label + '</span>';
  }

  /** แบบบันทึกขอเบิกเงินนอกเวลาราชการ On Call (รายละเอียดผู้ป่วย) — 1 บล็อกต่อ 1 ครั้งที่ on call
   *  ตามฟอร์มที่หน่วยงานแนบมา (วัน/เวลา/ชื่อผู้ป่วย/HN/LAB ที่ตรวจ/หน่วยงานที่ส่งตรวจ ER/IPD) */
  function repOcClaim_(pid, oncall, people, year, month) {
    function ocDayOf(o) {
      var dt = new Date(o.date);
      return (dt.getFullYear() === year - 543 && dt.getMonth() === month) ? dt.getDate() : null;
    }
    var per = people.filter(function (p) { return p.id === pid; })[0];
    if (!per) return '<div style="padding:20px;color:var(--mut)">กรุณาเลือกเจ้าหน้าที่</div>';
    var list = oncall.filter(function (o) { return o.pid === pid && ocDayOf(o); });
    list.sort(function (a, b) { return ocDayOf(a) - ocDayOf(b); });
    var h = '<div style="text-align:center;font-size:15px;margin-bottom:10px">' +
      'ชื่อเจ้าหน้าที่ <b>' + fullN_(per) + '</b> &nbsp; ตำแหน่ง <b>' + per.title + '</b></div>';
    if (!list.length) return h + '<div style="padding:20px;color:var(--mut)">ยังไม่มีข้อมูล On Call</div>';
    list.forEach(function (o) {
      var d = ocDayOf(o);
      var period = BusinessService.onCallPeriod_(o.time);
      h += '<div class="oc-claim-blk" style="border-bottom:1px dashed var(--border);padding:10px 0;font-size:15px;line-height:1.9">' +
        '<div style="margin-bottom:3px">วัน เดือน ปี ' + d + ' ' + TH_M[month] + ' ' + year + ' &nbsp; เวลา <b>' + (o.time || '............') + '</b> น.' +
        ' &nbsp; ' + periodCheckbox_(period === 'd0', '00.00-04.00') + periodCheckbox_(period === 'd1', '04.01-08.00') + '</div>' +
        '<div style="margin-bottom:3px">ชื่อผู้ป่วย ' + (o.name || '......................................') + ' &nbsp; HN ' + (o.hn || '............') + '</div>' +
        '<div style="margin-bottom:3px">ส่วนที่ตรวจ/LAB ที่ตรวจ ' + ((o.labs || []).join(', ') || '......................................') + '</div>' +
        '<div>หน่วยงานที่ส่งตรวจ ' + (o.unit || 'ER/IPD') + '</div></div>';
    });
    return h;
  }

  var REPORT_TITLES = {
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

  /** Ported from renderRep() dispatcher (2703-2731). */
  function renderReport(kind, year, month, pid) {
    var settings = DataService.getSettings();
    var people = DataService.getPeople();
    var rateOvr = DataService.getRateOverrides();
    var rates = DataService.getRates();
    var stations = BusinessService.rotateStationsForMonth_(DataService.getStations(), year, month);
    var header = reportHeader_(settings, year, month);

    if (kind === 'ocrec') {
      return { title: titleFor_(settings, kind), html: header + repOcRec_(pid || 'all', DataService.getOnCallRecords(year, month), people, year, month, settings) };
    }
    if (kind === 'occlaim') {
      return { title: titleFor_(settings, kind), html: header + repOcClaim_(pid, DataService.getOnCallRecords(year, month), people, year, month) };
    }
    if (kind === 'otsheetd') {
      return { title: titleFor_(settings, kind), html: repOTD_(year, month, DataService.getOnCallRecords(year, month), people, settings) };
    }

    var calendar = BusinessService.loadCalendar(year, month);
    if (!calendar.status || calendar.status === 'none') {
      return { title: titleFor_(settings, kind), html: header + '<div style="padding:30px;text-align:center;color:var(--mut)">ยังไม่มีตารางเวร — สร้างก่อน</div>' };
    }
    var workload = BusinessService.calculateWorkload(year, month);
    var r = workload.byPerson;
    if (kind === 'otsheet') return { title: titleFor_(settings, kind), html: repOT_(workload, year, month, calendar.assign, calendar.N, settings) };
    if (kind === 'otsheetb1') return { title: titleFor_(settings, kind), html: repOTB1_(workload, year, month, calendar.laB, calendar.N, settings) };
    if (kind === 'nsheet') return { title: titleFor_(settings, kind), html: repN_(workload, year, month, calendar.clinicMt, calendar.clinicLa, calendar.N, settings) };
    if (kind === 'pay') return { title: titleFor_(settings, 'pay'), html: '<div class="pay-portrait">' + repPay_(r, people, rateOvr, rates, settings, year, month) + '</div>' };
    if (kind === 'payLandscape') return { title: titleFor_(settings, 'payLandscape'), html: '<div class="pay-landscape">' + repPay_(r, people, rateOvr, rates, settings, year, month) + '</div>' };
    if (kind === 'payperson') return { title: titleFor_(settings, kind), html: header + repPayPerson_(r, pid, people, rateOvr, rates, settings) };
    if (kind === 'shiftsummary') return { title: titleFor_(settings, kind), html: header + repShiftSummary_(r, pid, people, rateOvr, rates, settings, stations, year, month) };
    if (kind === 'teamoverview') return { title: titleFor_(settings, kind), html: header + repTeamOverview_(r, people, rateOvr, rates, year, month) };
    throw new Error('ไม่รู้จักประเภทรายงาน: ' + kind);
  }

  /**
   * exportExcel(kind, year, month, pid) — ported from exportExcel() (line 3150).
   * Original built an .xls-mime HTML blob client-side from #repBody.innerHTML;
   * here the server renders the same HTML and returns it base64-encoded so the
   * frontend can recreate the identical Blob-download (dl()) behavior.
   */
  function exportExcel(kind, year, month, pid) {
    var report = renderReport(kind, year, month, pid);
    var html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>' + report.html + '</body></html>';
    var settings = DataService.getSettings();
    var fname = 'รายงาน_' + kind + '_' + TH_M[month] + year + '.xls';
    return {
      filename: fname,
      mimeType: 'application/vnd.ms-excel',
      base64: Utilities.base64Encode('﻿' + html, Utilities.Charset.UTF_8)
    };
  }

  function exportWord(kind, year, month, pid) {
    var report = renderReport(kind, year, month, pid);
    var html = '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>' + report.html + '</body></html>';
    var fname = 'รายงาน_' + kind + '_' + TH_M[month] + year + '.doc';
    return {
      filename: fname,
      mimeType: 'application/msword',
      base64: Utilities.base64Encode('﻿' + html, Utilities.Charset.UTF_8)
    };
  }

  /* ---------------- New reports (additive, do not replace originals) ---------------- */

  function monthlySummary(year, month) {
    var calendar = BusinessService.loadCalendar(year, month);
    var workload = BusinessService.calculateWorkload(year, month);
    return {
      year: year, month: month, N: calendar.N, status: calendar.status,
      holidays: calendar.holidays.length, ruleViolations: calendar.ruleViolations.length,
      totalMoney: Object.keys(workload.money).reduce(function (s, k) { return s + workload.money[k]; }, 0)
    };
  }

  function workloadAnalysis(year, month) {
    var workload = BusinessService.calculateWorkload(year, month);
    return workload.people.map(function (p) {
      var d = workload.byPerson[p.id];
      var totalDays = ['ch', 'b', 'b1', 'n', 'd'].reduce(function (s, k) { return s + (d[k] || []).length; }, 0);
      return { pid: p.id, name: fullN_(p), role: p.role, totalDays: totalDays, money: workload.money[p.id] };
    });
  }

  function ruleViolationReport(year, month) {
    return DataService.getRuleViolations(year, month);
  }

  return {
    renderReport: renderReport,
    exportExcel: exportExcel,
    exportWord: exportWord,
    monthlySummary: monthlySummary,
    workloadAnalysis: workloadAnalysis,
    ruleViolationReport: ruleViolationReport
  };
})();

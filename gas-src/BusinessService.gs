/**
 * BusinessService.gs — CORE business logic, ported 1:1 from
 * labthungfon-platform-v4_43.html generate()/collectPay()/sendDraft()/publish()
 * (lines ~1660-1690, ~2058-2429, ~2634-2692 of the source file).
 *
 * RULE: every constraint, scoring order, and tolerance below must match the
 * original exactly. Only the I/O (Sheets instead of localStorage/DOM) changed.
 * Function names generateSchedule(), saveSchedule(), exportExcel(),
 * loadCalendar(), calculateWorkload() are kept as required.
 */

var BusinessService = (function () {

  /* ---------------- date helpers (ported from $ helpers in original) ---------------- */

  function ceY_(year) { return year - 543; } // Buddhist → CE
  function dim_(year, month) { return new Date(ceY_(year), month + 1, 0).getDate(); } // month is 0-indexed like original
  function dow_(year, month, d) { return new Date(ceY_(year), month, d).getDay(); }
  function isWknd_(year, month, d) { var w = dow_(year, month, d); return w === 0 || w === 6; }
  function nthTue_(year, month, d) {
    if (dow_(year, month, d) !== 2) return false;
    var c = 0;
    for (var x = 1; x <= d; x++) if (dow_(year, month, x) === 2) c++;
    return c === 3;
  }
  function isClin_(year, month, d, holidays) {
    if (isHol_(d, holidays)) return false;
    var w = dow_(year, month, d);
    return w === 3 || w === 4 || w === 5 || nthTue_(year, month, d);
  }
  function isHol_(d, holidays) { return holidays.some(function (h) { return h.day === d; }); }
  function isOff_(year, month, d, holidays) { return isWknd_(year, month, d) || isHol_(d, holidays); }

  function roleOf_(p) { return p.role === 'LA' ? 'LA' : 'MT'; }
  function dutyOK_(p) { return p.active && (p.role === 'MT' || p.role === 'HT'); }

  function byId_(people, pid) { return people.filter(function (p) { return p.id === pid; })[0]; }

  /** Ported from avOff()/avNo() in original (lines 2058-2059). */
  function avOff_(availability, pid, day, month, year) {
    return (availability[pid] || []).some(function (a) {
      return a.day === day && a.mon === month && a.yr === year && a.type === 'leave';
    });
  }
  function avNo_(availability, pid, day, month, year, type) {
    return (availability[pid] || []).some(function (a) {
      return a.day === day && a.mon === month && a.yr === year && (a.type === 'leave' || a.type === type);
    });
  }

  /** เวร ด (on call) แบ่งเป็น 2 ช่วงอัตราตามเวลาที่ key เข้ามา: 00.00-03.59 = d0, 04.00-07.59 = d1. */
  function onCallPeriod_(timeStr) {
    var h = timeStr ? parseInt(String(timeStr).split(':')[0], 10) : NaN;
    if (isNaN(h)) return 'd1';
    return h < 4 ? 'd0' : 'd1';
  }

  /** Ported from rateFor() (lines 1676-1685). */
  function rateFor_(rateOvr, rates, p, shift, day) {
    var best = null, score = -1;
    rateOvr.forEach(function (o) {
      if (o.shift !== shift) return;
      if (o.pid && o.pid !== p.id) return;
      if (o.from && day && (day < o.from || (o.to && day > o.to))) return;
      var s = (o.pid ? 2 : 0) + (o.from ? 1 : 0);
      if (s > score) { score = s; best = o.amount; }
    });
    if (best !== null) return best;
    var roleRates = rates[roleOf_(p)] || {};
    return roleRates[shift] || 0;
  }

  /* ============================================================
   * generateSchedule(year, month) — ported from generate() (2060-2429)
   * month is 0-indexed (matches original DATA.month convention)
   * ============================================================ */
  function generateSchedule(year, month) {
    var people = DataService.getPeople();
    var settings = DataService.getSettings();
    var holidays = DataService.getHolidays(year, month);
    var availabilityRows = DataService.getAvailability(year, month);
    var availability = {};
    availabilityRows.forEach(function (a) {
      availability[a.pid] = availability[a.pid] || [];
      availability[a.pid].push(a);
    });
    var rateOvr = DataService.getRateOverrides();
    var rates = DataService.getRates();

    var N = dim_(year, month);
    var assign = {}, clinicMt = {}, clinicLa = {}, laB = {};

    /* เลือกได้ว่า MT/HT คนไหนขึ้นเวร ช/บ/ด และ น คลินิก ในเดือนนี้ แยกรายการกัน (ดูตั้งค่า > กฎการจัดเวร > เจ้าหน้าที่ขึ้นเวรเดือนนี้)
       ถ้ายังไม่ตั้ง roster ไว้สำหรับเดือนนี้ ใช้ทุกคนตาม dutyOK_ เหมือนเดิม (ไม่กระทบเดือนที่ผ่านมา) */
    var dutyRoster = DataService.getDutyRoster(year, month);
    var includedIds = dutyRoster && dutyRoster.included;
    var includedClinicIds = dutyRoster && dutyRoster.includedClinic;
    var pool = people.filter(function (p) {
      if (!dutyOK_(p)) return false;
      return !includedIds || includedIds.indexOf(p.id) > -1;
    });
    if (!pool.length) throw new Error('ไม่มี MT/HT ขึ้นเวรได้');

    var cnt = {}; pool.forEach(function (p) { cnt[p.id] = 0; });
    var maxC = +settings.maxC || 4;
    var lastDuty = null;

    function consec(pid, day) {
      var n = 1, x = day - 1;
      while (x >= 1 && assign[x] && assign[x].b === pid) { n++; x--; }
      return n;
    }
    function canDuty(pid, days) {
      return days.every(function (d) {
        return !avOff_(availability, pid, d, month, year) &&
          !avNo_(availability, pid, d, month, year, 'noB') &&
          !avNo_(availability, pid, d, month, year, 'noD');
      });
    }
    function isOff(d) { return isOff_(year, month, d, holidays); }
    function isHolD(d) { return isHol_(d, holidays); }

    /* ══ โหลด trailInfo เดือนก่อน ══ */
    var prevM = month - 1, prevY = year;
    if (prevM < 0) { prevM = 11; prevY--; }
    var prevTrail = DataService.getTrailInfo(prevY, prevM);

    /* ══ lastWeekHolder: pid ที่ได้รับ Fri-Sun block ล่าสุด (ป้องกัน ชบด ติดกัน 2 อาทิตย์) ══ */
    var lastWeekHolder = prevTrail ? prevTrail.lastWeekHolder : null;

    /* ══ ดึง schedule เดือนก่อนครั้งเดียว — ใช้ร่วมกันทั้ง prevLastDayPid fallback และ b1 auto-rotate ══ */
    var prevMonthRows = DataService.getScheduleAssignments(prevY, prevM) || [];

    /* ══ lastDayPid: fallback ดึงจาก schedule เดือนก่อนกรณี trailInfo เก่าไม่มี lastDayPid ══ */
    var prevLastDayPid = prevTrail ? prevTrail.lastDayPid : null;
    if (!prevLastDayPid && prevMonthRows.length) {
      var prevN = dim_(prevY, prevM);
      var prevUnflat = unflattenAssignments_(prevMonthRows, prevN);
      prevLastDayPid = prevUnflat.assign[prevN] ? prevUnflat.assign[prevN].d : null;
    }

    /* ══ crossLock: วันต้นเดือนที่ต้องใช้คนเดิมจากเดือนก่อน ══ */
    var crossLock = {};
    if (prevTrail && prevTrail.lastPid && prevTrail.trailingCount > 0) {
      var lockedPid = prevTrail.lastPid;
      var carry = prevTrail.trailingCount;
      var d = 1;
      while (d <= N) {
        var isOffOrHol = isOff(d);
        if (!isOffOrHol) break;
        if (carry >= maxC) break;
        if (canDuty(lockedPid, [d])) { crossLock[d] = lockedPid; carry++; d++; }
        else break;
      }
    }

    /* ══ cross-month Fri block: ถ้าเดือนก่อนลงท้ายวันศุกร์ → ส-อา ต้นเดือนต้องเป็นคนเดิม ══
       อ่าน pid จาก shiftType='b' ของ prevMonthRows โดยตรง (robust ต่อกรณี disD=true) */
    var prevLastDay2 = dim_(prevY, prevM);
    if (dow_(prevY, prevM, prevLastDay2) === 5) {
      var lastFriBRow = null;
      for (var fri_i = 0; fri_i < prevMonthRows.length; fri_i++) {
        if (prevMonthRows[fri_i].day === prevLastDay2 && prevMonthRows[fri_i].shiftType === 'b') {
          lastFriBRow = prevMonthRows[fri_i]; break;
        }
      }
      var friPid = lastFriBRow ? lastFriBRow.pid : prevLastDayPid;
      if (friPid) {
        var lockD = 1;
        while (lockD <= N && isOff(lockD)) {
          if (!crossLock[lockD] && canDuty(friPid, [lockD])) crossLock[lockD] = friPid;
          lockD++;
        }
      }
    }

    function pick(days, excludeWeek) {
      if (crossLock[days[0]]) return crossLock[days[0]];
      /* primary: ตัด excludeWeek (ผู้ถือ Fri block อาทิตย์ก่อน) + consec < maxC */
      var cands = pool.filter(function (p) { return canDuty(p.id, days) && consec(p.id, days[0]) < maxC && (!excludeWeek || p.id !== excludeWeek); });
      if (!cands.length) cands = pool.filter(function (p) { return canDuty(p.id, days) && consec(p.id, days[0]) < maxC; });
      if (!cands.length) cands = pool.filter(function (p) { return canDuty(p.id, days); });
      if (!cands.length) cands = pool.slice();
      if (cands.length > 1 && lastDuty) {
        var r = cands.filter(function (p) { return p.id !== lastDuty; });
        if (r.length) cands = r;
      }
      cands.sort(function (a, b) {
        return (cnt[a.id] - cnt[b.id]) || (settings.dist === 'priority' ? a.priority - b.priority : 0);
      });
      return cands[0].id;
    }
    function setD(day, pid) {
      assign[day] = { ch: isOff(day) ? pid : null, b: pid, d: pid };
      cnt[pid]++; lastDuty = pid;
    }

    var dd = 1;
    while (dd <= N) {
      if (assign[dd]) { dd++; continue; }
      if (dow_(year, month, dd) === 5) {
        var bl = [dd], x = dd + 1;
        while (x <= N && isOff(x)) { bl.push(x); x++; }
        var pid = pick(bl, lastWeekHolder); bl.forEach(function (b) { setD(b, pid); });
        lastWeekHolder = pid; dd = x;
      } else if (isOff(dd)) {
        var bl2 = [dd], x2 = dd + 1;
        while (x2 <= N && isOff(x2)) { bl2.push(x2); x2++; }
        var pid2 = pick(bl2); bl2.forEach(function (b) { setD(b, pid2); }); dd = x2;
      } else {
        setD(dd, pick([dd])); dd++;
      }
    }

    /* ══ Clinic (น) — shiftDisabled ══ */
    var shiftDisabled = settings.shiftDisabled || { n_mt: [], n_la: [], ch: [], b: [], d: [], b1: [] };
    var mn1 = month + 1;
    var disCH = (shiftDisabled.ch || []).indexOf(mn1) > -1;
    var disB = (shiftDisabled.b || []).indexOf(mn1) > -1;
    var disD = (shiftDisabled.d || []).indexOf(mn1) > -1;
    var disB1 = (shiftDisabled.b1 || []).indexOf(mn1) > -1;
    var disMT = (shiftDisabled.n_mt || []).indexOf(mn1) > -1;
    var disLA = (shiftDisabled.n_la || []).indexOf(mn1) > -1;

    if (disCH || disB || disD) {
      for (var d3 = 1; d3 <= N; d3++) {
        if (!assign[d3]) continue;
        if (disCH) assign[d3].ch = null;
        if (disB) assign[d3].b = null;
        if (disD) assign[d3].d = null;
      }
    }

    var cp = people.filter(function (p) {
      if (!dutyOK_(p)) return false;
      return !includedClinicIds || includedClinicIds.indexOf(p.id) > -1;
    });
    var cc = {}; cp.forEach(function (p) { cc[p.id] = 0; });
    var lastC = null;
    var laPool = people.filter(function (p) { return p.role === 'LA' && p.active !== false; });
    var laClinicCnt = {}; laPool.forEach(function (p) { laClinicCnt[p.id] = 0; });

    for (var day = 1; day <= N; day++) {
      if (!isClin_(year, month, day, holidays)) continue;
      if (!disMT) {
        var prevD = assign[day - 1] ? assign[day - 1].d : null;
        var todD = assign[day] ? assign[day].d : null;
        var cands = cp.filter(function (p) { return !avOff_(availability, p.id, day, month, year); });
        var cands2 = cands.filter(function (p) { return p.id !== prevD; });
        if (!cands2.length) cands2 = cands;
        cands2.sort(function (a, b) {
          return (cc[a.id] - cc[b.id]) ||
            ((a.id === todD ? 1 : 0) - (b.id === todD ? 1 : 0)) ||
            ((a.id === lastC ? 1 : 0) - (b.id === lastC ? 1 : 0)) ||
            (a.priority - b.priority);
        });
        if (cands2.length) { var pidC = cands2[0].id; cc[pidC]++; lastC = pidC; clinicMt[day] = pidC; }
      }
      if (!disLA) {
        if (settings.clinicLa === '' || settings.clinicLa === undefined || settings.clinicLa === null) {
          /* no LA assistant configured — skip */
        } else if (settings.clinicLa === 'auto') {
          var laCands = laPool.filter(function (p) {
            if (avOff_(availability, p.id, day, month, year)) return false;
            if (laB[day] === p.id) return false;
            return true;
          });
          if (laCands.length) {
            laCands.sort(function (a, b) { return (laClinicCnt[a.id] - laClinicCnt[b.id]) || (a.priority - b.priority); });
            var chosen = laCands[0].id;
            clinicLa[day] = chosen;
            laClinicCnt[chosen]++;
          }
        } else {
          var lp = byId_(people, settings.clinicLa);
          if (lp && lp.active && !avOff_(availability, settings.clinicLa, day, month, year)) clinicLa[day] = settings.clinicLa;
        }
      }
    }

    /* ══ LA บ1 — สลับอัตโนมัติทุกเดือน โดยอ่านจาก b1 จริงเดือนก่อนเท่านั้น ══ */
    var prevEffectiveLaB = null;
    var prevB1All = prevMonthRows.filter(function (r) { return r.shiftType === 'b1'; });
    if (prevB1All.length > 0) {
      if (prevTrail && prevTrail.laB) {
        prevEffectiveLaB = prevTrail.laB;
      } else {
        var prevN2 = dim_(prevY, prevM);
        for (var pd = 1; pd <= prevN2 && !prevEffectiveLaB; pd++) {
          var w2 = dow_(prevY, prevM, pd);
          if (w2 === 1 || w2 === 2) {
            var b1row = null;
            for (var bi = 0; bi < prevB1All.length; bi++) { if (prevB1All[bi].day === pd) { b1row = prevB1All[bi]; break; } }
            if (b1row && b1row.pid === settings.laA) prevEffectiveLaB = 'A';
            else if (b1row && b1row.pid === settings.laB2) prevEffectiveLaB = 'B';
          }
        }
      }
    }
    var effectiveLaB = prevEffectiveLaB ? (prevEffectiveLaB === 'A' ? 'B' : 'A') : (settings.laB === 'A' ? 'A' : 'B');
    var laMonPer = effectiveLaB === 'A' ? settings.laA : settings.laB2;
    var laWedPer = effectiveLaB === 'A' ? settings.laB2 : settings.laA;
    if (!disB1) {
      for (var day2 = 1; day2 <= N; day2++) {
        var w = dow_(year, month, day2);
        if (isOff(day2) || w === 5) continue;
        var la = (w === 1 || w === 2) ? laMonPer : (w === 3 || w === 4) ? laWedPer : null;
        var laPerson = la ? byId_(people, la) : null;
        if (la && laPerson && laPerson.active && !avOff_(availability, la, day2, month, year)) laB[day2] = la;
      }
    }

    var overrides = [];
    var trailInfo = computeTrailInfo_(N, assign, isOff);
    trailInfo.laB = effectiveLaB;
    trailInfo.lastWeekHolder = lastWeekHolder;

    /* ══ ตรวจ balance ของ crossLock ══ */
    var crossLockedPid = prevTrail ? prevTrail.lastPid : null;
    if (crossLockedPid && Object.keys(crossLock).length > 0) {
      var tol2 = 650;
      var calcM2 = function (pid) {
        var m = 0;
        for (var d4 = 1; d4 <= N; d4++) {
          var a = assign[d4] || {};
          if (isOff(d4) && a.ch === pid) m += rateFor_(rateOvr, rates, byId_(people, pid), 'ch', d4);
          if (a.b === pid) m += rateFor_(rateOvr, rates, byId_(people, pid), 'b', d4);
          if (clinicMt[d4] === pid) m += rateFor_(rateOvr, rates, byId_(people, pid), 'n', d4);
        }
        return m;
      };
      var moneys2 = pool.map(function (p) { return { p: p, m: calcM2(p.id) }; });
      var avg2 = moneys2.reduce(function (s, x) { return s + x.m; }, 0) / (moneys2.length || 1);
      var lockedMoney = moneys2.filter(function (x) { return x.p.id === crossLockedPid; })[0];
      if (lockedMoney && Math.abs(lockedMoney.m - avg2) > tol2 * 2) {
        var crossDays = Object.keys(crossLock).map(Number).sort(function (a, b) { return a - b; });
        crossDays.forEach(function (dx) {
          var cands3 = pool.filter(function (p) { return canDuty(p.id, [dx]) && p.id !== crossLockedPid; });
          if (!cands3.length) cands3 = pool.filter(function (p) { return p.id !== crossLockedPid; });
          if (!cands3.length) cands3 = pool.slice();
          cands3.sort(function (a, b) { return calcM2(a.id) - calcM2(b.id); });
          var newPid = cands3[0].id;
          assign[dx] = { ch: isOff(dx) ? newPid : null, b: newPid, d: newPid };
          overrides.push({
            day: dx, type: 'cross-month-unlock', from: crossLockedPid, to: newPid, shift: 'b',
            shiftLabel: 'ปล่อย lock ข้ามเดือน (ไม่สมดุล)',
            reason: 'Cross-month lock ทำให้ไม่สมดุลเกิน tolerance',
            time: new Date().toISOString(), aff: [crossLockedPid, newPid]
          });
        });
        trailInfo = { lastPid: null, trailingCount: 0, lastDow: dow_(year, month, N), lastDay: N };
      }
    }

    /* ══ POST-BALANCE PASS (ported 1:1, tol=650, maxPass=12) ══ */
    var postPassLog = runPostBalancePass_(pool, assign, clinicMt, N, isOff, maxC, rateOvr, rates, people, year, month);

    /* ══ RULE VIOLATION CHECKER (3 rules, ported 1:1) ══ */
    var ruleViolations = checkRuleViolations_(pool, assign, clinicMt, N, maxC, year, month, holidays, people);

    DataService.saveScheduleAssignments(year, month, flattenAssignments_(assign, clinicMt, clinicLa, laB, N), 'draft');
    /* Each "สร้างตารางเวร" re-run replaces this run's auto-generated swap log instead of
       appending forever (was producing duplicate p1→p2/p1→p3 entries across repeated runs). */
    DataService.finalizeGenerateWrites(year, month, trailInfo, ruleViolations, overrides.concat(postPassLog));

    /* ══ assign[0] = d ข้ามเดือน — ให้ cellToks วันที่ 1 แสดง "ด" (ไม่บันทึก DB) ══ */
    if (prevLastDayPid && !disD) {
      var cp2 = byId_(people, prevLastDayPid);
      if (cp2 && cp2.active !== false) assign[0] = { ch: null, b: null, d: prevLastDayPid };
    }

    return {
      year: year, month: month, status: 'draft',
      assign: assign, clinicMt: clinicMt, clinicLa: clinicLa, laB: laB, N: N,
      postBalanceSwaps: postPassLog.length, ruleViolations: ruleViolations
    };
  }

  function computeTrailInfo_(N, assign, isOff) {
    var trailingCount = 0, lastPid = null, d = N;
    while (d >= 1) {
      if (!isOff(d)) break;
      var pid = assign[d] ? assign[d].b : null;
      if (!pid) break;
      if (lastPid === null) lastPid = pid;
      if (pid !== lastPid) break;
      trailingCount++; d--;
    }
    var lastDayPid = assign[N] ? assign[N].d : null;
    return { lastPid: lastPid, trailingCount: trailingCount, lastDay: N, lastDayPid: lastDayPid, laB: null };
  }

  function runPostBalancePass_(pool, assign, clinicMt, N, isOff, maxC, rateOvr, rates, people, year, month) {
    var tol = 650, maxPass = 12, postPassLog = [];
    var calcMoney = function (pid) {
      var m = 0, person = byId_(people, pid);
      for (var d = 1; d <= N; d++) {
        var a = assign[d] || {};
        if (isOff(d) && a.ch === pid) m += rateFor_(rateOvr, rates, person, 'ch', d);
        if (a.b === pid) m += rateFor_(rateOvr, rates, person, 'b', d);
        if (clinicMt[d] === pid) m += rateFor_(rateOvr, rates, person, 'n', d);
      }
      return m;
    };
    var recentlyReceived = {};
    for (var pass = 0; pass < maxPass; pass++) {
      var moneys = pool.map(function (p) { return { p: p, m: calcMoney(p.id) }; });
      var avg = moneys.reduce(function (s, x) { return s + x.m; }, 0) / (moneys.length || 1);
      moneys.forEach(function (x) { x.diff = x.m - avg; });
      var overList = moneys.filter(function (x) { return x.diff >= tol && !recentlyReceived[x.p.id]; })
        .sort(function (a, b) { return b.diff - a.diff; });
      if (!overList.length) break;
      var ov = overList[0];
      var underList = moneys.filter(function (x) { return x.p.id !== ov.p.id && !recentlyReceived[x.p.id]; })
        .sort(function (a, b) { return a.diff - b.diff; });
      if (!underList.length) { recentlyReceived = {}; continue; }
      var un = underList[0];
      var swapped = false;
      var ts = new Date().toISOString();

      var checkConsec = function (uid, d) {
        var nc = 1, x = d - 1;
        while (x >= 1 && assign[x] && assign[x].b === uid) { nc++; x--; }
        x = d + 1;
        while (x <= N && assign[x] && assign[x].b === uid) { nc++; x++; }
        return nc <= maxC;
      };
      /* d เป็นส่วนหนึ่งของ Fri-block (ศุกร์ + วันหยุดต่อเนื่อง เช่น ส-อา) หรือไม่ — ห้าม swap วันเดียว
         ในบล็อคนี้ เพราะจะทำให้ศุกร์แยกคนกับ ส-อา ที่ตามมา ถ้า backward-walk ชนวันที่ 1 (x<1) ให้เช็ค
         วันที่ 0 ต่อ — Date(year,month,0) โรลโอเวอร์ไปวันสุดท้ายของเดือนก่อนหน้าอัตโนมัติ ทำให้ตรวจจับ
         Fri-block ที่ลากข้ามมาจากศุกร์ท้ายเดือนก่อน (เดือนนี้เริ่มด้วย ส-อา ต่อเนื่อง) ได้ด้วย */
      var inFriBlock = function (d) {
        if (dow_(year, month, d) === 5) return true;
        if (!isOff(d)) return false;
        var x = d;
        while (x >= 1 && isOff(x)) x--;
        if (x >= 1) return dow_(year, month, x) === 5;
        return dow_(year, month, 0) === 5;
      };

      for (var d1 = 1; d1 <= N && !swapped; d1++) {
        var a1 = assign[d1] || {};
        if (!isOff(d1)) continue;
        if (inFriBlock(d1)) continue;
        if (a1.ch !== ov.p.id || a1.b !== ov.p.id) continue;
        if (avOffSimple_(un.p.id, d1, assign)) continue;
        if (!checkConsec(un.p.id, d1)) continue;
        assign[d1].ch = un.p.id; assign[d1].b = un.p.id; assign[d1].d = un.p.id;
        postPassLog.push({ day: d1, type: 'balance-swap', from: ov.p.id, to: un.p.id, shift: 'ch', shiftLabel: 'ช+บ+ด (วันหยุด)', time: ts, aff: [ov.p.id, un.p.id] });
        swapped = true;
      }
      for (var d2 = 1; d2 <= N && !swapped; d2++) {
        var a2 = assign[d2] || {};
        if (isOff(d2)) continue;
        if (inFriBlock(d2)) continue;
        if (a2.b !== ov.p.id) continue;
        if (!checkConsec(un.p.id, d2)) continue;
        assign[d2].b = un.p.id; assign[d2].d = un.p.id;
        postPassLog.push({ day: d2, type: 'balance-swap', from: ov.p.id, to: un.p.id, shift: 'b', shiftLabel: 'บ+ด (วันธรรมดา)', time: ts, aff: [ov.p.id, un.p.id] });
        swapped = true;
      }
      for (var d5 = 1; d5 <= N && !swapped; d5++) {
        var a5 = assign[d5] || {};
        if (isOff(d5)) continue;
        if (inFriBlock(d5)) continue; // Fri block: b ต้องเท่ากับ d เสมอ ห้าม swap แยกวัน
        if (a5.b !== ov.p.id) continue;
        if (!checkConsec(un.p.id, d5)) continue;
        assign[d5].b = un.p.id;
        postPassLog.push({ day: d5, type: 'balance-swap', from: ov.p.id, to: un.p.id, shift: 'b', shiftLabel: 'บ อย่างเดียว (ด ยังคงเดิม)', time: ts, aff: [ov.p.id, un.p.id] });
        swapped = true;
      }

      if (swapped) recentlyReceived[un.p.id] = true;
      else break;
    }
    return postPassLog;
  }

  // NOTE: original used DATA.availability inside avOff() closures; here, the post-balance
  // pass operates only on already-built `assign` so no extra availability check is needed
  // beyond consecutive-day constraint, matching original's checkConsec-only guard for cases 2/3.
  function avOffSimple_() { return false; }

  function checkRuleViolations_(pool, assign, clinicMt, N, maxC, year, month, holidays, people) {
    var violations = [];
    pool.forEach(function (p) {
      var run = 0, runStart = 1;
      for (var d = 1; d <= N + 1; d++) {
        var hasB = assign[d] && assign[d].b === p.id;
        if (hasB) { if (run === 0) runStart = d; run++; }
        else {
          if (run > maxC) {
            violations.push({
              type: 'maxC', pid: p.id, name: p.short,
              msg: p.short + ' ขึ้นเวรติดต่อกัน ' + run + ' วัน (วันที่ ' + runStart + '-' + (d - 1) + ') เกิน maxC=' + maxC,
              days: Array.apply(null, { length: run }).map(function (_, i) { return runStart + i; }),
              severity: 'warn'
            });
          }
          run = 0;
        }
      }
    });
    /* ชบดติดกัน 2 อาทิตย์: ตรวจ 14+ วันเวรบ่าย/ดึกติดต่อกัน */
    pool.forEach(function (p) {
      var run2 = 0, runStart2 = 1;
      for (var dk = 1; dk <= N + 1; dk++) {
        var hasB2 = assign[dk] && assign[dk].b === p.id;
        if (hasB2) { if (run2 === 0) runStart2 = dk; run2++; }
        else {
          if (run2 >= 14) {
            violations.push({
              type: 'consec_week', pid: p.id, name: (byId_(people, p.id) || p).short,
              msg: (byId_(people, p.id) || p).short + ' ขึ้นเวรชบดติดต่อกัน 2 สัปดาห์ (วันที่ ' + runStart2 + '-' + (runStart2 + run2 - 1) + ') รวม ' + run2 + ' วัน',
              days: Array.apply(null, { length: run2 }).map(function (_, i) { return runStart2 + i; }),
              severity: 'warn'
            });
          }
          run2 = 0;
        }
      }
    });
    for (var d2 = 2; d2 <= N; d2++) {
      if (!isClin_(year, month, d2, holidays)) continue;
      var prevD = assign[d2 - 1] ? assign[d2 - 1].d : null;
      var clinD = clinicMt[d2];
      if (prevD && clinD && prevD === clinD) {
        violations.push({
          type: 'd_n_overlap', pid: prevD, name: (byId_(people, prevD) || {}).short || prevD,
          msg: ((byId_(people, prevD) || {}).short || prevD) + ' มีเวร ด (คืนที่ ' + (d2 - 1) + ') ซ้อนกับ น คลินิก (วันที่ ' + d2 + ') — พักไม่เพียงพอ',
          days: [d2 - 1, d2], severity: 'warn'
        });
      }
    }
    var dowLabel = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
    for (var d3 = 1; d3 <= N; d3++) {
      if (dow_(year, month, d3) !== 5) continue;
      var friPid = assign[d3] ? assign[d3].b : null;
      if (!friPid) continue;
      var x = d3 + 1, offDays = [d3];
      while (x <= N && isOff_(year, month, x, holidays)) {
        var pid = (assign[x] && (assign[x].b || assign[x].ch));
        if (pid && pid !== friPid) {
          violations.push({
            type: 'fri_block_split', pid: friPid, name: (byId_(people, friPid) || {}).short || friPid,
            msg: 'วันที่ ' + d3 + '(ศ)-' + x + '(' + dowLabel[dow_(year, month, x)] + ') ไม่ใช่คนเดียวกัน',
            days: offDays.concat([x]), severity: 'info'
          });
          break;
        }
        offDays.push(x); x++;
      }
    }
    return violations;
  }

  function flattenAssignments_(assign, clinicMt, clinicLa, laB, N) {
    var rows = [];
    for (var d = 1; d <= N; d++) {
      var a = assign[d] || {};
      if (a.ch) rows.push({ day: d, shiftType: 'ch', pid: a.ch });
      if (a.b) rows.push({ day: d, shiftType: 'b', pid: a.b });
      if (a.d) rows.push({ day: d, shiftType: 'd', pid: a.d });
      if (clinicMt[d]) rows.push({ day: d, shiftType: 'n_mt', pid: clinicMt[d] });
      if (clinicLa[d]) rows.push({ day: d, shiftType: 'n_la', pid: clinicLa[d] });
      if (laB[d]) rows.push({ day: d, shiftType: 'b1', pid: laB[d] });
    }
    return rows;
  }

  function unflattenAssignments_(rows, N) {
    var assign = {}, clinicMt = {}, clinicLa = {}, laB = {};
    for (var d = 1; d <= N; d++) assign[d] = { ch: null, b: null, d: null };
    rows.forEach(function (r) {
      if (r.shiftType === 'ch') assign[r.day].ch = r.pid;
      else if (r.shiftType === 'b') assign[r.day].b = r.pid;
      else if (r.shiftType === 'd') assign[r.day].d = r.pid;
      else if (r.shiftType === 'n_mt') clinicMt[r.day] = r.pid;
      else if (r.shiftType === 'n_la') clinicLa[r.day] = r.pid;
      else if (r.shiftType === 'b1') laB[r.day] = r.pid;
    });
    return { assign: assign, clinicMt: clinicMt, clinicLa: clinicLa, laB: laB, N: N };
  }

  /* ============================================================
   * saveSchedule(year, month, assignments, status) — ported from
   * the manual-edit path (overrides[] log) + saveData()
   * ============================================================ */
  function saveSchedule(year, month, assignments, status, userId) {
    DataService.saveScheduleAssignments(year, month, assignments, status || 'draft', userId);
    return { year: year, month: month, status: status || 'draft', count: assignments.length };
  }

  /** Ported from publish() (line 2640): requires 'publish' permission (checked in Code.gs). */
  function publishSchedule(year, month) {
    DataService.setScheduleStatus(year, month, 'published');
    return { year: year, month: month, status: 'published' };
  }

  /* ============================================================
   * loadCalendar(year, month) — bundles everything the grid/dashboard
   * needs in one round trip (ported from renderGrid()/renderDash() data deps)
   * ============================================================ */
  function loadCalendar(year, month) {
    var N = dim_(year, month);
    var rows = DataService.getScheduleAssignments(year, month);
    var status = rows.length ? rows[0].status : 'none';
    var unflat = unflattenAssignments_(rows, N);

    /* assign[0] = d ข้ามเดือน — ให้ cellToks วันที่ 1 แสดง "ด" (ไม่บันทึก DB) */
    var prevM2 = month - 1, prevY2 = year;
    if (prevM2 < 0) { prevM2 = 11; prevY2--; }
    var pt2 = DataService.getTrailInfo(prevY2, prevM2);
    var prevLDP = pt2 ? pt2.lastDayPid : null;
    if (!prevLDP) {
      var pr2 = DataService.getScheduleAssignments(prevY2, prevM2);
      if (pr2 && pr2.length) {
        var pN2 = dim_(prevY2, prevM2);
        var pu2 = unflattenAssignments_(pr2, pN2);
        prevLDP = pu2.assign[pN2] ? pu2.assign[pN2].d : null;
      }
    }
    if (prevLDP) {
      var people2 = DataService.getPeople();
      var cp3 = byId_(people2, prevLDP);
      if (cp3 && cp3.active !== false) unflat.assign[0] = { ch: null, b: null, d: prevLDP };
    }

    return {
      year: year, month: month, N: N, status: status,
      assign: unflat.assign, clinicMt: unflat.clinicMt, clinicLa: unflat.clinicLa, laB: unflat.laB,
      holidays: DataService.getHolidays(year, month),
      ruleViolations: DataService.getRuleViolations(year, month),
      overrides: DataService.getOverrides(year, month),
      oncall: DataService.getOnCallRecords(year, month),
      people: DataService.getPeople()
    };
  }

  /* ============================================================
   * calculateWorkload(year, month) — ported 1:1 from collectPay() (2676-2692)
   * ============================================================ */
  function calculateWorkload(year, month) {
    var people = DataService.getPeople();
    var N = dim_(year, month);
    var scheduleRows = DataService.getScheduleAssignments(year, month);
    var unflat = unflattenAssignments_(scheduleRows, N);
    var holidays = DataService.getHolidays(year, month);
    var oncall = DataService.getOnCallRecords(year, month);
    var payAdjRows = DataService.getPayAdjustments(year, month);

    var r = {};
    people.forEach(function (p) { r[p.id] = { ch: [], b: [], b1: [], n: [], d: [], d0: [], d1: [] }; });

    for (var d = 1; d <= N; d++) {
      var a = unflat.assign[d];
      if (a) {
        if (a.ch && isOff_(year, month, d, holidays) && r[a.ch]) r[a.ch].ch.push(d);
        if (a.b && r[a.b]) r[a.b].b.push(d);
      }
      if (unflat.laB[d] && r[unflat.laB[d]]) r[unflat.laB[d]].b1.push(d);
      if (unflat.clinicMt[d] && r[unflat.clinicMt[d]]) r[unflat.clinicMt[d]].n.push(d);
      if (unflat.clinicLa[d] && r[unflat.clinicLa[d]]) r[unflat.clinicLa[d]].n.push(d);
    }
    /* เวร ด (on call) นับเป็น 2 ช่วงเวลาแยกกัน: 00.00-04.00 (d0) และ 04.00-08.00 (d1)
       on call หลายเวลาในช่วงเดียวกันของวันเดียวกัน นับเป็น 1 ครั้งของช่วงนั้น ไม่ใช่นับซ้ำต่อเวลา */
    oncall.forEach(function (o) {
      var dt = new Date(o.date);
      var day = (dt.getFullYear() === ceY_(year) && dt.getMonth() === month) ? dt.getDate() : null;
      if (!day || !r[o.pid]) return;
      if (r[o.pid].d.indexOf(day) === -1) r[o.pid].d.push(day);
      var period = onCallPeriod_(o.time);
      if (r[o.pid][period].indexOf(day) === -1) r[o.pid][period].push(day);
    });
    payAdjRows.forEach(function (adj) {
      if (r[adj.pid]) {
        Object.keys(adj).forEach(function (sh) {
          if (['ch', 'b', 'b1', 'n', 'd', 'd0', 'd1'].indexOf(sh) > -1) r[adj.pid][sh] = adj[sh];
        });
      }
    });

    var rateOvr = DataService.getRateOverrides();
    var rates = DataService.getRates();
    var money = {};
    people.forEach(function (p) {
      var m = 0;
      r[p.id].ch.forEach(function (day) { m += rateFor_(rateOvr, rates, p, 'ch', day); });
      r[p.id].b.forEach(function (day) { m += rateFor_(rateOvr, rates, p, 'b', day); });
      r[p.id].b1.forEach(function (day) { m += rateFor_(rateOvr, rates, p, 'b1', day); });
      r[p.id].n.forEach(function (day) { m += rateFor_(rateOvr, rates, p, 'n', day); });
      r[p.id].d0.forEach(function (day) { m += rateFor_(rateOvr, rates, p, 'd0', day); });
      r[p.id].d1.forEach(function (day) { m += rateFor_(rateOvr, rates, p, 'd1', day); });
      money[p.id] = m;
    });

    return { byPerson: r, money: money, people: people };
  }

  /* ============================================================
   * calculateBalance(year, month, tolerance) — ported from renderBalance()
   * (lines ~4178-4517 of source). Group split MT/HT vs LA, swap suggestions
   * with rate-accurate impact, constraints, auto-pass + rule-violation summary.
   * Kept server-side (vs. the original's client DOM build) since rates/rateOvr
   * already live here — avoids shipping rate tables to the browser.
   * ============================================================ */
  function calculateBalance(year, month, tolerance) {
    var tol = +tolerance || 650;
    var wl = calculateWorkload(year, month);
    var rateOvr = DataService.getRateOverrides();
    var rates = DataService.getRates();
    var scheduleRows = DataService.getScheduleAssignments(year, month);
    var hasSchedule = scheduleRows.length > 0;
    var overrides = DataService.getOverrides(year, month);
    var ruleViolations = DataService.getRuleViolations(year, month);
    var trailInfo = DataService.getTrailInfo(year, month);

    var people = wl.people.filter(function (p) { return p.active !== false; });
    var stats = people.map(function (p) {
      var shifts = wl.byPerson[p.id] || { ch: [], b: [], b1: [], n: [], d: [] };
      return { p: p, role: p.role || 'MT', rg: (p.role === 'HT' || p.role === 'MT') ? 'MT' : 'LA',
        money: wl.money[p.id] || 0, shifts: shifts };
    }).sort(function (a, b) { return (a.p.priority || 99) - (b.p.priority || 99); });

    var mtStats = stats.filter(function (x) { return x.rg === 'MT'; });
    var laStats = stats.filter(function (x) { return x.rg === 'LA'; });

    function calcGrp(grp) {
      var avg = grp.reduce(function (s, x) { return s + x.money; }, 0) / (grp.length || 1);
      grp.forEach(function (x) { x.diff = x.money - avg; x.avg = avg; });
      return avg;
    }
    var mtAvg = calcGrp(mtStats), laAvg = calcGrp(laStats);
    var unbalMT = mtStats.filter(function (x) { return Math.abs(x.diff) > tol; }).length;
    var unbalLA = laStats.filter(function (x) { return Math.abs(x.diff) > tol; }).length;
    var gapMT = mtStats.length > 1 ? Math.max.apply(null, mtStats.map(function (x) { return x.money; })) - Math.min.apply(null, mtStats.map(function (x) { return x.money; })) : 0;
    var gapLA = laStats.length > 1 ? Math.max.apply(null, laStats.map(function (x) { return x.money; })) - Math.min.apply(null, laStats.map(function (x) { return x.money; })) : 0;

    var availabilityRows = DataService.getAvailability(year, month);
    var availByPid = {};
    availabilityRows.forEach(function (a) { availByPid[a.pid] = (availByPid[a.pid] || 0) + 1; });

    function constraints_(over, under) {
      var reasons = [];
      var sameRateGroup = (over.role === 'HT' || over.role === 'MT') === (under.role === 'HT' || under.role === 'MT');
      var underAvail = availByPid[under.p.id] || 0;
      if (underAvail > 0) reasons.push({ ok: false, label: (under.p.short || under.p.name || under.p.id) + ' มีวันลา ' + underAvail + ' วัน' });
      if (sameRateGroup && underAvail === 0) reasons.push({ ok: true, label: 'สลับได้ — อัตราค่าตอบแทนเดียวกัน' });
      return reasons;
    }

    function buildPairs_(grp) {
      var over = grp.filter(function (x) { return x.diff > tol; }).sort(function (a, b) { return b.diff - a.diff; });
      var under = grp.filter(function (x) { return x.diff < -tol; }).sort(function (a, b) { return a.diff - b.diff; });
      var pairs = [];
      over.forEach(function (ov) {
        under.forEach(function (un) {
          if (ov.p.id === un.p.id) return;
          var bs = ov.shifts.b.length > 0 ? 'b' : ov.shifts.ch.length > 0 ? 'ch' : ov.shifts.b1.length > 0 ? 'b1' : 'n';
          var sR = rateFor_(rateOvr, rates, ov.p, bs, 1) || 0;
          var uR = rateFor_(rateOvr, rates, un.p, bs, 1) || 0;
          var nOv = ov.money - sR, nUn = un.money + uR;
          var curGap = ov.money - un.money;
          var newGap = Math.abs(nOv - nUn);
          var impact = curGap - newGap;
          var reasons = constraints_(ov, un);
          var canSwap = reasons.filter(function (r) { return !r.ok; }).length === 0;
          pairs.push({
            ovId: ov.p.id, ovName: ov.p.short || ov.p.name, ovMoney: ov.money,
            unId: un.p.id, unName: un.p.short || un.p.name, unMoney: un.money,
            reasons: reasons, canSwap: canSwap, bestShift: bs,
            sRate: sR, uRate: uR, newOvM: nOv, newUnM: nUn, impact: impact
          });
        });
      });
      pairs.sort(function (a, b) { return b.impact - a.impact; });
      return pairs;
    }

    var swaps = (overrides || []).filter(function (o) { return o.type === 'balance-swap'; });
    var unlocks = (overrides || []).filter(function (o) { return o.type === 'cross-month-unlock'; });

    return {
      hasSchedule: hasSchedule, tolerance: tol,
      mtStats: mtStats, laStats: laStats, mtAvg: mtAvg, laAvg: laAvg,
      unbalMT: unbalMT, unbalLA: unbalLA, gapMT: gapMT, gapLA: gapLA,
      swapPairsMT: buildPairs_(mtStats), swapPairsLA: buildPairs_(laStats),
      autoSwaps: swaps, autoUnlocks: unlocks, trailInfo: trailInfo,
      ruleViolations: ruleViolations
    };
  }

  /** Ported from _bpApproveSwap() — finds the day server-side (rates/schedule
   *  already loaded here) and writes the swap via the same override pipeline
   *  used by manual grid overrides, so it shows up identically in the log/grid. */
  function approveBalanceSwap(year, month, ovId, unId, shift, userId) {
    var N = dim_(year, month);
    var scheduleRows = DataService.getScheduleAssignments(year, month);
    var unflat = unflattenAssignments_(scheduleRows, N);
    var swapDay = null;

    if (shift === 'b') {
      for (var d1 = N; d1 >= 1; d1--) { if (unflat.assign[d1] && unflat.assign[d1].b === ovId) { swapDay = d1; break; } }
    } else if (shift === 'ch') {
      for (var d2 = N; d2 >= 1; d2--) { if (unflat.assign[d2] && unflat.assign[d2].ch === ovId) { swapDay = d2; break; } }
    } else if (shift === 'b1') {
      for (var d3 = N; d3 >= 1; d3--) { if (unflat.laB[d3] === ovId) { swapDay = d3; break; } }
    } else if (shift === 'n') {
      for (var d4 = N; d4 >= 1; d4--) {
        if (unflat.clinicMt[d4] === ovId || unflat.clinicLa[d4] === ovId) { swapDay = d4; break; }
      }
    }
    if (!swapDay) throw new Error('ไม่พบวันที่จะสลับ');

    DataService.setAssignment(year, month, swapDay, shift, unId, userId);
    DataService.addOverride(year, month, {
      day: swapDay, type: 'balance-swap', shift: shift, from: ovId, to: unId,
      reason: 'สมดุลเวร: ' + ovId + ' → ' + unId
    }, userId);
    return { day: swapDay };
  }

  /** จุดปฏิบัติงานที่ตั้ง rotate:true + rotateWith คู่กัน ให้สลับ assigned กันทุกๆ เดือนคู่/เดือนคี่
   *  (ตั้งค่า "หมุนเวียน" ไว้แต่ไม่มีจุดไหนเรียกใช้จริง — เพิ่ม logic นี้เพื่อให้สลับเมื่อเปลี่ยนเดือนจริง). */
  function rotateStationsForMonth_(stations, year, month) {
    var swapMonth = (year * 12 + month) % 2 === 1;
    var byId = {};
    var result = (stations || []).map(function (s) {
      var copy = Object.assign({}, s, { assigned: (s.assigned || []).slice() });
      byId[copy.id] = copy;
      return copy;
    });
    if (!swapMonth) return result;
    var done = {};
    result.forEach(function (s) {
      if (s.rotate && s.rotateWith && byId[s.rotateWith] && !done[s.id] && !done[s.rotateWith]) {
        var partner = byId[s.rotateWith];
        var tmp = s.assigned;
        s.assigned = partner.assigned;
        partner.assigned = tmp;
        done[s.id] = done[s.rotateWith] = true;
      }
    });
    return result;
  }

  return {
    generateSchedule: generateSchedule,
    saveSchedule: saveSchedule,
    publishSchedule: publishSchedule,
    loadCalendar: loadCalendar,
    calculateWorkload: calculateWorkload,
    calculateBalance: calculateBalance,
    approveBalanceSwap: approveBalanceSwap,
    rateFor_: rateFor_,
    onCallPeriod_: onCallPeriod_,
    dim_: dim_,
    dow_: dow_,
    isOff_: isOff_,
    isHol_: isHol_,
    isClin_: isClin_,
    rotateStationsForMonth_: rotateStationsForMonth_
  };
})();

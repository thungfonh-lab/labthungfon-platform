/**
 * businessService.js — CORE business logic, ported 1:1 from BusinessService.gs.
 * RULE: every constraint, scoring order, and tolerance must match the original
 * exactly. Only the I/O (async Sheets calls instead of sync SpreadsheetApp) changed.
 */

const dataService = require('./dataService');

/* ---------------- date helpers (ported from $ helpers in original) ---------------- */

function ceY(year) { return year - 543; } // Buddhist -> CE
function dim(year, month) { return new Date(ceY(year), month + 1, 0).getDate(); } // month is 0-indexed
function dow(year, month, d) { return new Date(ceY(year), month, d).getDay(); }
function isWknd(year, month, d) { const w = dow(year, month, d); return w === 0 || w === 6; }
function nthTue(year, month, d) {
  if (dow(year, month, d) !== 2) return false;
  let c = 0;
  for (let x = 1; x <= d; x++) if (dow(year, month, x) === 2) c++;
  return c === 3;
}
function isHol(d, holidays) { return holidays.some((h) => h.day === d); }
function isClin(year, month, d, holidays) {
  if (isHol(d, holidays)) return false;
  const w = dow(year, month, d);
  return w === 3 || w === 4 || w === 5 || nthTue(year, month, d);
}
function isOff(year, month, d, holidays) { return isWknd(year, month, d) || isHol(d, holidays); }

function roleOf(p) { return p.role === 'LA' ? 'LA' : 'MT'; }
function dutyOK(p) { return p.active && (p.role === 'MT' || p.role === 'HT'); }

function byId(people, pid) { return people.filter((p) => p.id === pid)[0]; }

/** Ported from avOff()/avNo() in original. */
function avOff(availability, pid, day, month, year) {
  return (availability[pid] || []).some((a) => a.day === day && a.mon === month && a.yr === year && a.type === 'leave');
}
function avNo(availability, pid, day, month, year, type) {
  return (availability[pid] || []).some((a) => a.day === day && a.mon === month && a.yr === year && (a.type === 'leave' || a.type === type));
}

/** เวร ด (on call) แบ่งเป็น 2 ช่วงอัตราตามเวลาที่ key เข้ามา: 00.00-03.59 = d0, 04.00-07.59 = d1. */
function onCallPeriod(timeStr) {
  const h = timeStr ? parseInt(String(timeStr).split(':')[0], 10) : NaN;
  if (isNaN(h)) return 'd1';
  return h < 4 ? 'd0' : 'd1';
}

/** Ported from rateFor_(). */
function rateFor(rateOvr, rates, p, shift, day) {
  let best = null, score = -1;
  rateOvr.forEach((o) => {
    if (o.shift !== shift) return;
    if (o.pid && o.pid !== p.id) return;
    if (o.from && day && (day < o.from || (o.to && day > o.to))) return;
    const s = (o.pid ? 2 : 0) + (o.from ? 1 : 0);
    if (s > score) { score = s; best = o.amount; }
  });
  if (best !== null) return best;
  const roleRates = rates[roleOf(p)] || {};
  return roleRates[shift] || 0;
}

/* ============================================================
 * generateSchedule(year, month) — ported from generate()
 * ============================================================ */
async function generateSchedule(year, month) {
  const people = await dataService.getPeople();
  const settings = await dataService.getSettings();
  const holidays = await dataService.getHolidays(year, month);
  const availabilityRows = await dataService.getAvailability(year, month);
  const availability = {};
  availabilityRows.forEach((a) => {
    availability[a.pid] = availability[a.pid] || [];
    availability[a.pid].push(a);
  });
  const rateOvr = await dataService.getRateOverrides();
  const rates = await dataService.getRates();

  const N = dim(year, month);
  const assign = {}, clinicMt = {}, clinicLa = {}, laB = {};

  const dutyRoster = await dataService.getDutyRoster(year, month);
  const includedIds = dutyRoster && dutyRoster.included;
  const includedClinicIds = dutyRoster && dutyRoster.includedClinic;
  const pool = people.filter((p) => {
    if (!dutyOK(p)) return false;
    return !includedIds || includedIds.indexOf(p.id) > -1;
  });
  if (!pool.length) throw new Error('ไม่มี MT/HT ขึ้นเวรได้');

  const cnt = {}; pool.forEach((p) => { cnt[p.id] = 0; });
  const maxC = +settings.maxC || 4;
  let lastDuty = null;

  function consec(pid, day) {
    let n = 1, x = day - 1;
    while (x >= 1 && assign[x] && assign[x].b === pid) { n++; x--; }
    return n;
  }
  function canDuty(pid, days) {
    return days.every((d) => !avOff(availability, pid, d, month, year) &&
      !avNo(availability, pid, d, month, year, 'noB') &&
      !avNo(availability, pid, d, month, year, 'noD'));
  }
  const isOffFn = (d) => isOff(year, month, d, holidays);

  /* trailInfo เดือนก่อน */
  let prevM = month - 1, prevY = year;
  if (prevM < 0) { prevM = 11; prevY--; }
  const prevTrail = await dataService.getTrailInfo(prevY, prevM);

  /* lastWeekHolder: pid ที่ได้รับ Fri-Sun block ล่าสุด (ป้องกัน ชบด ติดกัน 2 อาทิตย์) */
  let lastWeekHolder = prevTrail ? prevTrail.lastWeekHolder : null;

  /* lastDayPid: fallback ดึงจาก schedule เดือนก่อนกรณี trailInfo เก่าไม่มี lastDayPid */
  let prevLastDayPid = prevTrail ? prevTrail.lastDayPid : null;
  if (!prevLastDayPid) {
    const prevRows = await dataService.getScheduleAssignments(prevY, prevM);
    if (prevRows.length) {
      const prevN = dim(prevY, prevM);
      const prevUnflat = unflattenAssignments(prevRows, prevN);
      prevLastDayPid = prevUnflat.assign[prevN] ? prevUnflat.assign[prevN].d : null;
    }
  }

  /* crossLock */
  const crossLock = {};
  if (prevTrail && prevTrail.lastPid && prevTrail.trailingCount > 0) {
    const lockedPid = prevTrail.lastPid;
    let carry = prevTrail.trailingCount;
    let d = 1;
    while (d <= N) {
      const isOffOrHol = isOffFn(d);
      if (!isOffOrHol) break;
      if (carry >= maxC) break;
      if (canDuty(lockedPid, [d])) { crossLock[d] = lockedPid; carry++; d++; }
      else break;
    }
  }

  function pick(days, excludeWeek) {
    if (crossLock[days[0]]) return crossLock[days[0]];
    /* primary: ตัด excludeWeek (ผู้ถือ Fri block อาทิตย์ก่อน) + consec < maxC */
    let cands = pool.filter((p) => canDuty(p.id, days) && consec(p.id, days[0]) < maxC && (!excludeWeek || p.id !== excludeWeek));
    if (!cands.length) cands = pool.filter((p) => canDuty(p.id, days) && consec(p.id, days[0]) < maxC);
    if (!cands.length) cands = pool.filter((p) => canDuty(p.id, days));
    if (!cands.length) cands = pool.slice();
    if (cands.length > 1 && lastDuty) {
      const r = cands.filter((p) => p.id !== lastDuty);
      if (r.length) cands = r;
    }
    cands.sort((a, b) => (cnt[a.id] - cnt[b.id]) || (settings.dist === 'priority' ? a.priority - b.priority : 0));
    return cands[0].id;
  }
  function setD(day, pid) {
    assign[day] = { ch: isOffFn(day) ? pid : null, b: pid, d: pid };
    cnt[pid]++; lastDuty = pid;
  }

  let dd = 1;
  while (dd <= N) {
    if (assign[dd]) { dd++; continue; }
    if (dow(year, month, dd) === 5) {
      const bl = [dd]; let x = dd + 1;
      while (x <= N && isOffFn(x)) { bl.push(x); x++; }
      const pid = pick(bl, lastWeekHolder); bl.forEach((b) => setD(b, pid));
      lastWeekHolder = pid; dd = x;
    } else if (isOffFn(dd)) {
      const bl2 = [dd]; let x2 = dd + 1;
      while (x2 <= N && isOffFn(x2)) { bl2.push(x2); x2++; }
      const pid2 = pick(bl2); bl2.forEach((b) => setD(b, pid2)); dd = x2;
    } else {
      setD(dd, pick([dd])); dd++;
    }
  }

  /* Clinic (น) — shiftDisabled */
  const shiftDisabled = settings.shiftDisabled || { n_mt: [], n_la: [], ch: [], b: [], d: [], b1: [] };
  const mn1 = month + 1;
  const disCH = (shiftDisabled.ch || []).indexOf(mn1) > -1;
  const disB = (shiftDisabled.b || []).indexOf(mn1) > -1;
  const disD = (shiftDisabled.d || []).indexOf(mn1) > -1;
  const disB1 = (shiftDisabled.b1 || []).indexOf(mn1) > -1;
  const disMT = (shiftDisabled.n_mt || []).indexOf(mn1) > -1;
  const disLA = (shiftDisabled.n_la || []).indexOf(mn1) > -1;

  if (disCH || disB || disD) {
    for (let d3 = 1; d3 <= N; d3++) {
      if (!assign[d3]) continue;
      if (disCH) assign[d3].ch = null;
      if (disB) assign[d3].b = null;
      if (disD) assign[d3].d = null;
    }
  }

  const cp = people.filter((p) => {
    if (!dutyOK(p)) return false;
    return !includedClinicIds || includedClinicIds.indexOf(p.id) > -1;
  });
  const cc = {}; cp.forEach((p) => { cc[p.id] = 0; });
  let lastC = null;
  const laPool = people.filter((p) => p.role === 'LA' && p.active !== false);
  const laClinicCnt = {}; laPool.forEach((p) => { laClinicCnt[p.id] = 0; });

  for (let day = 1; day <= N; day++) {
    if (!isClin(year, month, day, holidays)) continue;
    if (!disMT) {
      const prevD = assign[day - 1] ? assign[day - 1].d : null;
      const todD = assign[day] ? assign[day].d : null;
      const cands = cp.filter((p) => !avOff(availability, p.id, day, month, year));
      let cands2 = cands.filter((p) => p.id !== prevD);
      if (!cands2.length) cands2 = cands;
      cands2.sort((a, b) => (cc[a.id] - cc[b.id]) ||
        ((a.id === todD ? 1 : 0) - (b.id === todD ? 1 : 0)) ||
        ((a.id === lastC ? 1 : 0) - (b.id === lastC ? 1 : 0)) ||
        (a.priority - b.priority));
      if (cands2.length) { const pidC = cands2[0].id; cc[pidC]++; lastC = pidC; clinicMt[day] = pidC; }
    }
    if (!disLA) {
      if (settings.clinicLa === '' || settings.clinicLa === undefined || settings.clinicLa === null) {
        // no LA assistant configured
      } else if (settings.clinicLa === 'auto') {
        const laCands = laPool.filter((p) => {
          if (avOff(availability, p.id, day, month, year)) return false;
          if (laB[day] === p.id) return false;
          return true;
        });
        if (laCands.length) {
          laCands.sort((a, b) => (laClinicCnt[a.id] - laClinicCnt[b.id]) || (a.priority - b.priority));
          const chosen = laCands[0].id;
          clinicLa[day] = chosen;
          laClinicCnt[chosen]++;
        }
      } else {
        const lp = byId(people, settings.clinicLa);
        if (lp && lp.active && !avOff(availability, settings.clinicLa, day, month, year)) clinicLa[day] = settings.clinicLa;
      }
    }
  }

  /* LA บ1 — สลับอัตโนมัติทุกเดือน โดยอ่านจาก b1 จริงเดือนก่อนเท่านั้น (ป้องกัน trailInfo เก่าหรือ generate ทดสอบมีผล) */
  let prevEffectiveLaB = null;
  const prevB1Rows = await dataService.getScheduleAssignments(prevY, prevM);
  const prevB1All = prevB1Rows.filter((r) => r.shiftType === 'b1');
  if (prevB1All.length > 0) {
    /* เดือนก่อนมี b1 จริง: อ่าน laB จาก trailInfo หรือตรวจจาก จ/อ */
    if (prevTrail && prevTrail.laB) {
      prevEffectiveLaB = prevTrail.laB;
    } else {
      const prevN2 = dim(prevY, prevM);
      for (let pd = 1; pd <= prevN2 && !prevEffectiveLaB; pd++) {
        const w2 = dow(prevY, prevM, pd);
        if (w2 === 1 || w2 === 2) {
          const b1row = prevB1All.find((r) => r.day === pd);
          if (b1row && b1row.pid === settings.laA) prevEffectiveLaB = 'A';
          else if (b1row && b1row.pid === settings.laB2) prevEffectiveLaB = 'B';
        }
      }
    }
  }
  /* ถ้าไม่มี b1 เดือนก่อน → เดือนแรก ใช้ settings.laB เป็น base */
  const effectiveLaB = prevEffectiveLaB ? (prevEffectiveLaB === 'A' ? 'B' : 'A') : (settings.laB === 'A' ? 'A' : 'B');
  const laMonPer = effectiveLaB === 'A' ? settings.laA : settings.laB2;
  const laWedPer = effectiveLaB === 'A' ? settings.laB2 : settings.laA;
  if (!disB1) {
    for (let day2 = 1; day2 <= N; day2++) {
      const w = dow(year, month, day2);
      if (isOffFn(day2) || w === 5) continue;
      const la = (w === 1 || w === 2) ? laMonPer : (w === 3 || w === 4) ? laWedPer : null;
      const laPerson = la ? byId(people, la) : null;
      if (la && laPerson && laPerson.active && !avOff(availability, la, day2, month, year)) laB[day2] = la;
    }
  }

  let overrides = [];
  let trailInfo = computeTrailInfo(N, assign, isOffFn);
  trailInfo.laB = effectiveLaB;
  trailInfo.lastWeekHolder = lastWeekHolder;

  /* ตรวจ balance ของ crossLock */
  const crossLockedPid = prevTrail ? prevTrail.lastPid : null;
  if (crossLockedPid && Object.keys(crossLock).length > 0) {
    const tol2 = 650;
    const calcM2 = (pid) => {
      let m = 0;
      for (let d4 = 1; d4 <= N; d4++) {
        const a = assign[d4] || {};
        if (isOffFn(d4) && a.ch === pid) m += rateFor(rateOvr, rates, byId(people, pid), 'ch', d4);
        if (a.b === pid) m += rateFor(rateOvr, rates, byId(people, pid), 'b', d4);
        if (clinicMt[d4] === pid) m += rateFor(rateOvr, rates, byId(people, pid), 'n', d4);
      }
      return m;
    };
    const moneys2 = pool.map((p) => ({ p, m: calcM2(p.id) }));
    const avg2 = moneys2.reduce((s, x) => s + x.m, 0) / (moneys2.length || 1);
    const lockedMoney = moneys2.filter((x) => x.p.id === crossLockedPid)[0];
    if (lockedMoney && Math.abs(lockedMoney.m - avg2) > tol2 * 2) {
      const crossDays = Object.keys(crossLock).map(Number).sort((a, b) => a - b);
      crossDays.forEach((dx) => {
        let cands3 = pool.filter((p) => canDuty(p.id, [dx]) && p.id !== crossLockedPid);
        if (!cands3.length) cands3 = pool.filter((p) => p.id !== crossLockedPid);
        if (!cands3.length) cands3 = pool.slice();
        cands3.sort((a, b) => calcM2(a.id) - calcM2(b.id));
        const newPid = cands3[0].id;
        assign[dx] = { ch: isOffFn(dx) ? newPid : null, b: newPid, d: newPid };
        overrides.push({
          day: dx, type: 'cross-month-unlock', from: crossLockedPid, to: newPid, shift: 'b',
          shiftLabel: 'ปล่อย lock ข้ามเดือน (ไม่สมดุล)',
          reason: 'Cross-month lock ทำให้ไม่สมดุลเกิน tolerance',
          time: new Date().toISOString(), aff: [crossLockedPid, newPid]
        });
      });
      trailInfo = { lastPid: null, trailingCount: 0, lastDow: dow(year, month, N), lastDay: N };
    }
  }

  /* POST-BALANCE PASS (tol=650, maxPass=12) */
  const postPassLog = runPostBalancePass(pool, assign, clinicMt, N, isOffFn, maxC, rateOvr, rates, people);

  /* RULE VIOLATION CHECKER */
  const ruleViolations = checkRuleViolations(pool, assign, clinicMt, N, maxC, year, month, holidays, people);

  await dataService.saveScheduleAssignments(year, month, flattenAssignments(assign, clinicMt, clinicLa, laB, N), 'draft');
  await dataService.setTrailInfo(year, month, trailInfo);
  await dataService.clearRuleViolations(year, month);
  await dataService.addRuleViolations(year, month, ruleViolations);
  await dataService.clearAutoOverrides(year, month);
  if (overrides.length || postPassLog.length) {
    await dataService.addOverridesBulk(year, month, overrides.concat(postPassLog));
  }

  /* assign[0] = d ข้ามเดือน — ให้ cellToks วันที่ 1 แสดง "ด" ได้ (ไม่บันทึก DB) */
  if (prevLastDayPid && !disD) {
    const cp2 = byId(people, prevLastDayPid);
    if (cp2 && cp2.active !== false) assign[0] = { ch: null, b: null, d: prevLastDayPid };
  }

  return {
    year, month, status: 'draft',
    assign, clinicMt, clinicLa, laB, N,
    postBalanceSwaps: postPassLog.length, ruleViolations
  };
}

function computeTrailInfo(N, assign, isOffFn) {
  let trailingCount = 0, lastPid = null, d = N;
  while (d >= 1) {
    if (!isOffFn(d)) break;
    const pid = assign[d] ? assign[d].b : null;
    if (!pid) break;
    if (lastPid === null) lastPid = pid;
    if (pid !== lastPid) break;
    trailingCount++; d--;
  }
  const lastDayPid = assign[N] ? assign[N].d : null;
  return { lastPid, trailingCount, lastDay: N, lastDayPid, laB: null };
}

function runPostBalancePass(pool, assign, clinicMt, N, isOffFn, maxC, rateOvr, rates, people) {
  const tol = 650, maxPass = 12; const postPassLog = [];
  const calcMoney = (pid) => {
    let m = 0; const person = byId(people, pid);
    for (let d = 1; d <= N; d++) {
      const a = assign[d] || {};
      if (isOffFn(d) && a.ch === pid) m += rateFor(rateOvr, rates, person, 'ch', d);
      if (a.b === pid) m += rateFor(rateOvr, rates, person, 'b', d);
      if (clinicMt[d] === pid) m += rateFor(rateOvr, rates, person, 'n', d);
    }
    return m;
  };
  let recentlyReceived = {};
  for (let pass = 0; pass < maxPass; pass++) {
    const moneys = pool.map((p) => ({ p, m: calcMoney(p.id) }));
    const avg = moneys.reduce((s, x) => s + x.m, 0) / (moneys.length || 1);
    moneys.forEach((x) => { x.diff = x.m - avg; });
    const overList = moneys.filter((x) => x.diff >= tol && !recentlyReceived[x.p.id]).sort((a, b) => b.diff - a.diff);
    if (!overList.length) break;
    const ov = overList[0];
    const underList = moneys.filter((x) => x.p.id !== ov.p.id && !recentlyReceived[x.p.id]).sort((a, b) => a.diff - b.diff);
    if (!underList.length) { recentlyReceived = {}; continue; }
    const un = underList[0];
    let swapped = false;
    const ts = new Date().toISOString();

    const checkConsec = (uid, d) => {
      let nc = 1, x = d - 1;
      while (x >= 1 && assign[x] && assign[x].b === uid) { nc++; x--; }
      x = d + 1;
      while (x <= N && assign[x] && assign[x].b === uid) { nc++; x++; }
      return nc <= maxC;
    };

    for (let d1 = 1; d1 <= N && !swapped; d1++) {
      const a1 = assign[d1] || {};
      if (!isOffFn(d1)) continue;
      if (a1.ch !== ov.p.id || a1.b !== ov.p.id) continue;
      if (!checkConsec(un.p.id, d1)) continue;
      assign[d1].ch = un.p.id; assign[d1].b = un.p.id; assign[d1].d = un.p.id;
      postPassLog.push({ day: d1, type: 'balance-swap', from: ov.p.id, to: un.p.id, shift: 'ch', shiftLabel: 'ช+บ+ด (วันหยุด)', time: ts, aff: [ov.p.id, un.p.id] });
      swapped = true;
    }
    for (let d2 = 1; d2 <= N && !swapped; d2++) {
      const a2 = assign[d2] || {};
      if (isOffFn(d2)) continue;
      if (a2.b !== ov.p.id) continue;
      if (!checkConsec(un.p.id, d2)) continue;
      assign[d2].b = un.p.id; assign[d2].d = un.p.id;
      postPassLog.push({ day: d2, type: 'balance-swap', from: ov.p.id, to: un.p.id, shift: 'b', shiftLabel: 'บ+ด (วันธรรมดา)', time: ts, aff: [ov.p.id, un.p.id] });
      swapped = true;
    }
    for (let d5 = 1; d5 <= N && !swapped; d5++) {
      const a5 = assign[d5] || {};
      if (isOffFn(d5)) continue;
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

function checkRuleViolations(pool, assign, clinicMt, N, maxC, year, month, holidays, people) {
  const violations = [];
  pool.forEach((p) => {
    let run = 0, runStart = 1;
    for (let d = 1; d <= N + 1; d++) {
      const hasB = assign[d] && assign[d].b === p.id;
      if (hasB) { if (run === 0) runStart = d; run++; }
      else {
        if (run > maxC) {
          violations.push({
            type: 'maxC', pid: p.id, name: p.short,
            msg: p.short + ' ขึ้นเวรติดต่อกัน ' + run + ' วัน (วันที่ ' + runStart + '-' + (d - 1) + ') เกิน maxC=' + maxC,
            days: Array.from({ length: run }, (_, i) => runStart + i),
            severity: 'warn'
          });
        }
        run = 0;
      }
    }
  });
  /* ชบดติดกัน 2 อาทิตย์: ตรวจ 14+ วันเวรบ่าย/ดึกติดต่อกัน */
  pool.forEach((p) => {
    let run = 0, runStart = 1;
    for (let d = 1; d <= N + 1; d++) {
      const hasB = assign[d] && assign[d].b === p.id;
      if (hasB) { if (run === 0) runStart = d; run++; }
      else {
        if (run >= 14) {
          violations.push({
            type: 'consec_week', pid: p.id, name: (byId(people, p.id) || p).short,
            msg: (byId(people, p.id) || p).short + ' ขึ้นเวรชบดติดต่อกัน 2 สัปดาห์ (วันที่ ' + runStart + '-' + (runStart + run - 1) + ') รวม ' + run + ' วัน',
            days: Array.from({ length: run }, (_, i) => runStart + i),
            severity: 'warn'
          });
        }
        run = 0;
      }
     }
  });
  for (let d2 = 2; d2 <= N; d2++) {
    if (!isClin(year, month, d2, holidays)) continue;
    const prevD = assign[d2 - 1] ? assign[d2 - 1].d : null;
    const clinD = clinicMt[d2];
    if (prevD && clinD && prevD === clinD) {
      violations.push({
        type: 'd_n_overlap', pid: prevD, name: (byId(people, prevD) || {}).short || prevD,
        msg: ((byId(people, prevD) || {}).short || prevD) + ' มีเวร ด (คืนที่ ' + (d2 - 1) + ') ซ้อนกับ น คลินิก (วันที่ ' + d2 + ') — พักไม่เพียงพอ',
        days: [d2 - 1, d2], severity: 'warn'
      });
    }
  }
  const dowLabel = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  for (let d3 = 1; d3 <= N; d3++) {
    if (dow(year, month, d3) !== 5) continue;
    const friPid = assign[d3] ? assign[d3].b : null;
    if (!friPid) continue;
    let x = d3 + 1; const offDays = [d3];
    while (x <= N && isOff(year, month, x, holidays)) {
      const pid = (assign[x] && (assign[x].b || assign[x].ch));
      if (pid && pid !== friPid) {
        violations.push({
          type: 'fri_block_split', pid: friPid, name: (byId(people, friPid) || {}).short || friPid,
          msg: 'วันที่ ' + d3 + '(ศ)-' + x + '(' + dowLabel[dow(year, month, x)] + ') ไม่ใช่คนเดียวกัน',
          days: offDays.concat([x]), severity: 'info'
        });
        break;
      }
      offDays.push(x); x++;
    }
  }
  return violations;
}

function flattenAssignments(assign, clinicMt, clinicLa, laB, N) {
  const rows = [];
  for (let d = 1; d <= N; d++) {
    const a = assign[d] || {};
    if (a.ch) rows.push({ day: d, shiftType: 'ch', pid: a.ch });
    if (a.b) rows.push({ day: d, shiftType: 'b', pid: a.b });
    if (a.d) rows.push({ day: d, shiftType: 'd', pid: a.d });
    if (clinicMt[d]) rows.push({ day: d, shiftType: 'n_mt', pid: clinicMt[d] });
    if (clinicLa[d]) rows.push({ day: d, shiftType: 'n_la', pid: clinicLa[d] });
    if (laB[d]) rows.push({ day: d, shiftType: 'b1', pid: laB[d] });
  }
  return rows;
}

function unflattenAssignments(rows, N) {
  const assign = {}, clinicMt = {}, clinicLa = {}, laB = {};
  for (let d = 1; d <= N; d++) assign[d] = { ch: null, b: null, d: null };
  rows.forEach((r) => {
    if (r.shiftType === 'ch') assign[r.day].ch = r.pid;
    else if (r.shiftType === 'b') assign[r.day].b = r.pid;
    else if (r.shiftType === 'd') assign[r.day].d = r.pid;
    else if (r.shiftType === 'n_mt') clinicMt[r.day] = r.pid;
    else if (r.shiftType === 'n_la') clinicLa[r.day] = r.pid;
    else if (r.shiftType === 'b1') laB[r.day] = r.pid;
  });
  return { assign, clinicMt, clinicLa, laB, N };
}

/* ============================================================
 * saveSchedule(year, month, assignments, status)
 * ============================================================ */
async function saveSchedule(year, month, assignments, status) {
  await dataService.saveScheduleAssignments(year, month, assignments, status || 'draft');
  return { year, month, status: status || 'draft', count: assignments.length };
}

async function publishSchedule(year, month) {
  await dataService.setScheduleStatus(year, month, 'published');
  return { year, month, status: 'published' };
}

/* ============================================================
 * loadCalendar(year, month)
 * ============================================================ */
async function loadCalendar(year, month) {
  const N = dim(year, month);
  const rows = await dataService.getScheduleAssignments(year, month);
  const status = rows.length ? rows[0].status : 'none';
  const unflat = unflattenAssignments(rows, N);

  /* assign[0] = d ข้ามเดือน — ให้ cellToks วันที่ 1 แสดง "ด" (ไม่บันทึก DB) */
  const prevLastDayPidForLoad = await (async () => {
    let prevM2 = month - 1, prevY2 = year;
    if (prevM2 < 0) { prevM2 = 11; prevY2--; }
    const pt = await dataService.getTrailInfo(prevY2, prevM2);
    if (pt && pt.lastDayPid) return pt.lastDayPid;
    const pr = await dataService.getScheduleAssignments(prevY2, prevM2);
    if (pr.length) {
      const pN = dim(prevY2, prevM2);
      const pu = unflattenAssignments(pr, pN);
      return pu.assign[pN] ? pu.assign[pN].d : null;
    }
    return null;
  })();
  if (prevLastDayPidForLoad) {
    const people2 = await dataService.getPeople();
    const cp3 = byId(people2, prevLastDayPidForLoad);
    if (cp3 && cp3.active !== false) unflat.assign[0] = { ch: null, b: null, d: prevLastDayPidForLoad };
  }

  return {
    year, month, N, status,
    assign: unflat.assign, clinicMt: unflat.clinicMt, clinicLa: unflat.clinicLa, laB: unflat.laB,
    holidays: await dataService.getHolidays(year, month),
    ruleViolations: await dataService.getRuleViolations(year, month),
    overrides: await dataService.getOverrides(year, month),
    oncall: await dataService.getOnCallRecords(year, month),
    people: await dataService.getPeople()
  };
}

/* ============================================================
 * calculateWorkload(year, month) — ported 1:1 from collectPay()
 * ============================================================ */
async function calculateWorkload(year, month) {
  const people = await dataService.getPeople();
  const N = dim(year, month);
  const scheduleRows = await dataService.getScheduleAssignments(year, month);
  const unflat = unflattenAssignments(scheduleRows, N);
  const holidays = await dataService.getHolidays(year, month);
  const oncall = await dataService.getOnCallRecords(year, month);
  const payAdjRows = await dataService.getPayAdjustments(year, month);

  const r = {};
  people.forEach((p) => { r[p.id] = { ch: [], b: [], b1: [], n: [], d: [], d0: [], d1: [] }; });

  for (let d = 1; d <= N; d++) {
    const a = unflat.assign[d];
    if (a) {
      if (a.ch && isOff(year, month, d, holidays) && r[a.ch]) r[a.ch].ch.push(d);
      if (a.b && r[a.b]) r[a.b].b.push(d);
    }
    if (unflat.laB[d] && r[unflat.laB[d]]) r[unflat.laB[d]].b1.push(d);
    if (unflat.clinicMt[d] && r[unflat.clinicMt[d]]) r[unflat.clinicMt[d]].n.push(d);
    if (unflat.clinicLa[d] && r[unflat.clinicLa[d]]) r[unflat.clinicLa[d]].n.push(d);
  }
  oncall.forEach((o) => {
    const dt = new Date(o.date);
    const day = (dt.getFullYear() === ceY(year) && dt.getMonth() === month) ? dt.getDate() : null;
    if (!day || !r[o.pid]) return;
    if (r[o.pid].d.indexOf(day) === -1) r[o.pid].d.push(day);
    const period = onCallPeriod(o.time);
    if (r[o.pid][period].indexOf(day) === -1) r[o.pid][period].push(day);
  });
  payAdjRows.forEach((adj) => {
    if (r[adj.pid]) {
      Object.keys(adj).forEach((sh) => {
        if (['ch', 'b', 'b1', 'n', 'd', 'd0', 'd1'].indexOf(sh) > -1) r[adj.pid][sh] = adj[sh];
      });
    }
  });

  const rateOvr = await dataService.getRateOverrides();
  const rates = await dataService.getRates();
  const money = {};
  people.forEach((p) => {
    let m = 0;
    r[p.id].ch.forEach((day) => { m += rateFor(rateOvr, rates, p, 'ch', day); });
    r[p.id].b.forEach((day) => { m += rateFor(rateOvr, rates, p, 'b', day); });
    r[p.id].b1.forEach((day) => { m += rateFor(rateOvr, rates, p, 'b1', day); });
    r[p.id].n.forEach((day) => { m += rateFor(rateOvr, rates, p, 'n', day); });
    r[p.id].d0.forEach((day) => { m += rateFor(rateOvr, rates, p, 'd0', day); });
    r[p.id].d1.forEach((day) => { m += rateFor(rateOvr, rates, p, 'd1', day); });
    money[p.id] = m;
  });

  return { byPerson: r, money, people };
}

/* ============================================================
 * calculateBalance(year, month, tolerance)
 * ============================================================ */
async function calculateBalance(year, month, tolerance) {
  const tol = +tolerance || 650;
  const wl = await calculateWorkload(year, month);
  const rateOvr = await dataService.getRateOverrides();
  const rates = await dataService.getRates();
  const scheduleRows = await dataService.getScheduleAssignments(year, month);
  const hasSchedule = scheduleRows.length > 0;
  const overrides = await dataService.getOverrides(year, month);
  const ruleViolations = await dataService.getRuleViolations(year, month);
  const trailInfo = await dataService.getTrailInfo(year, month);

  const people = wl.people.filter((p) => p.active !== false);
  const stats = people.map((p) => {
    const shifts = wl.byPerson[p.id] || { ch: [], b: [], b1: [], n: [], d: [] };
    return { p, role: p.role || 'MT', rg: (p.role === 'HT' || p.role === 'MT') ? 'MT' : 'LA', money: wl.money[p.id] || 0, shifts };
  }).sort((a, b) => (a.p.priority || 99) - (b.p.priority || 99));

  const mtStats = stats.filter((x) => x.rg === 'MT');
  const laStats = stats.filter((x) => x.rg === 'LA');

  function calcGrp(grp) {
    const avg = grp.reduce((s, x) => s + x.money, 0) / (grp.length || 1);
    grp.forEach((x) => { x.diff = x.money - avg; x.avg = avg; });
    return avg;
  }
  const mtAvg = calcGrp(mtStats), laAvg = calcGrp(laStats);
  const unbalMT = mtStats.filter((x) => Math.abs(x.diff) > tol).length;
  const unbalLA = laStats.filter((x) => Math.abs(x.diff) > tol).length;
  const gapMT = mtStats.length > 1 ? Math.max(...mtStats.map((x) => x.money)) - Math.min(...mtStats.map((x) => x.money)) : 0;
  const gapLA = laStats.length > 1 ? Math.max(...laStats.map((x) => x.money)) - Math.min(...laStats.map((x) => x.money)) : 0;

  const availabilityRows = await dataService.getAvailability(year, month);
  const availByPid = {};
  availabilityRows.forEach((a) => { availByPid[a.pid] = (availByPid[a.pid] || 0) + 1; });

  function constraints(over, under) {
    const reasons = [];
    const sameRateGroup = (over.role === 'HT' || over.role === 'MT') === (under.role === 'HT' || under.role === 'MT');
    const underAvail = availByPid[under.p.id] || 0;
    if (underAvail > 0) reasons.push({ ok: false, label: (under.p.short || under.p.name || under.p.id) + ' มีวันลา ' + underAvail + ' วัน' });
    if (sameRateGroup && underAvail === 0) reasons.push({ ok: true, label: 'สลับได้ — อัตราค่าตอบแทนเดียวกัน' });
    return reasons;
  }

  function buildPairs(grp) {
    const over = grp.filter((x) => x.diff > tol).sort((a, b) => b.diff - a.diff);
    const under = grp.filter((x) => x.diff < -tol).sort((a, b) => a.diff - b.diff);
    const pairs = [];
    over.forEach((ov) => {
      under.forEach((un) => {
        if (ov.p.id === un.p.id) return;
        const bs = ov.shifts.b.length > 0 ? 'b' : ov.shifts.ch.length > 0 ? 'ch' : ov.shifts.b1.length > 0 ? 'b1' : 'n';
        const sR = rateFor(rateOvr, rates, ov.p, bs, 1) || 0;
        const uR = rateFor(rateOvr, rates, un.p, bs, 1) || 0;
        const nOv = ov.money - sR, nUn = un.money + uR;
        const curGap = ov.money - un.money;
        const newGap = Math.abs(nOv - nUn);
        const impact = curGap - newGap;
        const reasons = constraints(ov, un);
        const canSwap = reasons.filter((r) => !r.ok).length === 0;
        pairs.push({
          ovId: ov.p.id, ovName: ov.p.short || ov.p.name, ovMoney: ov.money,
          unId: un.p.id, unName: un.p.short || un.p.name, unMoney: un.money,
          reasons, canSwap, bestShift: bs,
          sRate: sR, uRate: uR, newOvM: nOv, newUnM: nUn, impact
        });
      });
    });
    pairs.sort((a, b) => b.impact - a.impact);
    return pairs;
  }

  const swaps = (overrides || []).filter((o) => o.type === 'balance-swap');
  const unlocks = (overrides || []).filter((o) => o.type === 'cross-month-unlock');

  return {
    hasSchedule, tolerance: tol,
    mtStats, laStats, mtAvg, laAvg,
    unbalMT, unbalLA, gapMT, gapLA,
    swapPairsMT: buildPairs(mtStats), swapPairsLA: buildPairs(laStats),
    autoSwaps: swaps, autoUnlocks: unlocks, trailInfo,
    ruleViolations
  };
}

/** Ported from _bpApproveSwap(). */
async function approveBalanceSwap(year, month, ovId, unId, shift) {
  const N = dim(year, month);
  const scheduleRows = await dataService.getScheduleAssignments(year, month);
  const unflat = unflattenAssignments(scheduleRows, N);
  let swapDay = null;

  if (shift === 'b') {
    for (let d1 = N; d1 >= 1; d1--) { if (unflat.assign[d1] && unflat.assign[d1].b === ovId) { swapDay = d1; break; } }
  } else if (shift === 'ch') {
    for (let d2 = N; d2 >= 1; d2--) { if (unflat.assign[d2] && unflat.assign[d2].ch === ovId) { swapDay = d2; break; } }
  } else if (shift === 'b1') {
    for (let d3 = N; d3 >= 1; d3--) { if (unflat.laB[d3] === ovId) { swapDay = d3; break; } }
  } else if (shift === 'n') {
    for (let d4 = N; d4 >= 1; d4--) {
      if (unflat.clinicMt[d4] === ovId || unflat.clinicLa[d4] === ovId) { swapDay = d4; break; }
    }
  }
  if (!swapDay) throw new Error('ไม่พบวันที่จะสลับ');

  await dataService.setAssignment(year, month, swapDay, shift, unId);
  await dataService.addOverride(year, month, {
    day: swapDay, type: 'balance-swap', shift, from: ovId, to: unId,
    reason: 'สมดุลเวร: ' + ovId + ' → ' + unId
  });
  return { day: swapDay };
}

/** จุดปฏิบัติงานที่ตั้ง rotate:true + rotateWith คู่กัน ให้สลับ assigned กันทุกๆ เดือนคู่/เดือนคี่. */
function rotateStationsForMonth(stations, year, month) {
  const swapMonth = (year * 12 + month) % 2 === 1;
  const byIdMap = {};
  const result = (stations || []).map((s) => {
    const copy = Object.assign({}, s, { assigned: (s.assigned || []).slice() });
    byIdMap[copy.id] = copy;
    return copy;
  });
  if (!swapMonth) return result;
  const done = {};
  result.forEach((s) => {
    if (s.rotate && s.rotateWith && byIdMap[s.rotateWith] && !done[s.id] && !done[s.rotateWith]) {
      const partner = byIdMap[s.rotateWith];
      const tmp = s.assigned;
      s.assigned = partner.assigned;
      partner.assigned = tmp;
      done[s.id] = done[s.rotateWith] = true;
    }
  });
  return result;
}

module.exports = {
  generateSchedule,
  saveSchedule,
  publishSchedule,
  loadCalendar,
  calculateWorkload,
  calculateBalance,
  approveBalanceSwap,
  rateFor,
  onCallPeriod,
  dim,
  dow,
  isOff,
  isHol,
  isClin,
  rotateStationsForMonth,
  unflattenAssignments
};

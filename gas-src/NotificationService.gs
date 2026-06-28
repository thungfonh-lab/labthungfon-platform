/**
 * NotificationService.gs — ported from openSend()/confirmSend()/sendDraft()/
 * publish()/sendCollect()/syncCalendar() (lines 2635-2672). The original was
 * a demo (toast() simulating Email/LINE); this turns the same trigger points
 * into real sends while keeping CFG.chEmail/chLine/chCal as the on/off switches.
 */

var NotificationService = (function () {

  function sendEmail_(toEmails, subject, body) {
    if (!toEmails.length) return;
    MailApp.sendEmail({ to: toEmails.join(','), subject: subject, htmlBody: body });
  }

  function sendLine_(message) {
    var settings = DataService.getSettings();
    if (!settings.chLine || !settings.lineToken) return;
    UrlFetchApp.fetch('https://notify-api.line.me/api/notify', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + settings.lineToken },
      payload: { message: message },
      muteHttpExceptions: true
    });
  }

  /** Ported from sendDraft() (2635-2639). */
  function notifyDraftReady(year, month) {
    var settings = DataService.getSettings();
    var people = DataService.getPeople();
    var text = 'เรียนเจ้าหน้าที่ทุกท่าน\nตารางเวร (ฉบับร่าง) เดือน ' + TH_M[month] + ' ' + year + ' จัดเสร็จแล้ว\nกรุณาตรวจสอบเวรและแจ้งแก้ไขก่อนประกาศใช้';
    if (settings.chEmail) sendEmail_(people.map(function (p) { return p.email; }).filter(Boolean), 'ตารางเวร (ฉบับร่าง) ' + TH_M[month] + ' ' + year, text.replace(/\n/g, '<br>'));
    if (settings.chLine) sendLine_(text);
    return { ok: true };
  }

  /** Ported from publish() (2640-2645). */
  function notifySchedulePublished(year, month) {
    var settings = DataService.getSettings();
    var people = DataService.getPeople();
    var text = 'ประกาศใช้ตารางเวร เดือน ' + TH_M[month] + ' ' + year + '\nแนบรายงานรายบุคคลให้ท่าน';
    if (settings.chEmail) sendEmail_(people.map(function (p) { return p.email; }).filter(Boolean), 'ประกาศใช้ตารางเวร ' + TH_M[month] + ' ' + year, text.replace(/\n/g, '<br>'));
    if (settings.chLine) sendLine_(text);
    return { ok: true };
  }

  /** Ported from sendCollect() (2666-2670). */
  function notifyCollectRequest(year, month) {
    var settings = DataService.getSettings();
    var people = DataService.getPeople();
    var cd = settings.colDay ? ('วันที่ ' + settings.colDay + ' ของทุกเดือน') : '(ยังไม่ตั้งค่า)';
    var text = 'เรียนเจ้าหน้าที่ทุกท่าน\nขอให้แจ้งวันลา/วันที่ไม่สะดวกขึ้นเวรสำหรับ ' + TH_M[month] + ' ' + year + '\nภายใน ' + cd + '\nหากไม่แจ้ง ระบบจะจัดตามกฎ';
    if (settings.chEmail) sendEmail_(people.map(function (p) { return p.email; }).filter(Boolean), 'ขอวันลา/ความไม่สะดวก ' + TH_M[month] + ' ' + year, text.replace(/\n/g, '<br>'));
    if (settings.chLine) sendLine_(text);
    return { ok: true };
  }

  /** New: internal alert (rule violations, low blood stock, etc.) — additive, not in original. */
  function createInternalAlert(title, message, severity) {
    AuditService.logAction('system', 'ALERT', 'Notification', title, null, { message: message, severity: severity || 'info' });
  }

  return {
    notifyDraftReady: notifyDraftReady,
    notifySchedulePublished: notifySchedulePublished,
    notifyCollectRequest: notifyCollectRequest,
    createInternalAlert: createInternalAlert
  };
})();

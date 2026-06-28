/**
 * notificationService.js — ported from NotificationService.gs.
 * sendEmail_ → nodemailer; sendLine_ → fetch call to LINE Notify API.
 * CFG.chEmail/chLine remain the on/off switches (read from Settings sheet).
 */

const nodemailer = require('nodemailer');
const dataService = require('./dataService');
const auditService = require('./auditService');

const TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!process.env.MAIL_HOST) return null;
  _transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT) || 587,
    secure: process.env.MAIL_SECURE === 'true',
    auth: process.env.MAIL_USER ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } : undefined
  });
  return _transporter;
}

async function sendEmail(toEmails, subject, htmlBody) {
  if (!toEmails.length) return;
  const transporter = getTransporter();
  if (!transporter) return; // MAIL_* not configured — silently skip, matches original's settings-gated behavior
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to: toEmails.join(','),
    subject,
    html: htmlBody
  });
}

async function sendLine(message) {
  const settings = await dataService.getSettings();
  const token = process.env.LINE_TOKEN || settings.lineToken;
  if (!settings.chLine || !token) return;
  try {
    await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ message }).toString()
    });
  } catch (e) {
    // muteHttpExceptions equivalent: swallow network errors, matching original's best-effort send
  }
}

async function notifyDraftReady(year, month) {
  const settings = await dataService.getSettings();
  const people = await dataService.getPeople();
  const text = 'เรียนเจ้าหน้าที่ทุกท่าน\nตารางเวร (ฉบับร่าง) เดือน ' + TH_M[month] + ' ' + year + ' จัดเสร็จแล้ว\nกรุณาตรวจสอบเวรและแจ้งแก้ไขก่อนประกาศใช้';
  if (settings.chEmail) await sendEmail(people.map((p) => p.email).filter(Boolean), 'ตารางเวร (ฉบับร่าง) ' + TH_M[month] + ' ' + year, text.replace(/\n/g, '<br>'));
  if (settings.chLine) await sendLine(text);
  return { ok: true };
}

async function notifySchedulePublished(year, month) {
  const settings = await dataService.getSettings();
  const people = await dataService.getPeople();
  const text = 'ประกาศใช้ตารางเวร เดือน ' + TH_M[month] + ' ' + year + '\nแนบรายงานรายบุคคลให้ท่าน';
  if (settings.chEmail) await sendEmail(people.map((p) => p.email).filter(Boolean), 'ประกาศใช้ตารางเวร ' + TH_M[month] + ' ' + year, text.replace(/\n/g, '<br>'));
  if (settings.chLine) await sendLine(text);
  return { ok: true };
}

async function notifyCollectRequest(year, month) {
  const settings = await dataService.getSettings();
  const people = await dataService.getPeople();
  const cd = settings.colDay ? ('วันที่ ' + settings.colDay + ' ของทุกเดือน') : '(ยังไม่ตั้งค่า)';
  const text = 'เรียนเจ้าหน้าที่ทุกท่าน\nขอให้แจ้งวันลา/วันที่ไม่สะดวกขึ้นเวรสำหรับ ' + TH_M[month] + ' ' + year + '\nภายใน ' + cd + '\nหากไม่แจ้ง ระบบจะจัดตามกฎ';
  if (settings.chEmail) await sendEmail(people.map((p) => p.email).filter(Boolean), 'ขอวันลา/ความไม่สะดวก ' + TH_M[month] + ' ' + year, text.replace(/\n/g, '<br>'));
  if (settings.chLine) await sendLine(text);
  return { ok: true };
}

async function createInternalAlert(title, message, severity) {
  await auditService.logAction('system', 'ALERT', 'Notification', title, null, { message, severity: severity || 'info' });
}

module.exports = {
  notifyDraftReady,
  notifySchedulePublished,
  notifyCollectRequest,
  createInternalAlert
};

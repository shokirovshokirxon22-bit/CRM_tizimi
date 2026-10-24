// SMS yuborish. SMS_PROVIDER: eskiz | console | memory
//  - eskiz   : https://eskiz.uz (ESKIZ_EMAIL, ESKIZ_PASSWORD, ixtiyoriy ESKIZ_FROM, SMS_TEMPLATE)
//  - console : kod server logiga yoziladi (faqat sinov uchun!)
//  - memory  : testlar uchun (kodlar xotirada)
// Sozlanmagan bo'lsa: development'da console, production'da xato (503).
const { ApiError } = require('./util');

const outbox = []; // faqat SMS_PROVIDER=memory
let eskizToken = null;

const provider = () => {
  const p = (process.env.SMS_PROVIDER || '').toLowerCase();
  if (p) return p;
  if (process.env.ESKIZ_EMAIL && process.env.ESKIZ_PASSWORD) return 'eskiz';
  return process.env.NODE_ENV === 'production' ? 'none' : 'console';
};

const template = () => process.env.SMS_TEMPLATE || 'Ombor tasdiqlash kodi: {code}. Uni hech kimga bermang.';

// Eskiz 998XXXXXXXXX formatini kutadi
const eskizCall = async (path, form, token) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  const r = await fetch('https://notify.eskiz.uz/api' + path, { method: 'POST', body: fd, headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const eskizLogin = async () => {
  const r = await eskizCall('/auth/login', { email: process.env.ESKIZ_EMAIL, password: process.env.ESKIZ_PASSWORD });
  const t = r.j && r.j.data && r.j.data.token;
  if (!t) throw new Error('Eskiz login xatosi: ' + r.status);
  eskizToken = t;
};

async function sendSms(phone, text) {
  const p = provider();
  if (p === 'memory') { outbox.push({ phone, text }); return; }
  if (p === 'console') { console.log(`[SMS -> +${phone}] ${text}`); return; }
  if (p === 'eskiz') {
    try {
      if (!eskizToken) await eskizLogin();
      const body = { mobile_phone: phone, message: text, from: process.env.ESKIZ_FROM || '4546' };
      let r = await eskizCall('/message/sms/send', body, eskizToken);
      if (r.status === 401) { await eskizLogin(); r = await eskizCall('/message/sms/send', body, eskizToken); }
      if (r.status >= 300) throw new Error('Eskiz send xatosi: ' + r.status + ' ' + JSON.stringify(r.j));
      return;
    } catch (e) {
      console.error('[SMS]', e.message);
      throw new ApiError(502, "SMS yuborib bo'lmadi. Birozdan keyin qayta urinib ko'ring");
    }
  }
  throw new ApiError(503, 'SMS xizmati sozlanmagan (SMS_PROVIDER / ESKIZ_EMAIL, ESKIZ_PASSWORD)');
}

const sendCode = (phone, code) => sendSms(phone, template().replace('{code}', code));

module.exports = { sendSms, sendCode, outbox };
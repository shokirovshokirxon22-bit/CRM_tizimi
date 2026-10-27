const express = require('express');
const rateLimit = require('express-rate-limit');
const { h, str } = require('../util');
const monitor = require('../monitor');

// Brauzerdagi kutilmagan JS xatolari. Brauzerga Sentry skripti yuklamaymiz (CSP yopiq qoladi, ilova yengil):
// frontend xatoni shu yerga yuboradi, server uni (tozalab) Sentry'ga uzatadi. Kirish shart emas (login oynasida ham xato bo'lishi mumkin),
// shuning uchun suiiste'molga qarshi: IP bo'yicha limit va kichik hajm. SENTRY_DSN bo'lmasa hech narsa qilmaydi.
const r = express.Router();
const lim = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Limit' } });

r.post('/', lim, express.json({ limit: '8kb' }), h(async (req, res) => {
  if (monitor.enabled()) {
    const msg = monitor.clean(str(req.body && req.body.msg, { max: 300 })) || 'noma\'lum xato';
    const e = new Error('[brauzer] ' + msg);
    e.stack = '[brauzer] ' + monitor.clean(str(req.body && req.body.stack, { max: 1500 })); // stack matni (faqat ko'rish uchun)
    monitor.capture(e, null, { page: str(req.body && req.body.page, { max: 100 }), ua: str(req.headers['user-agent'], { max: 150 }) });
    await monitor.flush();
  }
  res.status(204).end();
}));

module.exports = r;

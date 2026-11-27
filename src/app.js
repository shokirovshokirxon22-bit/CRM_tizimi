require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { auth, adminOnly, superOnly } = require('./auth');
const { gate } = require('./billing');
const billingRoutes = require('./routes/billing');
const { ApiError } = require('./util');
const misc = require('./routes/misc');
const monitor = require('./monitor');
 
function createApp() {
  monitor.init(); // SENTRY_DSN bo'lsa xatolar kuzatiladi, bo'lmasa o'chiq
  const app = express();
  if (process.env.VERCEL && !process.env.TRUST_PROXY) process.env.TRUST_PROXY = '1';
  if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') app.set('trust proxy', +process.env.TRUST_PROXY || 1);
  // Frontend shu serverdan beriladi (public/), shuning uchun CSP'ni frontend uchun yumshatamiz
  app.use(helmet({ contentSecurityPolicy: false }));
  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : true }));
  // Eski (localStorage) zaxirani ko'chirish katta bo'lishi mumkin, shuning uchun alohida limit
  app.post('/api/import', auth, gate, adminOnly, express.json({ limit: '15mb' }), require('./routes/import'));
  // Brauzer xatolari: o'zining kichik hajm limiti bor, shuning uchun umumiy json parserdan oldin
  app.use('/api/client-error', require('./routes/clienterr'));
  app.use(express.json({ limit: '200kb' }));
 
  app.get('/api/health', (req, res) => res.json({ ok: true }));
 
  const lim = rateLimit({ windowMs: 15 * 60 * 1000, limit: +process.env.AUTH_RATE_LIMIT || 30, standardHeaders: true, legacyHeaders: false, message: { error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring" } });
  app.use('/api/auth/login', lim);
  app.use('/api/auth/register', lim);
  app.use('/api/auth/reset', lim);
  // SMS pul turadi: kod yuboradigan yo'llarga qattiqroq limit (IP bo'yicha)
  const smsLim = rateLimit({ windowMs: 15 * 60 * 1000, limit: +process.env.SMS_RATE_LIMIT || 10, standardHeaders: true, legacyHeaders: false, message: { error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring" } });
  ['/api/auth/register/start', '/api/auth/reset/start', '/api/auth/phone/start'].forEach((p) => app.use(p, smsLim));
 
  // Ochiq to'lov yo'llari (login oynasidan ID bo'yicha): qattiq limit
  const payLim = rateLimit({ windowMs: 15 * 60 * 1000, limit: +process.env.PAY_RATE_LIMIT || 40, standardHeaders: true, legacyHeaders: false, message: { error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring" } });
  app.use('/api/billing/public', payLim, billingRoutes.pub);
  app.get('/api/billing/cron', billingRoutes.cron);
  // To'lov tizimlarining serverga so'rovlari (JWT emas, o'zining imzo/parol tekshiruvi bor). Click form-urlencoded yuboradi.
  app.use('/api/pay/payme', require('./pay/payme').handler);
  app.use('/api/pay/click', express.urlencoded({ extended: false, limit: '50kb' }), require('./pay/click').handler);
 
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/billing', auth, billingRoutes.user);
  // Egasi API si: SUPER_KEY ni taxmin qilishga qarshi (faqat xatoli urinishlar sanaladi)
  const supLim = rateLimit({ windowMs: 15 * 60 * 1000, limit: +process.env.SUPER_RATE_LIMIT || 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring" } });
  app.use('/api/super/billing', supLim, superOnly, billingRoutes.sup);
  app.use('/api/staff', auth, gate, adminOnly, require('./routes/staff'));
  app.use('/api/audit', auth, gate, adminOnly, require('./routes/audit'));
  app.use('/api/products', auth, gate, require('./routes/products'));
  app.use('/api/sales', auth, gate, require('./routes/sales'));
  app.use('/api/debts', auth, gate, require('./routes/debts'));
  app.use('/api/settings', auth, gate, misc.settings);
  app.use('/api/expenses', auth, gate, adminOnly, misc.expenses);
  app.use('/api/buys', auth, gate, adminOnly, misc.buys);
  app.use('/api/reports', auth, gate, adminOnly, misc.reports);
  app.use('/api/ads', misc.ads);
  app.use('/api/super/ads', misc.superAds);
 
  // Egasi paneli (narxlar, buyurtmalar). Sahifaning o'zi ochiq, lekin hamma amal SUPER_KEY talab qiladi. public/ da emas: mobil ilovaga kirmaydi.
  const ownerHtml = fs.readFileSync(path.join(__dirname, 'owner.html'), 'utf8');
  app.get('/owner', (req, res) => { res.set('Cache-Control', 'no-store').type('html').send(ownerHtml); });
 
  app.use('/api', (req, res) => res.status(404).json({ error: 'Topilmadi' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
 
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "JSON noto'g'ri" });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: "So'rov hajmi juda katta" }); // mijoz xatosi: Sentry'ga ketmaydi
    if (err.code === '23505' || /UNIQUE constraint/i.test(err.message || '')) return res.status(409).json({ error: 'Bunday yozuv allaqachon bor' });
    console.error(err);
    monitor.capture(err, req.user); // Sentry (yoqilgan bo'lsa): faqat kutilmagan 5xx xatolar
    monitor.flush().finally(() => res.status(500).json({ error: 'Server xatosi' }));
  });
  return app;
}
module.exports = { createApp };
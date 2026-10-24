require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { auth, adminOnly } = require('./auth');
const { ApiError } = require('./util');
const misc = require('./routes/misc');
 
function createApp() {
  const app = express();
  if (process.env.VERCEL && !process.env.TRUST_PROXY) process.env.TRUST_PROXY = '1';
  if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') app.set('trust proxy', +process.env.TRUST_PROXY || 1);
  // Frontend shu serverdan beriladi (public/), shuning uchun CSP'ni frontend uchun yumshatamiz
  app.use(helmet({ contentSecurityPolicy: false }));
  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : true }));
  // Eski (localStorage) zaxirani ko'chirish katta bo'lishi mumkin, shuning uchun alohida limit
  app.post('/api/import', auth, adminOnly, express.json({ limit: '15mb' }), require('./routes/import'));
  app.use(express.json({ limit: '200kb' }));
 
  app.get('/api/health', (req, res) => res.json({ ok: true }));
 
  const lim = rateLimit({ windowMs: 15 * 60 * 1000, limit: +process.env.AUTH_RATE_LIMIT || 30, standardHeaders: true, legacyHeaders: false, message: { error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring" } });
  app.use('/api/auth/login', lim);
  app.use('/api/auth/register', lim);
  app.use('/api/auth/reset', lim);
  // SMS pul turadi: kod yuboradigan yo'llarga qattiqroq limit (IP bo'yicha)
  const smsLim = rateLimit({ windowMs: 15 * 60 * 1000, limit: +process.env.SMS_RATE_LIMIT || 10, standardHeaders: true, legacyHeaders: false, message: { error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring" } });
  ['/api/auth/register/start', '/api/auth/reset/start', '/api/auth/phone/start'].forEach((p) => app.use(p, smsLim));
 
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/staff', auth, adminOnly, require('./routes/staff'));
  app.use('/api/products', auth, require('./routes/products'));
  app.use('/api/sales', auth, require('./routes/sales'));
  app.use('/api/debts', auth, require('./routes/debts'));
  app.use('/api/settings', auth, misc.settings);
  app.use('/api/expenses', auth, adminOnly, misc.expenses);
  app.use('/api/buys', auth, adminOnly, misc.buys);
  app.use('/api/reports', auth, adminOnly, misc.reports);
  app.use('/api/ads', misc.ads);
  app.use('/api/super/ads', misc.superAds);
 
  app.use('/api', (req, res) => res.status(404).json({ error: 'Topilmadi' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
 
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "JSON noto'g'ri" });
    if (err.code === '23505' || /UNIQUE constraint/i.test(err.message || '')) return res.status(409).json({ error: 'Bunday yozuv allaqachon bor' });
    console.error(err);
    res.status(500).json({ error: 'Server xatosi' });
  });
  return app;
}
module.exports = { createApp };
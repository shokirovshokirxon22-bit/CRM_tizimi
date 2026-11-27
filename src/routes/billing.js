// Tarif va to'lov yo'llari.
//   user  : /api/billing/*          (kirgan foydalanuvchi; to'lov faqat admin)
//   pub   : /api/billing/public/*   (login oynasidan: ID bo'yicha to'lash)
//   sup   : /api/super/billing/*    (egasi: x-super-key; narx, buyurtmalar, qo'lda berish)
//   cron  : /api/billing/cron       (eslatma SMS; CRON_SECRET)
const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const { adminOnly } = require('../auth');
const { ApiError, h, str, num, now } = require('../util');
const { maskPhone } = require('../audit');
const billing = require('../billing');
const payme = require('../pay/payme');
const click = require('../pay/click');
const reminders = require('../reminders');

const PROVIDERS = { payme, click };
const available = () => [payme.configured() && { id: 'payme', name: 'Payme' }, click.configured() && { id: 'click', name: 'Click' }].filter(Boolean);
// App Store / Google Play qoidalari tufayli ba'zi platformalarda (default: ios) ilova ichida to'lov tugmalari ko'rsatilmaydi. PAY_HIDDEN_PLATFORMS bilan o'zgartiriladi.
const hiddenPlatforms = () => (process.env.PAY_HIDDEN_PLATFORMS === undefined ? 'ios' : process.env.PAY_HIDDEN_PLATFORMS).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const platformOf = (req) => String(req.query.platform || req.headers['x-app-platform'] || 'web').toLowerCase().slice(0, 12);
function payInfo(req) {
  const list = available(), hide = hiddenPlatforms().includes(platformOf(req));
  return { providers: hide ? [] : list, canPay: !hide && list.length > 0, ...(hide ? { hidden: true } : {}), ...(!hide && !list.length ? { notConfigured: true } : {}) };
}
const langOf = (v) => (['uz', 'ru', 'en'].includes(v) ? v : 'uz');
const idParam = (v) => { if (!/^\d{1,12}$/.test(String(v))) throw new ApiError(404, 'Topilmadi'); return +v; };

async function checkout(req, shopId, planCode, provider, userId) {
  const info = payInfo(req);
  if (!info.canPay) throw new ApiError(info.hidden ? 403 : 503, info.hidden ? "Bu ilovada to'lov mavjud emas" : "To'lov tizimi hali sozlanmagan");
  if (!info.providers.some((p) => p.id === provider)) throw new ApiError(400, "To'lov usuli topilmadi");
  const order = await billing.createOrder(shopId, planCode, provider, userId);
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const url = PROVIDERS[provider].checkoutUrl(order, langOf(req.body && req.body.lang), base ? `${base}/?paid=${order.id}` : null);
  return { orderId: order.id, url, amount: Number(order.amount) };
}

/* ================= Kirgan foydalanuvchi ================= */
const user = express.Router();
user.get('/status', h(async (req, res) => res.json({ sub: await billing.shopStatus(req.user.shopId) })));
user.get('/plans', adminOnly, h(async (req, res) => {
  res.json({ sub: await billing.shopStatus(req.user.shopId), plans: await billing.listPlans(req.user.shopId), ...payInfo(req) });
}));
user.post('/checkout', adminOnly, h(async (req, res) => {
  res.json(await checkout(req, req.user.shopId, req.body.plan, String(req.body.provider || ''), req.user.id));
}));
user.get('/order/:id', adminOnly, h(async (req, res) => {
  const o = await db('orders').where({ id: idParam(req.params.id), shop_id: req.user.shopId }).first();
  if (!o) throw new ApiError(404, 'Topilmadi');
  res.json({ state: o.state, paid: o.state === 'paid', sub: await billing.shopStatus(req.user.shopId) });
}));
user.get('/history', adminOnly, h(async (req, res) => {
  const rows = await db('orders').where({ shop_id: req.user.shopId, state: 'paid' }).orderBy('paid_at', 'desc').limit(20);
  res.json({ orders: rows.map((o) => ({ id: o.id, plan: o.plan_code, amount: Number(o.amount), provider: o.provider, paidAt: Number(o.paid_at) })) });
}));

/* ================= Login oynasidan (ID bo'yicha) =================
   Faqat admin ID si qabul qilinadi. Do'kon nomi qisman yashiriladi. Ochiq yo'l, shuning uchun app.js da qattiq limit bor. */
const pub = express.Router();
const maskName = (n) => { const s = String(n || ''); return s.length <= 2 ? s[0] + '***' : s.slice(0, 2) + '***'; };
async function adminByLoginId(v) {
  const id = String(v || '').replace(/\D/g, '');
  const u = id.length === 6 ? await db('users').where({ login_id: id, role: 'admin', active: true }).first() : null;
  if (!u) throw new ApiError(404, 'Bunday ID topilmadi');
  return u;
}
pub.post('/lookup', h(async (req, res) => {
  const u = await adminByLoginId(req.body.id);
  const shop = await db('shops').where({ id: u.shop_id }).first();
  const st = billing.statusOf(shop);
  res.json({ name: maskName(shop.name), sub: { state: st.state, daysLeft: st.daysLeft, lifetime: st.lifetime }, plans: st.lifetime ? [] : await billing.listPlans(shop.id), ...payInfo(req) });
}));
pub.post('/checkout', h(async (req, res) => {
  const u = await adminByLoginId(req.body.id);
  res.json(await checkout(req, u.shop_id, req.body.plan, String(req.body.provider || ''), u.id));
}));
pub.get('/order/:id', h(async (req, res) => {
  const o = await db('orders').where({ id: idParam(req.params.id) }).first();
  res.json({ paid: !!o && o.state === 'paid' });
}));

/* ================= Cron ================= */
const cron = h(async (req, res) => {
  const key = process.env.CRON_SECRET || '';
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(key), b = Buffer.from(got);
  if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ApiError(403, "Ruxsat yo'q");
  res.json({ ok: true, ...(await reminders.run()) });
});

/* ================= Egasi (SUPER_KEY) ================= */
const sup = express.Router();
const planRow = (p) => ({ code: p.code, name: p.name, kind: p.kind, days: p.days, price: Number(p.price), active: !!p.active, maxSlots: p.max_slots, sort: p.sort });
const money = async (where) => Number((await db('orders').where({ state: 'paid' }).whereNot({ provider: 'manual' }).modify(where || (() => {})).sum({ s: 'amount' }).first()).s || 0);

sup.get('/summary', h(async (req, res) => {
  const t = now(), cnt = async (f) => Number((await db('shops').modify(f).count({ c: '*' }).first()).c);
  const life = await db('plans').where({ kind: 'lifetime' }).first();
  res.json({
    shops: await cnt(() => {}),
    trial: await cnt((q) => q.where({ lifetime: false, plan: 'trial' }).where('sub_until', '>', t)),
    paying: await cnt((q) => q.where({ lifetime: false }).whereNot({ plan: 'trial' }).where('sub_until', '>', t)),
    expired: await cnt((q) => q.where({ lifetime: false }).where((w) => w.where('sub_until', '<=', t).orWhereNull('sub_until'))),
    lifetime: await cnt((q) => q.where({ lifetime: true })),
    lifetimeSold: await billing.soldLifetime(db), lifetimeSlots: life ? life.max_slots : 0,
    revenueTotal: await money(), revenue30d: await money((q) => q.where('paid_at', '>', t - 30 * billing.DAY)),
  });
}));
sup.get('/plans', h(async (req, res) => res.json({ plans: (await db('plans').orderBy('sort')).map(planRow) })));
sup.put('/plans/:code', h(async (req, res) => {
  const p = await db('plans').where({ code: req.params.code }).first();
  if (!p) throw new ApiError(404, 'Tarif topilmadi');
  const b = req.body || {}, u = {};
  if (b.name !== undefined) u.name = str(b.name, { req: true, max: 60 });
  if (b.price !== undefined) u.price = Math.round(num(b.price, { min: 0, max: 1e10 }));
  if (b.active !== undefined) u.active = !!b.active;
  if (b.sort !== undefined) u.sort = Math.round(num(b.sort, { min: 0, max: 1000 }));
  if (b.days !== undefined && p.kind !== 'lifetime') u.days = Math.round(num(b.days, { min: p.kind === 'trial' ? 0 : 1, max: 3650 }));
  if (b.maxSlots !== undefined && p.kind === 'lifetime') u.max_slots = Math.round(num(b.maxSlots, { min: 0, max: 100000 }));
  if (p.kind === 'trial') { delete u.price; delete u.active; }
  if (Object.keys(u).length) await db('plans').where({ code: p.code }).update(u);
  res.json({ plan: planRow(await db('plans').where({ code: p.code }).first()) });
}));
sup.post('/plans', h(async (req, res) => {
  const b = req.body || {};
  if (!/^[a-z0-9]{2,12}$/.test(String(b.code || ''))) throw new ApiError(400, "Kod 2-12 ta kichik lotin harf yoki raqam bo'lsin");
  if (await db('plans').where({ code: b.code }).first()) throw new ApiError(409, 'Bunday kod bor');
  const sort = Number((await db('plans').max({ m: 'sort' }).first()).m || 0) + 1;
  await db('plans').insert({ code: b.code, name: str(b.name, { req: true, max: 60 }), kind: 'period', days: Math.round(num(b.days, { min: 1, max: 3650 })), price: Math.round(num(b.price, { min: 1, max: 1e10 })), active: true, sort });
  res.status(201).json({ plan: planRow(await db('plans').where({ code: b.code }).first()) });
}));
sup.get('/orders', h(async (req, res) => {
  const q = db('orders').orderBy('id', 'desc').limit(Math.min(200, +req.query.limit || 50));
  if (['new', 'paid', 'refunded'].includes(req.query.state)) q.where({ state: req.query.state });
  res.json({ orders: (await q).map((o) => ({ id: o.id, shopId: o.shop_id, shop: o.shop_name, plan: o.plan_code, amount: Number(o.amount), provider: o.provider, state: o.state, note: o.note, createdAt: Number(o.created_at), paidAt: o.paid_at ? Number(o.paid_at) : null })) });
}));
sup.get('/shops', h(async (req, res) => {
  const q = String(req.query.q || '').trim(), t = now();
  const rows = await db('shops').leftJoin('users', function () { this.on('users.shop_id', 'shops.id').andOn('users.role', db.raw('?', ['admin'])); })
    .select('shops.id', 'shops.name', 'shops.plan', 'shops.sub_until', 'shops.lifetime', 'shops.created_at', 'users.login_id', 'users.phone')
    .modify((b) => { if (q) b.where((w) => w.whereRaw('lower(shops.name) like ?', [`%${q.replace(/[%_]/g, '').toLowerCase()}%`]).orWhere('users.login_id', q.replace(/\D/g, '') || '-')); })
    .orderBy('shops.id', 'desc').limit(100);
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue; seen.add(r.id);
    const st = billing.statusOf(r, t);
    out.push({ id: r.id, name: r.name, loginId: r.login_id, phone: maskPhone(r.phone), plan: r.plan, state: st.state, daysLeft: st.daysLeft, until: st.until, createdAt: Number(r.created_at) });
  }
  res.json({ shops: out });
}));
sup.post('/grant', h(async (req, res) => {
  const b = req.body || {};
  const shopId = /^\d+$/.test(String(b.shopId || '')) ? +b.shopId : null;
  if (!shopId) throw new ApiError(400, "Do'kon ID si kerak");
  const o = await billing.manualGrant(shopId, { planCode: b.planCode, days: b.days, note: b.note });
  res.status(201).json({ order: { id: o.id, plan: o.plan_code, days: o.days }, sub: await billing.shopStatus(shopId) });
}));

module.exports = { user, pub, sup, cron };

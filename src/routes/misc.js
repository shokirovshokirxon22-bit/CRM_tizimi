const express = require('express');
const { db } = require('../db');
const { auth, adminOnly, superOnly } = require('../auth');
const { ApiError, h, num, str, idOf, now } = require('../util');
const { audit, who } = require('../audit');

const DEF = { lang: 'uz', sms: false, days: 0, tpl: "Assalomu alaykum, {ism}! {biznes} oldidagi {summa} so'm qarzingiz muddati {sana} da tugaydi. Iltimos, to'lovni amalga oshiring." };
const parseS = (s) => { try { return { ...DEF, ...(JSON.parse(s) || {}) }; } catch { return { ...DEF }; } };

/* ---------- Sozlamalar ---------- */
const settings = express.Router();
settings.get('/', h(async (req, res) => {
  const s = await db('shops').where({ id: req.user.shopId }).first();
  res.json({ shopName: s.name, sellerEditPrice: !!s.seller_edit_price, sellerSeeDebts: !!s.seller_see_debts, ...parseS(s.settings) });
}));
settings.put('/', adminOnly, h(async (req, res) => {
  const s = await db('shops').where({ id: req.user.shopId }).first();
  const b = req.body, cur = parseS(s.settings), upd = {};
  if (b.shopName !== undefined) upd.name = str(b.shopName, { req: true, max: 100 });
  if (b.sellerEditPrice !== undefined) upd.seller_edit_price = !!b.sellerEditPrice;
  if (b.sellerSeeDebts !== undefined) upd.seller_see_debts = !!b.sellerSeeDebts;
  const n = { ...cur };
  if (b.lang !== undefined) n.lang = ['uz', 'ru', 'en'].includes(b.lang) ? b.lang : 'uz';
  if (b.sms !== undefined) n.sms = !!b.sms;
  if (b.days !== undefined) n.days = num(b.days, { min: 0, max: 365, def: 0 });
  if (b.tpl !== undefined) n.tpl = str(b.tpl, { max: 500 }) || DEF.tpl;
  upd.settings = JSON.stringify(n);
  await db('shops').where({ id: s.id }).update(upd);
  const L = { shopName: 'do\'kon nomi', sellerEditPrice: 'sotuvchi narxni o\'zgartira oladi', sellerSeeDebts: 'sotuvchi qarzlarni ko\'radi', lang: 'til', sms: 'SMS eslatma', days: 'eslatma kuni', tpl: 'SMS matni' };
  const was = { shopName: s.name, sellerEditPrice: !!s.seller_edit_price, sellerSeeDebts: !!s.seller_see_debts, lang: cur.lang, sms: !!cur.sms, days: cur.days, tpl: cur.tpl };
  const now_ = { shopName: upd.name !== undefined ? upd.name : s.name, sellerEditPrice: upd.seller_edit_price !== undefined ? upd.seller_edit_price : !!s.seller_edit_price, sellerSeeDebts: upd.seller_see_debts !== undefined ? upd.seller_see_debts : !!s.seller_see_debts, lang: n.lang, sms: !!n.sms, days: n.days, tpl: n.tpl };
  const diff = Object.keys(was).filter((k) => was[k] !== now_[k]);
  if (diff.length) await audit(who(req), { action: 'settings.update', entity: 'settings', summary: 'Sozlama: ' + diff.map((k) => k === 'tpl' ? L[k] + " o'zgartirildi" : `${L[k]}: ${was[k]} → ${now_[k]}`).join(', '), data: { changes: Object.fromEntries(diff.filter((k) => k !== 'tpl').map((k) => [k, [was[k], now_[k]]])) } });
  res.json({ ok: true });
}));

/* ---------- Xarajatlar (admin) ---------- */
const expenses = express.Router();
expenses.get('/', h(async (req, res) => {
  res.json(await db('expenses').where({ shop_id: req.user.shopId }).orderBy('id', 'desc').limit(200)
    .then((a) => a.map((e) => ({ id: e.id, name: e.name, amount: e.amount, createdAt: e.created_at }))));
}));
expenses.post('/', h(async (req, res) => {
  const amount = num(req.body.amount, { min: 0.0001 });
  if (amount === undefined) throw new ApiError(400, 'Summani kiriting');
  const id = idOf(await db('expenses').insert({ shop_id: req.user.shopId, name: str(req.body.name, { req: true, max: 100 }), amount, created_at: now() }).returning('id'));
  await audit(who(req), { action: 'expense.create', entity: 'expense', entityId: id, summary: `Xarajat qo'shildi: ${str(req.body.name, { max: 100 })}, ${amount} so'm` });
  res.status(201).json({ id });
}));
expenses.delete('/:id', h(async (req, res) => {
  const old = await db('expenses').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
  const n = await db('expenses').where({ id: +req.params.id, shop_id: req.user.shopId }).del();
  if (!n) throw new ApiError(404, 'Topilmadi');
  await audit(who(req), { action: 'expense.delete', entity: 'expense', entityId: old.id, summary: `Xarajat o'chirildi: ${old.name}, ${old.amount} so'm` });
  res.json({ ok: true });
}));

/* ---------- Tovar olish tarixi (admin) ---------- */
const buys = express.Router();
buys.get('/', h(async (req, res) => {
  res.json(await db('buys').where({ shop_id: req.user.shopId }).orderBy('id', 'desc').limit(2000)
    .then((a) => a.map((b) => ({ id: b.id, name: b.name, amount: b.amount, createdAt: b.created_at }))));
}));

/* ---------- Hisobotlar (admin) ---------- */
const reports = express.Router();
// GET /api/reports/summary?from=ms&to=ms&tz=daqiqa(masalan -300 = UTC+5)
reports.get('/summary', h(async (req, res) => {
  const shopId = req.user.shopId;
  const from = num(req.query.from, { min: 0, def: 0 }), to = num(req.query.to, { min: 0, def: now() });
  const tz = num(req.query.tz, { min: -840, max: 840, def: 0 });
  const rows = await db('sale_items').join('sales', 'sales.id', 'sale_items.sale_id')
    .where('sales.shop_id', shopId).whereNull('sales.voided_at').whereBetween('sales.created_at', [from, to])
    .select('sales.created_at as t', 'sale_items.name', 'sale_items.unit', 'sale_items.qty', 'sale_items.price', 'sale_items.cost');
  const day = {}, rank = {}; let revenue = 0, profit = 0;
  for (const i of rows) {
    const rev = i.qty * i.price, pr = i.qty * (i.price - i.cost);
    revenue += rev; profit += pr;
    const k = Math.floor((i.t - tz * 60000) / 864e5);
    const d = (day[k] = day[k] || { day: k, revenue: 0, profit: 0 }); d.revenue += rev; d.profit += pr;
    const m = (rank[i.name] = rank[i.name] || { name: i.name, unit: i.unit, qty: 0, revenue: 0 }); m.qty += i.qty; m.revenue += rev;
  }
  const sum = async (t) => Number((await db(t).where({ shop_id: shopId }).whereBetween('created_at', [from, to]).sum({ s: 'amount' }).first()).s || 0);
  const purchases = await sum('buys'), exp = await sum('expenses');
  const stock = await db('products').where({ shop_id: shopId }).select('cost', 'pct', 'qty');
  const debtsTotal = Number((await db('debts').where({ shop_id: shopId, paid: false }).sum({ s: 'amount' }).first()).s || 0);
  res.json({
    revenue, profit, purchases, expenses: exp, net: profit - exp, debtsTotal,
    stock: { cost: stock.reduce((a, p) => a + p.cost * p.qty, 0), value: stock.reduce((a, p) => a + p.cost * (1 + p.pct / 100) * p.qty, 0) },
    daily: Object.values(day).sort((a, b) => a.day - b.day),
    ranking: Object.values(rank).sort((a, b) => b.revenue - a.revenue).slice(0, 20),
  });
}));

/* ---------- Reklama ---------- */
// Do'kon foydalanuvchilari faqat faol reklamalarni o'qiydi
const ads = express.Router();
const adv = (a) => ({ id: a.id, placement: a.placement, title: a.title, body: a.body || '', imageUrl: a.image_url || '', link: a.link || '', active: !!a.active });
ads.get('/', auth, h(async (req, res) => {
  const q = db('ads').where({ active: true }).orderBy('id', 'desc').limit(20);
  if (req.query.placement) q.where({ placement: String(req.query.placement) });
  res.json((await q).map(adv));
}));
// Platforma egasi (siz) SUPER_KEY bilan boshqarasiz: x-super-key sarlavhasi
const superAds = express.Router();
superAds.use(superOnly);
const adBody = (b) => ({
  placement: str(b.placement || 'home', { max: 30 }), title: str(b.title, { req: true, max: 120 }), body: str(b.body, { max: 500 }),
  image_url: str(b.imageUrl, { max: 1000 }) || null, link: str(b.link, { max: 1000 }) || null, active: b.active === undefined ? true : !!b.active,
});
superAds.get('/', h(async (req, res) => res.json((await db('ads').orderBy('id', 'desc')).map(adv))));
superAds.post('/', h(async (req, res) => {
  const id = idOf(await db('ads').insert({ ...adBody(req.body), created_at: now() }).returning('id'));
  res.status(201).json(adv(await db('ads').where({ id }).first()));
}));
superAds.put('/:id', h(async (req, res) => {
  const n = await db('ads').where({ id: +req.params.id }).update(adBody(req.body));
  if (!n) throw new ApiError(404, 'Topilmadi');
  res.json(adv(await db('ads').where({ id: +req.params.id }).first()));
}));
superAds.delete('/:id', h(async (req, res) => { await db('ads').where({ id: +req.params.id }).del(); res.json({ ok: true }); }));

module.exports = { settings, expenses, buys, reports, ads, superAds };

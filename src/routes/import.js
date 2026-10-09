// Eski (localStorage) "ombor-zaxira.json" ma'lumotini shu do'konga ko'chirish. Faqat bo'sh do'konga.
const { db } = require('../db');
const { ApiError, h, idOf, now } = require('../util');

const N = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const S = (v, m = 150) => String(v ?? '').slice(0, m);
const UNITS = ['m', 'dona', 'kg'];

module.exports = h(async (req, res) => {
  const D = req.body || {}, shopId = req.user.shopId;
  if (!Array.isArray(D.products) || !Array.isArray(D.sales)) throw new ApiError(400, "Zaxira fayli noto'g'ri");
  if (await db('products').where({ shop_id: shopId }).first() || await db('sales').where({ shop_id: shopId }).first())
    throw new ApiError(409, "Do'konda allaqachon ma'lumot bor. Ko'chirish faqat bo'sh do'konga mumkin");

  const out = await db.transaction(async (trx) => {
    const pid = {}, byName = {}, seen = new Set(); let np = 0, ns = 0, nd = 0;
    for (const p of D.products) {
      let bc = S(p.bc, 64).trim() || null;
      if (bc && seen.has(bc)) bc = null; seen.add(bc);
      const id = idOf(await trx('products').insert({
        shop_id: shopId, name: S(p.name) || 'Mahsulot', unit: UNITS.includes(p.unit) ? p.unit : 'dona',
        cost: Math.max(N(p.cost), 0.0001), pct: N(p.pct), qty: N(p.qty), min: N(p.min), width: N(p.w), barcode: bc, created_at: N(p.id, now()),
      }).returning('id'));
      pid[p.id] = id; byName[p.name] = id; np++;
    }
    if (Array.isArray(D.buys)) await trx.batchInsert('buys', D.buys.map((b) => ({ shop_id: shopId, name: S(b.name), amount: N(b.amount), created_at: N(b.t, now()) })), 100);
    if (Array.isArray(D.exp)) await trx.batchInsert('expenses', D.exp.map((e) => ({ shop_id: shopId, name: S(e.name, 100), amount: N(e.amount), created_at: N(e.t, now()) })), 100);

    const sid = {};
    for (const s of D.sales) {
      const items = (Array.isArray(s.items) ? s.items : []).filter((i) => N(i.qty) > 0);
      if (!items.length) continue;
      const total = items.reduce((a, i) => a + N(i.qty) * N(i.price), 0);
      const paid = s.pay != null ? Math.min(N(s.pay), total) : (s.debt && !s.paid ? 0 : total);
      const id = idOf(await trx('sales').insert({
        shop_id: shopId, seller_id: req.user.id, customer: S(s.cust, 100) || 'Mijoz', total, paid, created_at: N(s.t, now()),
      }).returning('id'));
      await trx.batchInsert('sale_items', items.map((i) => ({
        shop_id: shopId, sale_id: id, product_id: byName[i.name] || null, name: S(i.name),
        unit: UNITS.includes(i.unit) ? i.unit : 'dona', qty: N(i.qty), price: N(i.price), cost: N(i.cost),
      })), 100);
      sid[s.id] = id; ns++;
    }
    for (const d of Array.isArray(D.debts) ? D.debts : []) {
      const left = Math.max(N(d.amount), 0), paidAll = !!d.paid || left <= 0;
      const id = idOf(await trx('debts').insert({
        shop_id: shopId, sale_id: sid[d.sid] || null, name: S(d.name, 100) || 'Mijoz', phone: S(d.ph, 30) || null,
        total: N(d.total, left), amount: left, due: S(d.due, 10) || null, note: S(d.note, 60), paid: paidAll, created_at: N(d.t, now()),
      }).returning('id'));
      for (const p of Array.isArray(d.pays) ? d.pays : [])
        await trx('payments').insert({ shop_id: shopId, debt_id: id, amount: N(p.a), created_by: req.user.id, created_at: N(p.t, now()) });
      nd++;
    }
    if (D.set && typeof D.set === 'object') {
      const set = { lang: ['uz', 'ru', 'en'].includes(D.set.lang) ? D.set.lang : 'uz', sms: !!D.set.sms, days: N(D.set.days), tpl: S(D.set.tpl, 500) };
      if (!set.tpl) delete set.tpl;
      await trx('shops').where({ id: shopId }).update({ settings: JSON.stringify(set) });
    }
    return { products: np, sales: ns, debts: nd };
  });
  res.status(201).json(out);
});

const express = require('express');
const { db } = require('../db');
const { ApiError, h, num, str, idOf, now } = require('../util');

const r = express.Router();
const sp = (p) => Math.round(p.cost * (1 + p.pct / 100));

// Tannarx va foyda faqat adminga
const view = (s, items, debt, admin) => ({
  id: s.id, customer: s.customer, total: s.total, paid: s.paid, createdAt: s.created_at, sellerId: s.seller_id,
  items: items.map((i) => ({ name: i.name, unit: i.unit, qty: i.qty, price: i.price, ...(admin ? { cost: i.cost } : {}) })),
  ...(admin ? { profit: items.reduce((a, i) => a + i.qty * (i.price - i.cost), 0) } : {}),
  debt: debt ? { id: debt.id, remaining: debt.amount, paid: !!debt.paid, due: debt.due } : null,
});

async function load(shopId, rows, admin) {
  if (!rows.length) return [];
  const ids = rows.map((s) => s.id);
  const items = await db('sale_items').where({ shop_id: shopId }).whereIn('sale_id', ids).orderBy('id');
  const debts = await db('debts').where({ shop_id: shopId }).whereIn('sale_id', ids);
  return rows.map((s) => view(s, items.filter((i) => i.sale_id === s.id), debts.find((d) => d.sale_id === s.id), admin));
}

r.get('/', h(async (req, res) => {
  const admin = req.user.role === 'admin';
  const q = db('sales').where({ shop_id: req.user.shopId }).orderBy('id', 'desc')
    .limit(num(req.query.limit, { min: 1, max: 1000, def: 100 }));
  if (!admin) q.where({ seller_id: req.user.id }); // sotuvchi faqat o'zining sotuvlarini ko'radi
  if (req.query.before) q.where('created_at', '<', num(req.query.before));
  res.json(await load(req.user.shopId, await q, admin));
}));

r.get('/:id', h(async (req, res) => {
  const admin = req.user.role === 'admin';
  const q = db('sales').where({ id: +req.params.id, shop_id: req.user.shopId });
  if (!admin) q.where({ seller_id: req.user.id });
  const s = await q.first();
  if (!s) throw new ApiError(404, 'Sotuv topilmadi');
  res.json((await load(req.user.shopId, [s], admin))[0]);
}));

/* Sotish (savat). Narx, tannarx va qoldiq tekshiruvi SERVERDA:
   {customer, items:[{productId, qty, price}], credit:{paidNow, phone, due} | null} */
r.post('/', h(async (req, res) => {
  const admin = req.user.role === 'admin', shopId = req.user.shopId;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 100) throw new ApiError(400, "Savat bo'sh");
  const shop = await db('shops').where({ id: shopId }).first();
  const canPrice = admin || !!shop.seller_edit_price;
  const credit = req.body.credit || null;
  const customer = str(req.body.customer, { max: 100 });
  if (credit && !customer) throw new ApiError(400, 'Nasiyada mijoz ismini kiriting');

  const sale = await db.transaction(async (trx) => {
    const rows = []; let total = 0;
    for (const it of items) {
      const qty = num(it.qty, { min: 0.0001 });
      if (qty === undefined) throw new ApiError(400, 'Miqdorni kiriting');
      const p = await trx('products').where({ id: +it.productId, shop_id: shopId }).first();
      if (!p) throw new ApiError(404, 'Mahsulot topilmadi');
      let price = sp(p);
      if (canPrice && it.price !== undefined) { price = num(it.price, { min: 0.0001 }); }
      // atomik: qoldiq yetmasa 0 qator o'zgaradi (ikki xodim bir vaqtda sotsa ham to'qnashmaydi)
      const n = await trx('products').where({ id: p.id, shop_id: shopId }).andWhere('qty', '>=', qty)
        .update({ qty: trx.raw('qty - ?', [qty]) });
      if (!n) throw new ApiError(409, 'Omborda yetarli emas: ' + p.name);
      rows.push({ shop_id: shopId, product_id: p.id, name: p.name, unit: p.unit, qty, price, cost: p.cost });
      total += qty * price;
    }
    const paid = credit ? Math.min(Math.max(num(credit.paidNow, { min: 0, def: 0 }), 0), total) : total;
    const t = now();
    const id = idOf(await trx('sales').insert({
      shop_id: shopId, seller_id: req.user.id, customer: customer || 'Mijoz', total, paid, created_at: t,
    }).returning('id'));
    await trx('sale_items').insert(rows.map((x) => ({ ...x, sale_id: id })));
    if (credit && total - paid > 0) {
      await trx('debts').insert({
        shop_id: shopId, sale_id: id, name: customer, phone: str(credit.phone, { max: 30 }) || null,
        total, amount: total - paid, due: str(credit.due, { max: 10 }) || null,
        note: rows.map((x) => x.name).join(', ').slice(0, 60), paid: false, created_at: t,
      });
    }
    return trx('sales').where({ id }).first();
  });
  res.status(201).json((await load(shopId, [sale], admin))[0]);
}));

module.exports = r;

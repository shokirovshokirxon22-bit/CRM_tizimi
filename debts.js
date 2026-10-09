const express = require('express');
const { db } = require('../db');
const { ApiError, h, num, str, phone, idOf, now } = require('../util');

const r = express.Router();
const view = (d) => ({
  id: d.id, saleId: d.sale_id, name: d.name, phone: d.phone || '', total: d.total, remaining: d.amount,
  due: d.due || '', note: d.note || '', paid: !!d.paid, createdAt: d.created_at,
});

// Admin har doim; sotuvchi faqat admin ruxsat bergan bo'lsa (shops.seller_see_debts)
r.use(h(async (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const shop = await db('shops').where({ id: req.user.shopId }).first();
  if (!shop.seller_see_debts) throw new ApiError(403, 'Qarzdorlar bo\'limi sizga yopiq');
  next();
}));

r.get('/', h(async (req, res) => {
  res.json((await db('debts').where({ shop_id: req.user.shopId }).orderBy([{ column: 'paid' }, { column: 'due' }])).map(view));
}));

r.get('/:id/payments', h(async (req, res) => {
  const d = await db('debts').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
  if (!d) throw new ApiError(404, 'Qarz topilmadi');
  res.json(await db('payments').where({ debt_id: d.id, shop_id: req.user.shopId }).orderBy('id')
    .then((a) => a.map((p) => ({ id: p.id, amount: p.amount, createdAt: p.created_at }))));
}));

// Qo'lda qarz qo'shish faqat admin
r.post('/', h(async (req, res) => {
  if (req.user.role !== 'admin') throw new ApiError(403, 'Faqat admin uchun');
  const amount = num(req.body.amount, { min: 0.0001 });
  if (amount === undefined) throw new ApiError(400, 'Summani kiriting');
  const id = idOf(await db('debts').insert({
    shop_id: req.user.shopId, name: str(req.body.name, { req: true, max: 100 }),
    phone: req.body.phone ? phone(req.body.phone) : null, total: amount, amount,
    due: str(req.body.due, { max: 10 }) || null, note: str(req.body.note, { max: 60 }), paid: false, created_at: now(),
  }).returning('id'));
  res.status(201).json(view(await db('debts').where({ id }).first()));
}));

r.post('/:id/pay', h(async (req, res) => {
  const want = num(req.body.amount, { min: 0.0001 });
  if (want === undefined) throw new ApiError(400, 'Summani kiriting');
  const d = await db.transaction(async (trx) => {
    const d = await trx('debts').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
    if (!d) throw new ApiError(404, 'Qarz topilmadi');
    if (d.paid) throw new ApiError(409, "Qarz allaqachon to'langan");
    const a = Math.min(want, d.amount), left = d.amount - a;
    await trx('payments').insert({ shop_id: d.shop_id, debt_id: d.id, amount: a, created_by: req.user.id, created_at: now() });
    await trx('debts').where({ id: d.id }).update({ amount: left, paid: left <= 0 });
    return trx('debts').where({ id: d.id }).first();
  });
  res.json(view(d));
}));

module.exports = r;

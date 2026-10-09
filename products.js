const express = require('express');
const { db } = require('../db');
const { adminOnly } = require('../auth');
const { ApiError, h, num, str, idOf, now } = require('../util');

const r = express.Router();
const UNITS = ['m', 'dona', 'kg'];
const sp = (p) => p.cost * (1 + p.pct / 100);

// Sotuvchiga tannarx (cost) va foiz (pct) umuman yuborilmaydi
const view = (p, admin) => ({
  id: p.id, name: p.name, unit: p.unit, qty: p.qty, min: p.min, width: p.width,
  barcode: p.barcode || '', sellPrice: Math.round(sp(p)),
  ...(admin ? { cost: p.cost, pct: p.pct } : {}),
});

const parse = (b, partial) => {
  const o = {
    name: str(b.name, { req: true, max: 150 }),
    cost: num(b.cost, { min: 0.0001 }),
    pct: num(b.pct, { min: 0, def: 0 }),
    qty: num(b.qty, { min: 0, def: 0 }),
    min: num(b.min, { min: 0, def: 0 }),
    width: num(b.width, { min: 0, def: 0 }),
    barcode: str(b.barcode, { max: 64 }) || null,
  };
  if (o.cost === undefined) throw new ApiError(400, 'Narxni kiriting');
  if (!partial) {
    if (!UNITS.includes(b.unit)) throw new ApiError(400, "Birlik noto'g'ri");
    o.unit = b.unit;
  }
  return o;
};

const dupBarcode = async (shopId, barcode, exceptId) => {
  if (!barcode) return;
  const q = db('products').where({ shop_id: shopId, barcode });
  if (exceptId) q.whereNot({ id: exceptId });
  if (await q.first()) throw new ApiError(409, 'Bu shtrix-kod bilan mahsulot bor');
};

r.get('/', h(async (req, res) => {
  const q = db('products').where({ shop_id: req.user.shopId }).orderBy('name');
  if (req.query.barcode) q.where({ barcode: String(req.query.barcode) });
  if (req.query.q) q.whereRaw('LOWER(name) LIKE ?', [`%${String(req.query.q).toLowerCase()}%`]);
  const admin = req.user.role === 'admin';
  res.json((await q).map((p) => view(p, admin)));
}));

r.post('/', adminOnly, h(async (req, res) => {
  const o = parse(req.body, false);
  await dupBarcode(req.user.shopId, o.barcode);
  const p = await db.transaction(async (trx) => {
    const id = idOf(await trx('products').insert({ ...o, shop_id: req.user.shopId, created_at: now() }).returning('id'));
    if (o.qty > 0) await trx('buys').insert({ shop_id: req.user.shopId, name: o.name, amount: o.qty * o.cost, created_at: now() });
    return trx('products').where({ id }).first();
  });
  res.status(201).json(view(p, true));
}));

r.put('/:id', adminOnly, h(async (req, res) => {
  const old = await db('products').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
  if (!old) throw new ApiError(404, 'Mahsulot topilmadi');
  const o = parse(req.body, true);
  await dupBarcode(req.user.shopId, o.barcode, old.id);
  const p = await db.transaction(async (trx) => {
    await trx('products').where({ id: old.id, shop_id: req.user.shopId }).update(o);
    if (o.qty > old.qty) await trx('buys').insert({ shop_id: req.user.shopId, name: o.name, amount: (o.qty - old.qty) * o.cost, created_at: now() });
    return trx('products').where({ id: old.id }).first();
  });
  res.json(view(p, true));
}));

// Ombor to'ldirish: yangi tannarx va qo'shiladigan miqdor
r.post('/:id/restock', adminOnly, h(async (req, res) => {
  const qty = num(req.body.qty, { min: 0.0001 }), cost = num(req.body.cost, { min: 0.0001 });
  if (qty === undefined || cost === undefined) throw new ApiError(400, 'Miqdor va narxni kiriting');
  const p = await db.transaction(async (trx) => {
    const n = await trx('products').where({ id: +req.params.id, shop_id: req.user.shopId })
      .update({ cost, qty: trx.raw('qty + ?', [qty]) });
    if (!n) throw new ApiError(404, 'Mahsulot topilmadi');
    const p = await trx('products').where({ id: +req.params.id }).first();
    await trx('buys').insert({ shop_id: req.user.shopId, name: p.name, amount: qty * cost, created_at: now() });
    return p;
  });
  res.json(view(p, true));
}));

r.delete('/:id', adminOnly, h(async (req, res) => {
  const n = await db('products').where({ id: +req.params.id, shop_id: req.user.shopId }).del();
  if (!n) throw new ApiError(404, 'Mahsulot topilmadi');
  res.json({ ok: true });
}));

module.exports = r;
module.exports.sp = sp;

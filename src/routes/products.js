const express = require('express');
const { db } = require('../db');
const { adminOnly } = require('../auth');
const { ApiError, h, num, str, idOf, now } = require('../util');
const { audit, who, changes, fmtChanges } = require('../audit');

const PF = ['name', 'cost', 'pct', 'qty', 'min', 'width', 'barcode'];
const PL = { name: 'nom', cost: 'tannarx', pct: 'foiz', qty: 'qoldiq', min: 'minimal', width: 'eni', barcode: 'shtrix-kod' };
 
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
  await audit(who(req), { action: 'product.create', entity: 'product', entityId: p.id, summary: `Mahsulot qo'shildi: ${p.name} (${p.qty} ${p.unit}, tannarx ${p.cost}, foiz ${p.pct})`, data: { after: { name: p.name, unit: p.unit, qty: p.qty, cost: p.cost, pct: p.pct } } });
  res.status(201).json(view(p, true));
}));
 
r.put('/:id', adminOnly, h(async (req, res) => {
  const old = await db('products').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
  if (!old) throw new ApiError(404, 'Mahsulot topilmadi');
  const o = parse(req.body, true);
  await dupBarcode(req.user.shopId, o.barcode, old.id);
  // Forma ochilgan paytdagi qoldiq (qtyBase) yuborilsa, faqat FARQ qo'llanadi: shu orada sotilgan tovar qaytib ketmaydi.
  const base = req.body.qtyBase === undefined ? undefined : num(req.body.qtyBase, { min: 0 });
  const delta = base === undefined ? null : o.qty - base;
  const p = await db.transaction(async (trx) => {
    const upd = { ...o };
    if (delta !== null) delete upd.qty;
    const q = trx('products').where({ id: old.id, shop_id: req.user.shopId });
    if (delta !== null) {
      q.andWhere('qty', '>=', -delta); // qoldiq manfiy bo'lib qolmasin
      upd.qty = trx.raw('qty + ?', [delta]);
    }
    if (!(await q.update(upd))) throw new ApiError(409, "Qoldiq shu orada o'zgargan. Sahifani yangilab qayta urining");
    const cur = await trx('products').where({ id: old.id }).first();
    const added = delta !== null ? delta : o.qty - old.qty;
    if (added > 0) await trx('buys').insert({ shop_id: req.user.shopId, name: o.name, amount: added * o.cost, created_at: now() });
    return cur;
  });
  const ch = changes(old, p, PF);
  if (Object.keys(ch).length) await audit(who(req), { action: 'product.update', entity: 'product', entityId: p.id, summary: `${old.name}: ${fmtChanges(ch, PL)}`, data: { changes: ch } });
  res.json(view(p, true));
}));
 
// Ombor to'ldirish: yangi tannarx va qo'shiladigan miqdor
r.post('/:id/restock', adminOnly, h(async (req, res) => {
  const qty = num(req.body.qty, { min: 0.0001 }), cost = num(req.body.cost, { min: 0.0001 });
  if (qty === undefined || cost === undefined) throw new ApiError(400, 'Miqdor va narxni kiriting');
  const p = await db.transaction(async (trx) => {
    const before = await trx('products').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
    const n = await trx('products').where({ id: +req.params.id, shop_id: req.user.shopId })
      .update({ cost, qty: trx.raw('qty + ?', [qty]) });
    if (!n) throw new ApiError(404, 'Mahsulot topilmadi');
    const p = await trx('products').where({ id: +req.params.id }).first();
    await trx('buys').insert({ shop_id: req.user.shopId, name: p.name, amount: qty * cost, created_at: now() });
    return { p, before };
  });
  const { p: np, before } = p;
  await audit(who(req), { action: 'product.restock', entity: 'product', entityId: np.id, summary: `${np.name}: +${qty} qo'shildi (qoldiq ${before.qty} → ${np.qty}, tannarx ${before.cost} → ${np.cost})`, data: { qty, before: { qty: before.qty, cost: before.cost }, after: { qty: np.qty, cost: np.cost } } });
  res.json(view(np, true));
}));
 
r.delete('/:id', adminOnly, h(async (req, res) => {
  const old = await db('products').where({ id: +req.params.id, shop_id: req.user.shopId }).first();
  const n = await db('products').where({ id: +req.params.id, shop_id: req.user.shopId }).del();
  if (!n) throw new ApiError(404, 'Mahsulot topilmadi');
  await audit(who(req), { action: 'product.delete', entity: 'product', entityId: old.id, summary: `Mahsulot o'chirildi: ${old.name} (qoldiq ${old.qty} ${old.unit}, tannarx ${old.cost})`, data: { before: { name: old.name, qty: old.qty, cost: old.cost, pct: old.pct } } });
  res.json({ ok: true });
}));
 
module.exports = r;
module.exports.sp = sp;
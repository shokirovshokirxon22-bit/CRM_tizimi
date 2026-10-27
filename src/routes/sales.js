const express = require('express');
const { db } = require('../db');
const { ApiError, h, num, str, idOf, now } = require('../util');
const { audit, who } = require('../audit');

const r = express.Router();
const sp = (p) => Math.round(p.cost * (1 + p.pct / 100));

// Sotuvchi o'z sotuvini shu daqiqa ichida bekor qila oladi (xato qilsa tuzatish uchun). 0 = faqat admin.
const voidMinutes = () => (process.env.SELLER_VOID_MINUTES === undefined || process.env.SELLER_VOID_MINUTES === '' ? 15 : +process.env.SELLER_VOID_MINUTES || 0);
const canVoid = (s, user, debtPaid) => {
  if (s.voided_at) return false;
  if (user.role === 'admin') return true;
  const m = voidMinutes();
  return s.seller_id === user.id && m > 0 && now() - s.created_at <= m * 60000 && !debtPaid;
};

// Tannarx va foyda faqat adminga
const view = (s, items, debt, admin, can) => ({
  id: s.id, customer: s.customer, total: s.total, paid: s.paid, createdAt: s.created_at, sellerId: s.seller_id,
  items: items.map((i) => ({ name: i.name, unit: i.unit, qty: i.qty, price: i.price, ...(admin ? { cost: i.cost } : {}) })),
  ...(admin ? { profit: items.reduce((a, i) => a + i.qty * (i.price - i.cost), 0) } : {}),
  debt: debt ? { id: debt.id, remaining: debt.amount, paid: !!debt.paid, due: debt.due } : null,
  canVoid: !!can,
  ...(s.offline ? { offline: true } : {}),
  ...(s.voided_at ? { voided: true, voidedAt: s.voided_at, voidReason: s.void_reason || '' } : {}),
});

async function load(user, rows) {
  if (!rows.length) return [];
  const shopId = user.shopId, admin = user.role === 'admin';
  const ids = rows.map((s) => s.id);
  const items = await db('sale_items').where({ shop_id: shopId }).whereIn('sale_id', ids).orderBy('id');
  const debts = await db('debts').where({ shop_id: shopId }).whereIn('sale_id', ids);
  const paidDebts = new Set(debts.length ? (await db('payments').where({ shop_id: shopId }).whereIn('debt_id', debts.map((d) => d.id)).select('debt_id')).map((p) => p.debt_id) : []);
  return rows.map((s) => {
    const debt = debts.find((d) => d.sale_id === s.id);
    return view(s, items.filter((i) => i.sale_id === s.id), debt, admin, canVoid(s, user, debt && paidDebts.has(debt.id)));
  });
}

r.get('/', h(async (req, res) => {
  const admin = req.user.role === 'admin';
  const q = db('sales').where({ shop_id: req.user.shopId }).orderBy('id', 'desc')
    .limit(num(req.query.limit, { min: 1, max: 1000, def: 100 }));
  if (!admin) q.where({ seller_id: req.user.id }); // sotuvchi faqat o'zining sotuvlarini ko'radi
  // Bekor qilingan sotuvlar odatda ko'rinmaydi (hisob-kitobga kirmaydi). Admin ?voided=1 bilan ularning tarixini ko'ra oladi.
  if (admin && req.query.voided === '1') q.whereNotNull('voided_at'); else q.whereNull('voided_at');
  if (req.query.before) q.where('created_at', '<', num(req.query.before));
  res.json(await load(req.user, await q));
}));

r.get('/:id', h(async (req, res) => {
  const admin = req.user.role === 'admin';
  const q = db('sales').where({ id: +req.params.id, shop_id: req.user.shopId });
  if (!admin) q.where({ seller_id: req.user.id }).whereNull('voided_at');
  const s = await q.first();
  if (!s) throw new ApiError(404, 'Sotuv topilmadi');
  res.json((await load(req.user, [s]))[0]);
}));

/* Sotish (savat). Narx, tannarx va qoldiq tekshiruvi SERVERDA:
   {customer, items:[{productId, qty, price}], credit:{paidNow, phone, due} | null}

   Oflayn sotuv (internet yo'qligida qurilmada saqlanib, keyin yuboriladi):
   {..., clientId, offline:true, createdAt, items:[{..., seen}]}
   - clientId: qurilma bergan noyob ID. Bir xil clientId qayta kelsa sotuv ikkinchi marta yozilmaydi,
     avvalgisi qaytariladi (javob yo'lda yo'qolgan bo'lsa ham xavfsiz).
   - Tovar mijozga allaqachon berilgan, shuning uchun qoldiq yetmasa ham sotuv yoziladi (qoldiq minusga ketishi mumkin)
     va javobda `warnings` qaytadi. Narx baribir SERVER hisoblaydi (sotuvchiga ishonilmaydi);
     qurilma ko'rgan narx (`seen`) bilan farq bo'lsa ham ogohlantirish chiqadi.
   - createdAt: sotuv haqiqatda qilingan vaqt (faqat oflayn sotuvda, oxirgi 30 kun ichida va kelajakda emas). */
const OFFLINE_MAX_AGE = 30 * 24 * 3600 * 1000, CLOCK_SKEW = 5 * 60 * 1000;

r.post('/', h(async (req, res) => {
  const admin = req.user.role === 'admin', shopId = req.user.shopId;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 100) throw new ApiError(400, "Savat bo'sh");
  const clientId = str(req.body.clientId, { max: 64 }) || null;
  const offline = !!clientId && req.body.offline === true;

  // Idempotentlik: shu clientId bilan sotuv allaqachon yozilgan bo'lsa, yangisini yaratmaymiz
  const existing = async () => {
    if (!clientId) return null;
    const ex = await db('sales').where({ shop_id: shopId, client_id: clientId }).first();
    if (!ex) return null;
    if (ex.seller_id !== req.user.id) throw new ApiError(409, 'Bu sotuv ID si band');
    return ex;
  };
  const dup = await existing();
  if (dup) return res.status(200).json((await load(req.user, [dup]))[0]);

  const shop = await db('shops').where({ id: shopId }).first();
  const canPrice = admin || !!shop.seller_edit_price;
  const credit = req.body.credit || null;
  const customer = str(req.body.customer, { max: 100 });
  if (credit && !customer) throw new ApiError(400, 'Nasiyada mijoz ismini kiriting');

  const warnings = [], overrides = [];
  let sale;
  try {
    sale = await db.transaction(async (trx) => {
      const rows = []; let total = 0;
      for (const it of items) {
        const qty = num(it.qty, { min: 0.0001 });
        if (qty === undefined) throw new ApiError(400, 'Miqdorni kiriting');
        const p = await trx('products').where({ id: +it.productId, shop_id: shopId }).first();
        if (!p) throw new ApiError(404, offline ? "Mahsulot topilmadi (o'chirilgan bo'lishi mumkin)" : 'Mahsulot topilmadi');
        let price = sp(p);
        const listPrice = price;
        if (canPrice && it.price !== undefined) { price = num(it.price, { min: 0.0001 }); }
        if (Math.abs(price - listPrice) > 0.5) overrides.push({ name: p.name, qty, list: Math.round(listPrice), price });
        if (offline) {
          // tovar allaqachon berilgan: qoldiq tekshirilmaydi, lekin kamchilik haqida ogohlantiramiz
          await trx('products').where({ id: p.id, shop_id: shopId }).update({ qty: trx.raw('qty - ?', [qty]) });
          if (p.qty < qty) warnings.push(`Omborda yetarli emas edi: ${p.name} (omborda ${p.qty}, sotildi ${qty})`);
          const seen = Number(it.seen); // ixtiyoriy ma'lumot: noto'g'ri bo'lsa sotuvni rad etmaymiz
          if (it.seen !== undefined && Number.isFinite(seen) && Math.abs(seen - price) > 0.5) warnings.push(`Narx o'zgargan: ${p.name} (qurilmada ${Math.round(seen)}, serverda ${Math.round(price)})`);
        } else {
          // atomik: qoldiq yetmasa 0 qator o'zgaradi (ikki xodim bir vaqtda sotsa ham to'qnashmaydi)
          const n = await trx('products').where({ id: p.id, shop_id: shopId }).andWhere('qty', '>=', qty)
            .update({ qty: trx.raw('qty - ?', [qty]) });
          if (!n) throw new ApiError(409, 'Omborda yetarli emas: ' + p.name);
        }
        rows.push({ shop_id: shopId, product_id: p.id, name: p.name, unit: p.unit, qty, price, cost: p.cost });
        total += qty * price;
      }
      const paid = credit ? Math.min(Math.max(num(credit.paidNow, { min: 0, def: 0 }), 0), total) : total;
      let t = now();
      if (offline) { // haqiqiy sotuv vaqti: faqat oflayn sotuvda va oqilona oraliqda
        const ca = Number(req.body.createdAt);
        if (Number.isFinite(ca) && ca <= t + CLOCK_SKEW && ca >= t - OFFLINE_MAX_AGE) t = Math.round(Math.min(ca, t));
      }
      const id = idOf(await trx('sales').insert({
        shop_id: shopId, seller_id: req.user.id, customer: customer || 'Mijoz', total, paid, created_at: t,
        client_id: clientId, offline,
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
  } catch (e) {
    // Ikki bir xil so'rov bir vaqtda kelib, unique indeksga urilgan bo'lsa: g'olibning sotuvini qaytaramiz
    const dup2 = clientId && !(e instanceof ApiError) ? await existing() : null;
    if (!dup2) throw e;
    return res.status(200).json((await load(req.user, [dup2]))[0]);
  }
  const out = (await load(req.user, [sale]))[0];
  // Tarix: narx o'zgartirilgan yoki oflayn sotuvda qoldiq yetmagan sotuvlar (ombor yetishmovchiligini topish uchun)
  if (overrides.length) await audit(who(req), { action: 'sale.price', entity: 'sale', entityId: sale.id, summary: `Sotuv #${sale.id}: narx o'zgartirildi: ` + overrides.map((o) => `${o.name} ${o.list} → ${o.price} (×${o.qty})`).join(', '), data: { overrides } });
  if (offline && warnings.length) await audit(who(req), { action: 'sale.offline', entity: 'sale', entityId: sale.id, summary: `Sotuv #${sale.id} (oflayn): ` + warnings.join('; '), data: { warnings } });
  res.status(201).json(warnings.length ? { ...out, warnings } : out);
}));

/* Sotuvni bekor qilish: mahsulotlar omborga qaytadi, shu sotuvning qarzi (bo'lsa) o'chadi, sotuv hisobotlardan chiqadi.
   Admin: istalgan sotuvni. Sotuvchi: faqat o'zining sotuvini, SELLER_VOID_MINUTES (default 15) daqiqa ichida va qarz bo'yicha to'lov olinmagan bo'lsa. */
r.post('/:id/void', h(async (req, res) => {
  const admin = req.user.role === 'admin', shopId = req.user.shopId;
  const reason = str((req.body || {}).reason, { max: 200 });
  const out = await db.transaction(async (trx) => {
    const q = trx('sales').where({ id: +req.params.id, shop_id: shopId });
    if (!admin) q.where({ seller_id: req.user.id });
    const s = await q.first();
    if (!s) throw new ApiError(404, 'Sotuv topilmadi');
    if (s.voided_at) throw new ApiError(409, 'Sotuv allaqachon bekor qilingan');
    const debt = await trx('debts').where({ sale_id: s.id, shop_id: shopId }).first();
    const hasPays = debt ? !!(await trx('payments').where({ debt_id: debt.id }).first()) : false;
    if (!admin) {
      const m = voidMinutes();
      if (m <= 0 || now() - s.created_at > m * 60000) throw new ApiError(403, `Sotuvchi sotuvni faqat ${m} daqiqa ichida bekor qila oladi. Admin bilan bog'laning`);
      if (hasPays) throw new ApiError(403, "Bu sotuv qarzi bo'yicha to'lov qabul qilingan. Faqat admin bekor qila oladi");
    }
    // Avval belgilaymiz (faqat bekor qilinmagan bo'lsa): ikki marta bosilsa ombor ikki marta to'lmaydi
    const marked = await trx('sales').where({ id: s.id }).whereNull('voided_at')
      .update({ voided_at: now(), voided_by: req.user.id, void_reason: reason || null });
    if (!marked) throw new ApiError(409, 'Sotuv allaqachon bekor qilingan');
    if (debt) {
      await trx('payments').where({ debt_id: debt.id }).del();
      await trx('debts').where({ id: debt.id }).del();
    }
    let restored = 0, skipped = 0;
    for (const i of await trx('sale_items').where({ sale_id: s.id, shop_id: shopId })) {
      const n = i.product_id ? await trx('products').where({ id: i.product_id, shop_id: shopId }).update({ qty: trx.raw('qty + ?', [i.qty]) }) : 0;
      if (n) restored++; else skipped++; // mahsulot keyin o'chirilgan bo'lsa, qaytaradigan joy yo'q
    }
    return { restored, skipped, sale: { id: s.id, total: s.total, customer: s.customer, sellerId: s.seller_id } };
  });
  const { sale: vs, ...vout } = out;
  await audit(who(req), { action: 'sale.void', entity: 'sale', entityId: vs.id, summary: `Sotuv #${vs.id} bekor qilindi (${vs.customer}, ${vs.total} so'm)` + (reason ? `. Sabab: ${reason}` : ''), data: { total: vs.total, sellerId: vs.sellerId, reason: reason || null, ...vout } });
  res.json({ ok: true, ...vout });
}));

module.exports = r;

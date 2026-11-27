// Obuna (tarif) mantiqi. Hamma hisob-kitob SERVER vaqti bilan qilinadi: foydalanuvchi qurilma soatini
// surib obunani cho'za olmaydi. To'lov tizimlari (Payme, Click) va qo'lda berish (owner paneli) shu fayldagi
// bitta yo'ldan o'tadi: applyPaid() / reverseOrder().
const { db, isPg } = require('./db');
const { ApiError, h, idOf, now } = require('./util');
const { audit } = require('./audit');

const DAY = 86400000;
const RESERVE_MS = 30 * 60 * 1000; // umrbod tarif uchun to'lov paytida joy ushlab turish

/* ---------- Holat ---------- */
function statusOf(shop, t = now()) {
  if (shop.lifetime) return { ok: true, state: 'lifetime', plan: shop.plan, until: null, daysLeft: null, remind: 0, lifetime: true, serverTime: t };
  const until = Number(shop.sub_until) || 0;
  const ok = t < until;
  const daysLeft = ok ? Math.ceil((until - t) / DAY) : 0;
  return {
    ok, state: ok ? (shop.plan === 'trial' ? 'trial' : 'active') : 'expired', plan: shop.plan, until, daysLeft,
    remind: !ok ? 0 : daysLeft <= 1 ? 1 : daysLeft <= 5 ? 5 : 0, // 5 va 1 kun qolganda eslatma
    lifetime: false, serverTime: t,
  };
}
const shopStatus = async (shopId) => {
  const shop = await db('shops').where({ id: shopId }).first();
  return shop ? statusOf(shop) : null;
};

/* ---------- Himoya: obunasi tugagan do'kon ma'lumotlariga kirish yopiladi (402) ----------
   Har bir so'rovda do'kon bazadan o'qiladi: to'lov kelishi bilan blok darrov ochiladi. Xodimlar ham shu do'kon obunasiga bo'ysunadi. */
const gate = h(async (req, res, next) => {
  const shop = await db('shops').where({ id: req.user.shopId }).first();
  const st = shop && statusOf(shop);
  if (!st || !st.ok) {
    throw new ApiError(402, req.user.role === 'admin' ? "Obuna muddati tugagan. Davom etish uchun to'lov qiling" : "Obuna muddati tugagan. Administratorga murojaat qiling", 'SUB_EXPIRED');
  }
  req.sub = st;
  next();
});

/* ---------- Bir vaqtda ishlashdan himoya (Postgres) ---------- */
const lock = async (trx) => { if (isPg) await trx.raw('select pg_advisory_xact_lock(7461001)'); };

/* ---------- Tariflar ---------- */
const soldLifetime = async (trx, exceptId = 0) =>
  Number((await trx('orders').where({ kind: 'lifetime', state: 'paid' }).whereNot({ id: exceptId }).count({ c: '*' }).first()).c);
const reservedLifetime = async (trx, exceptId = 0, t = now()) =>
  Number((await trx('orders').where({ kind: 'lifetime', state: 'new' }).where('reserved_until', '>', t).whereNot({ id: exceptId }).count({ c: '*' }).first()).c);
const slotsLeft = async (trx, plan, exceptId = 0) =>
  Math.max(0, (plan.max_slots || 0) - (await soldLifetime(trx, exceptId)) - (await reservedLifetime(trx, exceptId)));

const pubPlan = (p, left) => ({ code: p.code, name: p.name, kind: p.kind, days: p.days, price: Number(p.price), ...(p.kind === 'lifetime' ? { left } : {}) });

// Shu do'kon uchun umrbod tarifdan nechta joy qolgan. Do'konning O'ZI ushlab turgan (to'lanmagan) buyurtmasi joyni egallamagan hisoblanadi.
async function leftFor(trx, plan, shopId) {
  let left = await slotsLeft(trx, plan);
  if (shopId) for (const o of await trx('orders').where({ shop_id: shopId, plan_code: plan.code, state: 'new' }).select('id')) left = Math.max(left, await slotsLeft(trx, plan, o.id));
  return left;
}

// Sotib olish mumkin bo'lgan tariflar. Umrbod tarif joylari tugagan bo'lsa ro'yxatdan chiqib ketadi.
async function listPlans(shopId = null) {
  const rows = await db('plans').where({ active: true }).whereNot({ kind: 'trial' }).orderBy('sort');
  const out = [];
  for (const p of rows) {
    if (p.kind === 'lifetime') { const left = await leftFor(db, p, shopId); if (left > 0) out.push(pubPlan(p, left)); } else out.push(pubPlan(p));
  }
  return out;
}

/* ---------- Buyurtma ---------- */
async function createOrder(shopId, planCode, provider, userId = null) {
  return db.transaction(async (trx) => {
    await lock(trx);
    const shop = await trx('shops').where({ id: shopId }).first();
    if (!shop) throw new ApiError(404, 'Do\'kon topilmadi');
    if (shop.lifetime) throw new ApiError(409, 'Sizda umrbod tarif bor, to\'lov kerak emas');
    const plan = await trx('plans').where({ code: String(planCode || '') }).first();
    if (!plan || !plan.active || plan.kind === 'trial') throw new ApiError(400, 'Tarif topilmadi');
    if (!(Number(plan.price) > 0)) throw new ApiError(400, 'Bu tarif hozir sotilmaydi');
    const t = now();
    let reserved = null;
    if (plan.kind === 'lifetime') {
      if ((await leftFor(trx, plan, shopId)) <= 0) throw new ApiError(409, 'Umrbod tarif tugagan');
      reserved = t + RESERVE_MS;
    }
    // Tez-tez bosilganda buyurtmalar ko'payib ketmasligi uchun yaqinda ochilgan bir xil buyurtma qayta ishlatiladi
    const same = await trx('orders').where({ shop_id: shopId, plan_code: plan.code, provider, state: 'new', amount: plan.price })
      .where('created_at', '>', t - 10 * 60 * 1000).orderBy('id', 'desc').first();
    if (same) {
      if (reserved) await trx('orders').where({ id: same.id }).update({ reserved_until: reserved });
      return { ...same, reserved_until: reserved || same.reserved_until };
    }
    const id = idOf(await trx('orders').insert({
      shop_id: shopId, shop_name: String(shop.name || '').slice(0, 100), plan_code: plan.code, kind: plan.kind, days: plan.days,
      amount: plan.price, provider, state: 'new', reserved_until: reserved, created_by: userId, created_at: t,
    }).returning('id'));
    return trx('orders').where({ id }).first();
  });
}

/* ---------- To'lov qabul qilindi: obunani berish ----------
   Faqat db.transaction ichida chaqiriladi. Natija: { ok, order } yoki { ok:false, reason }. */
async function applyPaid(trx, orderId) {
  await lock(trx);
  const order = await trx('orders').where({ id: orderId }).first();
  if (!order) return { ok: false, reason: 'no_order' };
  if (order.state === 'paid') return { ok: true, order, already: true };
  if (order.state !== 'new') return { ok: false, reason: 'bad_state' };
  const shop = await trx('shops').where({ id: order.shop_id }).first();
  if (!shop) return { ok: false, reason: 'no_shop' };
  const t = now();
  const upd = { state: 'paid', paid_at: t, prev_plan: shop.plan };
  if (order.kind === 'lifetime') {
    const plan = await trx('plans').where({ code: order.plan_code }).first();
    if ((await soldLifetime(trx, order.id)) >= ((plan && plan.max_slots) || 0)) return { ok: false, reason: 'no_slot' };
    await trx('shops').where({ id: shop.id }).update({ lifetime: true, plan: order.plan_code });
  } else {
    // Muddati tugamagan bo'lsa qolgan kunlar yo'qolmaydi: yangi muddat eski tugash sanasidan boshlanadi
    const ms = order.days * DAY, base = Math.max(Number(shop.sub_until) || 0, t);
    upd.granted_ms = ms;
    await trx('shops').where({ id: shop.id }).update({ sub_until: base + ms, plan: order.plan_code });
  }
  await trx('orders').where({ id: order.id }).update(upd);
  return { ok: true, order: { ...order, ...upd } };
}

// Payme to'lovni qaytarsa (CancelTransaction, state 2): berilgan obuna ham qaytariladi
async function reverseOrder(trx, orderId) {
  await lock(trx);
  const order = await trx('orders').where({ id: orderId }).first();
  if (!order || order.state !== 'paid') return;
  const shop = await trx('shops').where({ id: order.shop_id }).first();
  if (shop) {
    if (order.kind === 'lifetime') await trx('shops').where({ id: shop.id }).update({ lifetime: false, plan: order.prev_plan || 'trial' });
    else await trx('shops').where({ id: shop.id }).update({ sub_until: Math.max(0, (Number(shop.sub_until) || 0) - (Number(order.granted_ms) || 0)) });
  }
  await trx('orders').where({ id: order.id }).update({ state: 'refunded' });
}

// Tranzaksiya yopilgach: faoliyat tarixiga yozuv (asosiy amalni to'xtatmaydi)
const PROV = { payme: 'Payme', click: 'Click', manual: "qo'lda" };
async function afterPaid(order, summaryPrefix = 'Obuna') {
  await audit({ shopId: order.shop_id, userName: "To'lov tizimi" }, {
    action: 'billing.paid', entity: 'billing', entityId: order.id,
    summary: `${summaryPrefix}: ${order.plan_code} · ${Number(order.amount).toLocaleString('en-US').replace(/,/g, ' ')} so'm (${PROV[order.provider] || order.provider})`,
  });
}

/* ---------- Qo'lda berish (owner paneli: naqd, o'tkazma va h.k.) ---------- */
async function manualGrant(shopId, { planCode, days, note }) {
  const out = await db.transaction(async (trx) => {
    await lock(trx);
    const shop = await trx('shops').where({ id: shopId }).first();
    if (!shop) throw new ApiError(404, "Do'kon topilmadi");
    let plan = null;
    if (planCode) {
      plan = await trx('plans').where({ code: String(planCode) }).first();
      if (!plan || plan.kind === 'trial') throw new ApiError(400, 'Tarif topilmadi');
    }
    const d = plan ? plan.days : Math.floor(Number(days));
    if (!plan && !(d >= 1 && d <= 3650)) throw new ApiError(400, "Kunlar 1 dan 3650 gacha bo'lsin");
    const kind = plan ? plan.kind : 'period';
    if (kind === 'lifetime') {
      // Qo'lda ham umrbod joy ichida: limitdan oshib ketmasin
      if ((await soldLifetime(trx)) >= (plan.max_slots || 0)) throw new ApiError(409, 'Umrbod tarif joylari tugagan');
    }
    const id = idOf(await trx('orders').insert({
      shop_id: shop.id, shop_name: String(shop.name || '').slice(0, 100), plan_code: plan ? plan.code : 'manual', kind, days: d || 0,
      amount: 0, provider: 'manual', state: 'new', note: String(note || '').slice(0, 200) || null, created_at: now(),
    }).returning('id'));
    const r = await applyPaid(trx, id);
    if (!r.ok) throw new ApiError(409, "Berib bo'lmadi: " + r.reason);
    return r.order;
  });
  await afterPaid(out, 'Obuna (qo\'lda)');
  return out;
}

module.exports = { DAY, gate, statusOf, shopStatus, lock, listPlans, createOrder, applyPaid, reverseOrder, afterPaid, manualGrant, slotsLeft, soldLifetime };

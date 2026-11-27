// Payme Merchant API (Payme serverlari bizning serverga JSON-RPC so'rov yuboradi).
// Hujjat: https://developer.help.paycom.uz  |  Endpoint: POST /api/pay/payme
// Sozlash: PAYME_MERCHANT_ID, PAYME_KEY (sinovda PAYME_KEY o'rniga TEST KEY qo'yiladi).
// Xavfsizlik: Basic auth (Paycom:KEY) doim doimiy-vaqtli taqqoslanadi; summa va buyurtma har safar bazadan tekshiriladi;
// takroriy so'rovlarga bir xil javob qaytadi (Payme so'rovni qayta yuborishi mumkin).
const crypto = require('crypto');
const { db } = require('../db');
const billing = require('../billing');
const { now } = require('../util');

const TIMEOUT = 12 * 60 * 60 * 1000; // Payme: tranzaksiya 12 soat ichida tugallanmasa bekor qilinadi
const M = {
  auth: { ru: 'Недостаточно привилегий для выполнения метода', uz: 'Metodni bajarish uchun huquq yetarli emas', en: 'Insufficient privileges to perform this method' },
  method: { ru: 'Метод не найден', uz: 'Metod topilmadi', en: 'Method not found' },
  system: { ru: 'Системная ошибка', uz: 'Tizim xatosi', en: 'System error' },
  amount: { ru: 'Неверная сумма', uz: "Noto'g'ri summa", en: 'Invalid amount' },
  order: { ru: 'Заказ не найден', uz: 'Buyurtma topilmadi', en: 'Order not found' },
  state: { ru: 'Невозможно выполнить операцию', uz: "Amalni bajarib bo'lmaydi", en: 'Unable to perform the operation' },
  notfound: { ru: 'Транзакция не найдена', uz: 'Tranzaksiya topilmadi', en: 'Transaction not found' },
  params: { ru: 'Неверные параметры', uz: "Noto'g'ri parametrlar", en: 'Invalid parameters' },
};
class Rpc extends Error { constructor(code, key, data) { super(key); this.code = code; this.msg = M[key]; this.data = data; } }
const E = {
  auth: () => new Rpc(-32504, 'auth'),
  amount: () => new Rpc(-31001, 'amount'),
  order: () => new Rpc(-31050, 'order', 'order_id'),
  state: () => new Rpc(-31008, 'state'),
  notfound: () => new Rpc(-31003, 'notfound'),
};

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function checkAuth(req) {
  const key = process.env.PAYME_KEY;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!key || !m || !eq(Buffer.from(m[1], 'base64').toString(), 'Paycom:' + key)) throw E.auth();
}

const out = (tx) => ({
  create_time: Number(tx.create_time), perform_time: Number(tx.perform_time) || 0, cancel_time: Number(tx.cancel_time) || 0,
  transaction: String(tx.id), state: tx.state, reason: tx.reason === undefined || tx.reason === null ? null : tx.reason,
});
const expired = (tx, t = now()) => t - Number(tx.create_time) > TIMEOUT;

// Buyurtmani tekshirish (CheckPerformTransaction va CreateTransaction uchun umumiy)
async function validate(trx, p) {
  const raw = p && p.account && p.account.order_id;
  if (!/^\d{1,12}$/.test(String(raw === undefined || raw === null ? '' : raw))) throw E.order();
  const order = await trx('orders').where({ id: +raw }).first();
  if (!order || order.provider !== 'payme' || !(await trx('shops').where({ id: order.shop_id }).first())) throw E.order();
  if (!Number.isInteger(p.amount) || p.amount !== Number(order.amount) * 100) throw E.amount();
  if (order.state !== 'new') throw E.state();
  return order;
}
const cancelTx = (trx, tx, reason, state = -1) => trx('payme_tx').where({ id: tx.id }).update({ state, cancel_time: now(), reason });

// Soliq (fiskal chek) ma'lumoti: PAYME_IKPU va PAYME_PACKAGE_CODE berilgan bo'lsa chek tavsifi qo'shiladi
async function detailFor(order) {
  const code = process.env.PAYME_IKPU, pack = process.env.PAYME_PACKAGE_CODE;
  if (!code || !pack) return undefined;
  const plan = await db('plans').where({ code: order.plan_code }).first();
  return { receipt_type: 0, items: [{ title: `Mizan: ${plan ? plan.name : order.plan_code}`.slice(0, 128), price: Number(order.amount) * 100, count: 1, code, package_code: pack, vat_percent: +process.env.PAYME_VAT || 0 }] };
}

const METHODS = {
  async CheckPerformTransaction(p) {
    const order = await validate(db, p);
    if (await db('payme_tx').where({ order_id: order.id, state: 1 }).first()) throw E.state(); // boshqa tranzaksiya kutilmoqda
    const detail = await detailFor(order);
    return detail ? { allow: true, detail } : { allow: true };
  },

  async CreateTransaction(p) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 40 || !Number.isFinite(p.time)) throw new Rpc(-32602, 'params');
    const r = await db.transaction(async (trx) => {
      await billing.lock(trx);
      const found = await trx('payme_tx').where({ payme_id: p.id }).first();
      if (found) {
        if (found.state !== 1) return { err: E.state() };
        if (expired(found)) { await cancelTx(trx, found, 4); return { err: E.state() }; } // xato qaytariladi, lekin bekor qilish saqlanadi
        return { tx: found };
      }
      const order = await validate(trx, p);
      const active = await trx('payme_tx').where({ order_id: order.id, state: 1 }).first();
      if (active) {
        if (!expired(active)) return { err: E.state() };
        await cancelTx(trx, active, 4);
      }
      const t = now();
      await trx('payme_tx').insert({ payme_id: p.id, order_id: order.id, amount: p.amount, time: p.time, state: 1, create_time: t });
      if (order.kind === 'lifetime') await trx('orders').where({ id: order.id }).update({ reserved_until: t + 30 * 60 * 1000 });
      return { tx: await trx('payme_tx').where({ payme_id: p.id }).first() };
    });
    if (r.err) throw r.err;
    return { create_time: Number(r.tx.create_time), transaction: String(r.tx.id), state: 1 };
  },

  async PerformTransaction(p) {
    const r = await db.transaction(async (trx) => {
      await billing.lock(trx);
      const tx = p && p.id ? await trx('payme_tx').where({ payme_id: String(p.id) }).first() : null;
      if (!tx) return { err: E.notfound() };
      if (tx.state === 2) return { tx };
      if (tx.state !== 1) return { err: E.state() };
      if (expired(tx)) { await cancelTx(trx, tx, 4); return { err: E.state() }; }
      const res = await billing.applyPaid(trx, tx.order_id);
      if (!res.ok || res.already) { await cancelTx(trx, tx, 10); return { err: E.state() }; } // masalan: umrbod tarif joyi tugagan, pul Payme tomonidan qaytariladi
      await trx('payme_tx').where({ id: tx.id }).update({ state: 2, perform_time: now() });
      return { tx: await trx('payme_tx').where({ id: tx.id }).first(), paid: res.already ? null : res.order };
    });
    if (r.err) throw r.err;
    if (r.paid) await billing.afterPaid(r.paid);
    return { transaction: String(r.tx.id), perform_time: Number(r.tx.perform_time), state: 2 };
  },

  async CancelTransaction(p) {
    const r = await db.transaction(async (trx) => {
      await billing.lock(trx);
      const tx = p && p.id ? await trx('payme_tx').where({ payme_id: String(p.id) }).first() : null;
      if (!tx) return { err: E.notfound() };
      if (tx.state === 1) await cancelTx(trx, tx, +p.reason || null, -1);
      else if (tx.state === 2) { await billing.reverseOrder(trx, tx.order_id); await cancelTx(trx, tx, +p.reason || null, -2); }
      return { tx: await trx('payme_tx').where({ id: tx.id }).first() };
    });
    if (r.err) throw r.err;
    return { transaction: String(r.tx.id), cancel_time: Number(r.tx.cancel_time), state: r.tx.state };
  },

  async CheckTransaction(p) {
    const tx = p && p.id ? await db('payme_tx').where({ payme_id: String(p.id) }).first() : null;
    if (!tx) throw E.notfound();
    return out(tx);
  },

  async GetStatement(p) {
    if (!p || !Number.isFinite(p.from) || !Number.isFinite(p.to)) throw new Rpc(-32602, 'params');
    const rows = await db('payme_tx').whereBetween('time', [p.from, p.to]).orderBy('time');
    return { transactions: rows.map((tx) => ({ id: tx.payme_id, time: Number(tx.time), amount: Number(tx.amount), account: { order_id: String(tx.order_id) }, ...out(tx) })) };
  },
};

async function handler(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = body.id === undefined ? null : body.id;
  try {
    checkAuth(req);
    const fn = Object.prototype.hasOwnProperty.call(METHODS, body.method) ? METHODS[body.method] : null;
    if (!fn) throw new Rpc(-32601, 'method', body.method);
    res.json({ jsonrpc: '2.0', id, result: await fn(body.params || {}) });
  } catch (e) {
    if (e instanceof Rpc) return res.json({ jsonrpc: '2.0', id, error: { code: e.code, message: e.msg, ...(e.data ? { data: e.data } : {}) } });
    console.error('[payme]', e);
    res.json({ jsonrpc: '2.0', id, error: { code: -32400, message: M.system } });
  }
}

const configured = () => !!(process.env.PAYME_MERCHANT_ID && process.env.PAYME_KEY);
// Mijozni Payme to'lov sahifasiga yuboradigan havola
function checkoutUrl(order, lang, returnUrl) {
  const parts = [`m=${process.env.PAYME_MERCHANT_ID}`, `ac.order_id=${order.id}`, `a=${Number(order.amount) * 100}`, `l=${['uz', 'ru', 'en'].includes(lang) ? lang : 'uz'}`, 'cr=860'];
  if (returnUrl) parts.push(`c=${returnUrl}`);
  const base = process.env.PAYME_TEST === '1' ? 'https://test.paycom.uz' : 'https://checkout.paycom.uz';
  return `${base}/${Buffer.from(parts.join(';')).toString('base64')}`;
}

module.exports = { handler, configured, checkoutUrl, TIMEOUT };

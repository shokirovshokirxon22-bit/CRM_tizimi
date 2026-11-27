// Click SHOP-API (Click serverlari bizning serverga Prepare va Complete so'rovlarini yuboradi).
// Endpoint: POST /api/pay/click/prepare va /api/pay/click/complete (ikkalasi ham bitta handler: action 0 = prepare, 1 = complete)
// Sozlash: CLICK_SERVICE_ID, CLICK_MERCHANT_ID, CLICK_SECRET_KEY.
// Xavfsizlik: har bir so'rov MD5 imzo bilan tekshiriladi (doimiy-vaqtli taqqoslash), summa va buyurtma bazadan solishtiriladi.
const crypto = require('crypto');
const { db } = require('../db');
const billing = require('../billing');

const ERR = {
  OK: [0, 'Success'], SIGN: [-1, 'SIGN CHECK FAILED!'], AMOUNT: [-2, 'Incorrect parameter amount'], ACTION: [-3, 'Action not found'],
  PAID: [-4, 'Already paid'], NOUSER: [-5, 'User does not exist'], NOTX: [-6, 'Transaction does not exist'],
  UPDATE: [-7, 'Failed to update user'], REQ: [-8, 'Error in request from click'], CANCEL: [-9, 'Transaction cancelled'],
};
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const S = (v) => (v === undefined || v === null ? '' : String(v));

function reply(res, q, e, extra = {}) {
  res.json({ click_trans_id: q.click_trans_id, merchant_trans_id: q.merchant_trans_id, ...extra, error: e[0], error_note: e[1] });
}

async function handler(req, res) {
  const q = { ...(req.body || {}) };
  try {
    const secret = process.env.CLICK_SECRET_KEY, service = process.env.CLICK_SERVICE_ID;
    if (!secret || !service) return reply(res, q, ERR.REQ);
    const isComplete = S(q.action) === '1';
    const raw = isComplete
      ? S(q.click_trans_id) + S(q.service_id) + secret + S(q.merchant_trans_id) + S(q.merchant_prepare_id) + S(q.amount) + S(q.action) + S(q.sign_time)
      : S(q.click_trans_id) + S(q.service_id) + secret + S(q.merchant_trans_id) + S(q.amount) + S(q.action) + S(q.sign_time);
    if (!same(md5(raw), S(q.sign_string).toLowerCase())) return reply(res, q, ERR.SIGN);
    if (S(q.service_id) !== S(service)) return reply(res, q, ERR.REQ);
    if (S(q.action) !== '0' && !isComplete) return reply(res, q, ERR.ACTION);
    if (!S(q.click_trans_id) || S(q.click_trans_id).length > 40) return reply(res, q, ERR.REQ);

    if (!/^\d{1,12}$/.test(S(q.merchant_trans_id))) return reply(res, q, ERR.NOUSER);
    const oid = +q.merchant_trans_id;

    if (!isComplete) { // ---- Prepare: buyurtmani tekshiramiz va band qilamiz
      const r = await db.transaction(async (trx) => {
        await billing.lock(trx);
        const o = await trx('orders').where({ id: oid }).first();
        if (!o || o.provider !== 'click' || !(await trx('shops').where({ id: o.shop_id }).first())) return ERR.NOUSER;
        if (o.state === 'paid') return ERR.PAID;
        if (o.state !== 'new') return ERR.CANCEL;
        if (!(Number(q.amount) === Number(o.amount))) return ERR.AMOUNT;
        if (Number(q.error) < 0) return ERR.CANCEL;
        const upd = { provider_tx: S(q.click_trans_id) };
        if (o.kind === 'lifetime') upd.reserved_until = Date.now() + 30 * 60 * 1000;
        await trx('orders').where({ id: o.id }).update(upd);
        return ERR.OK;
      });
      return reply(res, q, r, r === ERR.OK ? { merchant_prepare_id: oid } : {});
    }

    // ---- Complete: to'lov amalga oshdi, obunani beramiz
    const r = await db.transaction(async (trx) => {
      await billing.lock(trx);
      const o = await trx('orders').where({ id: oid }).first();
      if (!o || o.provider !== 'click') return { e: ERR.NOUSER };
      if (o.state === 'paid') return { e: ERR.PAID };
      if (o.state !== 'new') return { e: ERR.CANCEL };
      if (!o.provider_tx || o.provider_tx !== S(q.click_trans_id) || S(q.merchant_prepare_id) !== String(o.id)) return { e: ERR.NOTX };
      if (!(Number(q.amount) === Number(o.amount))) return { e: ERR.AMOUNT };
      if (Number(q.error) < 0) { await trx('orders').where({ id: o.id }).update({ provider_tx: null }); return { e: ERR.CANCEL }; } // Click to'lov o'tmaganini bildirdi
      const a = await billing.applyPaid(trx, o.id);
      if (!a.ok) return { e: ERR.UPDATE };
      return { e: ERR.OK, paid: a.already ? null : a.order };
    });
    if (r.paid) await billing.afterPaid(r.paid);
    return reply(res, q, r.e, r.e === ERR.OK ? { merchant_confirm_id: oid } : {});
  } catch (e) {
    console.error('[click]', e);
    reply(res, q, ERR.UPDATE);
  }
}

const configured = () => !!(process.env.CLICK_SERVICE_ID && process.env.CLICK_MERCHANT_ID && process.env.CLICK_SECRET_KEY);
function checkoutUrl(order, lang, returnUrl) {
  const u = new URL('https://my.click.uz/services/pay');
  u.searchParams.set('service_id', process.env.CLICK_SERVICE_ID);
  u.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  u.searchParams.set('amount', String(Number(order.amount)));
  u.searchParams.set('transaction_param', String(order.id));
  if (returnUrl) u.searchParams.set('return_url', returnUrl);
  return u.toString();
}

module.exports = { handler, configured, checkoutUrl };

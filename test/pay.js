const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-p-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
Object.assign(process.env, {
  JWT_SECRET: 'test-secret', AUTH_RATE_LIMIT: '1000', SMS_RATE_LIMIT: '1000', SMS_PROVIDER: 'memory', SMS_DAILY_LIMIT: '0', PAY_RATE_LIMIT: '1000',
  SUPER_KEY: 'super-test-key', CRON_SECRET: 'cron-test', PUBLIC_URL: 'https://mizan.test',
  PAYME_MERCHANT_ID: 'merchant123', PAYME_KEY: 'payme-secret', CLICK_SERVICE_ID: '777', CLICK_MERCHANT_ID: '888', CLICK_SECRET_KEY: 'click-secret',
});
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { createApp } = require('../src/app');
const { migrate, db } = require('../src/db');
const { outbox } = require('../src/sms');
const reminders = require('../src/reminders');

let base, n = 0;
const DAY = 86400000;
const call = async (m, u, t, b, hdr = {}) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}), ...hdr }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { s: r.status, j };
};
const sup = (m, u, b) => call(m, '/api/super/billing' + u, null, b, { 'x-super-key': 'super-test-key' });
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  \u2713', name); };
let phoneSeq = 1;
async function reg(phone) {
  phone = phone || '99890300' + String(1000 + phoneSeq++);
  await db('sms_log').del(); // bir raqamga qayta kod yuborish kutish muddatini chetlab o'tamiz (test uchun)
  await call('POST', '/api/auth/register/start', null, { phone });
  const code = [...outbox].reverse().find((x) => x.phone === phone && /\d{6}/.test(x.text)).text.match(/\d{6}/)[0];
  const r = await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon ' + phone.slice(-4), phone, password: 'secret1', code });
  assert.strictEqual(r.s, 201, 'ro\'yxatdan o\'tish: ' + JSON.stringify(r.j));
  return { phone, token: r.j.token, loginId: r.j.user.loginId, shopId: r.j.shop.id, sub: r.j.sub };
}
const setUntil = (shopId, ms) => db('shops').where({ id: shopId }).update({ sub_until: ms });
const subOf = async (shopId) => (await call('GET', '/api/billing/status', (await tokOf(shopId)))).j.sub;
const toks = {}; const tokOf = async (shopId) => toks[shopId];

// Click imzosi
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
async function clickPay(orderId, amount, tid) {
  const q = { click_trans_id: tid || String(Math.floor(Math.random() * 1e9)), service_id: '777', click_paydoc_id: '1', merchant_trans_id: String(orderId), amount: String(amount), error: '0', error_note: 'Success', sign_time: '2026-11-26 12:00:00' };
  const form = (o) => new URLSearchParams(o).toString();
  const post = async (o) => (await fetch(base + '/api/pay/click/prepare', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(o) })).json();
  const p = { ...q, action: '0' }; p.sign_string = md5(q.click_trans_id + '777' + 'click-secret' + q.merchant_trans_id + q.amount + '0' + q.sign_time);
  const rp = await post(p);
  if (rp.error !== 0) return { prepare: rp };
  const c = { ...q, action: '1', merchant_prepare_id: String(rp.merchant_prepare_id) }; c.sign_string = md5(q.click_trans_id + '777' + 'click-secret' + q.merchant_trans_id + c.merchant_prepare_id + q.amount + '1' + q.sign_time);
  return { prepare: rp, complete: await post(c) };
}

const rpc = async (method, params, key = 'payme-secret', id = 1) => {
  const r = await fetch(base + '/api/pay/payme', { method: 'POST', headers: { 'content-type': 'application/json', ...(key === null ? {} : { authorization: 'Basic ' + Buffer.from('Paycom:' + key).toString('base64') }) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return { s: r.status, j: await r.json() };
};
const errCode = (r) => r.j.error && r.j.error.code;
let txSeq = 0; const newId = () => 'pt' + (++txSeq) + 'x' + Math.random().toString(36).slice(2, 8);
const click = async (path, o) => (await fetch(base + '/api/pay/click/' + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() })).json();
const csign = (o, complete) => md5(o.click_trans_id + o.service_id + 'click-secret' + o.merchant_trans_id + (complete ? o.merchant_prepare_id : '') + o.amount + o.action + o.sign_time);

const mkc2 = async (plan) => (await call('POST', '/api/billing/checkout', (toks[Object.keys(toks)[0]]), { plan, provider: 'click' })).j.orderId;
async function clickFull(oid, amount) {
  const tid = String(Math.floor(Math.random() * 1e9));
  const q = { click_trans_id: tid, service_id: '777', click_paydoc_id: '5', merchant_trans_id: String(oid), amount: String(amount), error: '0', error_note: 'ok', sign_time: '2026-11-26 10:00:00' };
  const pq = { ...q, action: '0' }; pq.sign_string = csign(pq, false);
  const rp = await click('prepare', pq);
  if (rp.error !== 0) return { prepare: rp };
  const cq = { ...q, action: '1', merchant_prepare_id: String(rp.merchant_prepare_id) }; cq.sign_string = csign(cq, true);
  return { prepare: rp, complete: await click('complete', cq) };
}

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const U = await reg(); toks[U.shopId] = U.token;
  await setUntil(U.shopId, Date.now() - 1000); // bloklangan hisob
  const mk = async (plan, prov) => (await call('POST', '/api/billing/checkout', U.token, { plan, provider: prov })).j.orderId;

  /* ================= PAYME ================= */
  let o = await mk('m1', 'payme');
  const amt = 9900000;
  let r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } }, null);
  ok('Payme: authorization yo\'q -> -32504 (HTTP 200)', r.s === 200 && errCode(r) === -32504);
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } }, 'wrong-key');
  ok('Payme: noto\'g\'ri kalit -> -32504', errCode(r) === -32504);
  r = await rpc('NoSuchMethod', {});
  ok('Payme: noma\'lum metod -> -32601', errCode(r) === -32601);
  ok('Payme: xato xabari uch tilda', ['ru', 'uz', 'en'].every((l) => typeof r.j.error.message[l] === 'string'));
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } });
  ok('Payme: CheckPerformTransaction -> allow', r.j.result.allow === true);
  ok('Payme: so\'rov id si javobda qaytadi', (await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } }, 'payme-secret', 777)).j.id === 777);
  r = await rpc('CheckPerformTransaction', { amount: amt + 100, account: { order_id: String(o) } });
  ok('Payme: noto\'g\'ri summa -> -31001', errCode(r) === -31001);
  r = await rpc('CheckPerformTransaction', { amount: 99000, account: { order_id: String(o) } });
  ok('Payme: so\'mni tiyin deb yuborish -> -31001', errCode(r) === -31001);
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: '999999' } });
  ok('Payme: buyurtma yo\'q -> -31050 (data=order_id)', errCode(r) === -31050 && r.j.error.data === 'order_id');
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: 'abc' } });
  ok('Payme: yaroqsiz order_id -> -31050', errCode(r) === -31050);
  r = await rpc('CheckPerformTransaction', { amount: amt, account: {} });
  ok('Payme: order_id berilmasa -> -31050', errCode(r) === -31050);
  const clickOrder = await mk('m1', 'click');
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(clickOrder) } });
  ok('Payme: Click uchun ochilgan buyurtma Payme da yo\'q -> -31050', errCode(r) === -31050);

  const id1 = newId(), t1 = Date.now();
  r = await rpc('CreateTransaction', { id: id1, time: t1, amount: amt, account: { order_id: String(o) } });
  ok('Payme: CreateTransaction -> state 1', r.j.result.state === 1 && r.j.result.transaction && r.j.result.create_time > 0);
  const created = r.j.result;
  await new Promise((x) => setTimeout(x, 15));
  r = await rpc('CreateTransaction', { id: id1, time: t1, amount: amt, account: { order_id: String(o) } });
  ok('Payme: takroriy CreateTransaction aynan bir xil javob (create_time o\'zgarmaydi)', JSON.stringify(r.j.result) === JSON.stringify(created));
  r = await rpc('CreateTransaction', { id: newId(), time: Date.now(), amount: amt, account: { order_id: String(o) } });
  ok('Payme: bir buyurtmaga ikkinchi faol tranzaksiya -> -31008', errCode(r) === -31008);
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } });
  ok('Payme: tranzaksiya kutilayotgan buyurtma uchun CheckPerform -> -31008', errCode(r) === -31008);
  r = await rpc('CheckTransaction', { id: id1 });
  ok('Payme: CheckTransaction (state 1, perform_time 0, reason null)', r.j.result.state === 1 && r.j.result.perform_time === 0 && r.j.result.cancel_time === 0 && r.j.result.reason === null && r.j.result.transaction === created.transaction);
  r = await rpc('CheckTransaction', { id: 'yoq-id' });
  ok('Payme: tranzaksiya topilmasa -> -31003', errCode(r) === -31003);
  ok('Payme: hali to\'lanmagan, hisob bloklangan', (await call('GET', '/api/products', U.token)).s === 402);

  r = await rpc('PerformTransaction', { id: id1 });
  const performed = r.j.result;
  ok('Payme: PerformTransaction -> state 2', performed.state === 2 && performed.perform_time > 0 && performed.transaction === created.transaction);
  ok('Payme: to\'lovdan keyin hisob darrov ochiladi', (await call('GET', '/api/products', U.token)).s === 200 && (await subOf(U.shopId)).plan === 'm1');
  await new Promise((x) => setTimeout(x, 15));
  r = await rpc('PerformTransaction', { id: id1 });
  ok('Payme: takroriy PerformTransaction bir xil javob, obuna ikki marta berilmaydi', JSON.stringify(r.j.result) === JSON.stringify(performed) && (await subOf(U.shopId)).daysLeft === 30);
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } });
  ok('Payme: to\'langan buyurtma uchun CheckPerform -> -31008', errCode(r) === -31008);
  r = await rpc('CreateTransaction', { id: newId(), time: Date.now(), amount: amt, account: { order_id: String(o) } });
  ok('Payme: to\'langan buyurtmaga yangi tranzaksiya ochilmaydi', errCode(r) === -31008);
  r = await rpc('PerformTransaction', { id: 'yoq-id' });
  ok('Payme: Perform topilmasa -> -31003', errCode(r) === -31003);

  // qaytarish (Payme kabinetidan refund): obuna ham qaytariladi
  r = await rpc('CancelTransaction', { id: id1, reason: 5 });
  ok('Payme: to\'langandan keyin bekor qilish -> state -2', r.j.result.state === -2 && r.j.result.cancel_time > 0);
  ok('Payme: qaytarilgach obuna ayirildi (hisob yana bloklandi)', (await call('GET', '/api/products', U.token)).s === 402 && (await db('orders').where({ id: o }).first()).state === 'refunded');
  const cancelled = r.j.result;
  r = await rpc('CancelTransaction', { id: id1, reason: 5 });
  ok('Payme: takroriy Cancel bir xil javob', JSON.stringify(r.j.result) === JSON.stringify(cancelled));
  r = await rpc('CheckTransaction', { id: id1 });
  ok('Payme: bekor qilingan tranzaksiyada reason saqlanadi', r.j.result.state === -2 && r.j.result.reason === 5);
  r = await rpc('PerformTransaction', { id: id1 });
  ok('Payme: bekor qilinganini Perform qilib bo\'lmaydi -> -31008', errCode(r) === -31008);

  // to'lanishdan oldin bekor qilish: buyurtma qayta to'lanishi mumkin
  o = await mk('m3', 'payme');
  const a3 = 24900000, id2 = newId();
  await rpc('CreateTransaction', { id: id2, time: Date.now(), amount: a3, account: { order_id: String(o) } });
  r = await rpc('CancelTransaction', { id: id2, reason: 3 });
  ok('Payme: to\'lovdan oldin bekor qilish -> state -1', r.j.result.state === -1);
  const id3 = newId();
  r = await rpc('CreateTransaction', { id: id3, time: Date.now(), amount: a3, account: { order_id: String(o) } });
  ok('Payme: bekor qilingandan keyin yangi tranzaksiya ochiladi', r.j.result.state === 1);
  ok('Payme: eski bekor qilingan tranzaksiya yozuvi saqlanadi', (await rpc('CheckTransaction', { id: id2 })).j.result.state === -1);

  // 12 soatlik vaqt tugashi
  await db('payme_tx').where({ payme_id: id3 }).update({ create_time: Date.now() - 13 * 3600 * 1000 });
  r = await rpc('PerformTransaction', { id: id3 });
  ok('Payme: 12 soatdan keyin Perform -> -31008', errCode(r) === -31008);
  r = await rpc('CheckTransaction', { id: id3 });
  ok('Payme: vaqti tugagan tranzaksiya avtomatik bekor (state -1, reason 4)', r.j.result.state === -1 && r.j.result.reason === 4);
  ok('Payme: vaqti tugagani obuna bermadi', (await call('GET', '/api/products', U.token)).s === 402);

  // statement
  r = await rpc('GetStatement', { from: Date.now() - 3600000, to: Date.now() + 3600000 });
  ok('Payme: GetStatement tranzaksiyalarni qaytaradi (account, amount, state)', r.j.result.transactions.length >= 3 && r.j.result.transactions.every((x) => x.account.order_id && x.amount > 0 && typeof x.state === 'number' && x.id));
  r = await rpc('GetStatement', { from: 1, to: 2 });
  ok('Payme: bo\'sh oraliq -> bo\'sh ro\'yxat', r.j.result.transactions.length === 0);

  // fiskal chek tavsifi
  process.env.PAYME_IKPU = '10305001001000000'; process.env.PAYME_PACKAGE_CODE = '123456';
  o = await mk('m1', 'payme');
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: String(o) } });
  ok('Payme: IKPU sozlansa fiskal chek tavsifi (detail) qo\'shiladi', r.j.result.allow && r.j.result.detail.items[0].code === '10305001001000000' && r.j.result.detail.items[0].price === amt && r.j.result.detail.items[0].count === 1);
  delete process.env.PAYME_IKPU; delete process.env.PAYME_PACKAGE_CODE;

  // umrbod tarif: Payme bilan, joy to'lganda Perform rad etiladi
  const lifeOrders = [];
  for (let i = 0; i < 2; i++) { const u = await reg(); toks[u.shopId] = u.token; lifeOrders.push([u, (await call('POST', '/api/billing/checkout', u.token, { plan: 'life', provider: 'payme' })).j.orderId]); }
  const [uL1, oL1] = lifeOrders[0];
  const idL = newId();
  await rpc('CreateTransaction', { id: idL, time: Date.now(), amount: 149000000, account: { order_id: String(oL1) } });
  r = await rpc('PerformTransaction', { id: idL });
  ok('Payme: umrbod tarif to\'langandan keyin hisob umrbod bo\'ldi', r.j.result.state === 2 && (await subOf(uL1.shopId)).lifetime === true);
  r = await rpc('CancelTransaction', { id: idL, reason: 5 });
  ok('Payme: umrbod to\'lov qaytarilsa umrbod bekor bo\'ladi', r.j.result.state === -2 && (await subOf(uL1.shopId)).lifetime === false);

  /* ================= CLICK ================= */
  const mkc = async (plan) => mk(plan, 'click');
  const base0 = (oid, amount, tid, action = '0') => ({ click_trans_id: tid, service_id: '777', click_paydoc_id: '5', merchant_trans_id: String(oid), amount: String(amount), action, error: '0', error_note: 'Success', sign_time: '2026-11-26 10:00:00' });
  const prep = (o2) => ({ ...o2, sign_string: csign(o2, false) });
  const comp = (o2, pid) => { const x = { ...o2, action: '1', merchant_prepare_id: String(pid) }; return { ...x, sign_string: csign(x, true) }; };

  await setUntil(U.shopId, Date.now() - 1000);
  const c1 = await mkc('m1');
  let q = base0(c1, 99000, '9001');
  r = await click('prepare', { ...q, sign_string: 'x'.repeat(32) });
  ok('Click: noto\'g\'ri imzo -> -1', r.error === -1);
  r = await click('prepare', prep({ ...q, amount: '98000' }));
  ok('Click: noto\'g\'ri summa -> -2', r.error === -2);
  r = await click('prepare', prep(base0(999999, 99000, '9002')));
  ok('Click: buyurtma yo\'q -> -5', r.error === -5);
  r = await click('prepare', prep(base0('abc', 99000, '9002')));
  ok('Click: yaroqsiz buyurtma raqami -> -5', r.error === -5);
  r = await click('prepare', prep({ ...q, service_id: '123' }));
  ok('Click: begona service_id rad etiladi', r.error !== 0);
  r = await click('prepare', prep({ ...q, action: '5' }));
  ok('Click: noma\'lum action rad etiladi', r.error !== 0);
  r = await click('prepare', prep(q));
  ok('Click: Prepare OK, merchant_prepare_id qaytadi', r.error === 0 && r.merchant_prepare_id === c1 && r.click_trans_id === '9001');
  ok('Click: Prepare to\'lov hisobga olmaydi', (await call('GET', '/api/products', U.token)).s === 402);
  r = await click('complete', comp(base0(c1, 99000, '9001'), c1 + 1));
  ok('Click: Complete noto\'g\'ri prepare id -> -6', r.error === -6);
  r = await click('complete', comp(base0(c1, 99000, '9999'), c1));
  ok('Click: Complete boshqa click_trans_id -> -6', r.error === -6);
  r = await click('complete', comp(base0(c1, 98000, '9001'), c1));
  ok('Click: Complete noto\'g\'ri summa -> -2', r.error === -2);
  r = await click('complete', { ...comp(base0(c1, 99000, '9001'), c1), sign_string: 'a'.repeat(32) });
  ok('Click: Complete noto\'g\'ri imzo -> -1', r.error === -1);
  const failed = comp(base0(c1, 99000, '9001'), c1); failed.error = '-5017'; failed.sign_string = csign(failed, true);
  r = await click('complete', failed);
  ok('Click: Click to\'lov o\'tmadi desa (error<0) -> -9, obuna berilmaydi', r.error === -9 && (await call('GET', '/api/products', U.token)).s === 402);
  r = await click('prepare', prep(q));
  r = await click('complete', comp(base0(c1, 99000, '9001'), c1));
  ok('Click: Complete OK, merchant_confirm_id qaytadi', r.error === 0 && r.merchant_confirm_id === c1);
  ok('Click: to\'lovdan keyin hisob ochildi', (await call('GET', '/api/products', U.token)).s === 200);
  r = await click('complete', comp(base0(c1, 99000, '9001'), c1));
  ok('Click: takroriy Complete -> -4 (obuna qayta berilmaydi)', r.error === -4 && (await subOf(U.shopId)).daysLeft === 30);
  r = await click('prepare', prep(q));
  ok('Click: to\'langan buyurtmaga Prepare -> -4', r.error === -4);

  // JSON ko'rinishida kelgan so'rovlar ham ishlaydi
  const c2 = await mkc('m3');
  const jq = prep(base0(c2, 249000, '9100'));
  r = await (await fetch(base + '/api/pay/click/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(jq) })).json();
  ok('Click: JSON so\'rov ham qabul qilinadi', r.error === 0);

  // kalitlar sozlanmagan bo'lsa to'lov qabul qilinmaydi
  const saved = process.env.CLICK_SECRET_KEY; delete process.env.CLICK_SECRET_KEY;
  r = await click('prepare', prep(base0(c2, 249000, '9100')));
  ok('Click: maxfiy kalit sozlanmagan bo\'lsa hech narsa o\'tmaydi', r.error !== 0);
  process.env.CLICK_SECRET_KEY = saved;
  const savedP = process.env.PAYME_KEY; delete process.env.PAYME_KEY;
  r = await rpc('CheckPerformTransaction', { amount: amt, account: { order_id: '1' } });
  ok('Payme: kalit sozlanmagan bo\'lsa hamma so\'rov rad etiladi', errCode(r) === -32504);
  process.env.PAYME_KEY = savedP;

  /* ---------- Parallel so'rovlar (Payme qayta yuborishi yoki ikki marta bosish) ---------- */
  await setUntil(U.shopId, Date.now() - 1000);
  const oc = await mk('m1', 'payme');
  const rs = await Promise.all([1, 2, 3].map(() => rpc('CreateTransaction', { id: newId(), time: Date.now(), amount: amt, account: { order_id: String(oc) } })));
  ok('Payme: bir buyurtmaga 3 ta parallel CreateTransaction: faqat bittasi o\'tadi', rs.filter((x) => x.j.result).length === 1 && rs.filter((x) => errCode(x) === -31008).length === 2);
  const okId = (await db('payme_tx').where({ order_id: oc, state: 1 }).first()).payme_id;
  const t0 = Date.now();
  const ps = await Promise.all([1, 2, 3].map(() => rpc('PerformTransaction', { id: okId })));
  ok('Payme: 3 ta parallel PerformTransaction: hammasi state 2', ps.every((x) => x.j.result && x.j.result.state === 2));
  const left = (await subOf(U.shopId)).daysLeft;
  ok('Payme: parallel Perform obunani faqat bir marta beradi (30 kun, 90 emas)', left === 30 && Number((await db('orders').where({ id: oc }).first()).granted_ms) === 30 * DAY && (await db('audit_log').where({ shop_id: U.shopId, action: 'billing.paid' })).length >= 1);
  const cc = await mkc2('m1');
  const cs = await Promise.all([1, 2, 3].map(() => clickFull(cc, 99000)));
  ok('Click: 3 ta parallel to\'lov urinishi: faqat bittasi Complete bo\'ladi', cs.filter((x) => x.complete && x.complete.error === 0).length <= 1);
  ok('Click: parallel urinishlardan keyin obuna ortiqcha berilmadi (60 kundan oshmaydi)', (await subOf(U.shopId)).daysLeft <= 60);

  // to'lov tizimlari sozlanmagan bo'lsa
  for (const k of ['PAYME_MERCHANT_ID', 'CLICK_SERVICE_ID']) delete process.env[k];
  r = await call('GET', '/api/billing/plans', U.token);
  ok('Tizim sozlanmagan bo\'lsa tariflar ko\'rinadi, lekin to\'lov yo\'q (notConfigured)', r.j.plans.length >= 2 && r.j.canPay === false && r.j.notConfigured === true);
  ok('Sozlanmagan bo\'lsa checkout 503', (await call('POST', '/api/billing/checkout', U.token, { plan: 'm1', provider: 'click' })).s === 503);

  console.log(`\nPAYME/CLICK TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

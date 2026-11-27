const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-b-'));
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

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;

  /* ---------- Sinov muddati ---------- */
  const A = await reg(); toks[A.shopId] = A.token;
  ok('yangi hisobga 30 kunlik sinov muddati beriladi', A.sub.state === 'trial' && A.sub.ok && A.sub.daysLeft === 30);
  ok('sinov davrida mahsulotlar ochiq (200)', (await call('GET', '/api/products', A.token)).s === 200);
  const me = await call('GET', '/api/auth/me', A.token);
  ok('/me da obuna holati bor', me.j.sub && me.j.sub.state === 'trial' && typeof me.j.sub.serverTime === 'number');
  const lg = await call('POST', '/api/auth/login', null, { id: A.loginId, password: 'secret1' });
  ok('kirish javobida ham obuna holati bor', lg.s === 200 && lg.j.sub.state === 'trial');

  /* ---------- Eslatma bosqichlari ---------- */
  await setUntil(A.shopId, Date.now() + 4 * DAY);
  ok('5 kundan kam qolsa eslatma 5', (await subOf(A.shopId)).remind === 5);
  await setUntil(A.shopId, Date.now() + 20 * 3600 * 1000);
  const s1 = await subOf(A.shopId);
  ok('1 kun qolsa eslatma 1', s1.remind === 1 && s1.daysLeft === 1);
  await setUntil(A.shopId, Date.now() + 10 * DAY);
  ok('10 kun qolsa eslatma yo\'q', (await subOf(A.shopId)).remind === 0);

  /* ---------- Xodim ---------- */
  const st = await call('POST', '/api/staff', A.token, { name: 'Sotuvchi' });
  const S = await call('POST', '/api/auth/login', null, { id: st.j.loginId || st.j.login_id, password: st.j.password });
  ok('xodim kira oldi', S.s === 200);
  const ST = S.j.token;
  ok('xodim tariflar ro\'yxatini ko\'ra olmaydi (403)', (await call('GET', '/api/billing/plans', ST)).s === 403);
  ok('xodim to\'lov qila olmaydi (403)', (await call('POST', '/api/billing/checkout', ST, { plan: 'm1', provider: 'payme' })).s === 403);
  ok('xodim obuna holatini ko\'radi', (await call('GET', '/api/billing/status', ST)).j.sub.ok === true);

  /* ---------- Muddat tugadi: blok ---------- */
  await setUntil(A.shopId, Date.now() - 1000);
  let r = await call('GET', '/api/products', A.token);
  ok('muddat tugasa ma\'lumotlar yopiladi (402 + SUB_EXPIRED)', r.s === 402 && r.j.code === 'SUB_EXPIRED');
  ok('sotuv ham yopiladi', (await call('POST', '/api/sales', A.token, { items: [] })).s === 402);
  ok('xodim ham bloklanadi', (await call('GET', '/api/products', ST)).s === 402);
  ok('xodimga boshqacha xabar (adminga murojaat)', /Administrator/.test((await call('GET', '/api/products', ST)).j.error));
  const lg2 = await call('POST', '/api/auth/login', null, { id: A.loginId, password: 'secret1' });
  ok('bloklangan hisob kirishi mumkin (to\'lov oynasiga o\'tish uchun)', lg2.s === 200 && lg2.j.sub.state === 'expired' && lg2.j.sub.ok === false);
  ok('bloklangan hisob tariflarni ko\'radi', (await call('GET', '/api/billing/plans', A.token)).s === 200);
  const pw = await call('POST', '/api/auth/password', lg2.j.token, { current: 'secret1', password: 'secret22' });
  ok('bloklangan hisob parolni almashtira oladi', pw.s === 200 && pw.j.token);
  lg2.j.token = pw.j.token; A.token = pw.j.token; // eski token parol almashgach ishlamaydi

  /* ---------- Tariflar va to'lov havolasi ---------- */
  r = await call('GET', '/api/billing/plans', lg2.j.token);
  const codes = r.j.plans.map((p) => p.code);
  ok('tariflar: 1 oy, 3 oy, umrbod (3 joy)', codes.join() === 'm1,m3,life' && r.j.plans[2].left === 3 && r.j.plans[0].price === 99000);
  ok('to\'lov tizimlari: Payme va Click', r.j.providers.map((p) => p.id).join() === 'payme,click' && r.j.canPay === true);
  ok('sinov tarifi sotuvga chiqmaydi', !codes.includes('trial'));
  const T = lg2.j.token; toks[A.shopId] = T;
  r = await call('POST', '/api/billing/checkout', T, { plan: 'm1', provider: 'payme' });
  const dec = Buffer.from(r.j.url.slice('https://checkout.paycom.uz/'.length), 'base64').toString();
  ok('Payme havolasi to\'g\'ri (merchant, order, tiyindagi summa, qaytish)', r.s === 200 && r.j.url.startsWith('https://checkout.paycom.uz/') && dec.includes('m=merchant123') && dec.includes('ac.order_id=' + r.j.orderId) && dec.includes('a=9900000') && dec.includes('c=https://mizan.test/?paid=' + r.j.orderId));
  const o1 = r.j.orderId;
  ok('tez-tez bosilsa buyurtma takrorlanmaydi', (await call('POST', '/api/billing/checkout', T, { plan: 'm1', provider: 'payme' })).j.orderId === o1);
  r = await call('POST', '/api/billing/checkout', T, { plan: 'm3', provider: 'click' });
  ok('Click havolasi to\'g\'ri', r.s === 200 && /service_id=777/.test(r.j.url) && /merchant_id=888/.test(r.j.url) && /amount=249000/.test(r.j.url) && new RegExp('transaction_param=' + r.j.orderId).test(r.j.url));
  ok('noma\'lum tarif rad etiladi', (await call('POST', '/api/billing/checkout', T, { plan: 'xyz', provider: 'payme' })).s === 400);
  ok('sinov tarifini sotib bo\'lmaydi', (await call('POST', '/api/billing/checkout', T, { plan: 'trial', provider: 'payme' })).s === 400);
  ok('noma\'lum to\'lov usuli rad etiladi', (await call('POST', '/api/billing/checkout', T, { plan: 'm1', provider: 'visa' })).s === 400);
  ok('iOS ilovasida to\'lov yopiq (403)', (await call('POST', '/api/billing/checkout?platform=ios', T, { plan: 'm1', provider: 'payme' })).s === 403);
  ok('iOS da tariflar ro\'yxati to\'lovsiz keladi', (await call('GET', '/api/billing/plans?platform=ios', T)).j.canPay === false);
  ok('Android da to\'lov ochiq', (await call('GET', '/api/billing/plans?platform=android', T)).j.canPay === true);

  /* ---------- To'lov (Click) -> blok ochiladi ---------- */
  r = await clickPay(o1, 99000);
  ok('Payme buyurtmasini Click orqali to\'lab bo\'lmaydi (-5)', r.prepare.error === -5);
  const o2 = (await call('POST', '/api/billing/checkout', T, { plan: 'm1', provider: 'click' })).j.orderId;
  ok('to\'lanmagan buyurtma holati: paid=false', (await call('GET', '/api/billing/order/' + o2, T)).j.paid === false);
  r = await clickPay(o2, 99000);
  ok('Click to\'lovi qabul qilindi', r.prepare.error === 0 && r.complete.error === 0);
  const sub = (await call('GET', '/api/billing/status', T)).j.sub;
  ok('to\'lovdan keyin hisob ochiladi: 1 oy (30 kun)', sub.ok && sub.state === 'active' && sub.plan === 'm1' && sub.daysLeft === 30);
  ok('buyurtma holati: paid=true', (await call('GET', '/api/billing/order/' + o2, T)).j.paid === true);
  ok('ma\'lumotlar yana ochiq', (await call('GET', '/api/products', T)).s === 200 && (await call('GET', '/api/products', ST)).s === 200);
  ok('to\'lovlar tarixida ko\'rinadi', (await call('GET', '/api/billing/history', T)).j.orders.length === 1);
  ok('faoliyat tarixiga yozildi', (await db('audit_log').where({ shop_id: A.shopId, action: 'billing.paid' })).length === 1);

  /* ---------- Muddat tugashidan oldin to'lasa kunlar yo'qolmaydi ---------- */
  const before = Number((await db('shops').where({ id: A.shopId }).first()).sub_until);
  const o3 = (await call('POST', '/api/billing/checkout', T, { plan: 'm3', provider: 'click' })).j.orderId;
  await clickPay(o3, 249000);
  const after = Number((await db('shops').where({ id: A.shopId }).first()).sub_until);
  ok('erta to\'lasa yangi muddat eski tugash sanasiga qo\'shiladi (+90 kun)', after - before === 90 * DAY);

  /* ---------- Eslatma SMS (5 va 1 kun) ---------- */
  outbox.length = 0;
  await setUntil(A.shopId, Date.now() + 4 * DAY);
  let rr = await reminders.run();
  ok('5 kun eslatmasi adminga SMS bilan yuborildi', rr.sent >= 1 && outbox.some((m) => m.phone === A.phone && /4 kundan/.test(m.text)));
  const cnt = outbox.length; await reminders.run();
  ok('xuddi shu eslatma ikkinchi marta yuborilmaydi', outbox.length === cnt);
  await setUntil(A.shopId, Date.now() + 20 * 3600 * 1000);
  await reminders.run();
  ok('1 kun eslatmasi alohida yuboriladi', outbox.length === cnt + 1 && /1 kundan/.test(outbox[outbox.length - 1].text));
  ok('cron kalitsiz ishlamaydi (403)', (await call('GET', '/api/billing/cron')).s === 403);
  ok('cron kalit bilan ishlaydi', (await call('GET', '/api/billing/cron', 'cron-test')).s === 200);
  await setUntil(A.shopId, Date.now() + 30 * DAY);

  /* ---------- Umrbod tarif: faqat 3 kishiga ---------- */
  const L = [];
  for (let i = 0; i < 4; i++) { const u = await reg(); toks[u.shopId] = u.token; L.push(u); }
  for (let i = 0; i < 2; i++) {
    const o = (await call('POST', '/api/billing/checkout', L[i].token, { plan: 'life', provider: 'click' })).j.orderId;
    r = await clickPay(o, 1490000);
    ok(`umrbod tarif sotildi (${i + 1}/3)`, r.complete.error === 0);
  }
  ok('umrbod: hisob "lifetime" bo\'ldi, muddati yo\'q', (await call('GET', '/api/billing/status', L[0].token)).j.sub.lifetime === true);
  await setUntil(L[0].shopId, 1);
  ok('umrbod tarif muddat tugasa ham bloklanmaydi', (await call('GET', '/api/products', L[0].token)).s === 200);
  ok('umrbod egasiga to\'lov taklif qilinmaydi (409)', (await call('POST', '/api/billing/checkout', L[0].token, { plan: 'm1', provider: 'click' })).s === 409);
  // 3-joyni L[2] to'lash jarayonida ushlab turadi: L[3] ga joy qolmaydi
  const o3life = (await call('POST', '/api/billing/checkout', L[2].token, { plan: 'life', provider: 'click' })).j.orderId;
  ok('joy ushlab turilgach boshqaga umrbod ko\'rinmaydi', !(await call('GET', '/api/billing/plans', L[3].token)).j.plans.some((p) => p.code === 'life'));
  ok('joy ushlab turilgach boshqa buyurtma ocholmaydi (409)', (await call('POST', '/api/billing/checkout', L[3].token, { plan: 'life', provider: 'click' })).s === 409);
  ok('ushlab turgan kishining o\'zida umrbod ko\'rinadi', (await call('GET', '/api/billing/plans', L[2].token)).j.plans.some((p) => p.code === 'life'));
  r = await clickPay(o3life, 1490000);
  ok('umrbod tarif sotildi (3/3)', r.complete.error === 0);
  ok('3 ta sotilgach umrbod tarif ro\'yxatdan yo\'qoladi', !(await call('GET', '/api/billing/plans', L[3].token)).j.plans.some((p) => p.code === 'life') && (await call('GET', '/api/billing/plans', L[3].token)).j.plans.length === 2);
  ok('4-kishi umrbod sotib ololmaydi (409)', (await call('POST', '/api/billing/checkout', L[3].token, { plan: 'life', provider: 'click' })).s === 409);
  // hisob o'chirilsa ham joy qaytmaydi
  await call('POST', '/api/auth/delete-account', L[1].token, { password: 'secret1' });
  ok('umrbod egasi hisobini o\'chirsa ham joy qaytmaydi', !(await call('GET', '/api/billing/plans', L[3].token)).j.plans.some((p) => p.code === 'life'));

  /* ---------- Sinov muddatini takror olish mumkin emas ---------- */
  await call('POST', '/api/auth/delete-account', A.token, { password: 'secret22' });
  const again = await reg(A.phone);
  ok('hisobni o\'chirib qayta ochsa sinov muddati berilmaydi', again.sub.noTrial === true && again.sub.ok === false && again.sub.state === 'expired');
  ok('shunda ma\'lumotlar darrov yopiq (402)', (await call('GET', '/api/products', again.token)).s === 402);
  toks[again.shopId] = again.token;

  /* ---------- Login oynasidan ID bo'yicha to'lash ---------- */
  r = await call('POST', '/api/billing/public/lookup', null, { id: again.loginId });
  ok('ID bo\'yicha qidiruv: nom yashirin, holat va tariflar keladi', r.s === 200 && /\*\*\*/.test(r.j.name) && r.j.sub.state === 'expired' && r.j.plans.length >= 2 && r.j.canPay);
  ok('noto\'g\'ri ID: 404', (await call('POST', '/api/billing/public/lookup', null, { id: '123456' })).s === 404);
  ok('xodim ID si bilan to\'lab bo\'lmaydi', (await call('POST', '/api/billing/public/lookup', null, { id: st.j.loginId || st.j.login_id })).s === 404);
  r = await call('POST', '/api/billing/public/checkout', null, { id: again.loginId, plan: 'm1', provider: 'click' });
  ok('ID bo\'yicha to\'lov havolasi yaratildi', r.s === 200 && r.j.orderId);
  ok('to\'lanmagan: paid=false', (await call('GET', '/api/billing/public/order/' + r.j.orderId)).j.paid === false);
  await clickPay(r.j.orderId, 99000);
  ok('to\'langach: paid=true va hisob ochildi', (await call('GET', '/api/billing/public/order/' + r.j.orderId)).j.paid === true && (await call('GET', '/api/products', again.token)).s === 200);

  /* ---------- Egasi paneli (SUPER_KEY) ---------- */
  ok('kalitsiz owner API yopiq (403)', (await call('GET', '/api/super/billing/summary')).s === 403);
  ok('noto\'g\'ri kalit bilan yopiq (403)', (await call('GET', '/api/super/billing/summary', null, null, { 'x-super-key': 'nope' })).s === 403);
  r = await sup('GET', '/summary');
  ok('xulosa: do\'konlar, umrbod 3/3, tushum', r.s === 200 && r.j.shops >= 4 && r.j.lifetimeSold === 3 && r.j.lifetimeSlots === 3 && r.j.revenueTotal > 0);
  r = await sup('PUT', '/plans/m1', { price: 120000, name: '1 oy (aksiya)' });
  ok('egasi narxni o\'zgartira oldi', r.s === 200 && r.j.plan.price === 120000);
  ok('yangi narx foydalanuvchiga ko\'rinadi', (await call('GET', '/api/billing/plans', again.token)).j.plans.find((p) => p.code === 'm1').price === 120000);
  const o4 = (await call('POST', '/api/billing/checkout', again.token, { plan: 'm1', provider: 'click' })).j.orderId;
  ok('yangi buyurtma yangi narxda', Number((await db('orders').where({ id: o4 }).first()).amount) === 120000);
  ok('eski narxdagi to\'lov endi rad etiladi (summa mos emas, -2)', (await clickPay(o4, 99000)).prepare.error === -2);
  ok('yangi narxda o\'tadi', (await clickPay(o4, 120000)).complete.error === 0);
  ok('noto\'g\'ri narx rad etiladi', (await sup('PUT', '/plans/m1', { price: -5 })).s === 400);
  r = await sup('PUT', '/plans/m1', { active: false });
  ok('tarifni o\'chirsa ro\'yxatdan yo\'qoladi', !(await call('GET', '/api/billing/plans', again.token)).j.plans.some((p) => p.code === 'm1'));
  await sup('PUT', '/plans/m1', { active: true, price: 99000, name: '1 oy' });
  r = await sup('POST', '/plans', { code: 'm6', name: '6 oy', days: 180, price: 480000 });
  ok('egasi yangi tarif qo\'sha oldi', r.s === 201 && (await call('GET', '/api/billing/plans', again.token)).j.plans.some((p) => p.code === 'm6'));
  ok('trial kunlarini o\'zgartirish mumkin', (await sup('PUT', '/plans/trial', { days: 14 })).j.plan.days === 14);
  const B = await reg();
  ok('yangi sinov muddati shu kunlar bilan beriladi (14)', B.sub.daysLeft === 14);
  await sup('PUT', '/plans/trial', { days: 30 });

  // qo'lda berish
  await setUntil(B.shopId, Date.now() - 1000);
  r = await sup('POST', '/grant', { shopId: B.shopId, planCode: 'm3', note: 'naqd' });
  ok('qo\'lda tarif berildi', r.s === 201 && r.j.sub.ok && r.j.sub.daysLeft === 90);
  r = await sup('POST', '/grant', { shopId: B.shopId, days: 7 });
  ok('qo\'lda kun qo\'shildi', r.s === 201 && r.j.sub.daysLeft === 97);
  ok('manfiy kun rad etiladi', (await sup('POST', '/grant', { shopId: B.shopId, days: -5 })).s === 400);
  ok('mavjud bo\'lmagan do\'kon: 404', (await sup('POST', '/grant', { shopId: 999999, days: 5 })).s === 404);
  r = await sup('GET', '/shops?q=' + B.loginId);
  ok('do\'konlar ID bo\'yicha qidiriladi, telefon yashirin', r.s === 200 && r.j.shops.length === 1 && /\*/.test(r.j.shops[0].phone) && r.j.shops[0].state === 'active');
  r = await sup('GET', '/orders?state=paid');
  ok('buyurtmalar ro\'yxati', r.s === 200 && r.j.orders.length >= 5 && r.j.orders.every((o) => o.state === 'paid'));
  const page = await fetch(base + '/owner');
  ok('/owner sahifasi ochiladi', page.status === 200 && /html/.test(page.headers.get('content-type')));

  /* ---------- Bir vaqtda (parallel) so'rovlar: umrbod joylar oshib ketmaydi ---------- */
  await sup('PUT', '/plans/life', { maxSlots: 5 }); // 3 ta sotilgan, 2 joy bor
  const P = []; for (let i = 0; i < 4; i++) { const u = await reg(); toks[u.shopId] = u.token; P.push(u); }
  const res = await Promise.all(P.map((u) => call('POST', '/api/billing/checkout', u.token, { plan: 'life', provider: 'click' })));
  ok('bir vaqtda 4 ta umrbod buyurtma: faqat 2 tasi o\'tadi, 2 tasi rad (409)', res.filter((x) => x.s === 200).length === 2 && res.filter((x) => x.s === 409).length === 2);
  const paidAll = await Promise.all(res.filter((x) => x.s === 200).map((x) => clickPay(x.j.orderId, 1490000)));
  ok('o\'sha ikkitasi parallel to\'lasa ham ikkalasi qabul qilinadi', paidAll.every((x) => x.complete && x.complete.error === 0));
  ok('jami sotilgan umrbod: aniq 5 ta (limitdan oshmadi)', (await sup('GET', '/summary')).j.lifetimeSold === 5 && Number((await db('orders').where({ kind: 'lifetime', state: 'paid' }).count({ c: '*' }).first()).c) === 5);
  ok('endi umrbod tarif yo\'qoldi', !(await call('GET', '/api/billing/plans', P[0].token)).j.plans.some((p) => p.code === 'life'));

  /* ---------- SUPER_KEY ni taxmin qilishdan himoya ---------- */
  let last = 0; for (let i = 0; i < 30; i++) last = (await call('GET', '/api/super/billing/summary', null, null, { 'x-super-key': 'taxmin' + i })).s;
  ok('SUPER_KEY ni ko\'p marta xato kiritsa vaqtincha bloklanadi (429)', last === 429);
  console.log(`\nTO'LOV TIZIMI TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

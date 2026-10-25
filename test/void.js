// Sotuvni bekor qilish: ombor qaytadi, qarz o'chadi, hisobotdan chiqadi; huquqlar va izolyatsiya.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-v-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
delete process.env.SELLER_VOID_MINUTES;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { createApp } = require('../src/app');
const { migrate, db } = require('../src/db');
const { outbox } = require('../src/sms');

let base, n = 0;
const call = async (m, u, t, b) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { s: r.status, j };
};
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
const lastCode = (phone) => [...outbox].reverse().find((x) => x.phone === phone).text.match(/\d{6}/)[0];
const register = async (phone, shop) => {
  await call('POST', '/api/auth/register/start', null, { phone });
  return (await call('POST', '/api/auth/register', null, { shopName: shop, phone, password: 'secret1', code: lastCode(phone) })).j;
};
const addSeller = async (admin, name) => {
  const st = (await call('POST', '/api/staff', admin.token, { name })).j;
  return { ...(await call('POST', '/api/auth/login', null, { id: st.loginId, password: st.password })).j, loginId: st.loginId };
};
const qtyOf = async (t, id) => (await call('GET', '/api/products', t)).j.find((p) => p.id === id).qty;

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;

  const A = await register('998901230001', 'Do\'kon A'), B = await register('998901230002', 'Do\'kon B');
  const S1 = await addSeller(A, 'Ali'), S2 = await addSeller(A, 'Vali');
  const gilam = (await call('POST', '/api/products', A.token, { name: 'Gilam', unit: 'm', cost: 1000, pct: 20, qty: 100 })).j;
  const lampa = (await call('POST', '/api/products', A.token, { name: 'Lampa', unit: 'dona', cost: 500, pct: 10, qty: 10 })).j;

  // ---------- Admin bekor qiladi ----------
  let sale = (await call('POST', '/api/sales', A.token, { customer: 'Karim', items: [{ productId: gilam.id, qty: 10 }, { productId: lampa.id, qty: 2 }] })).j;
  ok('sotuvdan keyin ombor kamaydi', (await qtyOf(A.token, gilam.id)) === 90 && (await qtyOf(A.token, lampa.id)) === 8);
  ok('admin uchun canVoid=true', sale.canVoid === true);
  const rev0 = (await call('GET', '/api/reports/summary', A.token)).j;
  ok('hisobotda daromad bor', rev0.revenue === 10 * 1200 + 2 * 550);
  let r = await call('POST', `/api/sales/${sale.id}/void`, A.token, { reason: 'xato kiritilgan' });
  ok('admin sotuvni bekor qildi', r.s === 200 && r.j.restored === 2 && r.j.skipped === 0);
  ok('ombor to\'liq qaytdi', (await qtyOf(A.token, gilam.id)) === 100 && (await qtyOf(A.token, lampa.id)) === 10);
  ok('bekor qilingan sotuv ro\'yxatda ko\'rinmaydi', !(await call('GET', '/api/sales', A.token)).j.some((x) => x.id === sale.id));
  const rev1 = (await call('GET', '/api/reports/summary', A.token)).j;
  ok('hisobotdan daromad va foyda chiqdi', rev1.revenue === 0 && rev1.profit === 0 && rev1.ranking.length === 0);
  const hist = (await call('GET', '/api/sales?voided=1', A.token)).j;
  ok('admin bekor qilinganlar tarixini ko\'radi (sabab bilan)', hist.length === 1 && hist[0].id === sale.id && hist[0].voided === true && hist[0].voidReason === 'xato kiritilgan' && hist[0].canVoid === false);
  r = await call('POST', `/api/sales/${sale.id}/void`, A.token, {});
  ok('ikkinchi marta bekor qilib bo\'lmaydi (409)', r.s === 409);
  ok('ombor ikki marta to\'lmadi', (await qtyOf(A.token, gilam.id)) === 100);
  const row = await db('sales').where({ id: sale.id }).first();
  ok('kim va qachon bekor qilgani saqlandi', row.voided_by === A.user.id && row.voided_at > 0);

  // ---------- Bir vaqtda ikki marta bosish ----------
  sale = (await call('POST', '/api/sales', A.token, { customer: 'X', items: [{ productId: lampa.id, qty: 4 }] })).j;
  const both = await Promise.all([call('POST', `/api/sales/${sale.id}/void`, A.token, {}), call('POST', `/api/sales/${sale.id}/void`, A.token, {})]);
  ok('parallel ikki bosishda faqat bittasi o\'tadi', both.filter((x) => x.s === 200).length === 1);
  ok('parallel bosishda ombor aniq qaytdi (10)', (await qtyOf(A.token, lampa.id)) === 10);

  // ---------- Nasiya: qarz o'chadi ----------
  sale = (await call('POST', '/api/sales', A.token, { customer: 'Nasiyachi', items: [{ productId: gilam.id, qty: 5 }], credit: { paidNow: 1000, due: '2030-01-01' } })).j;
  ok('nasiya sotuvda qarz paydo bo\'ldi', sale.debt && (await call('GET', '/api/debts', A.token)).j.length === 1);
  r = await call('POST', `/api/sales/${sale.id}/void`, A.token, {});
  ok('nasiya sotuv bekor qilindi', r.s === 200);
  ok('uning qarzi o\'chdi', (await call('GET', '/api/debts', A.token)).j.length === 0);
  ok('ombor qaytdi (100)', (await qtyOf(A.token, gilam.id)) === 100);

  // ---------- Sotuvchi: o'zinikini muddat ichida ----------
  const mine = (await call('POST', '/api/sales', S1.token, { customer: 'M', items: [{ productId: gilam.id, qty: 3 }] })).j;
  ok('sotuvchi o\'z yangi sotuvida canVoid=true', mine.canVoid === true);
  const other = (await call('POST', '/api/sales', S2.token, { customer: 'O', items: [{ productId: gilam.id, qty: 1 }] })).j;
  ok('sotuvchi boshqaning sotuvini bekor qila olmaydi (404)', (await call('POST', `/api/sales/${other.id}/void`, S1.token, {})).s === 404);
  ok('sotuvchi boshqa do\'kon sotuvini ham (404)', (await call('POST', `/api/sales/${other.id}/void`, B.token, {})).s === 404);
  ok('sotuvchi ro\'yxatida canVoid to\'g\'ri', (await call('GET', '/api/sales', S1.token)).j.every((x) => x.canVoid === true));
  ok('sotuvchi o\'z sotuvini bekor qildi', (await call('POST', `/api/sales/${mine.id}/void`, S1.token, {})).s === 200);
  ok('sotuvchi uchun bekor qilingan sotuv yo\'q (ro\'yxat, ?voided=1 ham, GET)', (await call('GET', '/api/sales', S1.token)).j.length === 0 && (await call('GET', '/api/sales?voided=1', S1.token)).j.length === 0 && (await call('GET', `/api/sales/${mine.id}`, S1.token)).s === 404);

  // ---------- Sotuvchi: muddat o'tgach ----------
  const old = (await call('POST', '/api/sales', S1.token, { customer: 'Eski', items: [{ productId: gilam.id, qty: 2 }] })).j;
  await db('sales').where({ id: old.id }).update({ created_at: Date.now() - 20 * 60 * 1000 });
  ok('20 daqiqadan keyin sotuvchida canVoid=false', (await call('GET', `/api/sales/${old.id}`, S1.token)).j.canVoid === false);
  r = await call('POST', `/api/sales/${old.id}/void`, S1.token, {});
  ok('muddat o\'tgach sotuvchi bekor qila olmaydi (403)', r.s === 403 && /daqiqa/.test(r.j.error));
  process.env.SELLER_VOID_MINUTES = '0';
  const fresh = (await call('POST', '/api/sales', S1.token, { customer: 'Y', items: [{ productId: gilam.id, qty: 1 }] })).j;
  ok('SELLER_VOID_MINUTES=0: sotuvchi umuman bekor qila olmaydi', fresh.canVoid === false && (await call('POST', `/api/sales/${fresh.id}/void`, S1.token, {})).s === 403);
  delete process.env.SELLER_VOID_MINUTES;
  ok('admin muddati o\'tgan sotuvni ham bekor qila oladi', (await call('POST', `/api/sales/${old.id}/void`, A.token, {})).s === 200);
  ok('boshqa do\'kon admini bekor qila olmaydi (404)', (await call('POST', `/api/sales/${fresh.id}/void`, B.token, {})).s === 404);

  // ---------- Qarzga to'lov olingan bo'lsa sotuvchi bekor qila olmaydi, admin qila oladi ----------
  const cr = (await call('POST', '/api/sales', S1.token, { customer: 'Qarzdor', items: [{ productId: gilam.id, qty: 2 }], credit: { paidNow: 0 } })).j;
  await call('POST', `/api/debts/${cr.debt.id}/pay`, A.token, { amount: 500 });
  const cr2 = (await call('GET', `/api/sales/${cr.id}`, S1.token)).j;
  ok('qarzga to\'lov olingach sotuvchida canVoid=false', cr2.canVoid === false);
  ok('sotuvchi bekor qila olmaydi (403)', (await call('POST', `/api/sales/${cr.id}/void`, S1.token, {})).s === 403);
  ok('admin qila oladi, qarz va to\'lovlar o\'chadi', (await call('POST', `/api/sales/${cr.id}/void`, A.token, {})).s === 200 && (await db('payments').where({ debt_id: cr.debt.id }).first()) === undefined && (await db('debts').where({ id: cr.debt.id }).first()) === undefined);

  // ---------- O'chirilgan mahsulot ----------
  const tmpP = (await call('POST', '/api/products', A.token, { name: 'Vaqtincha', unit: 'dona', cost: 100, pct: 0, qty: 5 })).j;
  const s3 = (await call('POST', '/api/sales', A.token, { customer: 'Z', items: [{ productId: tmpP.id, qty: 1 }, { productId: lampa.id, qty: 1 }] })).j;
  await call('DELETE', `/api/products/${tmpP.id}`, A.token);
  r = await call('POST', `/api/sales/${s3.id}/void`, A.token, {});
  ok('mahsulot o\'chirilgan bo\'lsa ham bekor qilinadi (qolganlari qaytadi)', r.s === 200 && r.j.restored === 1 && r.j.skipped === 1 && (await qtyOf(A.token, lampa.id)) === 10);

  // ---------- Nuqtalar ----------
  ok('mavjud bo\'lmagan sotuv 404', (await call('POST', '/api/sales/999999/void', A.token, {})).s === 404);
  ok('tokensiz 401', (await call('POST', `/api/sales/${sale.id}/void`, null, {})).s === 401);

  console.log(`\nBEKOR QILISH TEST: HAMMASI JOYIDA (${n} ta tekshiruv)`);
  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });

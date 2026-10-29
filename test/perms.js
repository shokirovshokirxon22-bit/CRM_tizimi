// Sotuvchi huquqlari: narxni o'zgartirish va qarzdorlarni ko'rish. Hamma sotuvchiga yoki har biriga alohida.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-p-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { createApp } = require('../src/app');
const { migrate } = require('../src/db');
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
  return { ...(await call('POST', '/api/auth/login', null, { id: st.loginId, password: st.password })).j, id: st.id };
};

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = await register('998901230101', "Do'kon A");
  const S1 = await addSeller(A, 'Ali'), S2 = await addSeller(A, 'Vali');
  const g = (await call('POST', '/api/products', A.token, { name: 'Gilam', unit: 'm', cost: 1000, pct: 20, qty: 100 })).j;
  const eff = async (S) => (await call('GET', '/api/settings', S.token)).j;

  // Boshida hech kimda narx huquqi yo'q; qarzlar standart bo'yicha hammaga ochiq (eski xulq)
  await call('PUT', '/api/settings', A.token, { sellerSeeDebts: false });
  let e = await eff(S1);
  ok('boshida sotuvchida narx huquqi yo\'q', e.myEditPrice === false && e.mySeeDebts === false);
  ok('narxni o\'zgartirishga urinish 403', (await call('PUT', `/api/products/${g.id}/price`, S1.token, { price: 1500 })).s === 403);
  ok('qarzdorlar 403', (await call('GET', '/api/debts', S1.token)).s === 403);
  ok('sotuvda narx yuborsa e\'tiborga olinmaydi', (await call('POST', '/api/sales', S1.token, { items: [{ productId: g.id, qty: 1, price: 1 }] })).j.total === 1200);

  // Faqat S1 ga ikkala huquq
  let r = await call('PATCH', `/api/staff/${S1.id}`, A.token, { permPrice: true, permDebts: true });
  ok('staff PATCH huquqlarni qaytaradi', r.s === 200 && r.j.permPrice === true && r.j.permDebts === true);
  ok('ro\'yxatda huquqlar ko\'rinadi', (await call('GET', '/api/staff', A.token)).j.find((u) => u.id === S1.id).permPrice === true);
  e = await eff(S1);
  ok('S1 da ikkala huquq yoqildi', e.myEditPrice === true && e.mySeeDebts === true);
  e = await eff(S2);
  ok('S2 ga ta\'sir qilmadi', e.myEditPrice === false && e.mySeeDebts === false);
  ok('S1 qarzdorlarni ko\'radi', (await call('GET', '/api/debts', S1.token)).s === 200);
  ok('S2 qarzdorlarni ko\'ra olmaydi', (await call('GET', '/api/debts', S2.token)).s === 403);

  // S1 mahsulot narxini o'zgartiradi
  r = await call('PUT', `/api/products/${g.id}/price`, S1.token, { price: 1500 });
  ok('S1 narxni o\'zgartirdi: sellPrice 1500, tannarx/foiz yashirin', r.s === 200 && r.j.sellPrice === 1500 && r.j.cost === undefined && r.j.pct === undefined);
  ok('admin yangi narxni ko\'radi (foiz 50)', (await call('GET', '/api/products', A.token)).j[0].pct === 50);
  ok('tannarxdan past narx rad etiladi', (await call('PUT', `/api/products/${g.id}/price`, S1.token, { price: 900 })).s === 400);
  ok('noto\'g\'ri narx rad etiladi', (await call('PUT', `/api/products/${g.id}/price`, S1.token, { price: 'abc' })).s === 400);
  ok('S2 narxni o\'zgartira olmaydi', (await call('PUT', `/api/products/${g.id}/price`, S2.token, { price: 2000 })).s === 403);
  ok('S1 sotuvda o\'zgacha narx qo\'ya oladi', (await call('POST', '/api/sales', S1.token, { items: [{ productId: g.id, qty: 1, price: 1700 }] })).j.total === 1700);
  ok('narx o\'zgarishi tarixda qoldi', (await call('GET', '/api/audit', A.token)).j.some((a) => /sotish narxi 1200 → 1500/.test(a.summary)));

  // Hamma sotuvchilarga (do'kon darajasida)
  await call('PUT', '/api/settings', A.token, { sellerEditPrice: true, sellerSeeDebts: true });
  e = await eff(S2);
  ok('"barcha sotuvchilar" belgisi S2 ga ham beradi', e.myEditPrice === true && e.mySeeDebts === true);
  ok('S2 endi narxni o\'zgartira oladi', (await call('PUT', `/api/products/${g.id}/price`, S2.token, { price: 1600 })).s === 200);

  // Individual yoqilgan bo'lsa, umumiy o'chirilganda S1 saqlanib qoladi
  await call('PUT', '/api/settings', A.token, { sellerEditPrice: false, sellerSeeDebts: false });
  e = await eff(S1);
  ok('umumiy o\'chirilsa ham S1 ning o\'z huquqi qoladi', e.myEditPrice === true && e.mySeeDebts === true);
  e = await eff(S2);
  ok('S2 yana huquqsiz', e.myEditPrice === false && e.mySeeDebts === false);
  await call('PATCH', `/api/staff/${S1.id}`, A.token, { permPrice: false });
  e = await eff(S1);
  ok('huquqni alohida o\'chirsa bo\'ladi (bittasini)', e.myEditPrice === false && e.mySeeDebts === true);

  // Sotuvchi o'ziga huquq bera olmaydi
  ok('sotuvchi staff API ga kira olmaydi', (await call('PATCH', `/api/staff/${S2.id}`, S2.token, { permPrice: true })).s === 403);
  ok('admin narxni o\'zgartira oladi', (await call('PUT', `/api/products/${g.id}/price`, A.token, { price: 1400 })).j.sellPrice === 1400);

  console.log(`\nHUQUQLAR TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`);
  srv.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

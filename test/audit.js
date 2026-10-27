// Faoliyat tarixi: kim, qachon, nima qilgani. Faqat admin ko'radi, tarixga parol/token tushmaydi, tarix yozilmasa ham amal to'xtamaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-a-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
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
const feed = async (t, q = '') => (await call('GET', '/api/audit' + q, t)).j;
const has = (list, action, re) => list.some((a) => a.action === action && (!re || re.test(a.summary)));

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = await register('998901230301', "Do'kon A"), B = await register('998901230302', "Do'kon B");
  const st = (await call('POST', '/api/staff', A.token, { name: 'Ali' })).j;
  const S = (await call('POST', '/api/auth/login', null, { id: st.loginId, password: st.password })).j;

  // ---- Mahsulot ----
  const p = (await call('POST', '/api/products', A.token, { name: 'Gilam', unit: 'm', cost: 1000, pct: 20, qty: 10 })).j;
  let f = await feed(A.token);
  ok("mahsulot qo'shilishi yozildi (kim bilan)", has(f, 'product.create', /Gilam/) && f[0].userName === A.user.name && f[0].userId === A.user.id && f[0].entityId === p.id);
  await call('PUT', `/api/products/${p.id}`, A.token, { name: 'Gilam', cost: 1100, pct: 20, qty: 10, min: 0, width: 0 });
  f = await feed(A.token);
  ok('narx o\'zgarishi: avvalgi → yangi qiymat bilan', has(f, 'product.update', /tannarx: 1000 → 1100/) && f[0].data.changes.cost[0] === 1000 && f[0].data.changes.cost[1] === 1100);
  const cnt = (await feed(A.token)).length;
  await call('PUT', `/api/products/${p.id}`, A.token, { name: 'Gilam', cost: 1100, pct: 20, qty: 10, min: 0, width: 0 });
  ok("hech narsa o'zgarmasa yozuv qo'shilmaydi", (await feed(A.token)).length === cnt);
  await call('PUT', `/api/products/${p.id}`, A.token, { name: 'Gilam', cost: 1100, pct: 20, qty: 7, qtyBase: 10, min: 0, width: 0 });
  ok("qoldiq o'zgarishi yozildi (10 → 7)", has(await feed(A.token), 'product.update', /qoldiq: 10 → 7/));
  await call('POST', `/api/products/${p.id}/restock`, A.token, { qty: 5, cost: 1200 });
  ok('ombor to\'ldirish yozildi', has(await feed(A.token), 'product.restock', /\+5/));

  // ---- Sozlama + sotuvchi narx o'zgartirishi ----
  await call('PUT', '/api/settings', A.token, { sellerEditPrice: true });
  ok('sozlama o\'zgarishi yozildi', has(await feed(A.token), 'settings.update', /sotuvchi narxni o'zgartira oladi: false → true/));
  let r = await call('POST', '/api/sales', S.token, { items: [{ productId: p.id, qty: 2, price: 900 }] });
  const saleId = r.j.id;
  f = await feed(A.token);
  ok("sotuvchi narxni tushirsa: kim, qaysi mahsulot, necha → necha", r.s === 201 && has(f, 'sale.price', /Gilam 1440 → 900/) && f[0].userName === 'Ali');
  r = await call('POST', '/api/sales', S.token, { items: [{ productId: p.id, qty: 1 }] });
  ok('oddiy sotuv tarixga yozilmaydi (u sotuvlar jadvalida)', !(await feed(A.token)).some((a) => a.entityId === r.j.id && a.entity === 'sale' && a.action === 'sale.price'));

  // ---- Oflayn sotuvda qoldiq yetmagan ----
  await db('products').where({ id: p.id }).update({ qty: 1 });
  r = await call('POST', '/api/sales', S.token, { clientId: 'o1', offline: true, createdAt: Date.now() - 1000, items: [{ productId: p.id, qty: 3, seen: 1440 }] });
  ok('oflayn sotuvda qoldiq yetmasa kim sotgani yozildi', has(await feed(A.token), 'sale.offline', /yetarli emas/));

  // ---- Sotuvni bekor qilish ----
  r = await call('POST', `/api/sales/${saleId}/void`, S.token, { reason: 'xato kiritdim' });
  f = await feed(A.token);
  ok('sotuv bekori yozildi (kim, sabab)', r.s === 200 && has(f, 'sale.void', /bekor qilindi.*Sabab: xato kiritdim/) && f[0].userName === 'Ali');

  // ---- Qarz va xarajat ----
  const d = (await call('POST', '/api/debts', A.token, { name: 'Karim', amount: 500 })).j;
  await call('POST', `/api/debts/${d.id}/pay`, S.token, { amount: 200 });
  f = await feed(A.token);
  ok("qarz qo'shilishi va to'lovi (kim qabul qilgani) yozildi", has(f, 'debt.create', /Karim/) && has(f, 'debt.pay', /200 so'm qabul/) && f[0].userName === 'Ali');
  const e = (await call('POST', '/api/expenses', A.token, { name: 'Ijara', amount: 300 })).j;
  await call('DELETE', `/api/expenses/${e.id}`, A.token);
  f = await feed(A.token);
  ok("xarajat qo'shish va o'chirish yozildi", has(f, 'expense.create', /Ijara/) && has(f, 'expense.delete', /Ijara/));

  // ---- Xodim va xavfsizlik ----
  const st2 = (await call('PATCH', `/api/staff/${st.id}`, A.token, { resetPassword: true })).j;
  await call('PATCH', `/api/staff/${st.id}`, A.token, { active: false });
  f = await feed(A.token);
  ok('xodim: qo\'shish, parol yangilash, o\'chirish yozildi', has(f, 'staff.create', /Ali/) && has(f, 'staff.update', /yangi vaqtinchalik parol/) && has(f, 'staff.update', /o'chirildi/));
  const A2 = (await call('POST', '/api/auth/password', A.token, { current: 'secret1', password: 'secret2' })).j; // yangi token qaytadi
  ok("parol o'zgartirilgani yozildi", has(await feed(A2.token), 'auth.password'));
  await call('DELETE', `/api/products/${p.id}`, A2.token);
  ok("mahsulot o'chirilishi yozildi (qoldiq bilan)", has(await feed(A2.token), 'product.delete', /Gilam.*qoldiq/));

  // ---- Maxfiylik ----
  const all = JSON.stringify(await feed(A2.token, '?limit=200'));
  ok('tarixda parol, hash va token YO\'Q', !all.includes(st.password) && !all.includes(st2.password) && !all.includes('secret') && !/\$2[aby]\$/.test(all) && !all.includes(A.token));
  ok("tarixda to'liq telefon raqam yo'q", !all.includes('998901230301'));

  // ---- Kirish huquqi va izolyatsiya ----
  ok('sotuvchi tarixni ko\'ra olmaydi (403)', (await call('GET', '/api/audit', S.token)).s === 403 || (await call('GET', '/api/audit', S.token)).s === 401);
  ok('tokensiz 401', (await call('GET', '/api/audit')).s === 401);
  ok("boshqa do'kon admini bu tarixni ko'rmaydi", (await feed(B.token)).length === 0);

  // ---- Filtr va sahifalash ----
  const prodOnly = await feed(A2.token, '?entity=product');
  ok('entity filtri ishlaydi', prodOnly.length > 0 && prodOnly.every((a) => a.entity === 'product'));
  const p1 = await feed(A2.token, '?limit=3'), p2 = await feed(A2.token, `?limit=3&before=${p1[2].id}`);
  ok('sahifalash (before): takrorlanmaydi, yangidan eskiga', p1.length === 3 && p2.length > 0 && p2[0].id < p1[2].id && p1[0].id > p1[1].id);
  ok('limit 200 dan oshmaydi', (await feed(A2.token, '?limit=99999')).length <= 200);

  // ---- Tarix yozilmasa ham asosiy amal to'xtamaydi ----
  await db.schema.renameTable('audit_log', 'audit_log_x');
  r = await call('POST', '/api/products', A2.token, { name: 'Pardа', unit: 'dona', cost: 5, pct: 10, qty: 3 });
  await db.schema.renameTable('audit_log_x', 'audit_log');
  ok("audit jadvali ishlamasa ham mahsulot qo'shiladi (amal to'xtamaydi)", r.s === 201);

  // ---- Hisob o'chsa tarix ham o'chadi ----
  await call('POST', '/api/auth/delete-account', A2.token, { password: 'secret2' });
  ok("hisob o'chirilganda tarixi ham o'chadi", (await db('audit_log').count({ c: '*' }).first()).c == 0);

  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAUDIT TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

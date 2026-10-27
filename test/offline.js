// Oflayn sotuv (server): clientId bilan idempotentlik, oflayn sotuvda qoldiq/narx/vaqt qoidalari.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-o-'));
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
const addSeller = async (admin, name) => {
  const st = (await call('POST', '/api/staff', admin.token, { name })).j;
  return (await call('POST', '/api/auth/login', null, { id: st.loginId, password: st.password })).j;
};
const qtyOf = async (t, id) => (await call('GET', '/api/products', t)).j.find((p) => p.id === id).qty;

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = await register('998901230101', "Do'kon A"), B = await register('998901230102', "Do'kon B");
  const S1 = await addSeller(A, 'Ali'), S2 = await addSeller(A, 'Vali');
  const gilam = (await call('POST', '/api/products', A.token, { name: 'Gilam', unit: 'm', cost: 1000, pct: 20, qty: 5 })).j; // sotuv narxi 1200
  const past = Date.now() - 3 * 3600e3;

  const body = { clientId: 'cid-1', offline: true, createdAt: past, customer: 'Karim', items: [{ productId: gilam.id, qty: 2, seen: 1200 }] };
  let r = await call('POST', '/api/sales', S1.token, body);
  ok("oflayn sotuv yoziladi, sotuv vaqti (createdAt) saqlanadi", r.s === 201 && r.j.createdAt === past && r.j.offline === true && r.j.total === 2400);
  const id1 = r.j.id;
  ok('ombor kamaydi', (await qtyOf(A.token, gilam.id)) === 3);
  r = await call('POST', '/api/sales', S1.token, body);
  ok("QAYTA yuborilsa: o'sha sotuv qaytadi, dublikat yo'q, ombor ikki marta kamaymaydi", r.s === 200 && r.j.id === id1 && (await qtyOf(A.token, gilam.id)) === 3);
  const all = await Promise.all([1, 2, 3].map(() => call('POST', '/api/sales', S1.token, { clientId: 'race', offline: true, createdAt: past, items: [{ productId: gilam.id, qty: 1, seen: 1200 }] })));
  ok("bir vaqtda 3 ta bir xil so'rov: bitta sotuv", all.every((x) => x.s === 200 || x.s === 201) && (await qtyOf(A.token, gilam.id)) === 2 && new Set(all.map((x) => x.j.id)).size === 1);
  r = await call('POST', '/api/sales', S2.token, body);
  ok("boshqa xodim o'zganing clientId sini ishlata olmaydi", r.s === 409);

  r = await call('POST', '/api/sales', S1.token, { clientId: 'low', offline: true, createdAt: past, items: [{ productId: gilam.id, qty: 5, seen: 1200 }] });
  ok("oflayn: qoldiq yetmasa ham yoziladi (tovar berilgan), ogohlantirish bilan", r.s === 201 && r.j.warnings && /yetarli emas/.test(r.j.warnings[0]) && (await qtyOf(A.token, gilam.id)) === -3);
  await call('POST', `/api/products/${gilam.id}/restock`, A.token, { qty: 100, cost: 1000 });
  r = await call('POST', '/api/sales', S1.token, { items: [{ productId: gilam.id, qty: 1000 }] });
  ok("onlayn sotuvda qoldiq tekshiruvi avvalgidek (409)", r.s === 409);

  r = await call('POST', '/api/sales', S1.token, { clientId: 'hack', offline: true, createdAt: past, items: [{ productId: gilam.id, qty: 1, price: 1, seen: 1 }] });
  ok("sotuvchi oflayn sotuvda ham narxni o'zgartira olmaydi (server narxi 1200)", r.s === 201 && r.j.total === 1200 && r.j.warnings.some((w) => /Narx o'zgargan/.test(w)));
  r = await call('POST', '/api/sales', A.token, { clientId: 'adm', offline: true, createdAt: past, items: [{ productId: gilam.id, qty: 1, price: 1500, seen: 1500 }] });
  ok("admin o'z narxini bera oladi", r.s === 201 && r.j.total === 1500);

  r = await call('POST', '/api/sales', S1.token, { clientId: 'fut', offline: true, createdAt: Date.now() + 3600e3, items: [{ productId: gilam.id, qty: 1 }] });
  ok("kelajak vaqti qabul qilinmaydi", r.s === 201 && r.j.createdAt <= Date.now());
  r = await call('POST', '/api/sales', S1.token, { clientId: 'old', offline: true, createdAt: Date.now() - 90 * 86400e3, items: [{ productId: gilam.id, qty: 1 }] });
  ok("90 kun oldingi vaqt qabul qilinmaydi", r.s === 201 && r.j.createdAt > Date.now() - 60000);
  r = await call('POST', '/api/sales', S1.token, { clientId: 'noflag', createdAt: past, items: [{ productId: gilam.id, qty: 1 }] });
  ok("offline:true bo'lmasa createdAt e'tiborsiz (orqaga sana qo'yib bo'lmaydi)", r.s === 201 && r.j.createdAt > Date.now() - 60000 && !r.j.offline);

  r = await call('POST', '/api/sales', S1.token, { clientId: 'nasiya', offline: true, createdAt: past, customer: 'Aziz', credit: { paidNow: 200, due: '2027-01-01' }, items: [{ productId: gilam.id, qty: 1, seen: 1200 }] });
  const debts = (await call('GET', '/api/debts', A.token)).j;
  ok("oflayn nasiya: qarz 1000 qoldi", r.s === 201 && debts.some((d) => d.saleId === r.j.id && d.remaining === 1000));

  const gB = (await call('POST', '/api/products', B.token, { name: 'Boshqa', unit: 'dona', cost: 1, pct: 0, qty: 5 })).j;
  r = await call('POST', '/api/sales', S1.token, { clientId: 'x', offline: true, createdAt: past, items: [{ productId: gB.id, qty: 1 }] });
  ok("boshqa do'kon mahsulotiga oflayn sotuv o'tmaydi (404)", r.s === 404);
  r = await call('POST', `/api/sales/${id1}/void`, A.token, {});
  ok("oflayn sotuvni ham bekor qilish mumkin", r.s === 200);

  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nOFLAYN TEST: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

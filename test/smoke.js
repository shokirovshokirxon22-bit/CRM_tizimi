// Ishga tushirish: npm test  (vaqtinchalik SQLite bazada, haqiqiy ma'lumotga tegmaydi)
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret';
process.env.SUPER_KEY = 'super-test';
process.env.AUTH_RATE_LIMIT = '1000';
delete process.env.DATABASE_URL;

const { createApp } = require('../src/app');
const { migrate, db } = require('../src/db');

let base, pass = 0;
const call = async (method, url, token, body, extra = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j };
};
const ok = (name, cond) => { assert.ok(cond, 'XATO: ' + name); pass++; console.log('  ✓', name); };

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;

  // --- ikkita mustaqil biznes egasi
  const A = (await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon A', phone: '+998901111111', password: 'secretA1' })).j;
  const B = (await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon B', phone: '+998902222222', password: 'secretB1' })).j;
  ok('ikki do\'kon ro\'yxatdan o\'tdi', A.token && B.token && A.shop.id !== B.shop.id);
  ok('bir xil raqam ikkinchi marta olinmaydi', (await call('POST', '/api/auth/register', null, { shopName: 'x', phone: '998901111111', password: 'secretA1' })).s === 409);

  // --- A: mahsulotlar va xodim
  const p1 = (await call('POST', '/api/products', A.token, { name: 'Gilam', unit: 'm', cost: 10000, pct: 20, qty: 50, barcode: '111' })).j;
  const p2 = (await call('POST', '/api/products', A.token, { name: 'Lampa', unit: 'dona', cost: 5000, pct: 10, qty: 3 })).j;
  ok('admin mahsulot qo\'shdi (tannarx ko\'rinadi)', p1.id && p1.cost === 10000 && p1.sellPrice === 12000);
  const st = (await call('POST', '/api/staff', A.token, { name: 'Ali', phone: '+998903333333', password: 'seller123' })).j;
  ok('admin xodim yaratdi', st.role === 'seller');
  const S = (await call('POST', '/api/auth/login', null, { phone: '998903333333', password: 'seller123' })).j;
  ok('xodim login qildi va A do\'koniga ulandi', S.token && S.shop.id === A.shop.id);

  // --- B hech narsani ko'rmaydi / tega olmaydi
  ok('B ning mahsulotlari bo\'sh', (await call('GET', '/api/products', B.token)).j.length === 0);
  ok('B, A mahsulotini tahrirlay olmaydi', (await call('PUT', `/api/products/${p1.id}`, B.token, { name: 'hack', cost: 1 })).s === 404);
  ok('B, A mahsulotini o\'chira olmaydi', (await call('DELETE', `/api/products/${p1.id}`, B.token)).s === 404);
  ok('B, A mahsulotini sota olmaydi', (await call('POST', '/api/sales', B.token, { items: [{ productId: p1.id, qty: 1 }] })).s === 404);
  ok('B, A xodimlarini ko\'rmaydi', (await call('GET', '/api/staff', B.token)).j.length === 1);
  ok('B xodimni o\'zgartira olmaydi', (await call('PATCH', `/api/staff/${st.id}`, B.token, { active: false })).s === 404);
  ok('B shtrix-kod bilan A mahsulotini topa olmaydi', (await call('GET', '/api/products?barcode=111', B.token)).j.length === 0);
  // B ham xuddi shu shtrix-kodni ishlata oladi (do'konlar mustaqil)
  ok('B o\'z mahsulotiga o\'sha shtrix-kodni qo\'ya oladi', (await call('POST', '/api/products', B.token, { name: 'Boshqa', unit: 'dona', cost: 100, qty: 5, barcode: '111' })).s === 201);

  // --- sotuvchi cheklovlari
  const sp = (await call('GET', '/api/products', S.token)).j;
  ok('sotuvchi tannarx/foizni ko\'rmaydi', sp.length === 2 && sp.every((p) => !('cost' in p) && !('pct' in p) && p.sellPrice > 0));
  ok('sotuvchi mahsulot qo\'sha olmaydi', (await call('POST', '/api/products', S.token, { name: 'x', unit: 'kg', cost: 1 })).s === 403);
  ok('sotuvchi hisobotni ko\'ra olmaydi', (await call('GET', '/api/reports/summary', S.token)).s === 403);
  ok('sotuvchi xodimlarni ko\'ra olmaydi', (await call('GET', '/api/staff', S.token)).s === 403);
  ok('sotuvchi xarajatni ko\'ra olmaydi', (await call('GET', '/api/expenses', S.token)).s === 403);

  // --- sotuv: narx serverda hisoblanadi
  const sale = (await call('POST', '/api/sales', S.token, { customer: 'Vali', items: [{ productId: p1.id, qty: 2.5, price: 1 }] })).j;
  ok('sotuvchi narxni o\'zgartira olmaydi (server narxi ishlatildi)', sale.total === 2.5 * 12000);
  ok('sotuv javobida tannarx/foyda yo\'q', !('profit' in sale) && sale.items.every((i) => !('cost' in i)));
  ok('qoldiq kamaydi', (await call('GET', '/api/products?barcode=111', A.token)).j[0].qty === 47.5);
  ok('omborda yo\'q mahsulotni sotib bo\'lmaydi', (await call('POST', '/api/sales', S.token, { items: [{ productId: p2.id, qty: 99 }] })).s === 409);
  ok('muvaffaqiyatsiz sotuv qoldiqni o\'zgartirmadi', (await call('GET', '/api/products', A.token)).j.find((p) => p.id === p2.id).qty === 3);

  await call('PUT', '/api/settings', A.token, { sellerEditPrice: true });
  const s2 = (await call('POST', '/api/sales', S.token, { items: [{ productId: p1.id, qty: 1, price: 11000 }] })).j;
  ok('admin ruxsat bersa sotuvchi narxni o\'zgartira oladi', s2.total === 11000);

  // --- admin ko'radi: foyda
  const adm = (await call('GET', '/api/sales', A.token)).j;
  ok('admin sotuvda foyda va tannarxni ko\'radi', adm.length === 2 && adm.every((s) => 'profit' in s) && adm[1].profit === 2.5 * 2000);
  ok('sotuvchi faqat o\'z sotuvlarini ko\'radi', (await call('GET', '/api/sales', S.token)).j.length === 2);
  ok('B sotuvlarni ko\'rmaydi', (await call('GET', '/api/sales', B.token)).j.length === 0);
  const rep = (await call('GET', '/api/reports/summary', A.token)).j;
  ok('hisobot to\'g\'ri', rep.revenue === 41000 && rep.profit === 5000 + 1000 && rep.ranking[0].name === 'Gilam');
  ok('B hisoboti bo\'sh', (await call('GET', '/api/reports/summary', B.token)).j.revenue === 0);

  // --- nasiya
  const cs = (await call('POST', '/api/sales', S.token, { customer: 'Qarzdor', items: [{ productId: p1.id, qty: 1 }], credit: { paidNow: 2000, phone: '+998904444444', due: '2026-12-01' } })).j;
  ok('nasiya qarz yaratdi', cs.debt && cs.debt.remaining === 10000);
  ok('B qarzlarni ko\'rmaydi', (await call('GET', '/api/debts', B.token)).j.length === 0);
  ok('B, A qarzini to\'lay olmaydi', (await call('POST', `/api/debts/${cs.debt.id}/pay`, B.token, { amount: 1 })).s === 404);
  const pd = (await call('POST', `/api/debts/${cs.debt.id}/pay`, S.token, { amount: 4000 })).j;
  ok('qisman to\'lov', pd.remaining === 6000 && !pd.paid);
  ok('to\'liq to\'lov', (await call('POST', `/api/debts/${cs.debt.id}/pay`, A.token, { amount: 99999 })).j.paid === true);
  await call('PUT', '/api/settings', A.token, { sellerSeeDebts: false });
  ok('admin yopsa sotuvchi qarzlarni ko\'rmaydi', (await call('GET', '/api/debts', S.token)).s === 403);

  // --- xodimni o'chirish va autentifikatsiya
  await call('PATCH', `/api/staff/${st.id}`, A.token, { active: false });
  ok('o\'chirilgan xodim tokeni darrov ishlamaydi', (await call('GET', '/api/products', S.token)).s === 401);
  ok('o\'chirilgan xodim login qila olmaydi', (await call('POST', '/api/auth/login', null, { phone: '998903333333', password: 'seller123' })).s === 401);
  ok('tokensiz so\'rov rad etiladi', (await call('GET', '/api/products')).s === 401);
  ok('noto\'g\'ri parol', (await call('POST', '/api/auth/login', null, { phone: '998901111111', password: 'wrong' })).s === 401);

  // --- reklama
  ok('SUPER_KEY siz reklama qo\'shib bo\'lmaydi', (await call('POST', '/api/super/ads', null, { title: 'x' })).s === 403);
  ok('admin SUPER_KEY o\'rniga o\'z tokeni bilan reklama qo\'sha olmaydi', (await call('POST', '/api/super/ads', A.token, { title: 'x' })).s === 403);
  await call('POST', '/api/super/ads', null, { title: 'Aksiya!', body: 'Chegirma', placement: 'home' }, { 'x-super-key': 'super-test' });
  const ads = (await call('GET', '/api/ads?placement=home', B.token)).j;
  ok('reklama hamma do\'konga ko\'rinadi', ads.length === 1 && ads[0].title === 'Aksiya!');

  // --- eski ma'lumotni ko'chirish va tovar tarixi
  const old = { products: [{ id: '1', name: 'Eski gilam', unit: 'm', cost: 100, pct: 10, qty: 5, min: 1, bc: '777', w: 2 }],
    sales: [{ id: 5, t: Date.now(), cust: 'Karim', debt: true, paid: false, pay: 20, items: [{ name: 'Eski gilam', unit: 'm', qty: 2, price: 120, cost: 100 }] }],
    buys: [{ t: Date.now(), name: 'Eski gilam', amount: 500 }], debts: [{ t: 5, sid: 5, name: 'Karim', amount: 220, total: 240, ph: '+998905555555', due: '2026-12-31', paid: false, pays: [{ t: Date.now(), a: 20 }] }],
    exp: [{ t: Date.now(), name: 'Ijara', amount: 50 }], set: { lang: 'ru', sms: true, days: 2 } };
  ok('seller/boshqa admin import qila olmaydi (B do\'konida ma\'lumot bor)', (await call('POST', '/api/import', B.token, old)).s === 409);
  const C = (await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon C', phone: '+998906666666', password: 'secretC1' })).j;
  const imp = await call('POST', '/api/import', C.token, old);
  ok('eski ma\'lumot ko\'chirildi', imp.s === 201 && imp.j.products === 1 && imp.j.sales === 1 && imp.j.debts === 1);
  const cd = (await call('GET', '/api/debts', C.token)).j;
  ok('ko\'chirilgan qarz sotuvga bog\'langan', cd.length === 1 && cd[0].remaining === 220 && cd[0].saleId);
  ok('ko\'chirilgan sotuvda qarz bor', (await call('GET', '/api/sales', C.token)).j[0].debt.remaining === 220);
  ok('ko\'chirilgan sozlamalar', (await call('GET', '/api/settings', C.token)).j.lang === 'ru');
  ok('buys faqat admin', (await call('GET', '/api/buys', C.token)).j.length === 1);
  ok('boshqa do\'kon C ma\'lumotini ko\'rmaydi', (await call('GET', '/api/products', A.token)).j.every((p) => p.name !== 'Eski gilam'));
  ok('ikkinchi marta import rad etiladi', (await call('POST', '/api/import', C.token, old)).s === 409);

  // parol hash bazada ochiq emas
  const u = await db('users').first();
  ok('parol bcrypt bilan hashlangan', u.password_hash.startsWith('$2'));

  console.log(`\nHAMMASI JOYIDA: ${pass} ta tekshiruv o'tdi`);
  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

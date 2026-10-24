// Kirish tizimi testlari: SMS tasdiqlash, 6 xonali ID, parol tiklash, raqam almashtirish, hisobni o'chirish.
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
const lastCode = (phone) => { const m = [...outbox].reverse().find((x) => x.phone === phone); return m && m.text.match(/\d{6}/)[0]; };
const wrong = (code) => (code === '000000' ? '000001' : '000000');

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;

  // ---------- Ro'yxatdan o'tish: telefon tasdiqlanadi ----------
  const P1 = '998901110001';
  ok('kodsiz ro\'yxatdan o\'tib bo\'lmaydi', (await call('POST', '/api/auth/register', null, { shopName: 'A', phone: P1, password: 'secret1' })).s === 400);
  let r = await call('POST', '/api/auth/register/start', null, { phone: '+998 90 111 00 01' });
  ok('kod yuborildi', r.s === 200 && lastCode(P1));
  ok('kodni tez-tez qayta yuborib bo\'lmaydi (429)', (await call('POST', '/api/auth/register/start', null, { phone: P1 })).s === 429);
  const code = lastCode(P1);
  ok('noto\'g\'ri kod bilan ochilmaydi', (await call('POST', '/api/auth/register', null, { shopName: 'A', phone: P1, password: 'secret1', code: wrong(code) })).s === 400);
  ok('boshqa raqamga kelgan kod bu raqamga yaramaydi', (await call('POST', '/api/auth/register', null, { shopName: 'A', phone: '998901110009', password: 'secret1', code })).s === 400);
  ok('qisqa parol rad etiladi (kod sarflanmaydi)', (await call('POST', '/api/auth/register', null, { shopName: 'A', phone: P1, password: '123', code })).s === 400);
  r = await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon A', phone: P1, password: 'secret1', code });
  ok('to\'g\'ri kod bilan hisob ochildi', r.s === 201 && /^\d{6}$/.test(r.j.user.loginId) && r.j.user.role === 'admin');
  const A = r.j, aId = A.user.loginId;
  ok('tasdiqlangan raqam bazada belgilangan', (await db('users').where({ id: A.user.id }).first()).phone_verified == true);
  ok('kod qayta ishlatilmaydi', (await call('POST', '/api/auth/register', null, { shopName: 'B', phone: P1, password: 'secret1', code })).s !== 201);
  ok('band raqam uchun kod yuborilmaydi (409)', (await call('POST', '/api/auth/register/start', null, { phone: '90 111 00 01' })).s === 409);

  // 5 marta xato kiritilsa kod bloklanadi
  const P2 = '998901110002';
  await call('POST', '/api/auth/register/start', null, { phone: P2 });
  const c2 = lastCode(P2);
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/register', null, { shopName: 'B', phone: P2, password: 'secret1', code: wrong(c2) });
  ok('5 ta xatodan keyin to\'g\'ri kod ham o\'tmaydi', (await call('POST', '/api/auth/register', null, { shopName: 'B', phone: P2, password: 'secret1', code: c2 })).s === 400);

  // muddati o'tgan kod
  const P3 = '998901110003';
  await call('POST', '/api/auth/register/start', null, { phone: P3 });
  await db('otps').where({ phone: P3 }).update({ expires_at: Date.now() - 1000 });
  ok('muddati o\'tgan kod o\'tmaydi', (await call('POST', '/api/auth/register', null, { shopName: 'C', phone: P3, password: 'secret1', code: lastCode(P3) })).s === 400);

  // ---------- Kirish: ID + parol ----------
  r = await call('POST', '/api/auth/login', null, { id: aId, password: 'secret1' });
  ok('admin ID + parol bilan kirdi', r.s === 200 && r.j.token && r.j.user.loginId === aId);
  ok('ID noto\'g\'ri bo\'lsa rad', (await call('POST', '/api/auth/login', null, { id: '123456', password: 'secret1' })).s === 401);
  ok('eski usul: telefon bilan ham kiradi (eski hisoblar uchun)', (await call('POST', '/api/auth/login', null, { phone: '90 111 00 01', password: 'secret1' })).s === 200);

  // ---------- Xodim: tizim ID va parol beradi ----------
  const st = (await call('POST', '/api/staff', A.token, { name: 'Ali' })).j;
  const st2 = (await call('POST', '/api/staff', A.token, { name: 'Vali' })).j;
  ok('xodim ID 6 xonali va takrorlanmas', /^\d{6}$/.test(st.loginId) && st.loginId !== st2.loginId && st.loginId !== aId);
  ok('xodimda telefon yo\'q', st.phone === null);
  ok('parol bazada hash', !JSON.stringify(await db('users').where({ id: st.id }).first()).includes(st.password));
  const SL = await call('POST', '/api/auth/login', null, { id: st.loginId, password: st.password });
  ok('xodim ID + parol bilan kirdi', SL.s === 200 && SL.j.shop.id === A.shop.id && SL.j.user.role === 'seller');
  ok('ro\'yxatda xodim ID si ko\'rinadi', (await call('GET', '/api/staff', A.token)).j.some((u) => u.loginId === st.loginId));
  const chg = await call('POST', '/api/auth/password', SL.j.token, { current: st.password, password: 'mening-parolim' });
  ok('xodim parolini o\'zi o\'zgartirdi', chg.s === 200 && chg.j.token);
  const sTok = chg.j.token; // parol almashgach eski token bekor bo'ladi, yangisi beriladi
  ok('eski parol ishlamaydi, yangisi ishlaydi', (await call('POST', '/api/auth/login', null, { id: st.loginId, password: st.password })).s === 401
    && (await call('POST', '/api/auth/login', null, { id: st.loginId, password: 'mening-parolim' })).s === 200);
  ok('xodim telefon almashtira olmaydi (403)', (await call('POST', '/api/auth/phone/start', sTok, { phone: '998901119999', password: 'mening-parolim' })).s === 403);
  ok('xodim hisobni o\'chira olmaydi (403)', (await call('POST', '/api/auth/delete-account', sTok, { password: 'mening-parolim' })).s === 403);

  // admin xodim parolini yangilaydi: yangi parol beriladi, eski token o'ladi
  const tokBefore = (await call('POST', '/api/auth/login', null, { id: st.loginId, password: 'mening-parolim' })).j.token;
  r = await call('PATCH', `/api/staff/${st.id}`, A.token, { resetPassword: true });
  ok('admin yangi vaqtinchalik parol oldi', r.s === 200 && r.j.password && r.j.password !== 'mening-parolim');
  ok('xodimning eski tokeni bekor bo\'ldi', (await call('GET', '/api/products', tokBefore)).s === 401);
  ok('yangi parol bilan kiradi', (await call('POST', '/api/auth/login', null, { id: st.loginId, password: r.j.password })).s === 200);

  // ---------- Parolni almashtirish: eski tokenlar bekor, yangi token beriladi ----------
  const T1 = (await call('POST', '/api/auth/login', null, { id: aId, password: 'secret1' })).j.token;
  r = await call('POST', '/api/auth/password', T1, { current: 'secret1', password: 'secret2' });
  ok('parol almashtirildi va yangi token berildi', r.s === 200 && r.j.token);
  ok('eski token endi ishlamaydi', (await call('GET', '/api/auth/me', T1)).s === 401);
  ok('yangi token ishlaydi', (await call('GET', '/api/auth/me', r.j.token)).s === 200);

  // ---------- Parolni tiklash (admin, SMS orqali) ----------
  const before = outbox.length;
  r = await call('POST', '/api/auth/reset/start', null, { phone: '998909998877' });
  ok('noma\'lum raqamga ham bir xil javob, SMS ketmaydi', r.s === 200 && outbox.length === before);
  r = await call('POST', '/api/auth/reset/start', null, { phone: '+998 90 111 00 01' });
  const rc = lastCode(P1);
  ok('tiklash kodi yuborildi', r.s === 200 && outbox.length === before + 1 && rc);
  ok('noto\'g\'ri kod bilan tiklanmaydi', (await call('POST', '/api/auth/reset/confirm', null, { phone: P1, code: wrong(rc), password: 'yangi-parol' })).s === 400);
  ok('xodim raqamiga tiklash yo\'q (xodimda telefon yo\'q)', (await call('POST', '/api/auth/reset/confirm', null, { phone: '998900000000', code: rc, password: 'yangi-parol' })).s === 400);
  r = await call('POST', '/api/auth/reset/confirm', null, { phone: P1, code: rc, password: 'yangi-parol' });
  ok('parol tiklandi va ID qaytarildi', r.s === 200 && r.j.loginId === aId);
  ok('eski parol ishlamaydi', (await call('POST', '/api/auth/login', null, { id: aId, password: 'secret2' })).s === 401);
  ok('yangi parol bilan kiradi', (await call('POST', '/api/auth/login', null, { id: aId, password: 'yangi-parol' })).s === 200);
  ok('tiklash kodi qayta ishlatilmaydi', (await call('POST', '/api/auth/reset/confirm', null, { phone: P1, code: rc, password: 'boshqa-parol' })).s === 400);
  ok('eski sessiya tokeni (reset oldidan) bekor', (await call('GET', '/api/auth/me', A.token)).s === 401);

  // ---------- Brute-force himoyasi ----------
  const adminTok = (await call('POST', '/api/auth/login', null, { id: aId, password: 'yangi-parol' })).j.token;
  for (let i = 0; i < 8; i++) await call('POST', '/api/auth/login', null, { id: st2.loginId, password: 'xato-parol' });
  r = await call('POST', '/api/auth/login', null, { id: st2.loginId, password: st2.password });
  ok('8 ta xatodan keyin hisob vaqtincha bloklanadi (429)', r.s === 429);
  r = await call('PATCH', `/api/staff/${st2.id}`, adminTok, { resetPassword: true });
  ok('admin parolni yangilasa blok olinadi', (await call('POST', '/api/auth/login', null, { id: st2.loginId, password: r.j.password })).s === 200);

  // ---------- Telefon raqamni o'zgartirish ----------
  const PN = '998901110077';
  ok('noto\'g\'ri parol bilan raqam almashmaydi', (await call('POST', '/api/auth/phone/start', adminTok, { phone: PN, password: 'xato' })).s === 400);
  // band raqam uchun alohida admin yaratamiz
  const reg = async (shop, phone, pw) => { await call('POST', '/api/auth/register/start', null, { phone }); return call('POST', '/api/auth/register', null, { shopName: shop, phone, password: pw, code: lastCode(phone.replace(/\D/g, '')) }); };
  const B = (await reg('Do\'kon B', '998901110005', 'bpass123')).j;
  ok('boshqa adminning raqamiga almashtirib bo\'lmaydi (409)', (await call('POST', '/api/auth/phone/start', adminTok, { phone: '998901110005', password: 'yangi-parol' })).s === 409);
  ok('hozirgi raqamning o\'ziga almashtirib bo\'lmaydi', (await call('POST', '/api/auth/phone/start', adminTok, { phone: P1, password: 'yangi-parol' })).s === 400);
  r = await call('POST', '/api/auth/phone/start', adminTok, { phone: PN, password: 'yangi-parol' });
  const pc = lastCode(PN);
  ok('yangi raqamga kod yuborildi', r.s === 200 && pc);
  ok('boshqa foydalanuvchi bu kodni ishlata olmaydi', (await call('POST', '/api/auth/phone/confirm', B.token, { phone: PN, code: pc })).s === 400);
  ok('noto\'g\'ri kod bilan almashmaydi', (await call('POST', '/api/auth/phone/confirm', adminTok, { phone: PN, code: wrong(pc) })).s === 400);
  r = await call('POST', '/api/auth/phone/confirm', adminTok, { phone: PN, code: pc });
  ok('raqam almashtirildi', r.s === 200 && (await call('GET', '/api/auth/me', adminTok)).j.user.phone === PN);
  const b4 = outbox.length;
  await call('POST', '/api/auth/reset/start', null, { phone: P1 });
  ok('eski raqamga endi tiklash kodi ketmaydi', outbox.length === b4);
  await call('POST', '/api/auth/reset/start', null, { phone: PN });
  ok('yangi raqamga tiklash kodi ketadi', outbox.length === b4 + 1);

  // ---------- Hisobni o'chirish ----------
  await call('POST', '/api/products', adminTok, { name: 'Gilam', unit: 'm', cost: 100, qty: 5 });
  const sellerTok = (await call('POST', '/api/auth/login', null, { id: st2.loginId, password: (await call('PATCH', `/api/staff/${st2.id}`, adminTok, { resetPassword: true })).j.password })).j.token;
  ok('noto\'g\'ri parol bilan o\'chirilmaydi', (await call('POST', '/api/auth/delete-account', adminTok, { password: 'xato' })).s === 400);
  ok('parolsiz o\'chirilmaydi', (await call('POST', '/api/auth/delete-account', adminTok, {})).s === 400);
  r = await call('POST', '/api/auth/delete-account', adminTok, { password: 'yangi-parol' });
  ok('hisob o\'chirildi', r.s === 200);
  ok('token endi ishlamaydi', (await call('GET', '/api/auth/me', adminTok)).s === 401);
  ok('xodim ham tizimdan chiqib ketdi', (await call('GET', '/api/products', sellerTok)).s === 401);
  ok('ID bilan qayta kirib bo\'lmaydi', (await call('POST', '/api/auth/login', null, { id: aId, password: 'yangi-parol' })).s === 401);
  ok('do\'kon, mahsulot va xodimlar bazadan o\'chdi', !(await db('shops').where({ id: A.shop.id }).first()) && !(await db('products').where({ shop_id: A.shop.id }).first()) && !(await db('users').where({ shop_id: A.shop.id }).first()));
  ok('boshqa do\'kon (B) saqlanib qoldi', (await call('GET', '/api/auth/me', B.token)).s === 200);
  ok('o\'chirilgan hisob raqami yana ro\'yxatdan o\'ta oladi', (await call('POST', '/api/auth/register/start', null, { phone: PN })).s === 200);

  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAUTH TEST: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });
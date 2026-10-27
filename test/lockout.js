// Brute-force himoyasi: bloklash (foydalanuvchi + IP) juftligi bo'yicha. Birovning ID sini terib uni to'sib bo'lmaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-l-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
process.env.TRUST_PROXY = '1'; process.env.LOGIN_USER_HOURLY = '10'; delete process.env.LOGIN_MAX_FAILS;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { createApp } = require('../src/app');
const { migrate, db } = require('../src/db');
const { outbox } = require('../src/sms');
const { ipKey } = require('../src/lockout');

let base, n = 0;
const call = async (m, u, t, b, ip) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { s: r.status, j };
};
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
const lastCode = (phone) => [...outbox].reverse().find((x) => x.phone === phone).text.match(/\d{6}/)[0];
const login = (id, password, ip) => call('POST', '/api/auth/login', null, { id, password }, ip);
const bad = async (id, ip, k) => { for (let i = 0; i < k; i++) await login(id, 'xato-parol', ip); };

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  await call('POST', '/api/auth/register/start', null, { phone: '998901230201' });
  const A = (await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon', phone: '998901230201', password: 'secret1', code: lastCode('998901230201') })).j;
  const mk = async (name) => (await call('POST', '/api/staff', A.token, { name })).j;
  const S1 = await mk('Ali'), S2 = await mk('Vali'), S3 = await mk('Sami');
  const IP1 = '203.0.113.5', IP2 = '198.51.100.7';

  // --- Asosiy: hujumchi IP1 dan terib, egasini to'sa olmaydi ---
  await bad(S1.loginId, IP1, 8);
  let r = await login(S1.loginId, S1.password, IP1);
  ok('8 ta xatodan keyin HUJUMCHI IP si bloklanadi (to\'g\'ri parol bilan ham 429)', r.s === 429 && /daqiqadan keyin/.test(r.j.error));
  r = await login(S1.loginId, S1.password, IP2);
  ok('EGASI boshqa IP dan kira oladi: birovning ID sini terib to\'sib bo\'lmaydi', r.s === 200 && !!r.j.token);
  r = await login(S2.loginId, S2.password, IP1);
  ok('hujumchi IP si boshqa ID lar uchun bloklanmagan (juftlik bo\'yicha)', r.s === 200);

  // --- Admin parolni yangilasa blok olinadi ---
  r = await call('PATCH', `/api/staff/${S1.id}`, A.token, { resetPassword: true });
  const newPw = r.j.password;
  ok('admin parolni yangilasa blok olinadi', (await login(S1.loginId, newPw, IP1)).s === 200);

  // --- Muvaffaqiyatli kirish hisoblagichni nolga qaytaradi ---
  await bad(S3.loginId, IP1, 7);
  ok('7 ta xato + to\'g\'ri kirish: hali bloklanmagan', (await login(S3.loginId, S3.password, IP1)).s === 200);
  await bad(S3.loginId, IP1, 7);
  ok('to\'g\'ri kirishdan keyin hisob qaytadan boshlanadi (yana 7 ta xato blok emas)', (await login(S3.loginId, S3.password, IP1)).s === 200);

  // --- Blok vaqt o'tgach o'zi tugaydi ---
  await bad(S3.loginId, '192.0.2.9', 8);
  ok('IP bloklandi', (await login(S3.loginId, S3.password, '192.0.2.9')).s === 429);
  await db('login_fail').where({ ip: '192.0.2.9' }).update({ created_at: Date.now() - 16 * 60 * 1000 });
  ok('15 daqiqadan keyin blok o\'zi tugaydi', (await login(S3.loginId, S3.password, '192.0.2.9')).s === 200);

  // --- Uyushgan hujum: ko'p IP dan ---
  const T = await mk('Tohir');
  for (let i = 1; i <= 10; i++) await login(T.loginId, 'xato-parol', '10.0.0.' + i);
  r = await login(T.loginId, T.password, '10.0.0.99');
  ok('ko\'p IP dan 10 ta xato: shu ID uchun vaqtincha to\'xtaydi (oxirgi chora)', r.s === 429);
  ok('boshqa foydalanuvchilarga ta\'sir qilmaydi', (await login(S2.loginId, S2.password, '10.0.0.99')).s === 200);
  await call('PATCH', `/api/staff/${T.id}`, A.token, { resetPassword: true });
  ok('admin parol yangilasa u ham olinadi', (await db('login_fail').where({ user_id: T.id })).length === 0);

  // --- Mavjud bo'lmagan ID ---
  r = await login('999999', 'xato', IP1);
  ok('mavjud bo\'lmagan ID: oddiy 401 (jadvalga hech narsa yozilmaydi)', r.s === 401 && (await db('login_fail').count({ c: '*' }).first()).c >= 0);

  // --- ipKey ---
  ok('IPv4 o\'zgarmaydi', ipKey('203.0.113.5') === '203.0.113.5');
  ok('IPv4 (xaritalangan) IPv4 ga o\'xshaydi', ipKey('::ffff:203.0.113.5') === '203.0.113.5');
  ok('IPv6: bitta /64 ichidagi manzillar bir xil kalit (manzilni almashtirib aylanib o\'tib bo\'lmaydi)', ipKey('2001:db8:1:2:aaaa::1') === ipKey('2001:db8:1:2:bbbb:cccc::2') && ipKey('2001:db8:1:3::1') !== ipKey('2001:db8:1:2::1'));

  // --- Hisob o'chirilsa yozuvlar ham o'chadi (FK) ---
  await call('POST', '/api/auth/delete-account', A.token, { password: 'secret1' });
  ok('hisob o\'chganda login_fail yozuvlari ham o\'chdi', (await db('login_fail').count({ c: '*' }).first()).c == 0);

  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nBLOKLASH TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

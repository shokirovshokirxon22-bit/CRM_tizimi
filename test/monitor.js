// Xatolarni kuzatish (Sentry): DSN bo'lmasa o'chiq; bo'lsa faqat tozalangan xato ketadi (telefon, parol, token YO'Q).
// Haqiqiy Sentry o'rniga mahalliy soxta server ishlatiladi: u nimani qabul qilganini ko'ramiz.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), http = require('http'), zlib = require('zlib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-m-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
delete process.env.SENTRY_DSN;
const monitor = require('../src/monitor');
const { createApp } = require('../src/app');
const { migrate, db } = require('../src/db');
const { outbox } = require('../src/sms');

let n = 0; const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const received = [];
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { let b = Buffer.concat(chunks); try { if (req.headers['content-encoding'] === 'gzip') b = zlib.gunzipSync(b); } catch {} received.push(b.toString('utf8')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
});
const waitFor = async (re, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const hit = received.find((x) => re.test(x)); if (hit) return hit; await sleep(50); } return null; };

(async () => {
  // ---- tozalash funksiyasi (tarmoqsiz) ----
  const c = monitor.clean;
  ok('telefon raqam yashiriladi', !/998901234567/.test(c('xato: +998 90 123 45 67 / 998901234567')));
  ok('Bearer token va JWT yashiriladi', !/abc123/.test(c('Authorization: Bearer abc123xyz.def')) && !/eyJhbGciOi/.test(c('t=eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.sig_nature-xx')));
  ok('password/code qiymatlari yashiriladi', !/Sirli123/.test(c('{"password":"Sirli123","code":"554433"}')) && !/554433/.test(c('{"password":"Sirli123","code":"554433"}')));
  const ev = monitor.scrub({ request: { headers: { authorization: 'Bearer x' }, data: { password: 'p' }, cookies: { a: 1 }, url: 'https://x.uz/api/auth/login?id=123456' }, user: { id: '7', email: 'a@b.c', ip_address: '1.2.3.4' }, message: 'tel 998901234567', exception: { values: [{ value: 'Key (phone)=(998901234567) already exists' }] } });
  ok('hodisadan sarlavha, tana, cookie, email, IP olib tashlanadi', !ev.request.headers && !ev.request.data && !ev.request.cookies && ev.user.id === '7' && !ev.user.email && !ev.user.ip_address && !/\?id=/.test(ev.request.url));
  ok('xato matnidagi raqamlar yashiriladi', !/998901234567/.test(JSON.stringify(ev)));

  // ---- DSN yo'q: o'chiq, ishlashga xalaqit bermaydi ----
  await migrate();
  let srv = createApp().listen(0); let base = 'http://localhost:' + srv.address().port;
  ok("DSN bo'lmasa monitor o'chiq", monitor.enabled() === false);
  let r = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'x' }) });
  ok("DSN bo'lmasa brauzer xatosi qabul qilinadi (204), hech narsa yuborilmaydi", r.status === 204 && received.length === 0);
  srv.close();

  // ---- DSN bor: soxta Sentry ----
  await new Promise((res) => fake.listen(0, res));
  process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${fake.address().port}/1`;
  srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  ok('DSN bo\'lsa monitor yoqiladi', monitor.enabled() === true);

  const call = async (m, u, t, b) => { const x = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await x.json(); } catch {} return { s: x.status, j }; };
  await call('POST', '/api/auth/register/start', null, { phone: '998901230401' });
  const code = [...outbox].reverse().find((x) => x.phone === '998901230401').text.match(/\d{6}/)[0];
  const A = (await call('POST', '/api/auth/register', null, { shopName: 'Do\'kon', phone: '998901230401', password: 'Sirli123', code })).j;

  // Brauzer xatosi (ichida telefon va token bor, ular yashirilishi kerak)
  r = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'TypeError: x is undefined, tel 998901230401, Bearer SECRETTOKEN123', stack: 'at foo (index.html:10:5)', page: '/' }) });
  const b1 = await waitFor(/brauzer/);
  ok('brauzer xatosi Sentry\'ga yetib bordi', r.status === 204 && !!b1 && /TypeError: x is undefined/.test(b1));
  ok("brauzer xatosida telefon va token yuborilmadi", !/998901230401/.test(b1) && !/SECRETTOKEN123/.test(b1));

  // Server xatosi (5xx): jadvalni vaqtincha buzamiz
  received.length = 0;
  await db.schema.renameTable('products', 'products_x');
  const e = await call('GET', '/api/products', A.token);
  await db.schema.renameTable('products_x', 'products');
  const b2 = await waitFor(/no such table|products/);
  ok('server 500 xatosi Sentry\'ga yetib bordi, foydalanuvchiga umumiy xabar', e.s === 500 && e.j.error === 'Server xatosi' && !!b2);
  ok('server xatosida ichki ID bor, lekin telefon/parol/token yo\'q', /"id":"\d+"/.test(b2) && !/998901230401/.test(b2) && !/Sirli123/.test(b2) && !b2.includes(A.token));

  // Kutilgan xatolar (400/401/404/409) Sentry'ga ketmaydi
  received.length = 0;
  await call('POST', '/api/auth/login', null, { id: '123456', password: 'xato' });
  await call('GET', '/api/products');
  await sleep(600);
  ok('kutilgan xatolar (401 va h.k.) Sentry\'ga ketmaydi', received.length === 0);

  // Suiiste'mol: katta tana / limit
  r = await fetch(base + '/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'a'.repeat(20000) }) });
  received.length = 0;
  ok("katta (8kb dan ortiq) xato tanasi 413 bilan rad etiladi va Sentry'ga ketmaydi", r.status === 413 && (await sleep(500), received.length === 0));
  let last = 0; for (let i = 0; i < 25; i++) last = (await fetch(base + '/api/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"msg":"x"}' })).status;
  ok('brauzer xatolari IP bo\'yicha cheklangan (429)', last === 429);

  srv.close(); fake.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nKUZATUV (SENTRY) TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

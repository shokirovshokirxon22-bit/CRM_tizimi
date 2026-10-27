// Faoliyat tarixi ekrani (frontend) haqiqiy backend bilan: faqat admin ko'radi, matn xavfsiz chiqadi (XSS yo'q),
// brauzerdagi kutilmagan xato serverga yuboriladi, kutilgan (API/oflayn) xatolar yuborilmaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { JSDOM } = require('jsdom');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-au-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db'); process.env.JWT_SECRET = 't'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { createApp } = require('../src/app'); const { migrate, db } = require('../src/db'); const { outbox } = require('../src/sms');
const lastCode = (phone) => [...outbox].reverse().find((x) => x.phone === phone.replace(/\D/g, '')).text.match(/\d{6}/)[0];
let base, n = 0;
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 6000) { const t = Date.now(); for (;;) { let v; try { v = fn(); } catch (e) {} if (v) return v; if (Date.now() - t > ms) throw new Error('Kutilgan narsa chiqmadi: ' + what); await sleep(30); } }
async function open() {
  const calls = [], errors = [];
  const dom = await JSDOM.fromURL(base + '/', { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.fetch = (u, o = {}) => { calls.push((o.method || 'GET') + ' ' + String(u).replace(/^.*\/api/, '')); return fetch(new URL(u, base), o); };
    w.confirm = () => true; w.HTMLElement.prototype.scrollIntoView = () => {}; w.URL.createObjectURL = () => 'blob:x';
    w.crypto.subtle || Object.defineProperty(w.crypto, 'subtle', { value: require('crypto').webcrypto.subtle });
    w.addEventListener('error', (e) => errors.push(e.message));
  } });
  const w = dom.window; return { w, calls, errors, $: (s) => w.document.querySelector(s), ev: (s) => w.eval(s), set: (id, v) => { w.document.querySelector('#' + id).value = v; } };
}
(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = await open();
  await until(() => A.$('#ph'), 'login oynasi'); A.ev('loginV(1)');
  A.set('nm', 'Gilam Dunyosi'); A.set('ph', '+998 90 111 22 44'); A.set('pw', 'admin123'); A.ev('doRegStart()');
  await until(() => A.$('#cdb') && A.$('#cdb').style.display === 'block', 'SMS kod maydoni');
  A.set('cd', lastCode('+998 90 111 22 44')); A.ev('doReg()'); await until(() => A.$('nav'), 'asosiy ekran'); A.ev('close()');

  // Mahsulot nomida zararli kod: tarixda matn sifatida chiqishi kerak
  const evil = '<img src=x onerror="window.__xss=1">Gilam';
  await A.ev(`api('/products','POST',{name:${JSON.stringify(evil)},unit:'m',cost:1000,pct:20,qty:5})`);
  await A.ev(`api('/products','POST',{name:'Lampa',unit:'dona',cost:500,pct:10,qty:3})`);
  A.ev('meV()');
  ok('admin profilida "Faoliyat tarixi" bor', /Faoliyat tarixi/.test(A.$('#v').innerHTML));
  A.ev('auditV()'); await until(() => /Faoliyat tarixi/.test((A.$('#md') || {}).innerHTML || '') && /Lampa/.test(A.$('#md').innerHTML), 'tarix ro\'yxati');
  ok('tarixda yozuvlar, kim va qachon bilan', /Mahsulot qo'shildi: Lampa/.test(A.$('#md').innerHTML) && /Gilam Dunyosi/.test(A.$('#md').innerHTML));
  ok('zararli matn XSS bo\'lmaydi: teg sifatida emas, matn sifatida', !A.$('#md img') && /&lt;img/.test(A.$('#md').innerHTML) && A.w.__xss === undefined);
  A.ev("auditV('sale')"); await until(() => /Hali yozuv yo'q/.test(A.$('#md').innerHTML), 'filtr natijasi');
  ok('filtr: sotuv bo\'yicha hozircha yozuv yo\'q, mahsulotlar ko\'rinmaydi', !/Lampa/.test(A.$('#md').innerHTML));
  A.ev("auditV('product')"); await until(() => /Lampa/.test(A.$('#md').innerHTML), 'mahsulot filtri');
  ok('filtr: mahsulot bo\'yicha yozuvlar chiqdi va tanlangan filtr saqlandi', /<option value="product" selected/.test(A.$('#md').innerHTML));
  A.ev('close()');

  // Sotuvchi: menyuda yo'q, serverdan ham 403
  const st = await A.ev("api('/staff','POST',{name:'Ali'})");
  const S = await open(); await until(() => S.$('#ph'), 'login'); S.set('ph', st.loginId); S.set('pw', st.password); S.ev('doLogin()'); await until(() => S.$('nav'), 'sotuvchi ekrani');
  S.ev('meV()');
  ok('sotuvchi profilida "Faoliyat tarixi" YO\'Q', !/Faoliyat tarixi/.test(S.$('#v').innerHTML));
  const code = await S.ev("fetch(API_BASE+'/api/audit',{headers:{Authorization:'Bearer '+TOK}}).then(r=>r.status)");
  ok('sotuvchi serverdan ham tarixni ola olmaydi', code === 403);

  // Brauzer xatolarini yuborish
  A.calls.length = 0;
  A.w.dispatchEvent(new A.w.ErrorEvent('error', { message: 'TypeError: kutilmagan xato', error: new Error('kutilmagan') }));
  await until(() => A.calls.some((c) => c === 'POST /client-error'), 'xato yuborildi');
  ok('kutilmagan JS xatosi serverga yuborildi', A.calls.filter((c) => c === 'POST /client-error').length === 1);
  A.calls.length = 0;
  const ae = new Error('Server aytdi'); ae.api = true; const oe = new Error('Internet yo\'q'); oe.offline = true;
  for (const e of [ae, oe]) { const ev = new A.w.Event('unhandledrejection'); ev.reason = e; A.w.dispatchEvent(ev); }
  await sleep(200);
  ok('kutilgan xatolar (API va internet yo\'q) yuborilmaydi', !A.calls.some((c) => /client-error/.test(c)));
  A.calls.length = 0;
  for (let i = 0; i < 8; i++) A.w.dispatchEvent(new A.w.ErrorEvent('error', { message: 'takror ' + i }));
  await sleep(300);
  ok('bir sahifadan ko\'pi bilan 4-5 ta xato yuboriladi (spam yo\'q)', A.calls.filter((c) => /client-error/.test(c)).length <= 4);

  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nTARIX EKRANI TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

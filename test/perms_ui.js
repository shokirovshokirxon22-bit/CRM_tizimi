// Haqiqiy frontend (public/index.html) ni jsdom ichida ishga tushirib, haqiqiy backend bilan sinaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { JSDOM } = require('jsdom');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-pui-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db'); process.env.JWT_SECRET = 't'; process.env.SUPER_KEY = 'sk'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
const { createApp } = require('../src/app'); const { migrate, db } = require('../src/db');

const { outbox } = require('../src/sms');
const lastCode = (phone) => { const m = [...outbox].reverse().find((x) => x.phone === phone.replace(/\D/g, '')); return m && m.text.match(/\d{6}/)[0]; };
let base, n = 0;
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 6000) { const t = Date.now(); for (;;) { let v; try { v = fn(); } catch (e) {} if (v) return v; if (Date.now() - t > ms) throw new Error('Kutilgan narsa chiqmadi: ' + what); await sleep(30); } }

async function open(seed) {
  const errors = [];
  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, base), o); w.confirm = () => true; w.prompt = () => w.__prompt || null;
      w.crypto.subtle || Object.defineProperty(w.crypto, 'subtle', { value: require('crypto').webcrypto.subtle });
      w.HTMLElement.prototype.scrollIntoView = () => {}; w.URL.createObjectURL = () => 'blob:x';
      w.addEventListener('error', (e) => errors.push(e.message));
      if (seed) seed(w);
    },
  });
  const w = dom.window, $ = (s) => w.document.querySelector(s), ev = (s) => w.eval(s);
  const set = (id, v) => { $('#' + id).value = v; };
  return { w, $, ev, set, errors, dom };
}
// UI orqali ro'yxatdan o'tish: kod yuborish -> SMS kodni kiritish -> tasdiqlash
async function register(c, nm, ph, pw) {
  await until(() => c.$('#ph'), 'login oynasi'); c.ev('loginV(1)');
  c.set('nm', nm); c.set('ph', ph); c.set('pw', pw); c.ev('doRegStart()');
  await until(() => c.$('#cdb') && c.$('#cdb').style.display === 'block', 'SMS kod maydoni');
  c.set('cd', lastCode(ph)); c.ev('doReg()');
  await until(() => c.$('nav'), 'ro\'yxatdan o\'tgach asosiy ekran');
}
async function login(c, ph, pw) { await until(() => c.$('#ph'), 'login oynasi'); c.set('ph', ph); c.set('pw', pw); c.ev('doLogin()'); await until(() => c.$('nav'), 'asosiy ekran'); }

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = await open();
  await register(A, 'Gilam Dunyosi', '+998 90 111 22 44', 'admin123'); A.ev('close()');
  A.ev("go('add')"); A.set('fn', 'Gilam'); A.set('fc', '10000'); A.set('fp', '20'); A.set('fq', '40'); A.set('fm', '5'); A.set('fw', '2'); A.ev('saveP()');
  await until(() => A.ev('D.products.length') === 1, 'mahsulot');
  A.ev('staffV()'); await until(() => A.$('#sfn'), 'xodimlar oynasi');
  A.set('sfn', 'Sardor'); A.ev('addStaff()'); await until(() => A.$('#cid'), 'xodim yaratildi');
  const sid = A.$('#cid').textContent, spw = A.$('#cpw').textContent; A.ev('close()');

  const S = await open(); await login(S, sid, spw);
  S.ev("go('find')"); await until(() => S.$('#res .card'), 'mahsulotlar');
  ok('ruxsatsiz sotuvchida ✏️ yo\'q', !S.$('#res .card .ic'));

  A.ev('staffV()'); await until(() => A.$('#md input[type=checkbox]'), 'huquq belgilari');
  ok('Xodimlar oynasida ikkita huquq belgisi bor', A.w.document.querySelectorAll('#md .card input[type=checkbox]').length === 2);
  const cbs = A.w.document.querySelectorAll('#md .card input[type=checkbox]');
  cbs[0].checked = true; cbs[0].dispatchEvent(new A.w.Event('change'));
  await until(async () => true, 'x'); await sleep(400);
  ok('adminning belgisi serverga saqlandi', (await db('users').where({ login_id: sid }).first()).perm_price == 1 && (await db('users').where({ login_id: sid }).first()).perm_debts == 0);

  S.ev('sync()'); await until(() => S.ev('D.set.canPrice') === true, 'sotuvchi huquqi yangilandi');
  S.ev('fl()'); await until(() => S.$('#res .card .ic'), '✏️ chiqdi');
  ok('huquqli sotuvchida ✏️ chiqdi', true);
  S.ev("priceM(D.products[0].id)"); await until(() => S.$('#np'), 'narx oynasi');
  S.set('np', '15000'); S.ev("savePrice(D.products[0].id)");
  await until(() => S.ev('D.products[0].sell') === 15000, 'narx yangilandi');
  ok('sotuvchi mahsulot narxini 15000 qildi', /15[\s\u00a0,.]?000/.test(S.$('#res').innerHTML));
  ok('adminda ham yangi narx (foiz 50)', (await db('products').first()).pct === 50);
  ok('brauzerda JS xatosi yo\'q', S.errors.length === 0 && A.errors.length === 0);
  console.log(`\nHUQUQ UI TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

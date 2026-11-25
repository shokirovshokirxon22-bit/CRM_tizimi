// Haqiqiy frontend (public/index.html) ni jsdom ichida ishga tushirib, haqiqiy backend bilan sinaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { JSDOM } = require('jsdom');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-ui-'));
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
  await register(A, 'Narx Test', '+998 90 777 88 99', 'admin123');
  A.ev('close()');
  const fv = (id) => A.$('#' + id).value;

  /* foiz -> narx */
  A.ev("go('add')"); A.set('fc', '10000'); A.set('fp', '20'); A.ev("pc('p')");
  ok('foiz yozilsa sotish narxi chiqadi (10000 + 20% = 12000)', fv('fs') === '12000');
  /* narx -> foiz */
  A.set('fs', '15000'); A.ev("pc('s')");
  ok('narx yozilsa foiz chiqadi (10000 -> 15000 = 50%)', +fv('fp') === 50);
  /* tannarx o'zgarsa, oxirgi yozilgan (narx) saqlanadi, foiz qayta hisoblanadi */
  A.set('fc', '12000'); A.ev("pc('c')");
  ok('narx asos bo\'lsa, tannarx o\'zgarganda foiz qayta hisoblanadi (12000 -> 15000 = 25%)', fv('fs') === '15000' && +fv('fp') === 25);
  /* foizni qayta yozsak, asos yana foiz bo'ladi */
  A.set('fp', '10'); A.ev("pc('p')");
  ok('foiz qayta yozilsa narx yangilanadi (12000 + 10% = 13200)', fv('fs') === '13200');
  A.set('fc', '10000'); A.ev("pc('c')");
  ok('foiz asos bo\'lsa, tannarx o\'zgarganda narx qayta hisoblanadi', fv('fs') === '11000' && +fv('fp') === 10);
  A.set('fp', ''); A.ev("pc('p')");
  ok('foiz tozalansa narx ham tozalanadi', fv('fs') === '');

  /* narx bilan saqlash: foiz cheksiz kasr bo'lsa ham sotish narxi aynan shu bo'ladi */
  A.ev("go('add')"); A.ev("AU='dona';addV(1)");
  A.set('fn', 'Qalam'); A.set('fc', '3'); A.set('fq', '100'); A.set('fs', '10'); A.ev("pc('s')"); A.ev('saveP()');
  await until(() => A.ev('D.products.length') === 1, 'narx bilan mahsulot saqlandi');
  ok('narx bilan kiritilgan mahsulotning sotish narxi aynan 10', A.ev('D.products[0].sell') === 10 && A.ev('Math.round(sp(D.products[0]))') === 10);
  ok('foiz serverda hisoblangan holda saqlandi (233.33%)', Math.abs(A.ev('D.products[0].pct') - 233.3333) < 0.001);

  /* tahrirlashda narx maydoni to'ldirilgan */
  A.ev(`ED='${A.ev('D.products[0].id')}';tab='add';render()`);
  await until(() => A.$('#fs'), 'tahrirlash formasi');
  ok('tahrirlashda sotish narxi ko\'rinadi (10)', +fv('fs') === 10);

  /* sotish narxi tannarxdan past bo'lsa saqlanmaydi */
  A.ev("go('add')"); A.ev("AU='dona';addV(1)");
  A.set('fn', 'Zarar'); A.set('fc', '1000'); A.set('fq', '5'); A.set('fs', '800'); A.ev("pc('s')"); A.ev('saveP()');
  await new Promise((r) => setTimeout(r, 400));
  ok('narx tannarxdan past bo\'lsa mahsulot saqlanmaydi', A.ev('D.products.length') === 1 && /past bo'lmasin/.test(A.w.document.body.innerHTML));

  /* eski usul (faqat foiz) hamon ishlaydi */
  A.ev("go('add')"); A.ev("AU='dona';addV(1)");
  A.set('fn', 'Oddiy'); A.set('fc', '5000'); A.set('fp', '10'); A.set('fq', '10'); A.ev('saveP()');
  await until(() => A.ev('D.products.length') === 2, 'foiz bilan mahsulot saqlandi');
  ok('faqat foiz yozib saqlash avvalgidek ishlaydi', A.ev("D.products.find(p=>p.name=='Oddiy').sell") === 5500);

  ok('brauzer konsolida JS xatosi yo\'q', A.errors.length === 0 || (console.log(A.errors), false));
  console.log(`\nNARX/FOIZ TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

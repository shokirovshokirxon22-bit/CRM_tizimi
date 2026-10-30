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
  ok('Xodimlar oynasida uchta huquq belgisi bor', A.w.document.querySelectorAll('#md .card input[type=checkbox]').length === 3);
  const cbs = A.w.document.querySelectorAll('#md .card input[type=checkbox]');
  cbs[0].checked = true; cbs[0].dispatchEvent(new A.w.Event('change'));
  await until(async () => true, 'x'); await sleep(400);
  ok('adminning belgisi serverga saqlandi', (await db('users').where({ login_id: sid }).first()).perm_edit == 1 && (await db('users').where({ login_id: sid }).first()).perm_debts == 0);

  S.ev('sync()'); await until(() => S.ev('D.set.canEdit') === true, 'sotuvchi huquqi yangilandi');
  ok('tahrirlash huquqi sotuvchida narx huquqini ham beradi', S.ev('D.set.canPrice') === true);
  S.ev('fl()'); await until(() => S.$('#res .card .ic'), '✏️ chiqdi');
  ok('huquqli sotuvchida ✏️ chiqdi', true);
  ok('kiritish huquqisiz sotuvchida Kiritish bo\'limi ko\'rinmaydi', ![...S.w.document.querySelectorAll('nav button')].some((b) => /Kiritish/.test(b.textContent)));
  S.$('#res .card .ic').click(); await until(() => S.$('#fn') && S.$('#fn').value === 'Gilam', 'tahrirlash formasi ochildi');
  ok('✏️ to\'liq tahrirlash formasini ochdi', S.ev('tab') === 'add' && !!S.$('#fc') && !!S.$('#fp'));
  ok('sotuvchida O\'chirish tugmasi yo\'q', ![...S.w.document.querySelectorAll('#v button')].some((b) => /O'chirish/.test(b.textContent)));
  S.set('fn', 'Gilam Premium'); S.set('fp', '50'); S.ev('saveP()');
  await until(() => S.ev('D.products[0].name') === 'Gilam Premium', 'mahsulot tahrirlandi');
  ok('sotuvchi mahsulot nomi va narxini tahrirladi (foiz 50)', (await db('products').first()).pct === 50 && (await db('products').first()).name === 'Gilam Premium');
  ok('yangi sotish narxi 15000', S.ev('Math.round(sp(D.products[0]))') === 15000);

  // Kiritish huquqi: bo'lim ko'rinadi va yangi mahsulot qo'shiladi
  A.ev('staffV()'); await until(() => A.w.document.querySelectorAll('#md .card input[type=checkbox]').length === 3, 'huquq belgilari');
  const cb2 = A.w.document.querySelectorAll('#md .card input[type=checkbox]')[1];
  cb2.checked = true; cb2.dispatchEvent(new A.w.Event('change')); await sleep(400);
  ok('kiritish huquqi serverga saqlandi', (await db('users').where({ login_id: sid }).first()).perm_add == 1);
  S.ev('sync().then(render)'); await until(() => S.ev('D.set.canAdd') === true, 'kiritish huquqi yangilandi');
  await until(() => [...S.w.document.querySelectorAll('nav button')].some((b) => /Kiritish/.test(b.textContent)), 'Kiritish tugmasi');
  ok('Kiritish bo\'limi sotuvchiga ko\'rindi', true);
  S.ev("go('add')"); await until(() => S.$('#fn'), 'yangi mahsulot formasi');
  S.set('fn', 'Parda'); S.set('fc', '5000'); S.set('fp', '10'); S.set('fq', '8'); S.set('fw', '2'); S.ev('saveP()');
  await until(() => S.ev('D.products.length') === 2, 'sotuvchi mahsulot qo\'shdi');
  ok('sotuvchi yangi mahsulot kiritdi', !!(await db('products').where({ name: 'Parda' }).first()));

  // Profil bo'limidagi oynalarda ✕ (chiqish) tugmasi
  A.ev("go('me')"); await until(() => A.$('.mi'), 'profil menyusi');
  const menu = [...A.w.document.querySelectorAll('.mi')];
  const items = ['Xodimlar', 'Xavfsizlik', 'Sozlamalar', 'Ilova haqida', 'Excelga yuklash', 'Xarajatlar', 'Faoliyat tarixi'];
  for (const nmI of items) {
    const b = [...A.w.document.querySelectorAll('.mi')].find((x) => x.textContent.includes(nmI));
    ok(`profil menyusida "${nmI}" bor`, !!b);
    b.click(); await until(() => A.$('#md .mx'), `"${nmI}" oynasida ✕ tugmasi`);
    ok(`"${nmI}" oynasida ✕ bor`, true);
    A.$('#md .mx').click(); await sleep(30);
    ok(`"${nmI}" ✕ bosilganda yopildi`, !A.$('#md'));
  }
  // Xavfsizlik ichidan ochiladigan ichki oynada ham ✕ qoladi; boshqa bo'limlardagi oynalarda ✕ yo'q
  [...A.w.document.querySelectorAll('.mi')].find((x) => x.textContent.includes('Xavfsizlik')).click(); await until(() => A.$('#md .mx'), 'xavfsizlik');
  A.ev('phoneV()'); await until(() => A.$('#npn'), 'raqam oynasi');
  ok('ichki oynada ham ✕ bor', !!A.$('#md .mx')); A.$('#md .mx').click();
  A.ev("go('find')"); await until(() => A.$('#res .card'), 'qidiruv'); A.ev("pm(D.products[0].id)"); await until(() => A.$('#md'), 'mahsulot oynasi');
  ok('profildan tashqari oynada ✕ yo\'q (o\'zgarmagan)', !A.$('#md .mx')); A.ev('close()');
  ok('brauzerda JS xatosi yo\'q', S.errors.length === 0 && A.errors.length === 0);
  console.log(`\nHUQUQ UI TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

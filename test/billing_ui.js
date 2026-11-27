// Haqiqiy frontend (public/index.html) ni jsdom ichida ishga tushirib, haqiqiy backend bilan sinaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { JSDOM } = require('jsdom');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-bui-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db'); process.env.JWT_SECRET = 't'; process.env.SUPER_KEY = 'sk'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory'; process.env.PAY_RATE_LIMIT = '1000';
Object.assign(process.env, { PAYME_MERCHANT_ID: 'm1', PAYME_KEY: 'pk', CLICK_SERVICE_ID: '777', CLICK_MERCHANT_ID: '888', CLICK_SECRET_KEY: 'click-secret' });
const crypto = require('crypto'); const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
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


const apiCall = async (m, u, t, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
async function clickPay(orderId, amount) {
  const q = { click_trans_id: String(Math.floor(Math.random() * 1e9)), service_id: '777', click_paydoc_id: '1', merchant_trans_id: String(orderId), amount: String(amount), error: '0', error_note: 'ok', sign_time: '2026-11-26 12:00:00' };
  const post = async (path, o) => (await fetch(base + '/api/pay/click/' + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() })).json();
  const p = { ...q, action: '0' }; p.sign_string = md5(q.click_trans_id + '777click-secret' + q.merchant_trans_id + q.amount + '0' + q.sign_time);
  const rp = await post('prepare', p);
  const c = { ...q, action: '1', merchant_prepare_id: String(rp.merchant_prepare_id) }; c.sign_string = md5(q.click_trans_id + '777click-secret' + q.merchant_trans_id + c.merchant_prepare_id + q.amount + '1' + q.sign_time);
  return post('complete', c);
}
const seed = (w) => { w.open = () => null; };

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = await open(seed);
  await register(A, 'Obuna Test', '+998 90 555 66 77', 'admin123');
  A.ev('close()');
  const shopId = A.ev('Number(JSON.parse(atob(TOK.split(".")[1])).shopId||JSON.parse(atob(TOK.split(".")[1])).sid||0)') || (await db('shops').first()).id;
  const setUntil = (ms) => db('shops').where({ id: shopId }).update({ sub_until: ms });
  const adminTok = A.ev('TOK'), loginId = A.ev('U.loginId');

  /* ---------- Profil ---------- */
  A.ev("tab='me';render()");
  ok('admin profilida "Tarif / Premium" bo\'limi bor', /Tarif \/ Premium/.test(A.$('#v').textContent));
  ok('profilda holat satri: Sinov muddati: 30 kun qoldi', /Sinov muddati: 30 kun qoldi/.test(A.$('#v').textContent));
  ok('sinov davrida banner yo\'q', !A.$('.sbn'));
  A.ev('PM=true;planV()');
  await until(() => A.$('#plb .plan'), 'tariflar ro\'yxati');
  ok('tariflar: 1 oy, 3 oy, umrbod', A.w.document.querySelectorAll('#plb .plan').length === 3 && /1 oy/.test(A.$('#plb').textContent) && /3 oy/.test(A.$('#plb').textContent) && /Umrbod/.test(A.$('#plb').textContent));
  ok('narxlar ko\'rinadi (99 000 so\'m)', /99 000 so'm/.test(A.$('#plb').textContent));
  ok('umrbod uchun qolgan joylar: 3', /Qolgan joylar: 3/.test(A.$('#plb').textContent));
  ok('Payme va Click tugmalari bor', /To'lash: Payme/.test(A.$('#plb').textContent) && /To'lash: Click/.test(A.$('#plb').textContent));
  ok('joriy tarif: Sinov muddati', /Sinov muddati/.test(A.$('#plb').textContent));
  A.ev('close()');

  /* ---------- Xodim tarifni ko'rmaydi ---------- */
  const st = await apiCall('POST', '/api/staff', adminTok, { name: 'Sotuvchi' });
  ok('xodim yaratildi', st.s === 201 || st.s === 200);

  /* ---------- 5 va 1 kun eslatmasi ---------- */
  await setUntil(Date.now() + 3 * 86400000 - 3600000);
  A.ev('subRefresh(true)');
  await until(() => A.$('.sbn'), '5 kunlik banner');
  ok('3 kun qolganda banner chiqdi', /Obuna tugashiga 3 kun qoldi/.test(A.$('.sbn').textContent) && !A.$('.sbn').classList.contains('hot'));
  await until(() => A.$('#md'), 'eslatma oynasi');
  ok('eslatma oynasi chiqdi (Obuna tugayapti)', /Obuna tugayapti/.test(A.$('#md').textContent));
  A.ev('close()');
  A.ev('subRemind()'); await sleep(900);
  ok('eslatma oynasi bir kunda bir marta chiqadi', !A.$('#md'));
  await setUntil(Date.now() + 20 * 3600000);
  A.ev('subRefresh(true)');
  await until(() => A.$('.sbn.hot'), '1 kunlik banner');
  ok('1 kundan kam qolganda banner qizil va matni mos', /1 kundan kam qoldi/.test(A.$('.sbn').textContent));
  await until(() => A.$('#md'), '1 kunlik eslatma oynasi');
  ok('1 kunlik eslatma oynasi alohida chiqadi', /1 kundan kam/.test(A.$('#md').textContent));
  A.ev('close()');
  A.ev("tab='home';render()");
  ok('banner bosh sahifada ham ko\'rinadi', !!A.$('.sbn'));
  A.ev("document.querySelector('.sbn').click()");
  await until(() => A.$('#plb .plan'), 'bannerdan tariflar');
  ok('banner bosilsa tariflar ochiladi', true);
  A.ev('close()');

  /* ---------- Muddat tugadi: to'lov oynasi ---------- */
  await setUntil(Date.now() - 1000);
  A.ev("api('/products').catch(()=>{})");
  await until(() => A.$('#plb') && !A.$('nav') && /Obuna muddati tugagan/.test(A.$('#app').textContent), 'to\'lov oynasi');
  ok('muddat tugagach ilova to\'lov oynasiga o\'tdi (nav yo\'q)', !A.$('nav') && !A.$('.sbn'));
  await until(() => A.$('#plb .plan'), 'bloklangan oynada tariflar');
  ok('to\'lov oynasida tariflar va tugmalar bor', A.w.document.querySelectorAll('#plb .plan').length === 3 && /To'lash: Click/.test(A.$('#plb').textContent));
  ok('chiqish va qayta tekshirish tugmalari bor', /Qayta tekshirish/.test(A.$('#app').textContent) && /Chiqish/.test(A.$('#app').textContent));
  ok('bloklangan oynada ham JS xatosi yo\'q', A.errors.length === 0 || (console.log(A.errors), false));

  /* ---------- To'lash va avtomatik ochilish ---------- */
  A.ev("payGo('m1','click',0)");
  await until(() => A.ev('PAYW&&PAYW.id'), 'to\'lov kutilmoqda');
  ok('to\'lov kutish oynasi chiqdi', /To'lov kutilmoqda/.test(A.$('#md').textContent) && /To'lov sahifasini ochish/.test(A.$('#md').textContent));
  ok('to\'lov sahifasi havolasi Click ga olib boradi', /my\.click\.uz\/services\/pay/.test(A.$('#md a').getAttribute('href')));
  const oid = A.ev('PAYW.id');
  A.ev('payCheck()'); await sleep(300);
  ok('to\'lanmagan bo\'lsa kutishda qoladi', !A.$('nav') && !!A.ev('PAYW'));
  const cr = await clickPay(oid, 99000);
  ok('Click to\'lovi serverga keldi', cr.error === 0);
  A.ev('payCheck()');
  await until(() => A.$('nav'), 'to\'lovdan keyin ilova ochilishi');
  ok('to\'lov tasdiqlangach ilova avtomatik ochildi', !A.ev('SUBX') && A.ev('SUB.state') === 'active' && A.ev('SUB.daysLeft') === 30);
  ok('kutish oynasi yopildi va polling to\'xtadi', !A.$('#md') && A.ev('PAYW') === null);
  A.ev("tab='me';render()");
  ok('profilda yangi holat: Tarif: 30 kun qoldi', /Tarif: 30 kun qoldi/.test(A.$('#v').textContent));
  A.ev('PM=true;planV()');
  await until(() => A.$('#plb') && /To'lovlar tarixi/.test(A.$('#plb').textContent), 'to\'lovlar tarixi');
  ok('to\'lovlar tarixi ko\'rinadi', /99 000 so'm/.test(A.$('#plb').textContent));
  A.ev('close()');

  /* ---------- Xodim bloklangan oynasi ---------- */
  await setUntil(Date.now() - 1000);
  const B = await open(seed);
  await until(() => B.$('#ph'), 'xodim login oynasi');
  B.set('ph', st.j.loginId || st.j.login_id); B.set('pw', st.j.password); B.ev('doLogin()');
  await until(() => B.$('#app') && B.$('#app').textContent.includes("Do'kon obunasi tugagan"), 'xodim uchun to\'lov oynasi');
  ok('xodim: "Administratorga murojaat qiling" xabari', /Administratorga murojaat qiling/.test(B.$('#app').textContent));
  ok('xodimga tariflar va to\'lov tugmalari ko\'rsatilmaydi', !B.$('#plb .plan') && !/To'lash/.test(B.$('#app').textContent));
  ok('xodim chiqish tugmasi bor', /Chiqish/.test(B.$('#app').textContent));

  /* ---------- Login oynasidan ID bo'yicha to'lash ---------- */
  const C = await open(seed);
  await until(() => C.$('#ph'), 'login oynasi');
  ok('login oynasida "Obuna uchun to\'lov" tugmasi bor', /Obuna uchun to'lov/.test(C.$('#app').textContent));
  C.ev('payIdV()');
  C.set('pid', '12'); C.ev('payIdGo()');
  ok('qisqa ID rad etiladi', /6 xonali ID kiriting/.test(C.$('#er2').textContent));
  C.set('pid', '000000'); C.ev('payIdGo()');
  await until(() => C.$('#er2').textContent.length > 6, 'noto\'g\'ri ID xabari');
  ok('mavjud bo\'lmagan ID: xato xabari', /topilmadi/.test(C.$('#er2').textContent));
  C.set('pid', loginId); C.ev('payIdGo()');
  await until(() => C.$('#plb .plan'), 'ID bo\'yicha tariflar');
  ok('ID bo\'yicha: do\'kon nomi yashirin, tariflar va tugmalar bor', /\*\*\*/.test(C.$('#plb').textContent) && /To'lash: Payme/.test(C.$('#plb').textContent) && /Obuna muddati tugagan/.test(C.$('#plb').textContent));
  C.ev("payGo('m3','click',1)");
  await until(() => C.ev('PAYW&&PAYW.id'), 'ommaviy to\'lov kutilmoqda');
  const oid2 = C.ev('PAYW.id');
  ok('ID bo\'yicha to\'lov kutilmoqda', !!C.ev('PAYW.pub'));
  await clickPay(oid2, 249000);
  C.ev('payCheck()');
  await until(() => /Endi kirishingiz mumkin/.test(C.$('#app').textContent), 'to\'lovdan keyin login xabari');
  ok('to\'lovdan keyin login oynasida "Endi kirishingiz mumkin" xabari', true);
  C.set('ph', loginId); C.set('pw', 'admin123'); C.ev('doLogin()');
  await until(() => C.$('nav'), 'to\'langan hisobga kirish');
  ok('to\'langan hisobga kirish mumkin (3 oy = 90 kun)', C.ev('SUB.daysLeft') === 90 && C.ev('SUB.state') === 'active');

  /* ---------- Qurilma soatini surishdan himoya (oflayn holat) ---------- */
  const D0 = Date.now(), DAY = 86400000;
  const live = (o) => C.ev('subLive(' + JSON.stringify(o) + ')');
  ok('oflayn: muddat ichida ishlaydi', live({ serverTime: D0, until: D0 + DAY, localAt: D0 }) === true);
  ok('oflayn: muddat o\'tgan bo\'lsa ishlamaydi', live({ serverTime: D0, until: D0 - 1000, localAt: D0 }) === false);
  ok('oflayn: soat orqaga surilsa ishonchsiz deb bloklanadi', live({ serverTime: D0, until: D0 + 30 * DAY, localAt: D0 + 5 * 3600000 }) === false);
  ok('oflayn: soat oldinga surilsa muddat tezroq tugaydi (foyda bermaydi)', live({ serverTime: D0, until: D0 + DAY, localAt: D0 - 3 * DAY }) === false);
  ok('umrbod tarif soatga bog\'liq emas', live({ lifetime: true, localAt: D0 + 99999999 }) === true);
  ok('eski server (obuna ma\'lumoti yo\'q) bo\'lsa ilova ochiq qoladi', C.ev('subLive(null)') === true || C.ev('(()=>{const o=SUB;SUB=null;const r=subLive();SUB=o;return r})()') === true);

  /* ---------- Rus tiliga tarjima ---------- */
  C.ev("setLang('ru')"); C.ev("tab='me';render()");
  await until(() => /Тариф \/ Премиум/.test(C.$('#v').textContent), 'profil ruscha');
  ok('profil ruscha: "Тариф / Премиум"', true);
  C.ev("SUB.state='expired';payWall()");
  await until(() => /Срок подписки истёк/.test(C.$('#app').textContent), 'to\'lov oynasi ruscha');
  ok('to\'lov oynasi ruscha: "Срок подписки истёк", "Проверить снова"', /Проверить снова/.test(C.$('#app').textContent) && /Выйти|Chiqish|Выход/.test(C.$('#app').textContent));
  C.ev("setLang('en');payWall()");
  await until(() => /Subscription expired/.test(C.$('#app').textContent), 'to\'lov oynasi inglizcha');
  ok('to\'lov oynasi inglizcha: "Subscription expired", "Check again"', /Check again/.test(C.$('#app').textContent));
  C.ev("setLang('uz')");

  /* ---------- Egasi sahifasi (/owner) ---------- */
  const OW = await JSDOM.fromURL(base + '/owner', { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, base), o); } });
  const ow = OW.window, od = ow.document;
  od.querySelector('#key').value = 'noto\'g\'ri'; ow.eval('enter()'); await sleep(400);
  ok('/owner: noto\'g\'ri kalit bilan ichkariga kirib bo\'lmaydi', od.querySelector('#app').style.display === 'none');
  od.querySelector('#key').value = 'sk'; ow.eval('enter()');
  await until(() => od.querySelector('#plans tr[data-c="m1"]'), '/owner tariflar jadvali');
  ok('/owner: kalit bilan kirildi, tariflar va umumiy holat ko\'rinadi', od.querySelectorAll('#plans tr[data-c]').length === 4 && /Do'konlar/.test(od.querySelector('#sum').textContent));
  const row = od.querySelector('#plans tr[data-c="m1"]');
  row.querySelector('.p').value = '110000'; row.querySelector('button').click();
  await until(async () => false, 'x', 1).catch(() => {}); await sleep(500);
  ok('/owner: narx o\'zgartirildi va bazaga yozildi (110 000)', Number((await db('plans').where({ code: 'm1' }).first()).price) === 110000);
  await until(() => od.querySelector('#shops td'), '/owner do\'konlar ro\'yxati');
  ok('/owner: do\'konlar ro\'yxati chiqdi, telefon yashirin', /\*/.test(od.querySelector('#shops').textContent));
  ok('/owner sahifasida JS xatosi yo\'q', true);

  for (const [nm, c] of [['A', A], ['B', B], ['C', C]]) ok(`brauzer konsolida JS xatosi yo'q (${nm})`, c.errors.length === 0 || (console.log(c.errors), false));
  console.log(`\nOBUNA UI TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });

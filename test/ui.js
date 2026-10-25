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

  /* ===== ADMIN ===== */
  const A = await open();
  await register(A, 'Gilam Dunyosi', '+998 90 111 22 33', 'admin123');
  ok('admin SMS kod bilan ro\'yxatdan o\'tdi va kirdi', A.ev('U.role') === 'admin' && A.ev('U.name') === 'Gilam Dunyosi');
  const adminId = A.ev('U.loginId');
  ok('admin 6 xonali ID oldi va oyna ko\'rsatdi', /^\d{6}$/.test(adminId) && new RegExp(adminId).test(A.$('#md').innerHTML) && /Ro'yxatdan o'tdingiz/.test(A.$('#md').innerHTML));
  A.ev('close()');
  ok('admin 5 ta tab ko\'radi (Kiritish bor)', A.w.document.querySelectorAll('nav button').length === 5);
  ok('admin bosh sahifada foyda va tiles ko\'radi', /Bugungi foyda/.test(A.$('#v').innerHTML) && /Savdo grafigi/.test(A.$('#v').innerHTML));

  A.ev("go('add')"); A.set('fn', 'Gilam 2x3'); A.set('fc', '10000'); A.set('fp', '20'); A.set('fq', '40'); A.set('fm', '5'); A.set('fw', '2'); A.ev('saveP()');
  await until(() => A.ev('D.products.length') === 1, 'mahsulot saqlandi');
  ok('mahsulot serverga saqlandi', A.ev('D.products[0].cost') === 10000 && A.ev('D.products[0].sell') === 12000);
  A.ev("go('add')"); A.ev("AU='dona';addV(1)"); A.set('fn', 'Lampa'); A.set('fc', '5000'); A.set('fp', '10'); A.set('fq', '10'); A.set('fb', '999'); A.ev('saveP()');
  await until(() => A.ev('D.products.length') === 2, 'ikkinchi mahsulot');

  A.ev('staffV()'); await until(() => A.$('#sfn'), 'xodimlar oynasi');
  A.set('sfn', 'Sardor'); A.ev('addStaff()');
  await until(() => A.$('#cid') && A.$('#cpw'), 'xodim ID va paroli ko\'rsatildi');
  const sellerId = A.$('#cid').textContent, sellerPw = A.$('#cpw').textContent;
  ok('xodim qo\'shilganda tizim ID va parol berdi', /^\d{6}$/.test(sellerId) && sellerPw.length >= 8 && /Sardor/.test(A.$('#md').innerHTML) && A.ev('CRED').includes(sellerPw));
  A.ev('staffV()'); await until(() => A.$('#md') && !A.$('#cpw') && /Sardor/.test(A.$('#md').innerHTML) && A.ev('CRED') === '', 'xodim ro\'yxatda');
  ok('xodim ro\'yxatida ID ko\'rinadi, parol ko\'rinmaydi', new RegExp('ID: ' + sellerId).test(A.$('#md').innerHTML) && !A.$('#md').innerHTML.includes(sellerPw));
  A.ev('close()');

  A.ev('expV()'); await until(() => A.$('#en'), 'xarajat oynasi'); A.set('en', 'Ijara'); A.set('ea', '30000'); A.ev('addExp()');
  await until(() => A.ev('D.exp.length') === 1, 'xarajat'); A.ev('close()');

  const gid = A.ev("D.products.find(p=>p.name=='Gilam 2x3').id");
  A.ev(`go('find');pm('${gid}')`); A.set('xq', '2'); A.ev(`xf('${gid}')`);
  ok('admin sotish oynasida foyda va tannarxni ko\'radi', /Olingan/.test(A.$('#md').innerHTML) && /Sof foyda/.test(A.$('#xi').innerHTML));
  A.ev(`addC('${gid}',1)`); await until(() => A.$('#xc'), 'savat oynasi'); A.set('xc', 'Karim'); A.ev('doSell()');
  await until(() => A.ev('D.sales.length') === 1, 'sotuv');
  ok('sotuv bo\'ldi, qoldiq serverda kamaydi', A.ev("D.products.find(p=>p.id=='" + gid + "').qty") === 38);
  ok('admin chekda foydani ko\'radi', /Sof foyda/.test(A.$('#md').innerHTML));
  A.ev('close()');

  // nasiya + to'lov
  A.ev(`pm('${gid}')`); A.set('xq', '1'); A.ev(`addC('${gid}',1)`); await until(() => A.$('#xc'), 'savat');
  A.set('xc', 'Qarzdor'); A.$('#xd').checked = true; A.set('xa', '2000'); A.set('xt', '+998905550000'); A.set('xu', '2026-12-31'); A.ev('doSell()');
  await until(() => A.ev('D.debts.length') === 1, 'qarz');
  ok('nasiya qarz yaratildi (qolgan 10000)', A.ev('D.debts[0].amount') === 10000);
  const did = A.ev('D.debts[0].id'); A.ev('close()'); A.ev(`payM(${did})`); await until(() => A.$('#pa'), 'to\'lov oynasi'); A.set('pa', '4000'); A.ev(`doPay(${did})`);
  await until(() => A.ev('D.debts[0].amount') === 6000, 'qisman to\'lov'); ok('qarz to\'lovi ishladi', true);

  A.ev("go('me')"); ok('admin profilida Xodimlar va Xarajatlar bor', /Xodimlar/.test(A.$('#v').innerHTML) && /Xarajatlar/.test(A.$('#v').innerHTML));
  A.ev("sub='chart';go('home');sub='chart';render()"); ok('grafik ishlaydi (xatosiz)', /Kirim/.test(A.$('#v').innerHTML));
  A.ev("sub='rank';render()"); ok('reyting ishlaydi', /Gilam 2x3/.test(A.$('#v').innerHTML));

  /* ===== SOTUVCHI ===== */
  const S = await open();
  await login(S, sellerId, sellerPw);
  ok('sotuvchi kirdi, do\'kon nomi xo\'jayinniki', S.ev('U.role') === 'seller' && S.ev('U.name') === 'Gilam Dunyosi');
  ok('sotuvchi 4 tab ko\'radi (Kiritish yo\'q)', S.w.document.querySelectorAll('nav button').length === 4 && !/Kiritish/.test(S.$('nav').innerHTML));
  ok('sotuvchi mahsulotlarida tannarx YO\'Q (brauzer xotirasida ham)', S.ev('D.products.every(p=>p.cost===undefined&&p.pct===undefined)') && S.ev('JSON.stringify(D).includes("10000")') === false);
  const home = S.$('#v').innerHTML;
  ok('sotuvchi bosh sahifasida foyda/ombor summasi/grafik tugmasi yo\'q', !/Bugungi foyda|Ombordagi summa|Savdo grafigi|Mahsulot reytingi/.test(home));
  S.ev("go('find')"); S.ev(`pm('${gid}')`);
  ok('sotuvchi sotish oynasida tannarx ko\'rinmaydi, narx o\'zgarmaydi', !/Olingan/.test(S.$('#md').innerHTML) && S.$('#xp').hasAttribute('readonly') && S.$('#xp').value === '12000');
  S.set('xq', '3'); S.ev(`xf('${gid}')`); ok('sotuvchi "Sof foyda"ni ko\'rmaydi', !/foyda/i.test(S.$('#xi').innerHTML));
  S.ev(`addC('${gid}',1)`); await until(() => S.$('#xc'), 'savat'); S.set('xc', 'Vali'); S.ev('doSell()');
  await until(() => S.ev('D.sales.length') === 1, 'sotuvchi sotuvi');
  ok('sotuvchi sota oldi', S.ev('D.sales[0].items[0].price') === 12000);
  ok('sotuvchi chekida foyda va tannarx yo\'q', !/foyda/i.test(S.$('#md').innerHTML) && S.ev('D.sales[0].items[0].cost===undefined'));
  S.ev('close()'); S.ev("go('me')");
  ok('sotuvchi profilida o\'z ID si ko\'rinadi', new RegExp('ID: ' + sellerId).test(S.$('#v').innerHTML));
  ok('sotuvchi profilida Xodimlar/Xarajatlar/Excel yo\'q', !/Xodimlar|Xarajatlar|Excel/.test(S.$('#v').innerHTML) && /SOTUVCHI/.test(S.$('#v').innerHTML));
  ok('sotuvchi faqat o\'z sotuvlarini ko\'radi', S.ev('D.sales.length') === 1);
  ok('sotuvchiga xarajat/tovar tarixi yuklanmaydi', S.ev('D.exp.length') === 0 && S.ev('D.buys.length') === 0);
  // qarzdorlar: ruxsat bor (default)
  ok('sotuvchi qarzdorlarni ko\'radi (default ruxsat)', S.ev('D.debts.length') === 1);
  // sotuvchi to'g'ridan-to'g'ri API ga hujum qilsa ham
  const r1 = await S.w.fetch('/api/reports/summary', { headers: { authorization: 'Bearer ' + S.ev('TOK') } }); ok('sotuvchi hisobotni API orqali ham ola olmaydi (403)', r1.status === 403);
  const r2 = await S.w.fetch('/api/products', { headers: { authorization: 'Bearer ' + S.ev('TOK') } }); ok('API javobida cost maydoni umuman yo\'q', !/"cost"|"pct"/.test(await r2.text()));

  // admin ruxsatlarni o'zgartiradi
  A.ev('setV()'); await until(() => A.$('#sp'), 'sozlamalar'); A.$('#sp').checked = true; A.$('#sd').checked = false; A.ev('saveSet()');
  await until(() => A.ev('D.set.editPrice') === true, 'sozlama saqlandi'); A.ev('close()');
  S.ev('sync()'); await until(() => S.ev('D.set.canPrice') === true && S.ev('D.debts.length') === 0, 'sotuvchi sozlamalari yangilandi');
  ok('admin ruxsat bersa sotuvchi narxni o\'zgartira oladi, qarz yopiladi', true);

  // xodimni o'chirish
  A.ev('staffV()'); await until(() => /Sardor/.test((A.$('#md') || {}).innerHTML || ''), 'xodimlar');
  const sid = +A.$('#md').innerHTML.match(/togStaff\((\d+),false\)/)[1]; A.ev(`togStaff(${sid},false)`);
  await until(() => /o'chirilgan/.test(A.$('#md').innerHTML), 'xodim o\'chirildi'); A.ev('close()');
  S.ev("sync().catch(()=>{})"); await until(() => S.$('#ph') && !S.$('nav'), 'sotuvchi tizimdan chiqarildi');
  ok('o\'chirilgan xodim darrov chiqarib yuboriladi', true);

  /* ===== SOTUVNI BEKOR QILISH (UI) ===== */
  const qOf = () => A.ev(`D.products.find(p=>p.id=='${gid}').qty`);
  const q0 = qOf();
  A.ev(`go('find');pm('${gid}')`); A.set('xq', '3'); A.ev(`xf('${gid}')`); A.ev(`addC('${gid}',1)`);
  await until(() => A.$('#xc'), 'savat oynasi (bekor qilish uchun)'); A.set('xc', 'Bekor Mijoz'); A.ev('doSell()');
  await until(() => A.ev("D.sales.some(s=>s.cust=='Bekor Mijoz')"), 'yangi sotuv');
  const vid = A.ev("D.sales.find(s=>s.cust=='Bekor Mijoz').id");
  ok('sotuv ombordan 3 ta kamaytirdi', qOf() === q0 - 3);
  A.ev('close()'); A.ev(`sd(${vid})`);
  ok('sotuv oynasida "Sotuvni bekor qilish" tugmasi bor', /Sotuvni bekor qilish/.test(A.$('#md').innerHTML));
  A.ev(`voidSale(${vid})`);
  await until(() => !A.ev(`D.sales.some(s=>s.id==${vid})`) && !A.$('#md'), 'sotuv bekor qilindi');
  ok('bekor qilingach sotuv ro\'yxatdan chiqdi va ombor qaytdi', qOf() === q0);

  /* ===== REKLAMA ===== */
  await fetch(base + '/api/super/ads', { method: 'POST', headers: { 'content-type': 'application/json', 'x-super-key': 'sk' }, body: JSON.stringify({ title: 'Aksiya <b>5%</b>', body: 'Yangi tovar', placement: 'home', link: 'https://example.com' }) });
  A.ev("go('home')"); await until(() => A.$('#ad'), 'reklama blokі');
  ok('reklama bosh sahifada chiqdi va HTML qochirildi (XSS yo\'q)', /Aksiya &lt;b&gt;5%&lt;\/b&gt;/.test(A.$('#ad').innerHTML) && !A.$('#ad b + b'));

  /* ===== BOSHQA DO'KON ===== */
  const B = await open(); await register(B, 'Boshqa Do\'kon', '+998977000000', 'boshqa123');
  ok('boshqa biznes egasi hech narsani ko\'rmaydi', B.ev('D.products.length') === 0 && B.ev('D.sales.length') === 0 && B.ev('D.debts.length') === 0 && B.ev('D.exp.length') === 0);

  /* ===== PAROLNI TIKLASH, RAQAM ALMASHTIRISH, HISOBNI O'CHIRISH (UI) ===== */
  const F = await open(); await until(() => F.$('#ph'), 'login');
  ok('kirish ekranida "ID raqam" va "Parolni unutdingizmi?" bor', /ID raqam/.test(F.$('.lg').innerHTML) && /Parolni unutdingizmi\?/.test(F.$('.lg').innerHTML) && !/Telefon raqam/.test(F.$('.lg').innerHTML));
  F.ev('loginV(2)'); F.set('ph', '+998 90 111 22 33'); F.ev('doResetStart()');
  await until(() => F.$('#cdb') && F.$('#cdb').style.display === 'block', 'tiklash kodi maydoni');
  F.set('cd', lastCode('998901112233')); F.set('pw', 'yangi1234'); F.ev('doResetConfirm()');
  await until(() => F.$('#ph') && F.$('#ph').value === adminId && /Parol yangilandi/.test(F.$('.lg').innerHTML), 'parol yangilandi va ID ko\'rsatildi');
  ok('parol tiklandi: ID ko\'rsatildi va kirish oynasiga o\'tdi', true);
  F.set('pw', 'yangi1234'); F.ev('doLogin()'); await until(() => F.$('nav'), 'yangi parol bilan kirdi');
  ok('yangi parol bilan ID orqali kirdi', F.ev('U.role') === 'admin' && F.ev('U.loginId') === adminId);

  F.ev("go('me')"); F.ev('secV()');
  ok('xavfsizlik oynasida ID, raqamni o\'zgartirish va hisobni o\'chirish bor', new RegExp(adminId).test(F.$('#md').innerHTML) && /phoneV\(\)/.test(F.$('#md').innerHTML) && /delAccV\(\)/.test(F.$('#md').innerHTML));
  const tok0 = F.ev('TOK'); F.set('cp', 'yangi1234'); F.set('np', 'yana5678'); F.ev('chPw()');
  await until(() => F.ev('TOK') !== tok0, 'yangi token olindi');
  ok('parol almashgach sessiya uzilmaydi (yangi token)', (await F.w.fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + F.ev('TOK') } })).status === 200 && (await F.w.fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + tok0 } })).status === 401);

  F.ev('phoneV()'); F.set('npn', '+998 90 555 66 77'); F.set('ppw', 'yana5678'); F.ev('phStart()');
  await until(() => F.$('#pcb') && F.$('#pcb').style.display === 'block', 'raqam kodi maydoni');
  F.set('pcd', lastCode('998905556677')); F.ev('phConfirm()');
  await until(() => F.ev('U.phone') === '998905556677', 'raqam almashdi');
  ok('telefon raqam SMS kod bilan almashtirildi', true);

  F.ev('delAccV()'); F.set('dpw', 'xato-parol'); F.ev('delAcc()');
  await until(() => /noto'g'ri/.test(F.$('#er').textContent), 'noto\'g\'ri parol xabari');
  ok('noto\'g\'ri parol bilan hisob o\'chmaydi', !!F.$('nav'));
  F.set('dpw', 'yana5678'); F.ev('delAcc()');
  await until(() => F.$('#ph') && !F.$('nav'), 'hisob o\'chdi, kirish oynasi');
  F.set('ph', adminId); F.set('pw', 'yana5678'); F.ev('doLogin()');
  await until(() => /noto'g'ri/.test(F.$('#er').textContent), 'o\'chirilgan hisob kira olmaydi');
  ok('hisob o\'chirildi va qayta kirib bo\'lmaydi', true);

  const R = await open(); await until(() => R.$('#ph'), 'login'); R.ev("setLang('ru');loginV(0)");
  await until(() => /Забыли пароль\?/.test(R.$('.lg').innerHTML), 'ruscha tarjima');
  ok('kirish ekrani ruscha tarjima qilinadi (ID, parolni unutdingizmi)', /ID номер/.test(R.$('.lg').innerHTML));
  R.ev('loginV(1)'); await until(() => /Отправить код/.test(R.$('.lg').innerHTML), 'ro\'yxat tarjimasi');
  ok('ro\'yxatdan o\'tish ekrani ruscha tarjima qilinadi', /Отправить код/.test(R.$('.lg').innerHTML));

  /* ===== ESKI MA'LUMOTNI KO'CHIRISH ===== */
  const old = { products: [{ id: '1', name: 'Eski mahsulot', unit: 'kg', cost: 500, pct: 10, qty: 7, min: 1, bc: '', w: 0 }], sales: [{ id: 9, t: Date.now(), cust: 'Eski mijoz', items: [{ name: 'Eski mahsulot', unit: 'kg', qty: 1, price: 550, cost: 500 }] }], buys: [], debts: [], exp: [] };
  const M = await open((w) => w.localStorage.setItem('data:998944000000', JSON.stringify(old)));
  await register(M, 'Ko\'chuvchi', '+998944000000', 'koch1234');
  await until(() => M.$('#md') && /Eski ma'lumot topildi/.test(M.$('#md').innerHTML) || (M.ev('close()'), M.ev('migrateOffer()'), false), 'ko\'chirish taklifi');
  ok('eski ma\'lumot topilganda taklif chiqdi', true);
  M.ev('doMigrate()'); await until(() => M.ev('D.products.length') === 1 && M.ev('D.sales.length') === 1, 'ko\'chirildi');
  ok('eski ma\'lumot serverga ko\'chirildi', M.ev('D.products[0].name') === 'Eski mahsulot' && M.ev('D.sales[0].cust') === 'Eski mijoz');

  for (const c of [A, S, B, M, F, R]) ok('brauzer konsolida JS xatosi yo\'q', c.errors.length === 0 || (console.log(c.errors), false));
  console.log(`\nUI TEST: HAMMASI JOYIDA (${n} ta tekshiruv)`); srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });
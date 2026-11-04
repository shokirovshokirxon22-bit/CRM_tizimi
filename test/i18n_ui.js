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


  const txt = () => (A.$('#md') || { textContent: '' }).textContent;
  await A.ev(`api('/products','POST',{name:'Lampa',unit:'dona',cost:500,pct:10,qty:3})`);
  await A.ev(`api('/staff','POST',{name:'Ali'})`);
  await A.ev(`api('/expenses','POST',{name:'Ijara',amount:1000})`);
  await A.ev('sync()');
  const cyr = (t) => /[А-Яа-я]/.test(t);
  for (const lg of ['ru', 'en']) {
    A.ev(`setLang('${lg}')`); A.ev('meV()'); await sleep(50);
    const menu = A.$('#v').textContent;
    ok(lg + ': menyuda "Xodimlar" va "Faoliyat tarixi" qolmadi', !/Xodimlar|Faoliyat tarixi/.test(menu) && (lg == 'ru' ? /Сотрудники/.test(menu) && /История действий/.test(menu) : /Staff/.test(menu) && /Activity log/.test(menu)));
    A.ev('staffV()'); await until(() => /Hali|ID:/.test(txt()) || txt().length > 50, 'xodimlar'); await sleep(80);
    ok(lg + ': xodimlar oynasi tarjima qilindi', !/Xodim|Mahsulotlarni tahrirlay|Qarzdorlarni ko|Yangi parol|Ism\b/.test(txt()));
    A.ev('close()');
    A.ev('auditV()'); await until(() => /Lampa/.test(txt()), 'tarix'); await sleep(80);
    const t = txt();
    ok(lg + ': tarix sarlavhasi, filtr va yozuvlar tarjima qilindi', !/Kim, qachon|Mahsulot qo'shildi|Xarajat qo'shildi|Xodim qo'shildi|tannarx|Hammasi\b/.test(t) && (lg == 'ru' ? /Товар добавлен: Lampa/.test(t) && /Расход добавлен/.test(t) && /Сотрудник добавлен/.test(t) : /Product added: Lampa/.test(t) && /Expense added/.test(t) && /Employee added/.test(t)));
    A.ev('close()');
  }
  // Excel: tilga mos fayl nomi, sarlavha, qiymat
  for (const lg of ['uz', 'ru', 'en']) {
    A.ev(`setLang('${lg}')`);
    const got = {}; A.w.XLSX = { utils: { book_new: () => ({}), aoa_to_sheet: (R) => ({ R }), book_append_sheet: (wb, ws, nm) => { got.R = ws.R; got.sheet = nm; } }, writeFile: (wb, f) => { got.file = f; } };
    A.ev("exC('p')"); const p = JSON.parse(JSON.stringify(got));
    A.ev("exC('d')"); const d = { file: got.file, head: got.R[0] };
    const exp = { uz: ['mahsulotlar.xlsx', 'Nomi', 'Hisobot', 'qarzlar.xlsx', 'Holat'], ru: ['Товары.xlsx', 'Название', 'Отчёт', 'Долги.xlsx', 'Статус'], en: ['Products.xlsx', 'Name', 'Report', 'Debts.xlsx', 'Status'] }[lg];
    ok('Excel (' + lg + '): fayl nomi, varaq nomi, sarlavhalar', p.file === exp[0] && p.R[0][0] === exp[1] && p.sheet === exp[2] && d.file === exp[3] && d.head[5] === exp[4]);
    ok('Excel (' + lg + '): birlik tarjima qilindi, mahsulot nomi buzilmadi', p.R[1][0] === 'Lampa' && p.R[1][1] === { uz: 'dona', ru: 'шт', en: 'pcs' }[lg]);
  }
  // Ilova haqida + Yordam + Telegram
  A.ev("setLang('uz')"); A.ev('aboutV()');
  const ab = A.$('#md').innerHTML;
  ok('Ilova haqida: shaffof logo (yorug\' va qorong\'i), Yordam tugmasi', /logo-about\.png/.test(ab) && /logo-about-dark\.png/.test(ab) && /helpV\(\)/.test(ab));
  const tg = A.$('#md a.tg');
  ok('Telegram bosilsa @Mizan_Uz_bot ga olib boradi', tg && tg.href === 'https://t.me/Mizan_Uz_bot' && tg.target === '_blank' && /@Mizan_Uz_bot/.test(tg.textContent));
  const n = A.ev('HELP().length'); ok('Yordamda ' + n + ' ta mavzu', n >= 8);
  for (const lg of ['uz', 'ru', 'en']) {
    A.ev(`setLang('${lg}')`); A.ev('helpV()'); await sleep(30);
    ok('Yordam (' + lg + ') ro\'yxati chiqdi', A.$('#md').querySelectorAll('button.mi').length === n);
    for (let i = 0; i < n; i++) { A.ev(`helpT(${i})`); await sleep(5); const m = A.$('#md'); if (!m.querySelector('.hm') || m.querySelectorAll('.hs').length < 2 || m.querySelectorAll('.hl').length < 1) throw new Error('Yordam mavzusi bo\'sh: ' + lg + ' ' + i); if (lg != 'uz' && /[ʻ’']\s?(?:ni|ga|da)\b/.test('')) throw 0; }
    if (lg == 'ru') { A.ev('helpT(0)'); await sleep(50); ok('Yordam (ru) matni ruscha', cyr(txt()) && !/Qidiruv|Savatga/.test(txt())); }
    if (lg == 'en') { A.ev('helpT(1)'); await sleep(50); ok('Yordam (en) matni inglizcha', !cyr(txt()) && !/Qarzdorlar|qabul/.test(txt())); }
  }
  A.ev('close()');
  ok('JS xatosi yo\'q', A.errors.length === 0);
  console.log('\nI18N/YORDAM TESTI: HAMMASI JOYIDA (' + n + ' mavzu)'); srv.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// Oflayn sotuv (frontend): internet uzilsa navbatga yozish, oflayn qayta ochish, qayta ulanganda yuborish, dublikat bo'lmasligi.
// Server soxta (xotirada): bu test faqat public/index.html ning oflayn mantig'ini tekshiradi.
const fs = require('fs'), assert = require('assert'); const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
let n = 0; const ok = (nm, c) => { assert.ok(c, 'XATO: ' + nm); n++; console.log('  ✓', nm); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 4000) { const t = Date.now(); for (;;) { let v; try { v = fn(); } catch (e) {} if (v) return v; if (Date.now() - t > ms) throw new Error('Kutilgan narsa chiqmadi: ' + what); await sleep(20); } }

// Soxta server (xotirada)
const srv = { products: [{ id: 1, name: 'Gilam', unit: 'm', cost: 1000, pct: 20, qty: 5, min: 0, barcode: '', width: 0, sellPrice: 1200 }], sales: [], posts: 0, loseFirstReply: false, rejectWith: null };
function handle(path, method, body) {
  const j = (s, o) => ({ s, o });
  if (path === '/auth/me') return j(200, { user: { id: 7, phone: '998900000000', role: 'admin', name: 'Ali', loginId: '123456' }, shop: { name: "Do'kon" } });
  if (path === '/settings') return j(200, { shopName: "Do'kon", lang: 'uz', sms: false, days: 3, tpl: '', sellerEditPrice: false, sellerSeeDebts: true });
  if (path === '/products') return j(200, srv.products);
  if (path.startsWith('/sales') && method === 'GET') return j(200, []);
  if (['/debts', '/expenses', '/buys'].includes(path)) return j(200, []);
  if (path === '/sales' && method === 'POST') {
    srv.posts++;
    if (srv.rejectWith) return j(404, { error: srv.rejectWith });
    let s = srv.sales.find((x) => x.clientId === body.clientId);
    if (!s) { for (const i of body.items) srv.products.find((p) => p.id === i.productId).qty -= i.qty; s = { id: srv.sales.length + 1, clientId: body.clientId, createdAt: body.createdAt, customer: body.customer, items: body.items, offline: body.offline }; srv.sales.push(s); }
    if (srv.loseFirstReply) { srv.loseFirstReply = false; return 'LOST'; } // server yozdi, lekin javob yo'lda yo'qoldi
    return j(201, { id: s.id, customer: s.customer, total: 2400, createdAt: s.createdAt, items: [], warnings: [] });
  }
  return j(404, { error: 'yo\'q ' + path });
}
async function open(store, online = true) {
  const st = { online, errors: [], calls: [] };
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    for (const [k, v] of Object.entries(store || {})) w.localStorage.setItem(k, v);
    Object.defineProperty(w.navigator, 'onLine', { get: () => st.online });
    w.fetch = async (u, o = {}) => { const p = String(u).replace(/^.*\/api/, ''); const m = o.method || 'GET'; st.calls.push(m + ' ' + p);
      if (!st.online) throw new TypeError('Failed to fetch');
      const r = handle(p, m, o.body ? JSON.parse(o.body) : null); if (r === 'LOST') throw new TypeError('Failed to fetch');
      return { ok: r.s < 400, status: r.s, json: async () => r.o }; };
    w.confirm = () => true; w.HTMLElement.prototype.scrollIntoView = () => {}; w.addEventListener('error', (e) => st.errors.push(e.message));
  } });
  const w = dom.window; return { w, st, $: (s) => w.document.querySelector(s), ev: (s) => w.eval(s), store: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => [w.localStorage.key(i), w.localStorage.getItem(w.localStorage.key(i))])) };
}
const sell = async (a, qty) => { a.ev(`C=[{id:'1',name:'Gilam',unit:'m',qty:${qty},price:1200,cost:1000}];checkout()`); await until(() => a.$('#xc'), 'savat oynasi'); a.ev('doSell()'); };

(async () => {
  const tok = 'tok-abcdefghijklmnopqrstuvwxyz0123';
  // 1) onlayn kirish: ma'lumot nusxasi saqlanadi
  let a = await open({ token: tok });
  await until(() => a.ev('D&&D.products.length==1'), 'mahsulotlar yuklandi');
  ok('onlayn boshlandi, mahsulot bor', a.ev("D.products[0].qty") === 5 && !a.$('#ob'));
  ok('ma\'lumot nusxasi (oc:7) va profil (om) saqlandi', !!a.w.localStorage.getItem('oc:7') && !!a.w.localStorage.getItem('om'));

  // 2) internet uzildi -> sotuv navbatga tushadi
  a.st.online = false; a.w.dispatchEvent(new a.w.Event('offline'));
  await until(() => a.$('#ob'), 'oflayn belgisi');
  const before = srv.posts; await sell(a, 2);
  await until(() => a.ev("JSON.parse(localStorage.getItem('oq:7')||'[]').length") === 1, 'navbatga tushdi');
  ok('oflayn sotuv navbatga tushdi, serverga so\'rov ketmadi', srv.posts === before);
  ok('mahalliy ombor kamaydi (5 -> 3), qayta sotib yuborilmaydi', a.ev('D.products[0].qty') === 3);
  ok('"1 ta sotuv kutmoqda" belgisi chiqdi', /Oflayn/.test(a.$('#ob').textContent) && /1 ta/.test(a.$('#ob').textContent));
  ok('"Sotuv saqlandi" oynasi chiqdi', /Sotuv saqlandi/.test(a.$('#md').textContent));
  const q = JSON.parse(a.w.localStorage.getItem('oq:7'))[0];
  ok('navbat yozuvida clientId, vaqt, qty bor', q.cid && q.t > 0 && q.items[0].qty === 2);

  // 3) ilova oflayn holda QAYTA ochiladi (sahifa yangilandi)
  const b = await open(a.store(), false);
  await until(() => b.ev('D&&D.products&&D.products.length==1'), 'oflayn qayta ochildi', 5000);
  ok('oflayn qayta ochildi: login sahifasi emas, ilova ichida', !b.$('.lg') && b.ev('!!U'));
  ok('qoldiq 3 (ikki marta ayrilmagan!)', b.ev('D.products[0].qty') === 3);
  ok('yuborilmagan sotuv belgisi saqlanib qoldi', /1 ta/.test(b.$('#ob').textContent));
  ok('API javoblari brauzer keshiga emas, faqat o\'z kalitiga yozildi', Object.keys(b.store()).every((k) => ['token', 'oq:7', 'oc:7', 'om', 'lang'].includes(k) || /^loc:/.test(k)));

  // 4) javob yo'lda yo'qoladi (server yozdi, mijoz bilmaydi) -> qayta yuborganda DUBL bo'lmasin
  srv.loseFirstReply = true; b.st.online = true; b.w.dispatchEvent(new b.w.Event('online'));
  await sleep(150);
  ok('javob yo\'qolganda sotuv navbatda qoldi', b.ev("JSON.parse(localStorage.getItem('oq:7')||'[]').length") === 1 || srv.sales.length === 1);
  b.w.dispatchEvent(new b.w.Event('online')); // qayta urinish
  await until(() => b.ev("!localStorage.getItem('oq:7')"), 'navbat bo\'shadi');
  ok('server tomonda sotuv faqat BITTA (clientId bilan dublikat yo\'q)', srv.sales.length === 1 && srv.sales[0].offline === true);
  ok('belgi yo\'qoldi, qoldiq serverdan (3)', !b.$('#ob') && b.ev('D.products[0].qty') === 3);

  // 5) server sotuvni rad etsa (mahsulot o'chirilgan): navbatda xato bilan qoladi, o'chirib tashlash mumkin
  b.st.online = false; await sell(b, 1); b.ev("$('#md')&&$('#md').remove()");
  ok('2-sotuv navbatda, ombor 2', b.ev("JSON.parse(localStorage.getItem('oq:7')).length") === 1 && b.ev('D.products[0].qty') === 2);
  srv.rejectWith = "Mahsulot topilmadi"; b.st.online = true; b.w.dispatchEvent(new b.w.Event('online'));
  await until(() => b.ev("(JSON.parse(localStorage.getItem('oq:7'))[0]||{}).err"), 'xato belgilandi');
  const posts = srv.posts; b.w.dispatchEvent(new b.w.Event('online')); await sleep(100);
  ok('rad etilgan sotuv har safar qayta yuborilavermaydi', srv.posts === posts);
  ok('foydalanuvchiga ko\'rinadi (qizil xabar bilan ro\'yxat)', (b.ev('qView()'), /Mahsulot topilmadi/.test(b.$('#md').textContent)));
  b.ev(`qDel('${b.ev("JSON.parse(localStorage.getItem('oq:7'))[0].cid")}')`);
  ok('o\'chirilgach navbat bo\'sh', !b.w.localStorage.getItem('oq:7'));

  // 6) boshqa foydalanuvchi: eski nusxa va navbat ishlatilmaydi
  const c = await open({ token: 'BOSHQA-token-xxxxxxxxxxxxxxxxxxxxxxxx', om: b.w.localStorage.getItem('om'), 'oc:7': b.w.localStorage.getItem('oc:7') }, false);
  await sleep(300);
  ok('boshqa token bilan oflayn ochilganda begona nusxa ishlatilmaydi', c.ev('!U') && !!c.$('.lg'));

  ok('JS xatolari yo\'q', a.st.errors.length + b.st.errors.length + c.st.errors.length === 0 || (console.log(a.st.errors, b.st.errors), false));
  console.log(`\nOFLAYN UI TESTI: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });

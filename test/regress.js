// Regressiya testlari: qoldiq to'qnashuvi va import (auth tartibi). Ishga tushirish: node test/regress.js
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
process.env.SQLITE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-r-')), 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory'; delete process.env.DATABASE_URL;
const { createApp } = require('../src/app'); const { migrate } = require('../src/db');
let base, n = 0;
const call = async (m, u, t, b, raw) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: raw || (b ? JSON.stringify(b) : undefined) });
  let j = null; try { j = await r.json(); } catch {} return { s: r.status, j };
};
// Ro'yxatdan o'tish endi SMS kod bilan: kod xotiradagi "outbox"dan olinadi (SMS_PROVIDER=memory)
const { outbox } = require('../src/sms');
const lastCode = (phone) => { const m = [...outbox].reverse().find((x) => x.phone === phone); return m && m.text.match(/\d{6}/)[0]; };
const reg = async (shopName, phone, password) => {
  const ph = phone.replace(/\D/g, '');
  const s = await call('POST', '/api/auth/register/start', null, { phone });
  if (s.s !== 200) return s;
  return call('POST', '/api/auth/register', null, { shopName, phone, password, code: lastCode(ph) });
};
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;
  const A = (await reg('A', '+998901111111', 'secret1')).j.token;
  const p = (await call('POST', '/api/products', A, { name: 'Mix', unit: 'dona', cost: 100, pct: 10, qty: 10 })).j;
 
  // forma ochilganda qoldiq 10 edi; shu orada 4 ta sotildi; admin nomni o'zgartirib saqlaydi
  await call('POST', '/api/sales', A, { items: [{ productId: p.id, qty: 4 }] });
  let r = await call('PUT', '/api/products/' + p.id, A, { name: 'Mix 2', cost: 100, pct: 10, qty: 10, qtyBase: 10 });
  ok('tahrir qoldiqni qaytarib yubormaydi (6 qoladi)', r.s === 200 && r.j.qty === 6);
  r = await call('PUT', '/api/products/' + p.id, A, { name: 'Mix 2', cost: 100, pct: 10, qty: 15, qtyBase: 10 });
  ok('forma bo\'yicha +5 qo\'shilsa 11 bo\'ladi', r.j.qty === 11);
  r = await call('PUT', '/api/products/' + p.id, A, { name: 'Mix 2', cost: 100, pct: 10, qty: 0, qtyBase: 50 });
  ok('manfiy qoldiq bo\'lishi mumkin emas (409)', r.s === 409);
  r = await call('PUT', '/api/products/' + p.id, A, { name: 'Mix 3', cost: 100, pct: 10, qty: 3 });
  ok('eski mijoz (qtyBase yo\'q) avvalgidek ishlaydi', r.s === 200 && r.j.qty === 3);
 
  // anonim odam katta JSON yuborsa auth'dan o'tolmay 401 olishi kerak (15 MB o'qilmasin)
  const big = '{"x":"' + 'a'.repeat(3 * 1024 * 1024) + '"}';
  r = await call('POST', '/api/import', null, null, big);
  ok('tokensiz /api/import 401', r.s === 401);
  srv.close(); console.log('REGRESSIYA: ' + n + ' ta tekshiruv o\'tdi'); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
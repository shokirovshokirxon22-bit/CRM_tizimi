// Eski (001) bazadagi foydalanuvchilar yangi tizimga o'tganda yo'qolmasligini tekshiradi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-m-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
if (!process.env.TEST_DATABASE_URL) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const bcrypt = require('bcryptjs');
const { migrate, db } = require('../src/db');
const { createApp } = require('../src/app');
let n = 0; const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };

(async () => {
  const dir = path.join(__dirname, '..', 'src', 'migrations');
  await db.migrate.up({ directory: dir }); // faqat 001 (eski sxema)
  const hash = bcrypt.hashSync('eskiparol1', 10);
  const sid = (await db('shops').insert({ name: 'Eski do\'kon', created_at: 1 }).returning('id'))[0];
  const sidv = typeof sid === 'object' ? sid.id : sid;
  await db('users').insert([
    { shop_id: sidv, phone: '998901234567', name: 'Egasi', role: 'admin', password_hash: hash, active: true, created_at: 1 },
    { shop_id: sidv, phone: '903334455', name: 'Xodim', role: 'seller', password_hash: hash, active: true, created_at: 2 }, // 9 xonali eski ko'rinish
  ]);
  await db('products').insert({ shop_id: sidv, name: 'Gilam', unit: 'm', cost: 10, pct: 0, qty: 5, min: 0, width: 0, created_at: 1 });

  await migrate(); // 002
  const us = await db('users').orderBy('id');
  ok('barcha eski foydalanuvchilar saqlandi', us.length === 2 && us[0].phone === '998901234567');
  ok('har biriga 6 xonali takrorlanmas ID berildi', us.every((u) => /^\d{6}$/.test(u.login_id)) && us[0].login_id !== us[1].login_id);
  ok('boshqa jadvallar (mahsulot) joyida', (await db('products').where({ shop_id: sidv })).length === 1);
  ok('ID unique indeksi bor (takror qo\'shib bo\'lmaydi)', await db('users').insert({ shop_id: sidv, phone: null, login_id: us[0].login_id, name: 'x', role: 'seller', password_hash: hash, created_at: 3 }).then(() => false, () => true));
  ok('telefonsiz xodim qo\'shsa bo\'ladi (phone NOT NULL emas)', await db('users').insert({ shop_id: sidv, phone: null, login_id: '555555', name: 'Telefonsiz', role: 'seller', password_hash: hash, created_at: 3 }).then(() => true, () => false));
  ok('ikkita telefonsiz xodim bo\'ladi (NULL lar to\'qnashmaydi)', await db('users').insert({ shop_id: sidv, phone: null, login_id: '555556', name: 'Telefonsiz2', role: 'seller', password_hash: hash, created_at: 3 }).then(() => true, () => false));
  ok('o\'sha telefon takrorlansa rad etiladi (unique saqlangan)', await db('users').insert({ shop_id: sidv, phone: '998901234567', login_id: '555557', name: 'x', role: 'seller', password_hash: hash, created_at: 3 }).then(() => false, () => true));
  ok('do\'kon o\'chsa foydalanuvchilar ham o\'chadi (FK cascade saqlangan)', (await db('shops').insert({ name: 'T', created_at: 1 }).returning('id').then(async (r) => { const id = typeof r[0] === 'object' ? r[0].id : r[0]; await db('users').insert({ shop_id: id, phone: '998900000001', login_id: '777777', name: 'T', role: 'admin', password_hash: hash, created_at: 1 }); await db('shops').where({ id }).del(); return db('users').where({ login_id: '777777' }); })).length === 0);

  const srv = createApp().listen(0); const base = 'http://localhost:' + srv.address().port;
  const login = async (b) => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  ok('eski admin yangi ID bilan kiradi', (await login({ id: us[0].login_id, password: 'eskiparol1' })).s === 200);
  ok('eski admin avvalgidek telefon bilan ham kiradi', (await login({ phone: '+998 90 123 45 67', password: 'eskiparol1' })).s === 200);
  ok('9 xonali saqlangan eski xodim telefon bilan kiradi', (await login({ phone: '90 333 44 55', password: 'eskiparol1' })).s === 200);
  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nMIGRATSIYA TEST: HAMMASI JOYIDA (${n} ta tekshiruv)`); process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });
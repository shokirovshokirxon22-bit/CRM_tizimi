// SMS limitlari: raqam bo'yicha, IP bo'yicha, kunlik umumiy; yuborilmagan SMS limitni yemaydi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ombor-s-'));
process.env.SQLITE_FILE = path.join(tmp, 't.db');
process.env.JWT_SECRET = 'test-secret'; process.env.AUTH_RATE_LIMIT = '1000'; process.env.SMS_RATE_LIMIT = '1000'; process.env.SMS_PROVIDER = 'memory';
delete process.env.SMS_DAILY_LIMIT;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
const { createApp } = require('../src/app');
const { migrate, db } = require('../src/db');
const { outbox } = require('../src/sms');

let base, n = 0;
const call = async (m, u, t, b) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { s: r.status, j };
};
const ok = (name, c) => { assert.ok(c, 'XATO: ' + name); n++; console.log('  ✓', name); };
const start = (phone) => call('POST', '/api/auth/register/start', null, { phone });
const sentTo = (phone) => outbox.filter((x) => x.phone === phone).length;
const count = async (where = {}) => Number((await db('sms_log').where(where).count({ c: '*' }).first()).c);

(async () => {
  await migrate();
  const srv = createApp().listen(0); base = 'http://localhost:' + srv.address().port;

  // ---------- Bitta raqamga soatiga 5 tadan ko'p emas ----------
  const P = '998905550001';
  let r = await start(P);
  ok('birinchi SMS ketdi', r.s === 200 && sentTo(P) === 1);
  ok('darrov qayta so\'rasa 429 (60 soniya)', (await start(P)).s === 429);
  ok('rad etilgan so\'rov jurnalga yozilmadi', (await count({ phone: P })) === 1);
  for (let i = 2; i <= 5; i++) {
    await db('sms_log').where({ phone: P }).update({ created_at: Date.now() - 2 * 60 * 1000 }); // 60 soniya o'tdi deb hisoblaymiz
    ok(`${i}-SMS ketdi`, (await start(P)).s === 200);
  }
  await db('sms_log').where({ phone: P }).update({ created_at: Date.now() - 2 * 60 * 1000 });
  r = await start(P);
  ok('6-SMS soatlik limitga tushdi (429)', r.s === 429 && /soat/.test(r.j.error));
  ok('jami faqat 5 ta SMS yuborilgan', sentTo(P) === 5 && (await count({ phone: P })) === 5);
  await db('sms_log').where({ phone: P }).update({ created_at: Date.now() - 61 * 60 * 1000 });
  ok('1 soatdan keyin yana yuborish mumkin', (await start(P)).s === 200);

  // ---------- Bitta IP dan 15 daqiqada SMS_RATE_LIMIT ta ----------
  await db('sms_log').del();
  process.env.SMS_RATE_LIMIT = '3';
  for (let i = 1; i <= 3; i++) ok(`IP: ${i}-raqamga ketdi`, (await start('99890555010' + i)).s === 200);
  r = await start('998905550109');
  ok('IP: 4-raqamga 429 (boshqa raqam bo\'lsa ham)', r.s === 429);
  ok('IP: rad etilgan SMS yuborilmadi', sentTo('998905550109') === 0);
  process.env.SMS_RATE_LIMIT = '1000';

  // ---------- Kunlik umumiy limit (Eskiz balansini himoya qiladi) ----------
  await db('sms_log').del();
  process.env.SMS_DAILY_LIMIT = '2';
  ok('kunlik limit: 1-SMS', (await start('998905550201')).s === 200);
  ok('kunlik limit: 2-SMS', (await start('998905550202')).s === 200);
  r = await start('998905550203');
  ok('kunlik limit tugagach 503', r.s === 503 && sentTo('998905550203') === 0);
  ok('limitdan oshgan so\'rov jurnalda qolmadi', (await count()) === 2);
  process.env.SMS_DAILY_LIMIT = '0';
  ok('SMS_DAILY_LIMIT=0 bo\'lsa cheklov yo\'q', (await start('998905550204')).s === 200);
  delete process.env.SMS_DAILY_LIMIT;

  // ---------- Bir vaqtda ko'p so'rov (bot) limitdan o'tib keta olmaydi ----------
  await db('sms_log').del(); outbox.length = 0;
  process.env.SMS_DAILY_LIMIT = '5';
  const res = await Promise.all(Array.from({ length: 25 }, (_, i) => start('9989056000' + String(10 + i))));
  const sent = res.filter((x) => x.s === 200).length;
  ok('25 ta parallel so\'rovdan 5 tadan ko\'p SMS ketmadi', sent <= 5 && outbox.length === sent && (await count()) === sent);
  delete process.env.SMS_DAILY_LIMIT;

  // ---------- Yuborilmagan SMS limitni yemaydi ----------
  await db('sms_log').del();
  process.env.SMS_PROVIDER = 'none';
  r = await start('998905550301');
  ok('SMS xizmati yo\'q bo\'lsa 503', r.s === 503);
  ok('yuborilmagan SMS jurnalda ham, kodlarda ham qolmadi', (await count()) === 0 && !(await db('otps').where({ phone: '998905550301' }).first()));
  process.env.SMS_PROVIDER = 'memory';
  ok('xizmat tiklangach darrov yuborish mumkin (kutish yo\'q)', (await start('998905550301')).s === 200);

  // ---------- Eski yozuvlar tozalanadi ----------
  await db('sms_log').insert({ phone: '998905550999', ip: null, purpose: 'register', created_at: Date.now() - 25 * 60 * 60 * 1000 });
  await start('998905550302');
  ok('24 soatdan eski jurnal yozuvlari o\'chiriladi', (await count({ phone: '998905550999' })) === 0);

  console.log(`\nSMS LIMIT TEST: HAMMASI JOYIDA (${n} ta tekshiruv)`);
  srv.close(); await db.destroy(); fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });

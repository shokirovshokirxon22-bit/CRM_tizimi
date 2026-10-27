// Kirishdagi brute-force himoyasi: (foydalanuvchi + IP) juftligi bo'yicha.
//  - Bir IP dan bitta ID ga 15 daqiqada LOGIN_MAX_FAILS (default 8) ta xato bo'lsa, FAQAT shu IP shu ID ga kira olmaydi.
//    Egasi o'z IP sidan kirishda davom etadi: birovning ID sini terib uni to'sib bo'lmaydi.
//  - Ko'p IP dan uyushgan hujumga qarshi: bitta ID ga bir soatda barcha IP lardan LOGIN_USER_HOURLY (default 60) ta xato
//    bo'lsa, shu ID uchun kirish vaqtincha to'xtaydi (0 = o'chiq). Bu oxirgi chora, hujumchiga ko'p IP kerak bo'ladi.
// Hisoblash bazada (Vercel'da xotira saqlanmaydi). Bloklangan urinishlar hisobga yozilmaydi, shuning uchun blok o'zi tugaydi.
const { db } = require('./db');
const { ApiError, now } = require('./util');

const WINDOW = 15 * 60 * 1000, HOUR = 60 * 60 * 1000;
const maxFails = () => +process.env.LOGIN_MAX_FAILS || 8;
const userHourly = () => (process.env.LOGIN_USER_HOURLY === undefined || process.env.LOGIN_USER_HOURLY === '' ? 60 : +process.env.LOGIN_USER_HOURLY || 0);

// IPv6 da foydalanuvchiga butun /64 beriladi: har safar manzilni almashtirib blokdan o'tib bo'lmasin
function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s) return 'noip';
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7); // IPv4 (xaritalangan)
  if (!s.includes(':')) return s.slice(0, 64);
  const [head] = s.split('%');
  let parts = head.split('::');
  const left = parts[0] ? parts[0].split(':') : [], right = parts[1] ? parts[1].split(':') : [];
  const full = parts.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

const mins = (ms) => Math.max(1, Math.ceil(ms / 60000));
const tooMany = (ms) => new ApiError(429, `Juda ko'p xato urinish. ${mins(ms)} daqiqadan keyin qayta urinib ko'ring`);

// N-chi eng yangi xatoning vaqti: u oynadan chiqqanda blok tugaydi
async function unlockAt(q, n, span) {
  const row = await q.clone().orderBy('created_at', 'desc').offset(n - 1).first('created_at');
  return row ? row.created_at + span : now() + span;
}

// Kirishdan OLDIN chaqiriladi: bloklangan bo'lsa 429
async function check(userId, ip) {
  const t = now(), key = ipKey(ip), n = maxFails();
  const pair = db('login_fail').where({ user_id: userId, ip: key }).where('created_at', '>', t - WINDOW);
  const c = Number((await pair.clone().count({ c: '*' }).first()).c);
  if (c >= n) throw tooMany((await unlockAt(pair, n, WINDOW)) - t);
  const uh = userHourly();
  if (uh > 0) {
    const all = db('login_fail').where({ user_id: userId }).where('created_at', '>', t - HOUR);
    if (Number((await all.clone().count({ c: '*' }).first()).c) >= uh) throw tooMany((await unlockAt(all, uh, HOUR)) - t);
  }
}

// Noto'g'ri parol: yozib qo'yamiz
async function fail(userId, ip) {
  const t = now();
  await db('login_fail').where('created_at', '<', t - HOUR).del(); // eskilarini tozalash
  await db('login_fail').insert({ user_id: userId, ip: ipKey(ip), created_at: t });
}

// To'g'ri kirish: shu IP ning xatolari tozalanadi
const succeed = (userId, ip) => db('login_fail').where({ user_id: userId, ip: ipKey(ip) }).del();
// Parol tiklanganda/yangilanganda: hamma blok olinadi
const clearUser = (userId) => db('login_fail').where({ user_id: userId }).del();

module.exports = { check, fail, succeed, clearUser, ipKey };

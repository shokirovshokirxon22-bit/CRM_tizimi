const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { sign, auth, adminOnly } = require('../auth');
const { ApiError, h, str, userPhone, phoneForms, randomLoginId, idOf, now } = require('../util');
const otp = require('../otp');

const r = express.Router();
const pub = (u) => ({ id: u.id, name: u.name, phone: u.phone || null, role: u.role, loginId: u.login_id || u.loginId });

const MAX_FAILS = 8, LOCK_MS = 15 * 60 * 1000;
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10); // foydalanuvchi topilmasa ham bir xil vaqt ketsin
const pwOk = (pw) => { if (String(pw || '').length < 6) throw new ApiError(400, "Parol kamida 6 belgi bo'lsin"); return String(pw); };

// Bo'sh 6 xonali ID topamiz (users.login_id unique, shuning uchun poyga bo'lsa ham xatoga tushmaydi)
async function freshLoginId(trx = db) {
  for (let i = 0; i < 30; i++) {
    const id = randomLoginId();
    if (!(await trx('users').where({ login_id: id }).first())) return id;
  }
  throw new ApiError(500, 'ID yaratib bo\'lmadi, qayta urinib ko\'ring');
}
const phoneTaken = async (ph) => !!(await db('users').whereIn('phone', phoneForms(ph)).first());

/* ---------- Ro'yxatdan o'tish: telefon SMS kod bilan tasdiqlanadi ---------- */
r.post('/register/start', h(async (req, res) => {
  const ph = userPhone(req.body.phone);
  if (await phoneTaken(ph)) throw new ApiError(409, 'Bu raqam band');
  await otp.issue(ph, 'register', null, req.ip);
  res.json({ ok: true });
}));

r.post('/register', h(async (req, res) => {
  const shopName = str(req.body.shopName, { req: true, max: 100 });
  const name = str(req.body.name || shopName, { max: 100 });
  const ph = userPhone(req.body.phone);
  const pw = pwOk(req.body.password);
  if (await phoneTaken(ph)) throw new ApiError(409, 'Bu raqam band');
  await otp.check(ph, 'register', req.body.code); // tasdiqlanmagan raqam bilan hisob ochilmaydi
  const hash = await bcrypt.hash(pw, 10);
  const user = await db.transaction(async (trx) => {
    const sid = idOf(await trx('shops').insert({ name: shopName, created_at: now() }).returning('id'));
    const uid = idOf(await trx('users').insert({
      shop_id: sid, phone: ph, phone_verified: true, login_id: await freshLoginId(trx), name, role: 'admin',
      password_hash: hash, active: true, created_at: now(),
    }).returning('id'));
    return trx('users').where({ id: uid }).first();
  });
  res.status(201).json({ token: sign(user), user: pub(user), shop: { id: user.shop_id, name: shopName } });
}));

/* ---------- Kirish: 6 xonali ID + parol (eski hisoblar telefon bilan ham kira oladi) ---------- */
r.post('/login', h(async (req, res) => {
  const raw = String(req.body.id ?? req.body.phone ?? req.body.login ?? '').replace(/\D/g, '');
  let u = null;
  if (raw.length === 6) u = await db('users').where({ login_id: raw }).first();
  else if (raw.length >= 9) u = await db('users').whereIn('phone', phoneForms(raw.length === 9 ? '998' + raw : raw)).first();
  const bad = new ApiError(401, "ID yoki parol noto'g'ri");
  if (u && u.locked_until && u.locked_until > now()) {
    throw new ApiError(429, `Juda ko'p xato urinish. ${Math.ceil((u.locked_until - now()) / 60000)} daqiqadan keyin qayta urinib ko'ring`);
  }
  const match = await bcrypt.compare(String(req.body.password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !u.active || !match) {
    if (u && u.active && !match) {
      const f = (u.failed_logins || 0) + 1;
      await db('users').where({ id: u.id }).update(f >= MAX_FAILS ? { failed_logins: 0, locked_until: now() + LOCK_MS } : { failed_logins: f });
    }
    throw bad;
  }
  if (u.failed_logins || u.locked_until) await db('users').where({ id: u.id }).update({ failed_logins: 0, locked_until: null });
  const shop = await db('shops').where({ id: u.shop_id }).first();
  res.json({ token: sign(u), user: pub(u), shop: { id: shop.id, name: shop.name } });
}));

r.get('/me', auth, h(async (req, res) => {
  const shop = await db('shops').where({ id: req.user.shopId }).first();
  res.json({ user: pub({ ...req.user }), shop: { id: shop.id, name: shop.name } });
}));

/* ---------- Parolni almashtirish (kirgan foydalanuvchi: admin ham, xodim ham) ---------- */
r.post('/password', auth, h(async (req, res) => {
  const u = await db('users').where({ id: req.user.id }).first();
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) throw new ApiError(400, "Joriy parol noto'g'ri");
  const pw = pwOk(req.body.password);
  await db('users').where({ id: u.id }).update({ password_hash: await bcrypt.hash(pw, 10), token_version: db.raw('token_version + 1') });
  // Eski tokenlar bekor bo'ladi, shu qurilma uchun yangisini beramiz
  res.json({ ok: true, token: sign(await db('users').where({ id: u.id }).first()) });
}));

/* ---------- Parolni tiklash (faqat admin, telefonga SMS kod orqali). Xodimniki: admin yangilaydi ---------- */
r.post('/reset/start', h(async (req, res) => {
  try {
    const ph = userPhone(req.body.phone);
    const u = await db('users').where({ role: 'admin', active: true }).whereIn('phone', phoneForms(ph)).first();
    if (u) await otp.issue(ph, 'reset', u.id, req.ip);
  } catch (e) { console.error('[reset/start]', e.message); } // raqam bor-yo'qligi sezilmasligi uchun doim bir xil javob
  res.json({ ok: true });
}));

r.post('/reset/confirm', h(async (req, res) => {
  const ph = userPhone(req.body.phone);
  const pw = pwOk(req.body.password);
  await otp.check(ph, 'reset', req.body.code);
  const u = await db('users').where({ role: 'admin', active: true }).whereIn('phone', phoneForms(ph)).first();
  if (!u) throw new ApiError(400, "Kod noto'g'ri yoki muddati o'tgan");
  await db('users').where({ id: u.id }).update({
    password_hash: await bcrypt.hash(pw, 10), token_version: db.raw('token_version + 1'), failed_logins: 0, locked_until: null, phone_verified: true,
  });
  res.json({ ok: true, loginId: u.login_id }); // ID unutilgan bo'lsa ham shu yerda ko'rsatiladi
}));

/* ---------- Telefon raqamni o'zgartirish (admin): joriy parol + YANGI raqamga SMS kod ---------- */
r.post('/phone/start', auth, adminOnly, h(async (req, res) => {
  const u = await db('users').where({ id: req.user.id }).first();
  if (!(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) throw new ApiError(400, "Parol noto'g'ri");
  const ph = userPhone(req.body.phone);
  if (phoneForms(ph).includes(u.phone)) throw new ApiError(400, 'Bu sizning hozirgi raqamingiz');
  if (await phoneTaken(ph)) throw new ApiError(409, 'Bu raqam band');
  await otp.issue(ph, 'phone', u.id, req.ip);
  res.json({ ok: true });
}));

r.post('/phone/confirm', auth, adminOnly, h(async (req, res) => {
  const ph = userPhone(req.body.phone);
  await otp.check(ph, 'phone', req.body.code, req.user.id);
  if (await phoneTaken(ph)) throw new ApiError(409, 'Bu raqam band');
  await db('users').where({ id: req.user.id }).update({ phone: ph, phone_verified: true });
  res.json({ ok: true, phone: ph });
}));

/* ---------- Hisobni o'chirish (admin): do'kon, xodimlar va barcha ma'lumot butunlay o'chadi ---------- */
r.post('/delete-account', auth, adminOnly, h(async (req, res) => {
  const u = await db('users').where({ id: req.user.id }).first();
  if (!(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) throw new ApiError(400, "Parol noto'g'ri");
  await db.transaction(async (trx) => {
    const ids = (await trx('users').where({ shop_id: u.shop_id }).select('id')).map((x) => x.id);
    await trx('otps').whereIn('user_id', ids).del();
    await trx('shops').where({ id: u.shop_id }).del(); // qolganlari ON DELETE CASCADE bilan o'chadi
  });
  res.json({ ok: true });
}));

module.exports = r;
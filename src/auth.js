const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('./db');
const { ApiError, h } = require('./util');

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (process.env.NODE_ENV === 'production') throw new Error("JWT_SECRET o'rnatilmagan!");
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn("[!] JWT_SECRET yo'q: vaqtinchalik kalit ishlatilmoqda (server qayta yonsa hamma qayta kiradi).");
}

const sign = (u) => jwt.sign({ uid: u.id, v: u.token_version || 0 }, SECRET, { expiresIn: '30d' });
const secret = () => SECRET;

// Foydalanuvchi va shop_id HAR SAFAR bazadan olinadi (tokendagi ma'lumotga ishonilmaydi).
// Shuning uchun o'chirilgan xodim tokeni darrov ishlamay qoladi.
const auth = h(async (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let p;
  try { p = jwt.verify(token, SECRET); } catch { throw new ApiError(401, 'Kirish kerak'); }
  const u = await db('users').where({ id: p.uid }).first();
  if (!u || !u.active) throw new ApiError(401, 'Kirish kerak');
  // Parol almashtirilsa token_version oshadi va oldingi tokenlar ishlamay qoladi (v yo'q eski tokenlar = 0)
  if ((p.v || 0) !== (u.token_version || 0)) throw new ApiError(401, 'Kirish kerak');
  req.user = { id: u.id, shopId: u.shop_id, role: u.role, name: u.name, phone: u.phone, loginId: u.login_id };
  next();
});

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : next(new ApiError(403, 'Faqat admin uchun'));

const superOnly = (req, res, next) => {
  const key = process.env.SUPER_KEY || '';
  const got = String(req.headers['x-super-key'] || '');
  const a = Buffer.from(key), b = Buffer.from(got);
  if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new ApiError(403, "Ruxsat yo'q"));
  next();
};

module.exports = { sign, secret, auth, adminOnly, superOnly };
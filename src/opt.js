// Bir martalik SMS kod: 6 xonali, 5 daqiqa amal qiladi, 5 marta xato kiritish mumkin,
// qayta yuborish 60 soniyada bir marta, soatiga 5 tadan ko'p emas.
const crypto = require('crypto');
const { db } = require('./db');
const { secret } = require('./auth');
const { ApiError, now } = require('./util');
const { sendCode } = require('./sms');

const TTL = 5 * 60 * 1000, COOLDOWN = 60 * 1000, HOURLY = 5, MAX_ATTEMPTS = 5;
const hash = (phone, purpose, code) => crypto.createHmac('sha256', secret()).update(`${phone}|${purpose}|${code}`).digest('hex');

async function issue(phone, purpose, userId = null) {
  const t = now();
  await db('otps').where('expires_at', '<', t - 60 * 60 * 1000).del(); // eski yozuvlarni tozalash
  const recent = await db('otps').where({ phone, purpose }).where('created_at', '>', t - 60 * 60 * 1000).orderBy('created_at', 'desc');
  if (recent[0] && t - recent[0].created_at < COOLDOWN) {
    throw new ApiError(429, `Kodni qayta yuborish uchun ${Math.ceil((COOLDOWN - (t - recent[0].created_at)) / 1000)} soniya kuting`);
  }
  if (recent.length >= HOURLY) throw new ApiError(429, "Juda ko'p urinish. Bir soatdan keyin qayta urinib ko'ring");
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db('otps').where({ phone, purpose }).del(); // faqat eng oxirgi kod amal qiladi
  await db('otps').insert({ phone, purpose, user_id: userId, code_hash: hash(phone, purpose, code), expires_at: t + TTL, created_at: t });
  try { await sendCode(phone, code); } catch (e) { await db('otps').where({ phone, purpose }).del(); throw e; }
}

// To'g'ri bo'lsa true, kod ishlatilgan hisoblanadi (qayta ishlatib bo'lmaydi)
async function check(phone, purpose, code, userId = null) {
  const row = await db('otps').where({ phone, purpose }).first();
  const bad = () => new ApiError(400, "Kod noto'g'ri yoki muddati o'tgan");
  if (!row || row.expires_at < now() || (userId != null && row.user_id !== userId)) throw bad();
  if (row.attempts >= MAX_ATTEMPTS) { await db('otps').where({ id: row.id }).del(); throw bad(); }
  const given = Buffer.from(hash(phone, purpose, String(code || '').replace(/\D/g, '')));
  const real = Buffer.from(row.code_hash);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    await db('otps').where({ id: row.id }).increment('attempts', 1);
    throw bad();
  }
  await db('otps').where({ id: row.id }).del();
  return true;
}

module.exports = { issue, check };
// Bir martalik SMS kod: 6 xonali, 5 daqiqa amal qiladi, 5 marta xato kiritish mumkin.
const crypto = require('crypto');
const { db } = require('./db');
const { secret } = require('./auth');
const { ApiError, idOf, now } = require('./util');
const { sendCode } = require('./sms');

const TTL = 5 * 60 * 1000, COOLDOWN = 60 * 1000, HOURLY = 5, MAX_ATTEMPTS = 5;
const hash = (phone, purpose, code) => crypto.createHmac('sha256', secret()).update(`${phone}|${purpose}|${code}`).digest('hex');

// Limitlar (hammasi bazada, shuning uchun Vercel'da ham ishlaydi). Env o'zgarmaydi: har chaqiruvda o'qiladi.
//  - bir raqamga: shu maqsad uchun 60 soniyada 1 ta; hamma maqsad bo'yicha soatiga HOURLY ta
//  - bir IP dan: 15 daqiqada SMS_RATE_LIMIT ta (default 10)
//  - butun tizim bo'yicha: 24 soatda SMS_DAILY_LIMIT ta (default 300; 0 = cheklovsiz). Eskiz balansi bekorga tugab qolmasligi uchun.
async function issue(phone, purpose, userId = null, ip = null) {
  const t = now();
  const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
  const ipLimit = +process.env.SMS_RATE_LIMIT || 10;
  const dayLimit = process.env.SMS_DAILY_LIMIT === undefined || process.env.SMS_DAILY_LIMIT === '' ? 300 : +process.env.SMS_DAILY_LIMIT;
  await db('sms_log').where('created_at', '<', t - DAY).del(); // eski yozuvlarni tozalash
  await db('otps').where('expires_at', '<', t - HOUR).del();

  // Avval yozib, keyin sanaymiz: bir vaqtda ko'p so'rov kelsa ham ortiqchasi o'tmaydi
  const logId = idOf(await db('sms_log').insert({ phone, ip: ip || null, purpose, created_at: t }).returning('id'));
  const reject = async (err) => { await db('sms_log').where({ id: logId }).del(); throw err; };

  const prev = await db('sms_log').where({ phone, purpose }).whereNot({ id: logId }).orderBy('created_at', 'desc').first();
  if (prev && t - prev.created_at < COOLDOWN) {
    await reject(new ApiError(429, `Kodni qayta yuborish uchun ${Math.ceil((COOLDOWN - (t - prev.created_at)) / 1000)} soniya kuting`));
  }
  const byPhone = Number((await db('sms_log').where({ phone }).where('created_at', '>', t - HOUR).count({ c: '*' }).first()).c);
  if (byPhone > HOURLY) await reject(new ApiError(429, "Juda ko'p urinish. Bir soatdan keyin qayta urinib ko'ring"));
  if (ip) {
    const byIp = Number((await db('sms_log').where({ ip }).where('created_at', '>', t - 15 * 60 * 1000).count({ c: '*' }).first()).c);
    if (byIp > ipLimit) await reject(new ApiError(429, "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring"));
  }
  if (dayLimit > 0) {
    const total = Number((await db('sms_log').where('created_at', '>', t - DAY).count({ c: '*' }).first()).c);
    if (total > dayLimit) {
      console.error(`[SMS] Kunlik limit (${dayLimit}) tugadi. Hujum bo'lishi mumkin yoki limitni oshiring (SMS_DAILY_LIMIT).`);
      await reject(new ApiError(503, "SMS xizmati hozir band. Birozdan keyin qayta urinib ko'ring"));
    }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db('otps').where({ phone, purpose }).del(); // faqat eng oxirgi kod amal qiladi
  await db('otps').insert({ phone, purpose, user_id: userId, code_hash: hash(phone, purpose, code), expires_at: t + TTL, created_at: t });
  // Yuborib bo'lmasa SMS pul turmaydi: jurnaldan ham, kodlardan ham olib tashlaymiz
  try { await sendCode(phone, code); } catch (e) { await db('otps').where({ phone, purpose }).del(); await db('sms_log').where({ id: logId }).del(); throw e; }
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
// Obuna tugashiga 5 va 1 kun qolganda adminga SMS eslatma. Har bir (do'kon, bosqich, tugash sanasi) uchun faqat bir marta yuboriladi.
// Chaqiriladi: Vercel Cron -> GET /api/billing/cron  yoki oddiy serverda har 6 soatda (src/server.js).
// Eslatma: SMS matni Eskiz'da oldindan tasdiqlangan shablonga mos bo'lishi kerak (REMIND_SMS_TEMPLATE). O'chirish: REMIND_SMS=0.
const { db } = require('./db');
const billing = require('./billing');
const { sendSms } = require('./sms');
const { now, userPhone } = require('./util');

const template = () => process.env.REMIND_SMS_TEMPLATE || "Mizan: obunangiz {days} kundan keyin tugaydi. Uzilishsiz ishlash uchun ilovada Profil > Tarif bo'limidan to'lang.";

async function run() {
  const t = now();
  let sent = 0;
  if (process.env.REMIND_SMS !== '0') {
    const shops = await db('shops').where({ lifetime: false }).where('sub_until', '>', t).where('sub_until', '<=', t + 5 * billing.DAY).select('id', 'sub_until', 'plan');
    for (const s of shops) {
      const st = billing.statusOf(s, t);
      if (!st.remind) continue;
      const key = { shop_id: s.id, level: st.remind, for_until: s.sub_until };
      if (await db('sub_reminders').where(key).first()) continue;
      const admin = await db('users').where({ shop_id: s.id, role: 'admin', active: true }).whereNotNull('phone').first();
      if (!admin) continue;
      try { await db('sub_reminders').insert({ ...key, sent_at: t }); } catch { continue; } // boshqa jarayon allaqachon oldi
      try { await sendSms(userPhone(admin.phone), template().replace('{days}', st.daysLeft)); sent++; }
      catch (e) { console.error('[reminder]', e.message); await db('sub_reminders').where(key).del(); } // keyingi safar qayta uriniladi
    }
  }
  // Hech qachon to'lanmagan eski buyurtmalarni tozalash (Payme tranzaksiyasi bor buyurtmalarga tegilmaydi)
  const cleaned = await db('orders').where({ state: 'new' }).where('created_at', '<', t - 7 * billing.DAY).whereNotIn('id', db('payme_tx').select('order_id')).del();
  return { sent, cleaned };
}

// Oddiy (Vercel bo'lmagan) serverda vaqti-vaqti bilan ishga tushirish
function schedule() {
  if (process.env.VERCEL || process.env.NODE_ENV === 'test') return;
  const tick = () => run().catch((e) => console.error('[reminder]', e.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 6 * 60 * 60 * 1000).unref();
}

module.exports = { run, schedule };

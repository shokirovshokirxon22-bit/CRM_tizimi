// Faoliyat tarixi yozuvi. Muhim: tarix yozilmay qolsa ham asosiy amal (sotuv, tahrir) to'xtamasligi kerak,
// shuning uchun xato bo'lsa faqat logga yoziladi. Parol, token va to'liq telefon raqam bu yerga berilmaydi.
const { db } = require('./db');
const { now } = require('./util');

const RETENTION_DAYS = () => (process.env.AUDIT_RETENTION_DAYS === undefined || process.env.AUDIT_RETENTION_DAYS === '' ? 365 : +process.env.AUDIT_RETENTION_DAYS);

// req.user dan kontekst: kim va qaysi IP dan
const who = (req) => ({ shopId: req.user.shopId, userId: req.user.id, userName: req.user.name, ip: req.ip });

/* audit(who(req), { action, entity, entityId, summary, data }) */
async function audit(ctx, { action, entity, entityId = null, summary, data = null }) {
  try {
    await db('audit_log').insert({
      shop_id: ctx.shopId, user_id: ctx.userId || null, user_name: String(ctx.userName || '').slice(0, 100) || null,
      action, entity, entity_id: entityId, summary: String(summary).slice(0, 300),
      data: data ? JSON.stringify(data).slice(0, 4000) : null, ip: ctx.ip ? String(ctx.ip).slice(0, 64) : null, created_at: now(),
    });
    const days = RETENTION_DAYS();
    if (days > 0 && Math.random() < 0.01) await db('audit_log').where('created_at', '<', now() - days * 86400000).del();
  } catch (e) { console.error('[audit]', e.message); }
}

// Ikki obyektni solishtirib, o'zgargan maydonlarni qaytaradi: { cost: [1000, 1200] }
function changes(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before[f] === undefined ? null : before[f], b = after[f] === undefined ? null : after[f];
    if (a !== b && !(a === null && b === '') && !(a === '' && b === null)) out[f] = [a, b];
  }
  return out;
}

// "5 → 3, 1000 → 1200" ko'rinishida qisqa matn
const fmtChanges = (ch, labels) => Object.entries(ch).map(([k, [a, b]]) => `${labels[k] || k}: ${a === null ? '—' : a} → ${b === null ? '—' : b}`).join(', ');

const maskPhone = (p) => { const s = String(p || '').replace(/\D/g, ''); return s.length > 4 ? '+' + s.slice(0, 3) + ' ** *** ** ' + s.slice(-2) : '***'; };

module.exports = { audit, who, changes, fmtChanges, maskPhone };

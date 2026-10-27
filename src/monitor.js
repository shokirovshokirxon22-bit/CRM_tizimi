// Xatolarni kuzatish (Sentry). SENTRY_DSN bo'lmasa hech narsa qilmaydi (o'chiq).
// Maxfiylik: Sentry'ga telefon raqam, parol, token, so'rov tanasi va sarlavhalar YUBORILMAYDI.
// Faqat xato matni (raqamlar yashirilgan), stack va ichki raqamli ID (foydalanuvchi/do'kon) ketadi.
let S = null;

const SECRET_RE = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [yashirin]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[token]'],      // JWT
  [/\+?\d[\d\s().-]{6,}\d/g, '[raqam]'],                                       // telefon va uzun raqamlar
  [/("?(?:password|parol|token|code|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[yashirin]'],
];
const clean = (s) => { let t = String(s == null ? '' : s); for (const [re, to] of SECRET_RE) t = t.replace(re, to); return t; };

// Sentry yuborishdan oldin hodisani tozalaydi
function scrub(event) {
  if (event.request) { delete event.request.headers; delete event.request.cookies; delete event.request.data; delete event.request.query_string; if (event.request.url) event.request.url = clean(event.request.url.split('?')[0]); }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  if (event.message) event.message = clean(event.message);
  for (const ex of (event.exception && event.exception.values) || []) if (ex.value) ex.value = clean(ex.value);
  if (event.breadcrumbs) {
    const list = Array.isArray(event.breadcrumbs) ? event.breadcrumbs : event.breadcrumbs.values || [];
    event.breadcrumbs = list.map((b) => ({ ...b, message: b.message ? clean(b.message) : b.message, data: undefined }));
  }
  if (event.extra) for (const k of Object.keys(event.extra)) if (typeof event.extra[k] === 'string') event.extra[k] = clean(event.extra[k]);
  return event;
}

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || S) return;
  try {
    S = require('@sentry/node');
    S.init({
      dsn, environment: process.env.SENTRY_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      sendDefaultPii: false, tracesSampleRate: 0, skipOpenTelemetrySetup: true,
      // Tozalashda xato bo'lsa hodisa YUBORILMAYDI (tozalanmagan ma'lumot ketib qolmasin)
      beforeSend: (e) => { try { return scrub(e); } catch (err) { console.error('[sentry] tozalab bo\'lmadi:', err.message); return null; } },
    });
  } catch (e) { console.error('[sentry] ishga tushmadi:', e.message); S = null; }
}

// ctx: { userId, shopId } (ixtiyoriy). Faqat ichki raqamlar.
function capture(err, ctx, extra) {
  if (!S) return;
  try {
    S.withScope((scope) => {
      if (ctx && ctx.id) scope.setUser({ id: String(ctx.id) });
      if (ctx && ctx.shopId) scope.setTag('shop', String(ctx.shopId));
      if (extra) scope.setExtras(extra);
      S.captureException(err instanceof Error ? err : new Error(clean(err)));
    });
  } catch (e) { console.error('[sentry]', e.message); }
}

// Vercel'da javobdan keyin funksiya to'xtaydi: yuborilishini kutamiz (ko'pi bilan 2 soniya)
const flush = async () => { if (S) { try { await S.flush(2000); } catch { /* e'tiborsiz */ } } };
const enabled = () => !!S;

module.exports = { init, capture, flush, enabled, scrub, clean };

const crypto = require('crypto');
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const num = (v, { min = -Infinity, max = 1e15, def } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, "Noto'g'ri son");
  return n;
};
const str = (v, { max = 200, req = false } = {}) => {
  const s = String(v ?? '').trim();
  if (req && !s) throw new ApiError(400, "Majburiy maydon bo'sh");
  return s.slice(0, max);
};
const phone = (v) => {
  const p = String(v || '').replace(/\D/g, '');
  if (p.length < 9 || p.length > 15) throw new ApiError(400, 'Telefon raqam xato');
  return p;
};
// Foydalanuvchi telefoni: faqat raqamlar; 9 xonali (90 123 45 67) bo'lsa 998 qo'shiladi, shunda bitta raqam bitta ko'rinishda saqlanadi
const userPhone = (v) => {
  let p = String(v || '').replace(/\D/g, '');
  if (p.length === 9) p = '998' + p;
  if (p.length < 10 || p.length > 15) throw new ApiError(400, 'Telefon raqam xato');
  return p;
};
// Eski hisoblarda telefon 9 xonali holatda saqlangan bo'lishi mumkin: ikkala ko'rinishda qidiramiz
const phoneForms = (p) => (p.startsWith('998') && p.length === 12 ? [p, p.slice(3)] : [p]);
// 6 xonali ID (100000-999999). Takrorlanmasligi uchun users.login_id da unique indeks bor.
const randomLoginId = () => String(crypto.randomInt(100000, 1000000));
// Parol: o'xshash belgilarsiz (0/O, 1/l/I yo'q), 8 belgi
const randomPassword = (n = 8) => {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; for (let i = 0; i < n; i++) s += A[crypto.randomInt(0, A.length)];
  return s;
};
// insert().returning('id') SQLite va Postgres'da turlicha qaytaradi
const idOf = (r) => { const x = Array.isArray(r) ? r[0] : r; return x && typeof x === 'object' ? x.id : x; };
const now = () => Date.now();
module.exports = { ApiError, h, num, str, phone, userPhone, phoneForms, randomLoginId, randomPassword, idOf, now };
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
// insert().returning('id') SQLite va Postgres'da turlicha qaytaradi
const idOf = (r) => { const x = Array.isArray(r) ? r[0] : r; return x && typeof x === 'object' ? x.id : x; };
const now = () => Date.now();
module.exports = { ApiError, h, num, str, phone, idOf, now };

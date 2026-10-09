const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { sign, auth } = require('../auth');
const { ApiError, h, str, phone, idOf, now } = require('../util');

const r = express.Router();
const pub = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role });

// Yangi biznes egasi: yangi do'kon + admin yaratiladi. Har bir do'kon alohida.
r.post('/register', h(async (req, res) => {
  const shopName = str(req.body.shopName, { req: true, max: 100 });
  const name = str(req.body.name || shopName, { max: 100 });
  const ph = phone(req.body.phone);
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw new ApiError(400, 'Parol kamida 6 belgi bo\'lsin');
  if (await db('users').where({ phone: ph }).first()) throw new ApiError(409, 'Bu raqam band');
  const hash = await bcrypt.hash(pw, 10);
  const user = await db.transaction(async (trx) => {
    const sid = idOf(await trx('shops').insert({ name: shopName, created_at: now() }).returning('id'));
    const uid = idOf(await trx('users').insert({
      shop_id: sid, phone: ph, name, role: 'admin', password_hash: hash, active: true, created_at: now(),
    }).returning('id'));
    return trx('users').where({ id: uid }).first();
  });
  res.status(201).json({ token: sign(user), user: pub(user), shop: { id: user.shop_id, name: shopName } });
}));

// Admin ham, xodim ham shu yerdan kiradi; qaysi do'konga tegishliligi bazadan aniqlanadi.
r.post('/login', h(async (req, res) => {
  const u = await db('users').where({ phone: String(req.body.phone || '').replace(/\D/g, '') }).first();
  const ok = u && u.active && (await bcrypt.compare(String(req.body.password || ''), u.password_hash));
  if (!ok) throw new ApiError(401, "Raqam yoki parol noto'g'ri");
  const shop = await db('shops').where({ id: u.shop_id }).first();
  res.json({ token: sign(u), user: pub(u), shop: { id: shop.id, name: shop.name } });
}));

r.get('/me', auth, h(async (req, res) => {
  const shop = await db('shops').where({ id: req.user.shopId }).first();
  res.json({ user: pub({ ...req.user }), shop: { id: shop.id, name: shop.name } });
}));

r.post('/password', auth, h(async (req, res) => {
  const u = await db('users').where({ id: req.user.id }).first();
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash))) throw new ApiError(400, "Joriy parol noto'g'ri");
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw new ApiError(400, "Parol kamida 6 belgi bo'lsin");
  await db('users').where({ id: u.id }).update({ password_hash: await bcrypt.hash(pw, 10) });
  res.json({ ok: true });
}));

module.exports = r;

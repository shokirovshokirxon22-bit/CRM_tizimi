const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { ApiError, h, str, phone, idOf, now } = require('../util');

// Faqat admin (app.js da adminOnly bilan ulangan). Hamma so'rov req.user.shopId bilan cheklanadi.
const r = express.Router();
const view = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, active: !!u.active, createdAt: u.created_at });

r.get('/', h(async (req, res) => {
  res.json(await db('users').where({ shop_id: req.user.shopId }).orderBy('id').then((a) => a.map(view)));
}));

// Admin xodimga login (telefon) va parol ochib beradi
r.post('/', h(async (req, res) => {
  const name = str(req.body.name, { req: true, max: 100 });
  const ph = phone(req.body.phone);
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw new ApiError(400, "Parol kamida 6 belgi bo'lsin");
  if (await db('users').where({ phone: ph }).first()) throw new ApiError(409, 'Bu raqam band');
  const id = idOf(await db('users').insert({
    shop_id: req.user.shopId, phone: ph, name, role: 'seller',
    password_hash: await bcrypt.hash(pw, 10), active: true, created_at: now(),
  }).returning('id'));
  res.status(201).json(view(await db('users').where({ id }).first()));
}));

r.patch('/:id', h(async (req, res) => {
  const u = await db('users').where({ id: +req.params.id, shop_id: req.user.shopId, role: 'seller' }).first();
  if (!u) throw new ApiError(404, 'Xodim topilmadi');
  const upd = {};
  if (req.body.name !== undefined) upd.name = str(req.body.name, { req: true, max: 100 });
  if (req.body.active !== undefined) upd.active = !!req.body.active;
  if (req.body.password !== undefined) {
    const pw = String(req.body.password);
    if (pw.length < 6) throw new ApiError(400, "Parol kamida 6 belgi bo'lsin");
    upd.password_hash = await bcrypt.hash(pw, 10);
  }
  if (Object.keys(upd).length) await db('users').where({ id: u.id }).update(upd);
  res.json(view(await db('users').where({ id: u.id }).first()));
}));

module.exports = r;

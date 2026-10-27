const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { ApiError, h, str, randomLoginId, randomPassword, idOf, now } = require('../util');
const lockout = require('../lockout');
const { audit, who } = require('../audit');

// Faqat admin (app.js da adminOnly bilan ulangan). Hamma so'rov req.user.shopId bilan cheklanadi.
const r = express.Router();
const view = (u) => ({ id: u.id, name: u.name, loginId: u.login_id, phone: u.phone || null, role: u.role, active: !!u.active, createdAt: u.created_at });

async function freshLoginId() {
  for (let i = 0; i < 30; i++) {
    const id = randomLoginId();
    if (!(await db('users').where({ login_id: id }).first())) return id;
  }
  throw new ApiError(500, "ID yaratib bo'lmadi, qayta urinib ko'ring");
}

r.get('/', h(async (req, res) => {
  res.json(await db('users').where({ shop_id: req.user.shopId }).orderBy('id').then((a) => a.map(view)));
}));

// Admin faqat ism kiritadi. Tizim 6 xonali ID va vaqtinchalik parol beradi; parol faqat shu javobda ko'rinadi.
// Xodim kirgach parolni o'zi o'zgartira oladi (Profil -> Xavfsizlik).
r.post('/', h(async (req, res) => {
  const name = str(req.body.name, { req: true, max: 100 });
  const pw = randomPassword();
  const hash = await bcrypt.hash(pw, 10);
  let id;
  for (let i = 0; i < 5 && !id; i++) { // ID poygasi (unique) bo'lsa qayta uriniladi
    try {
      id = idOf(await db('users').insert({
        shop_id: req.user.shopId, login_id: await freshLoginId(), phone: null, name, role: 'seller',
        password_hash: hash, active: true, created_at: now(),
      }).returning('id'));
    } catch (e) { if (!(e.code === '23505' || /UNIQUE constraint/i.test(e.message || ''))) throw e; }
  }
  if (!id) throw new ApiError(500, "ID yaratib bo'lmadi, qayta urinib ko'ring");
  const created = await db('users').where({ id }).first();
  await audit(who(req), { action: 'staff.create', entity: 'staff', entityId: id, summary: `Xodim qo'shildi: ${name} (ID ${created.login_id})` });
  res.status(201).json({ ...view(await db('users').where({ id }).first()), password: pw });
}));

r.patch('/:id', h(async (req, res) => {
  const u = await db('users').where({ id: +req.params.id, shop_id: req.user.shopId, role: 'seller' }).first();
  if (!u) throw new ApiError(404, 'Xodim topilmadi');
  const upd = {}; let newPw;
  if (req.body.name !== undefined) upd.name = str(req.body.name, { req: true, max: 100 });
  if (req.body.active !== undefined) upd.active = !!req.body.active;
  if (req.body.resetPassword) newPw = randomPassword(); // yangi vaqtinchalik parol (xodim parolini unutsa)
  else if (req.body.password !== undefined) {
    newPw = String(req.body.password);
    if (newPw.length < 6) throw new ApiError(400, "Parol kamida 6 belgi bo'lsin");
  }
  if (newPw) Object.assign(upd, { password_hash: await bcrypt.hash(newPw, 10), token_version: db.raw('token_version + 1'), failed_logins: 0, locked_until: null });
  if (Object.keys(upd).length) await db('users').where({ id: u.id }).update(upd);
  if (newPw) await lockout.clearUser(u.id);
  const parts = [];
  if (upd.name !== undefined && upd.name !== u.name) parts.push(`ism: ${u.name} → ${upd.name}`);
  if (upd.active !== undefined && !!upd.active !== !!u.active) parts.push(upd.active ? 'qayta faollashtirildi' : "o'chirildi (kira olmaydi)");
  if (newPw) parts.push(req.body.resetPassword ? 'yangi vaqtinchalik parol berildi' : "parol o'zgartirildi");
  if (parts.length) await audit(who(req), { action: 'staff.update', entity: 'staff', entityId: u.id, summary: `Xodim ${u.name}: ${parts.join(', ')}` });
  const out = view(await db('users').where({ id: u.id }).first());
  res.json(req.body.resetPassword ? { ...out, password: newPw } : out);
}));

module.exports = r;
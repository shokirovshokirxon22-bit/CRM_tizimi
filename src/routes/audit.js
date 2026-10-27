const express = require('express');
const { db } = require('../db');
const { h, num, str } = require('../util');

// Faqat admin (app.js da adminOnly bilan ulangan). Faqat o'qiladi: tarixni API orqali o'zgartirib yoki o'chirib bo'lmaydi.
const r = express.Router();
const ENTITIES = ['product', 'sale', 'debt', 'expense', 'settings', 'staff', 'auth'];
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// GET /api/audit?limit=50&before=<id>&entity=product&userId=3
r.get('/', h(async (req, res) => {
  const q = db('audit_log').where({ shop_id: req.user.shopId }).orderBy('id', 'desc').limit(Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 50)));
  const before = num(req.query.before, { min: 1 });
  if (before !== undefined) q.where('id', '<', before);
  const ent = str(req.query.entity, { max: 20 });
  if (ent && ENTITIES.includes(ent)) q.where({ entity: ent });
  const uid = num(req.query.userId, { min: 1 });
  if (uid !== undefined) q.where({ user_id: uid });
  res.json((await q).map((a) => ({
    id: a.id, userId: a.user_id, userName: a.user_name || '', action: a.action, entity: a.entity, entityId: a.entity_id,
    summary: a.summary, data: parse(a.data), createdAt: a.created_at,
  })));
}));

module.exports = r;

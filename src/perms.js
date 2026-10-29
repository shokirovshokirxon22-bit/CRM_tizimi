const { db } = require('./db');

/* Foydalanuvchining samarali huquqlari. Admin: hammasi. Sotuvchi: do'kon belgisi (hamma sotuvchiga) YOKI o'zining belgisi. */
async function perms(user) {
  if (user.role === 'admin') return { price: true, debts: true };
  const [shop, u] = await Promise.all([
    db('shops').where({ id: user.shopId }).first(),
    db('users').where({ id: user.id }).first(),
  ]);
  return {
    price: !!(shop && shop.seller_edit_price) || !!(u && u.perm_price),
    debts: !!(shop && shop.seller_see_debts) || !!(u && u.perm_debts),
  };
}
module.exports = { perms };

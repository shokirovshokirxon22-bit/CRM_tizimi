const { db } = require('./db');

/* Foydalanuvchining samarali huquqlari. Admin: hammasi. edit = mahsulotlarni tahrirlash, add = mahsulot kiritish (Kiritish bo'limi). Sotuvchi: do'kon belgisi (hamma sotuvchiga) YOKI o'zining belgisi. */
async function perms(user) {
  if (user.role === 'admin') return { price: true, debts: true, edit: true, add: true };
  const [shop, u] = await Promise.all([
    db('shops').where({ id: user.shopId }).first(),
    db('users').where({ id: user.id }).first(),
  ]);
  const edit = !!(u && u.perm_edit), add = !!(u && u.perm_add);
  return {
    // Mahsulotni tahrirlash huquqi sotish narxini o'zgartirishni ham o'z ichiga oladi
    price: !!(shop && shop.seller_edit_price) || edit,
    edit,
    add,
    debts: !!(shop && shop.seller_see_debts) || !!(u && u.perm_debts),
  };
}
module.exports = { perms };

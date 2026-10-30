// Xodim huquqlari: "narxni o'zgartirish" o'rniga "mahsulotlarni tahrirlash" va "mahsulot kiritish".
// Eski perm_price belgisi bor xodimlar perm_edit ga o'tkaziladi (tahrirlash narxni ham o'z ichiga oladi).
exports.up = async (k) => {
  if (await k.schema.hasColumn('users', 'perm_edit')) return;
  await k.schema.alterTable('users', (t) => {
    t.boolean('perm_edit').notNullable().defaultTo(false);
    t.boolean('perm_add').notNullable().defaultTo(false);
  });
  await k('users').where({ perm_price: true }).update({ perm_edit: true });
};

exports.down = async (k) => {
  await k.schema.alterTable('users', (t) => { t.dropColumn('perm_edit'); t.dropColumn('perm_add'); });
};

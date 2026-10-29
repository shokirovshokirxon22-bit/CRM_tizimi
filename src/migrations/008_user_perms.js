// Har bir sotuvchiga alohida huquq: narxni o'zgartirish va qarzdorlarni ko'rish.
// Samarali huquq = do'kon darajasidagi "barcha sotuvchilar" belgisi YOKI shu sotuvchining o'z belgisi.
exports.up = async (k) => {
  if (await k.schema.hasColumn('users', 'perm_price')) return;
  await k.schema.alterTable('users', (t) => {
    t.boolean('perm_price').notNullable().defaultTo(false);
    t.boolean('perm_debts').notNullable().defaultTo(false);
  });
};

exports.down = async (k) => {
  await k.schema.alterTable('users', (t) => { t.dropColumn('perm_price'); t.dropColumn('perm_debts'); });
};

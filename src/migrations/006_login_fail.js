// Kirishdagi xato urinishlar jurnali. Bloklash endi (foydalanuvchi + IP) juftligi bo'yicha:
// begona odam birovning ID sini terib, uni kirishdan to'sa olmaydi (faqat o'zining IP si bloklanadi).
// Hisoblash bazada (Vercel'da xotira saqlanmaydi). Eski users.failed_logins / locked_until ustunlari qoladi, lekin ishlatilmaydi.
exports.up = async (k) => {
  if (await k.schema.hasTable('login_fail')) return;
  await k.schema.createTable('login_fail', (t) => {
    t.increments('id');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('ip', 64).notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['user_id', 'ip', 'created_at']);
    t.index(['user_id', 'created_at']);
    t.index('created_at');
  });
};

exports.down = async (k) => {
  await k.schema.dropTableIfExists('login_fail');
};

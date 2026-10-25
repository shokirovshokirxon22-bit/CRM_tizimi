// SMS yuborish jurnali: limitlarni (raqam, IP, kunlik umumiy) bazada hisoblash uchun.
// Xotiradagi hisoblagich Vercel'da (har so'rov alohida nusxada) ishonchsiz, shuning uchun baza ishlatiladi.
exports.up = async (k) => {
  if (await k.schema.hasTable('sms_log')) return;
  await k.schema.createTable('sms_log', (t) => {
    t.increments('id');
    t.string('phone').notNullable();
    t.string('ip');
    t.string('purpose').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['phone', 'created_at']);
    t.index(['ip', 'created_at']);
    t.index('created_at');
  });
};

exports.down = async (k) => {
  await k.schema.dropTableIfExists('sms_log');
};

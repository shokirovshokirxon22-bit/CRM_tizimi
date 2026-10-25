// Sotuvni bekor qilish: sotuv o'chirilmaydi, "bekor qilingan" deb belgilanadi (kim va qachon qilgani saqlanadi).
exports.up = async (k) => {
  await k.schema.alterTable('sales', (t) => {
    t.bigInteger('voided_at');
    t.integer('voided_by');
    t.string('void_reason');
  });
};

exports.down = async (k) => {
  await k.schema.alterTable('sales', (t) => {
    t.dropColumn('void_reason');
    t.dropColumn('voided_by');
    t.dropColumn('voided_at');
  });
};

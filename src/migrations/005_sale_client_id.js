// Oflayn sotuv: qurilma har bir sotuvga o'zi noyob ID (client_id) beradi.
// Internet qaytib, sotuv serverga yuborilganda (yoki javob yo'lda yo'qolib, qayta yuborilganda)
// shu ID bo'yicha sotuv ikki marta yozilmaydi. NULL lar to'qnashmaydi (eski sotuvlarda client_id yo'q).
exports.up = async (k) => {
  await k.schema.alterTable('sales', (t) => {
    t.string('client_id', 64);
    t.boolean('offline').notNullable().defaultTo(false); // internet yo'qligida sotilgan (keyin yuklangan)
    t.unique(['shop_id', 'client_id'], { indexName: 'sales_shop_client_uq' });
  });
};

exports.down = async (k) => {
  await k.schema.alterTable('sales', (t) => {
    t.dropUnique(['shop_id', 'client_id'], 'sales_shop_client_uq');
    t.dropColumn('offline');
    t.dropColumn('client_id');
  });
};

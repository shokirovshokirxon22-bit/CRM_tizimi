// Faoliyat tarixi: kim, qachon, nima qildi (mahsulot, narx, qoldiq, sotuvni bekor qilish, qarz, xarajat, sozlama, xodim).
// Jadval faqat yoziladi va o'qiladi: API orqali o'zgartirib yoki o'chirib bo'lmaydi. Do'kon o'chsa (hisob o'chirilsa) birga o'chadi.
exports.up = async (k) => {
  if (await k.schema.hasTable('audit_log')) return;
  await k.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.integer('user_id');                 // kim (xodim keyin o'chsa ham yozuv qoladi)
    t.string('user_name', 100);           // o'sha paytdagi ismi
    t.string('action', 40).notNullable(); // masalan: product.update, sale.void
    t.string('entity', 20).notNullable(); // product | sale | debt | expense | settings | staff | auth
    t.integer('entity_id');
    t.string('summary', 300).notNullable();
    t.text('data');                       // JSON: avvalgi/yangi qiymatlar (parol va tokenlar HECH QACHON yozilmaydi)
    t.string('ip', 64);
    t.bigInteger('created_at').notNullable();
    t.index(['shop_id', 'id']);
    t.index(['shop_id', 'entity', 'id']);
    t.index('created_at');
  });
};

exports.down = async (k) => {
  await k.schema.dropTableIfExists('audit_log');
};

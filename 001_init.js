exports.up = async (k) => {
  await k.schema.createTable('shops', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.boolean('seller_edit_price').notNullable().defaultTo(false);
    t.boolean('seller_see_debts').notNullable().defaultTo(true);
    t.text('settings'); // JSON: lang, sms, days, tpl
    t.bigInteger('created_at').notNullable();
  });
  await k.schema.createTable('users', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.string('phone').notNullable().unique();
    t.string('name').notNullable();
    t.string('role').notNullable(); // admin | seller
    t.string('password_hash').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.bigInteger('created_at').notNullable();
    t.index('shop_id');
  });
  await k.schema.createTable('products', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('unit').notNullable(); // m | dona | kg
    t.double('cost').notNullable();
    t.double('pct').notNullable().defaultTo(0);
    t.double('qty').notNullable().defaultTo(0);
    t.double('min').notNullable().defaultTo(0);
    t.double('width').notNullable().defaultTo(0);
    t.string('barcode');
    t.bigInteger('created_at').notNullable();
    t.index('shop_id');
    t.unique(['shop_id', 'barcode']);
  });
  await k.schema.createTable('sales', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.integer('seller_id').notNullable();
    t.string('customer').notNullable();
    t.double('total').notNullable();
    t.double('paid').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['shop_id', 'created_at']);
  });
  await k.schema.createTable('sale_items', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable();
    t.integer('sale_id').notNullable().references('id').inTable('sales').onDelete('CASCADE');
    t.integer('product_id'); // FK yo'q: mahsulot o'chirilsa ham sotuv tarixi qoladi
    t.string('name').notNullable();
    t.string('unit').notNullable();
    t.double('qty').notNullable();
    t.double('price').notNullable();
    t.double('cost').notNullable();
    t.index('sale_id');
    t.index('shop_id');
  });
  await k.schema.createTable('debts', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.integer('sale_id');
    t.string('name').notNullable();
    t.string('phone');
    t.double('total').notNullable();
    t.double('amount').notNullable(); // qolgan qarz
    t.string('due'); // YYYY-MM-DD
    t.string('note');
    t.boolean('paid').notNullable().defaultTo(false);
    t.bigInteger('created_at').notNullable();
    t.index('shop_id');
  });
  await k.schema.createTable('payments', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable();
    t.integer('debt_id').notNullable().references('id').inTable('debts').onDelete('CASCADE');
    t.double('amount').notNullable();
    t.integer('created_by');
    t.bigInteger('created_at').notNullable();
  });
  await k.schema.createTable('expenses', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.string('name').notNullable();
    t.double('amount').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index('shop_id');
  });
  await k.schema.createTable('buys', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.string('name').notNullable();
    t.double('amount').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index('shop_id');
  });
  await k.schema.createTable('ads', (t) => {
    t.increments('id');
    t.string('placement').notNullable().defaultTo('home'); // home | sales | ...
    t.string('title').notNullable();
    t.text('body');
    t.text('image_url');
    t.text('link');
    t.boolean('active').notNullable().defaultTo(true);
    t.bigInteger('created_at').notNullable();
  });
};

exports.down = async (k) => {
  for (const t of ['ads', 'buys', 'expenses', 'payments', 'debts', 'sale_items', 'sales', 'products', 'users', 'shops']) {
    await k.schema.dropTableIfExists(t);
  }
};

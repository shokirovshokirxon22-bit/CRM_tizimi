// Pullik tizim: tariflar, buyurtmalar (to'lovlar), Payme tranzaksiyalari, eslatmalar, sinov muddati himoyasi.
// Obuna holati do'konda saqlanadi (shops.sub_until, server vaqti bilan), shuning uchun adminning xodimlari ham unga bo'ysunadi.
const DAY = 86400000;

exports.up = async (k) => {
  if (await k.schema.hasTable('plans')) return;

  await k.schema.alterTable('shops', (t) => {
    t.bigInteger('sub_until');                              // obuna tugash vaqti (ms, server vaqti)
    t.string('plan', 20).notNullable().defaultTo('trial');  // joriy tarif kodi
    t.boolean('lifetime').notNullable().defaultTo(false);   // umrbod tarif
  });

  await k.schema.createTable('plans', (t) => {
    t.string('code', 20).primary();
    t.string('name', 60).notNullable();
    t.string('kind', 10).notNullable();                     // trial | period | lifetime
    t.integer('days').notNullable().defaultTo(0);
    t.bigInteger('price').notNullable().defaultTo(0);       // so'mda
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('max_slots');                                 // faqat umrbod: jami nechta sotilishi mumkin
    t.integer('sort').notNullable().defaultTo(0);
  });
  await k('plans').insert([
    { code: 'trial', name: 'Sinov muddati', kind: 'trial', days: 30, price: 0, active: true, max_slots: null, sort: 0 },
    { code: 'm1', name: '1 oy', kind: 'period', days: 30, price: 99000, active: true, max_slots: null, sort: 1 },
    { code: 'm3', name: '3 oy', kind: 'period', days: 90, price: 249000, active: true, max_slots: null, sort: 2 },
    { code: 'life', name: 'Umrbod', kind: 'lifetime', days: 0, price: 1490000, active: true, max_slots: 3, sort: 3 },
  ]);

  // Buyurtma = bitta to'lov urinishi. Narx va kunlar buyurtma ochilgan paytdagidek saqlanadi (keyin tarif narxi o'zgarsa ham buzilmaydi).
  // shop_id ataylab FK emas: hisob o'chirilsa ham to'lov yozuvi (hisob-kitob uchun) qoladi.
  await k.schema.createTable('orders', (t) => {
    t.increments('id');
    t.integer('shop_id').notNullable().index();
    t.string('shop_name', 100);
    t.string('plan_code', 20).notNullable();
    t.string('kind', 10).notNullable();
    t.integer('days').notNullable().defaultTo(0);
    t.bigInteger('amount').notNullable();                   // so'm
    t.string('provider', 10).notNullable();                 // payme | click | manual
    t.string('state', 10).notNullable().defaultTo('new');   // new | paid | refunded
    t.string('provider_tx', 40);                            // Click: click_trans_id
    t.bigInteger('reserved_until');                         // umrbod tarif uchun joy ushlab turish
    t.bigInteger('granted_ms');                             // qancha vaqt qo'shilgan (qaytarishda ayiriladi)
    t.string('prev_plan', 20);
    t.integer('created_by');
    t.string('note', 200);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('paid_at');
    t.index(['kind', 'state']);
  });

  await k.schema.createTable('payme_tx', (t) => {
    t.increments('id');
    t.string('payme_id', 40).notNullable().unique();
    t.integer('order_id').notNullable().index();
    t.bigInteger('amount').notNullable();                   // tiyin
    t.bigInteger('time').notNullable();                     // Payme bergan vaqt
    t.integer('state').notNullable();                       // 1 | 2 | -1 | -2
    t.bigInteger('create_time').notNullable();
    t.bigInteger('perform_time');
    t.bigInteger('cancel_time');
    t.integer('reason');
  });

  await k.schema.createTable('sub_reminders', (t) => {
    t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
    t.integer('level').notNullable();                       // 5 yoki 1 (kun)
    t.bigInteger('for_until').notNullable();                // qaysi tugash sanasi uchun
    t.bigInteger('sent_at').notNullable();
    t.unique(['shop_id', 'level', 'for_until']);
  });

  // Hisobni o'chirib qayta ro'yxatdan o'tib, sinov muddatini takror olishning oldini olish (raqamning HMAC xeshi)
  await k.schema.createTable('trial_phones', (t) => {
    t.string('phone_hash', 64).primary();
    t.bigInteger('created_at').notNullable();
  });

  // Mavjud do'konlarga bir martalik sinov muddati: migratsiya paytidan boshlab
  await k('shops').update({ sub_until: Date.now() + 30 * DAY, plan: 'trial' });
};

exports.down = async (k) => {
  for (const t of ['trial_phones', 'sub_reminders', 'payme_tx', 'orders', 'plans']) await k.schema.dropTableIfExists(t);
  await k.schema.alterTable('shops', (t) => { t.dropColumn('sub_until'); t.dropColumn('plan'); t.dropColumn('lifetime'); });
};

// 002: 6 xonali login ID, telefon tasdiqlash (OTP), brute-force himoyasi, parol o'zgarganda eski tokenlarni bekor qilish (token_version).
const crypto = require('crypto');

const newId = () => String(crypto.randomInt(100000, 1000000));

exports.up = async (k) => {
  const isPg = k.client.config.client === 'pg';

  await k.schema.alterTable('users', (t) => {
    t.string('login_id');                                   // 6 xonali, takrorlanmas
    t.boolean('phone_verified').notNullable().defaultTo(false);
    t.integer('failed_logins').notNullable().defaultTo(0);
    t.bigInteger('locked_until');
    t.integer('token_version').notNullable().defaultTo(0); // parol o'zgarsa oshadi: eski tokenlar bekor bo'ladi
  });

  // Mavjud foydalanuvchilarga ID beramiz
  const used = new Set();
  for (const u of await k('users').select('id')) {
    let id; do { id = newId(); } while (used.has(id));
    used.add(id);
    await k('users').where({ id: u.id }).update({ login_id: id });
  }
  await k.schema.alterTable('users', (t) => { t.unique('login_id'); });

  // Xodimlarning telefoni endi majburiy emas (ular ID bilan kiradi)
  if (isPg) {
    await k.raw('ALTER TABLE users ALTER COLUMN phone DROP NOT NULL');
    await k.raw('ALTER TABLE users ALTER COLUMN login_id SET NOT NULL');
  } else {
    // SQLite ustunni "NOT NULL" dan chiqarolmaydi: jadvalni qayta yaratamiz
    await k.raw('PRAGMA foreign_keys = OFF');
    await k.schema.createTable('users_new', (t) => {
      t.increments('id');
      t.integer('shop_id').notNullable().references('id').inTable('shops').onDelete('CASCADE');
      t.string('phone').unique();
      t.string('login_id').notNullable().unique();
      t.string('name').notNullable();
      t.string('role').notNullable();
      t.string('password_hash').notNullable();
      t.boolean('active').notNullable().defaultTo(true);
      t.boolean('phone_verified').notNullable().defaultTo(false);
      t.integer('failed_logins').notNullable().defaultTo(0);
      t.bigInteger('locked_until');
      t.integer('token_version').notNullable().defaultTo(0);
      t.bigInteger('created_at').notNullable();
    });
    await k.raw(`INSERT INTO users_new (id, shop_id, phone, login_id, name, role, password_hash, active, phone_verified, failed_logins, locked_until, token_version, created_at)
                 SELECT id, shop_id, phone, login_id, name, role, password_hash, active, phone_verified, failed_logins, locked_until, token_version, created_at FROM users`);
    await k.schema.dropTable('users');
    await k.schema.renameTable('users_new', 'users');
    await k.schema.alterTable('users', (t) => { t.index('shop_id'); });
    await k.raw('PRAGMA foreign_keys = ON');
  }

  // Bir martalik SMS kodlar
  await k.schema.createTable('otps', (t) => {
    t.increments('id');
    t.string('phone').notNullable();
    t.string('purpose').notNullable();          // register | reset | phone
    t.integer('user_id');                       // phone almashtirishda kim so'ragani
    t.string('code_hash').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['phone', 'purpose']);
  });
};

exports.down = async (k) => {
  await k.schema.dropTableIfExists('otps');
};
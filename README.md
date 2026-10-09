# Ombor backend

Node.js + Express + Knex. Bazа: lokal/bepul uchun **SQLite**, pullik serverda **PostgreSQL**
(kod o'zgarmaydi, faqat `DATABASE_URL`). Frontend `public/` papkasidan shu serverning o'zidan beriladi
(kamera/skaner uchun HTTPS kerak, hosting buni beradi).

## Ishga tushirish
    npm install
    cp .env.example .env      # JWT_SECRET va SUPER_KEY ni to'ldiring
    npm start                 # http://localhost:3000
    npm test                  # 43 ta tekshiruv (do'konlar izolyatsiyasi, rollar, nasiya...)

## Qanday ishlaydi
- **Har bir biznes = alohida do'kon (shop).** `POST /api/auth/register` yangi do'kon va admin yaratadi.
- Admin `POST /api/staff` bilan xodimga telefon + parol ochadi. Xodim shu bilan kiradi va admin do'koniga ulanadi.
- **Izolyatsiya:** `shop_id` har so'rovda bazadagi foydalanuvchi qatoridan olinadi (mijoz yuborgan ma'lumotdan emas).
  Har bir so'rov `WHERE shop_id = ?` bilan cheklangan. Boshqa do'kon ID si bilan murojaat qilsangiz 404 qaytadi.
- **Rollar:** `admin` hamma narsa; `seller` faqat sotadi. Sotuvchiga tannarx (`cost`), foiz (`pct`), foyda
  server tomonida umuman yuborilmaydi. Narx, tannarx va qoldiq tekshiruvi serverda.
- Sotuvchi huquqlari admin sozlamalarida: `sellerEditPrice` (narxni o'zgartirish, default: yo'q),
  `sellerSeeDebts` (qarzdorlarni ko'rish, default: ha).
- O'chirilgan (`active:false`) xodim tokeni darrov ishlamay qoladi.

## API
| Yo'l | Kim | Vazifa |
|---|---|---|
| POST /api/auth/register, /login | hamma | do'kon ochish / kirish |
| GET /api/auth/me, POST /api/auth/password | kirgan | profil / parol almashtirish |
| GET, POST /api/staff, PATCH /api/staff/:id | admin | xodimlar (name, active, password) |
| GET /api/products?q=&barcode= | hamma | ro'yxat (sotuvchiga tannarxsiz) |
| POST, PUT, DELETE /api/products(/:id), POST /:id/restock | admin | mahsulot boshqaruvi |
| POST /api/sales, GET /api/sales(/:id) | hamma | sotish/savat/nasiya; sotuvchi faqat o'zinikini ko'radi |
| GET /api/debts, POST /:id/pay, GET /:id/payments, POST /api/debts | admin (+sotuvchi, ruxsat bilan) | qarzlar |
| GET, POST, DELETE /api/expenses | admin | xarajatlar |
| GET /api/reports/summary?from=&to=&tz= | admin | kirim, foyda, grafik, reyting, qarz, ombor qiymati |
| GET, PUT /api/settings | hamma / admin | sozlamalar |
| GET /api/ads?placement=home | kirgan | reklamalar |
| GET, POST, PUT, DELETE /api/super/ads | faqat siz | `x-super-key: <SUPER_KEY>` sarlavhasi bilan |

Sotuv: `POST /api/sales {customer, items:[{productId, qty, price?}], credit:{paidNow, phone, due}}`

## Bepul serverga qo'yish
1. Kodni GitHub'ga yuklang, Render/Railway/Fly kabi hostingda "Web Service" oching (Dockerfile bor).
2. Env: `JWT_SECRET`, `SUPER_KEY`, `NODE_ENV=production`, `TRUST_PROXY=1`.
3. **Muhim:** ko'p bepul hostinglarda disk doimiy emas, SQLite fayl yo'qolishi mumkin.
   Shuning uchun bepul tashqi PostgreSQL oching va `DATABASE_URL` ga yozing. Jadvallar server yonganda o'zi yaratiladi.
   (Bepul tariflar shartlari o'zgarib turadi, tanlashdan oldin tekshiring.)

## Pullik serverga o'tish
Kod o'zgarmaydi: yangi serverda shu loyihani (yoki Docker image) ishga tushiring, `DATABASE_URL` ni yangi
Postgres'ga yo'naltiring. Eski bazadan ko'chirish: `pg_dump` / `pg_restore`.

## Frontend (public/index.html)
Frontend endi shu API bilan ishlaydi (eski `localStorage` o'rniga). Interfeys o'sha, o'zgargani:
- Kirish/ro'yxatdan o'tish serverga; admin **Profil → Xodimlar** bo'limidan xodimga login va parol ochadi.
- **Sotuvchi** ko'rinishi: "Kiritish" tabi yo'q; tannarx, foiz, foyda, ombor summasi, grafik, reyting, xarajat va Excel yo'q;
  sotish narxi faqat admin ruxsat bersa o'zgaradi. Bular yashirilgani emas: ma'lumot sotuvchi brauzeriga umuman kelmaydi.
- **Sozlamalar → Xodimlar huquqlari:** narxni o'zgartirish va qarzdorlarni ko'rishni admin yoqadi/o'chiradi.
- **Eski ma'lumot:** agar shu qurilmada eski (localStorage) ma'lumot bo'lsa, admin birinchi kirganda "Serverga ko'chiramizmi?" deb so'raydi
  (faqat bo'sh do'konga, bir marta). Sozlamalarda ham tugma bor.
- PIN, fon va profil rasmi faqat shu qurilmada saqlanadi (serverga yuborilmaydi).
- Reklama: bosh sahifa (`home`) va sotuvlar (`sales`) tagida chiqadi. Qo'shish:
      curl -X POST $URL/api/super/ads -H "x-super-key: $SUPER_KEY" -H "content-type: application/json" \
           -d '{"title":"Aksiya","body":"Matn","placement":"home","link":"https://...","imageUrl":"https://..."}'
- `sw.js` `/api/` so'rovlarini keshlamaydi (foydalanuvchilar ma'lumoti aralashmasligi uchun).

## APK (Capacitor)
Frontend serverdan alohida (ilova ichida) bo'lsa, `index.html` boshiga qo'shing:
`window.OMBOR_API_BASE='https://sizning-server.uz'` va serverda `CORS_ORIGIN` ni bo'sh qoldiring yoki ilova manzilini yozing.

## Testlar
`npm test`: `test/smoke.js` (API: izolyatsiya, rollar, nasiya, import) va `test/ui.js` (haqiqiy frontend jsdom ichida,
admin/sotuvchi/boshqa do'kon/ko'chirish). Kamera skaneri va telefon ekrani bu testlarda tekshirilmaydi.

## Keyingi qadamlar
- Haqiqiy telefonda sinash (ayniqsa kamera/skaner, HTTPS hostingda).
- Yangi qatorlar (Xodimlar, huquqlar, ko'chirish) uchun ru/en tarjimalari.
- Katta do'konlar uchun: sotuvlar hozir 1000 tadan sahifalab yuklanadi; juda ko'p sotuvda hisobotlarni serverga o'tkazish.
- Yangi sxema o'zgarishlari `src/migrations/002_...js` fayllari orqali qo'shiladi.

## Vercel'ga qo'yish
1. GitHub'ga yuklang, Vercel'da "Add New → Project" qiling (Framework: Other).
2. Storage → Neon (Postgres) ulang: `DATABASE_URL` o'zi qo'shiladi.
3. Env: `JWT_SECRET`, `SUPER_KEY`. (`NODE_ENV=production` Vercel o'zi qo'yadi.)
4. Deploy. Jadvallar birinchi so'rovda o'zi yaratiladi. `public/` statik, `/api/*` -> `api/index.js`.
Cheklov: Vercel so'rov hajmi ~4.5 MB, shuning uchun juda katta eski zaxirani ko'chirish (`/api/import`) o'tmasligi mumkin.

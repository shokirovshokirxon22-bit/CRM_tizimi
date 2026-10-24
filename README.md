# Ombor backend

Node.js + Express + Knex. Bazа: lokal/bepul uchun **SQLite**, pullik serverda **PostgreSQL**
(kod o'zgarmaydi, faqat `DATABASE_URL`). Frontend `public/` papkasidan shu serverning o'zidan beriladi
(kamera/skaner uchun HTTPS kerak, hosting buni beradi).

## Ishga tushirish
    npm install
    cp .env.example .env      # JWT_SECRET va SUPER_KEY ni to'ldiring
    npm start                 # http://localhost:3000
    npm test                  # do'konlar izolyatsiyasi, rollar, nasiya, SMS tasdiqlash, parol tiklash, migratsiya, UI

## Qanday ishlaydi
- **Har bir biznes = alohida do'kon (shop).** Admin telefon raqamini **SMS kod bilan tasdiqlab** ro'yxatdan o'tadi
  (`POST /api/auth/register/start` -> `POST /api/auth/register`). Tasdiqlanmagan raqam bilan hisob ochib bo'lmaydi.
- **Kirish ID bilan.** Tizim har bir foydalanuvchiga 6 xonali takrorlanmas ID beradi; admin ham, xodim ham `ID + parol` bilan kiradi.
  (Eski hisoblar migratsiyadan keyin ID oladi; ular o'tish davrida telefon raqami bilan ham kira oladi.)
- Admin `POST /api/staff {name}` bilan xodim qo'shadi: **tizim ID va vaqtinchalik parolni o'zi beradi** (parol faqat shu javobda ko'rinadi).
  Xodim kirgach parolni o'zi o'zgartiradi (`POST /api/auth/password`). Xodim parolni unutsa admin `PATCH /api/staff/:id {resetPassword:true}` qiladi.
- **Admin parolini tiklash:** `POST /api/auth/reset/start` -> SMS kod -> `POST /api/auth/reset/confirm` (javobda ID ham qaytadi).
- **Telefonni o'zgartirish:** joriy parol + yangi raqamga SMS kod (`/api/auth/phone/start`, `/phone/confirm`).
- **Hisobni o'chirish:** `POST /api/auth/delete-account {password}`: do'kon, xodimlar va barcha ma'lumot o'chadi.
- Parol almashganda/tiklanganda eski tokenlar bekor bo'ladi. 8 ta xato urinishdan keyin hisob 15 daqiqaga bloklanadi.
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
| POST /api/auth/register/start, /register, /login | hamma | SMS kod, do'kon ochish, kirish (id + parol) |
| POST /api/auth/reset/start, /reset/confirm | hamma | admin parolini SMS orqali tiklash |
| POST /api/auth/phone/start, /phone/confirm, /delete-account | admin | raqam almashtirish, hisobni o'chirish |
| GET /api/auth/me, POST /api/auth/password | kirgan | profil / parol almashtirish (yangi token qaytadi) |
| GET, POST /api/staff, PATCH /api/staff/:id | admin | xodimlar (POST {name} -> ID+parol beriladi; PATCH: name, active, resetPassword) |
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
2. Env: `JWT_SECRET`, `SUPER_KEY`, `NODE_ENV=production`, `TRUST_PROXY=1`, **SMS:** `ESKIZ_EMAIL`, `ESKIZ_PASSWORD` (pastga qarang).
3. **Muhim:** ko'p bepul hostinglarda disk doimiy emas, SQLite fayl yo'qolishi mumkin.
   Shuning uchun bepul tashqi PostgreSQL oching va `DATABASE_URL` ga yozing. Jadvallar server yonganda o'zi yaratiladi.
   (Bepul tariflar shartlari o'zgarib turadi, tanlashdan oldin tekshiring.)

## SMS sozlash (majburiy: ro'yxatdan o'tish va parol tiklash SMS kod bilan ishlaydi)
Hozir [Eskiz.uz](https://eskiz.uz) qo'llab-quvvatlanadi. Env: `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, ixtiyoriy `ESKIZ_FROM` (default `4546`)
va `SMS_TEMPLATE` (`{code}` o'rniga kod qo'yiladi). Eskiz'da SMS matni shabloni oldindan tasdiqlanadi: `SMS_TEMPLATE` ni o'sha matnga moslang.
SMS sozlanmasa production'da ro'yxatdan o'tish 503 qaytaradi. Sinov uchun `SMS_PROVIDER=console` (kod server logiga yoziladi; productionda xavfli).
Boshqa provayder kerak bo'lsa faqat `src/sms.js` dagi `sendSms` o'zgaradi. Kod 6 xonali, 5 daqiqa amal qiladi, 5 marta xato kiritish mumkin,
qayta yuborish 60 soniyada bir marta, soatiga 5 tadan ko'p emas; IP bo'yicha `SMS_RATE_LIMIT` (default 10 / 15 daqiqa).

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
- Katta do'konlar uchun: sotuvlar hozir 1000 tadan sahifalab yuklanadi; juda ko'p sotuvda hisobotlarni serverga o'tkazish.
- Yangi sxema o'zgarishlari `src/migrations/002_...js` fayllari orqali qo'shiladi.

## Vercel'ga qo'yish
1. GitHub'ga yuklang, Vercel'da "Add New → Project" qiling (Framework: Other).
2. Storage → Neon (Postgres) ulang: `DATABASE_URL` o'zi qo'shiladi.
3. Env: `JWT_SECRET`, `SUPER_KEY`, `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `SMS_TEMPLATE`. (`NODE_ENV=production` Vercel o'zi qo'yadi.)
4. Deploy. Jadvallar birinchi so'rovda o'zi yaratiladi. `public/` statik, `/api/*` -> `api/index.js`.
Cheklov: Vercel so'rov hajmi ~4.5 MB, shuning uchun juda katta eski zaxirani ko'chirish (`/api/import`) o'tmasligi mumkin.
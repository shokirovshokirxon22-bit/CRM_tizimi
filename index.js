// Vercel kirish nuqtasi. Barcha /api/* so'rovlari shu yerga keladi (vercel.json rewrites).
// Jadvallar (migratsiya) har bir "sovuq start"da bir marta tekshiriladi.
const { createApp } = require('../src/app');
const { migrate } = require('../src/db');

const app = createApp();
let ready;
module.exports = async (req, res) => {
  try {
    ready = ready || migrate();
    await ready;
  } catch (e) {
    ready = null;
    console.error('Migratsiya xatosi:', e);
    return res.status(500).json({ error: 'Baza bilan bog\'lanib bo\'lmadi' });
  }
  return app(req, res);
};

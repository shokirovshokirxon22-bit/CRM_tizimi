const { createApp } = require('./app');
const { migrate } = require('./db');

(async () => {
  await migrate();
  const port = +process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Ombor backend: http://localhost:${port}`));
})().catch((e) => { console.error(e); process.exit(1); });

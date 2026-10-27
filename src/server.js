const { createApp } = require('./app');
const { migrate } = require('./db');
const monitor = require('./monitor');

(async () => {
  await migrate();
  const port = +process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Ombor backend: http://localhost:${port}`));
})().catch(async (e) => { console.error(e); monitor.init(); monitor.capture(e); await monitor.flush(); process.exit(1); });

// Punkt startowy serwera: `npm start`.
import { loadEnvFile, getConfig } from './config.js';
import { createApp, makeLogger } from './app.js';

loadEnvFile();
const config = getConfig();
const log = makeLogger(config.logLevel);

const app = await createApp(config, { log }).catch((e) => {
  log.error('Nie można uruchomić serwera:', e.message);
  process.exit(1);
});
const addr = await app.listen();
log.info(`Tysiąc działa: http://${addr.address}:${addr.port}  (dane: ${config.dataDir})`);

let closing = false;
const shutdown = async (sig) => {
  if (closing) return;
  closing = true;
  log.info(`Zatrzymywanie (${sig})…`);
  const t = setTimeout(() => process.exit(1), 10000);
  await app.close().catch((e) => log.error(e));
  clearTimeout(t);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('Nieobsłużony błąd:', e && e.stack ? e.stack : e));

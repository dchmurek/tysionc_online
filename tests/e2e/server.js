// Serwer dla testów E2E: świeży katalog danych (syntetyczna baza) przy każdym uruchomieniu.
import path from 'node:path';
import { seed } from './seed.js';
import { createApp, makeLogger } from '../../server/app.js';
import { getConfig, ROOT } from '../../server/config.js';

const dataDir = path.join(ROOT, 'tests/.tmp/e2e-data');
await seed(dataDir);
const config = { ...getConfig({ NODE_ENV: 'test' }), dataDir, port: Number(process.env.PORT || 8799), host: '127.0.0.1', noTimers: true, registerPerHour: 1000 };
const app = await createApp(config, { log: makeLogger('warn') });
await app.listen();
console.log('e2e server ready on', config.port);

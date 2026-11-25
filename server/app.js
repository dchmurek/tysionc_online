// Składanie aplikacji: magazyn JSON, usługi, HTTP API, pliki statyczne, WebSocket.
import http from 'node:http';
import crypto from 'node:crypto';
import { JsonStore } from './store/jsonStore.js';
import { validators } from './store/schemas.js';
import { createBackup, rotateBackups } from './store/backup.js';
import { Accounts } from './services/accounts.js';
import { Matches } from './services/matches.js';
import { Rooms } from './services/rooms.js';
import { createRouter } from './http/router.js';
import { serveStatic } from './http/static.js';
import { attachRealtime } from './realtime.js';
import { DEFAULT_SETTINGS } from '../shared/rules.js';

export function makeLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] || 20;
  const out = (lvl) => (...a) => { if (order[lvl] >= min) console[lvl === 'debug' ? 'log' : lvl](new Date().toISOString(), lvl.toUpperCase(), ...a); };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}

export async function createApp(config, { log = makeLogger(config.logLevel), randomInt } = {}) {
  const store = await new JsonStore(config.dataDir, { validators, log }).init();
  for (const r of store.recovered) log.warn('Odzyskiwanie:', r);

  const audit = async (type, data = {}) => {
    const month = new Date().toISOString().slice(0, 7);
    await store.appendLine(`audit/${month}.jsonl`, { at: new Date().toISOString(), type, ...data }).catch((e) => log.error('audit', e.message));
  };
  const getConfig = async () => ({ registrationOpen: true, defaultSettings: {}, ...(await store.getData('config', {})) });
  if (!(await store.get('config'))) await store.update('config', () => ({ registrationOpen: true, defaultSettings: { ...DEFAULT_SETTINGS } }));
  if (!(await store.get('meta'))) await store.update('meta', () => ({ schemaVersion: 2, createdAt: new Date().toISOString(), migrations: [] }));

  const { upgradeMeldsV2 } = await import('./migrate/meldsV2.js');
  await upgradeMeldsV2(store, { backup: (l) => createBackup(store, l), log });

  const accounts = new Accounts(store, { audit, getConfig, limits: { registerPerHour: config.registerPerHour } });
  let rooms = null;
  let realtime = null;
  const matches = new Matches(store, {
    accounts, audit,
    isLive: async (id) => (rooms ? rooms.isLive(id) : false),
    hasRoom: async (id) => !!(rooms && rooms.roomForMatch(id)),
    onChange: (id) => realtime && realtime.matchChanged(id),
  });
  rooms = new Rooms(store, { matches, accounts, audit, randomInt, onUpdate: (id, room) => realtime && realtime.roomChanged(id, room) });
  await rooms.init();

  const backup = (label) => createBackup(store, label);
  const services = { store, accounts, matches, rooms, audit, getConfig, backup, config, log, startedAt: new Date().toISOString() };
  const router = createRouter(services);

  const server = http.createServer(async (req, res) => {
    const reqId = crypto.randomBytes(4).toString('hex');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (req.url.startsWith('/api/')) return await router(req, res);
      return await serveStatic(req, res, config);
    } catch (e) {
      log.error(`[${reqId}]`, e.stack || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Błąd serwera (' + reqId + ')' }));
      }
    }
  });
  realtime = attachRealtime(server, services);
  services.realtime = realtime;

  // Kopia dzienna przy starcie (jeśli dziś jeszcze nie było) i co 24 h; sprzątanie pokoi co godzinę.
  const timers = [];
  const daily = async () => {
    try {
      const { listBackups } = await import('./store/backup.js');
      const today = new Date().toISOString().slice(0, 10);
      const list = await listBackups(store);
      if (!list.some((b) => b.name.startsWith('backup-' + today) && b.name.includes('-daily'))) {
        const b = await createBackup(store, 'daily');
        log.info('Kopia dzienna:', b.name);
      }
      await rotateBackups(store, config.backupKeep);
    } catch (e) { log.error('Kopia dzienna nieudana:', e.message); }
  };
  if (!config.noTimers) {
    await daily();
    timers.push(setInterval(daily, 6 * 3600e3).unref());
    timers.push(setInterval(() => rooms.sweep().catch(() => {}), 3600e3).unref());
  }

  return {
    server, services,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address()))),
    close: async () => {
      timers.forEach(clearInterval);
      realtime.close();
      await new Promise((r) => server.close(() => r()));
      store.close();
    },
  };
}

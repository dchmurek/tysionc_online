// REST API. Każde uprawnienie sprawdzane po stronie serwera.
import { Accounts, AppError } from '../services/accounts.js';
import { exportData, exportCsv, previewImport, applyImport, cancelImport } from '../services/transfer.js';
import { listBackups, createBackup, readBackup, restoreBundle, encryptBundle, decryptBundle, buildBundle } from '../store/backup.js';
import { validators } from '../store/schemas.js';
import { normalizeSettings } from '../../shared/rules.js';
import { ConflictError, ValidationError } from '../store/jsonStore.js';

export const COOKIE = 'tys_s';
const MAX_BODY = 1024 * 1024;
const MAX_IMPORT = 20 * 1024 * 1024;

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return; // resztę odrzucamy; po wysłaniu odpowiedzi 413 połączenie zostanie zamknięte
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(new AppError(413, 'Za duże dane', 'too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function clientIp(req, config) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true; // brak nagłówka (np. narzędzia CLI) – chroni nas wtedy token CSRF / nagłówek
  if (config.allowedOrigins.includes(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function setSessionCookie(res, config, token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function createRouter(svc) {
  const { accounts, matches, rooms, config, store, audit } = svc;
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, opts: { auth: true, ...opts } });
  };
  const me = (ctx) => ({ user: Accounts.publicUser(ctx.user), csrf: ctx.session.csrf });
  const admin = { admin: true };
  const getId = (v) => decodeURIComponent(v);

  // --- konto ---
  add('GET', '/api/me', async (ctx) => (ctx.user ? me(ctx) : { user: null }), { auth: false });
  add('POST', '/api/auth/register', async (ctx) => {
    const u = await accounts.register(ctx.body, { ip: ctx.ip });
    const s = await accounts.createSession(u.id, { ip: ctx.ip, ua: ctx.ua });
    setSessionCookie(ctx.res, config, s.token, 30 * 86400);
    return { user: Accounts.publicUser(u), csrf: s.session.csrf };
  }, { auth: false });
  add('POST', '/api/auth/login', async (ctx) => {
    const r = await accounts.login(ctx.body || {}, { ip: ctx.ip, ua: ctx.ua });
    setSessionCookie(ctx.res, config, r.token, 30 * 86400);
    return { user: Accounts.publicUser(r.user), csrf: r.session.csrf };
  }, { auth: false });
  add('POST', '/api/auth/activate', async (ctx) => {
    const r = await accounts.activate(ctx.body || {}, { ip: ctx.ip, ua: ctx.ua });
    setSessionCookie(ctx.res, config, r.token, 30 * 86400);
    return { user: Accounts.publicUser(r.user), csrf: r.session.csrf };
  }, { auth: false });
  add('POST', '/api/auth/logout', async (ctx) => {
    await accounts.revokeSession(ctx.user.id, ctx.session.id);
    setSessionCookie(ctx.res, config, '', 0);
    return {};
  });
  add('POST', '/api/account/password', async (ctx) => { await accounts.changePassword(ctx.user.id, ctx.body.old, ctx.body.new, ctx.session.id); return {}; });
  add('POST', '/api/account/nick', async (ctx) => ({ user: Accounts.publicUser(await accounts.changeNick(ctx.user.id, ctx.body.nick, ctx.body.password)) }));
  add('POST', '/api/account/profile', async (ctx) => ({ user: Accounts.publicUser(await accounts.updateProfile(ctx.user.id, ctx.body || {})) }));
  add('GET', '/api/account/sessions', async (ctx) => ({ sessions: (await accounts.listSessions(ctx.user.id)).map((s) => ({ ...s, current: s.id === ctx.session.id })) }));
  add('POST', '/api/account/sessions/revoke', async (ctx) => {
    if (ctx.body.all) await accounts.revokeAll(ctx.user.id, ctx.session.id);
    else await accounts.revokeSession(ctx.user.id, String(ctx.body.id || ''));
    return {};
  });

  // --- dane wspólne ---
  add('GET', '/api/users', async () => ({ users: (await accounts.allUsers()).map(Accounts.publicUser) }));
  add('POST', '/api/users/profile', async (ctx) => ({ user: Accounts.publicUser(await accounts.createProfile(ctx.user.id, ctx.body.nick)) }));
  add('GET', '/api/data', async (ctx) => ({
    users: (await accounts.allUsers()).map(Accounts.publicUser),
    matches: (await matches.list({ includeDeleted: ctx.user.role === 'admin' })).map(({ appliedOps, ...m }) => m),
    meets: await matches.meets(),
    rooms: rooms.listForUser(ctx.user.id),
    settings: normalizeSettings(((await store.getData('config')) || {}).defaultSettings || {}),
    serverTime: new Date().toISOString(),
  }));

  // --- mecze ---
  add('POST', '/api/matches', async (ctx) => ({ match: await matches.create(ctx.user, ctx.body || {}) }));
  add('GET', '/api/matches/:id', async (ctx) => ({ match: await matches.get(getId(ctx.params.id)) }));
  add('POST', '/api/matches/:id/rounds', async (ctx) => matches.addRound(ctx.user, getId(ctx.params.id), ctx.body));
  add('PUT', '/api/matches/:id/rounds/:rid', async (ctx) => matches.editRound(ctx.user, getId(ctx.params.id), getId(ctx.params.rid), ctx.body));
  add('POST', '/api/matches/:id/undo', async (ctx) => matches.undoLast(ctx.user, getId(ctx.params.id), ctx.body));
  add('POST', '/api/matches/:id/restore-round', async (ctx) => matches.restoreRound(ctx.user, getId(ctx.params.id), ctx.body));
  add('POST', '/api/matches/:id/status', async (ctx) => {
    if (ctx.body.status === 'deleted' && ctx.user.role !== 'admin') {
      const m = await matches.get(getId(ctx.params.id));
      if (!m.seats.includes(ctx.user.id) && m.createdBy !== ctx.user.id) throw new AppError(403, 'Brak uprawnień');
    }
    return matches.setStatus(ctx.user, getId(ctx.params.id), ctx.body);
  });
  add('POST', '/api/meets', async (ctx) => ({ meet: await matches.startMeet(ctx.user, ctx.body.players) }));
  add('POST', '/api/meets/:id/close', async (ctx) => ({ meet: await matches.closeMeet(ctx.user, getId(ctx.params.id)) }));

  // --- pokoje (akcje gry idą przez WebSocket; tu tworzenie i dołączanie) ---
  add('POST', '/api/rooms', async (ctx) => ({ room: await rooms.create(ctx.user, ctx.body || {}) }));
  add('POST', '/api/rooms/join', async (ctx) => ({ room: await rooms.joinByCode(ctx.user, ctx.body.code) }));
  add('GET', '/api/rooms/:id', async (ctx) => {
    const r = rooms.get(getId(ctx.params.id));
    if (!r.members.includes(ctx.user.id)) throw new AppError(403, 'Najpierw dołącz do pokoju kodem');
    return { room: rooms.viewFor(r, ctx.user.id) };
  });
  add('POST', '/api/rooms/:id/action', async (ctx) => {
    const id = getId(ctx.params.id);
    const r = await rooms.act(ctx.user, id, ctx.body || {});
    const room = rooms.rooms.get(id);
    return { ...r, room: room ? rooms.viewFor(room, ctx.user.id) : null };
  });

  // --- eksport ---
  add('GET', '/api/export/json', async (ctx) => {
    const data = await exportData(svc);
    ctx.raw = { type: 'application/json; charset=utf-8', body: JSON.stringify(data, null, 1), filename: `tysiac-eksport-${new Date().toISOString().slice(0, 10)}.json` };
  });
  add('GET', '/api/export/csv/:kind', async (ctx) => {
    const kind = getId(ctx.params.kind);
    ctx.raw = { type: 'text/csv; charset=utf-8', body: await exportCsv(kind, svc), filename: `tysiac-${kind}-${new Date().toISOString().slice(0, 10)}.csv` };
  });

  // --- administracja ---
  add('GET', '/api/admin/users', async () => ({
    users: (await accounts.allUsers()).map((u) => ({ ...Accounts.publicUser(u), hasPassword: !!u.passwordHash, activationPending: !!(u.activation && Date.parse(u.activation.expiresAt) > Date.now()), activationExpires: u.activation ? u.activation.expiresAt : null, nickHistory: u.nickHistory || [], legacy: u.legacy || null })),
  }), admin);
  add('POST', '/api/admin/users/:id/activation', async (ctx) => accounts.issueActivation(ctx.user.id, getId(ctx.params.id), ctx.body.purpose === 'reset' ? 'reset' : 'activate'), admin);
  add('POST', '/api/admin/users/:id/role', async (ctx) => { await accounts.setRole(ctx.user.id, getId(ctx.params.id), ctx.body.role); return {}; }, admin);
  add('POST', '/api/admin/users/:id/status', async (ctx) => { await accounts.setStatus(ctx.user.id, getId(ctx.params.id), ctx.body.status); return {}; }, admin);
  add('GET', '/api/admin/config', async () => ({ config: await svc.getConfig() }), admin);
  add('POST', '/api/admin/config', async (ctx) => {
    const b = ctx.body || {};
    const next = await store.update('config', (c) => {
      c = c || { registrationOpen: true, defaultSettings: {} };
      if (typeof b.registrationOpen === 'boolean') c.registrationOpen = b.registrationOpen;
      if (b.defaultSettings) { try { c.defaultSettings = normalizeSettings(b.defaultSettings); } catch (e) { throw new AppError(400, e.message); } }
      return c;
    });
    await audit('admin.config', { adminId: ctx.user.id });
    return { config: next.data };
  }, admin);
  add('GET', '/api/admin/backups', async () => ({ backups: await listBackups(store) }), admin);
  add('POST', '/api/admin/backups', async (ctx) => { const b = await createBackup(store, 'manual'); await audit('admin.backup', { adminId: ctx.user.id, name: b.name }); return { backup: b }; }, admin);
  add('POST', '/api/admin/backups/download', async (ctx) => {
    const bundle = ctx.body.name ? await readBackup(store, String(ctx.body.name)) : await buildBundle(store);
    const enc = await encryptBundle(bundle, String(ctx.body.passphrase || '')).catch((e) => { throw new AppError(400, e.message); });
    await audit('admin.backup.download', { adminId: ctx.user.id, name: ctx.body.name || 'current' });
    ctx.raw = { type: 'application/octet-stream', body: enc, filename: `tysiac-backup-${new Date().toISOString().slice(0, 10)}.tysiac.enc` };
  }, admin);
  add('POST', '/api/admin/restore/preview', async (ctx) => {
    let bundle;
    if (ctx.body.name) bundle = await readBackup(store, String(ctx.body.name));
    else bundle = await decryptBundle(Buffer.from(String(ctx.body.file || ''), 'base64'), String(ctx.body.passphrase || '')).catch((e) => { throw new AppError(400, e.message); });
    const files = Object.keys(bundle.files);
    const matchesCount = files.filter((f) => f.startsWith('matches/')).length;
    const users = bundle.files.users ? Object.keys(bundle.files.users.data.users).length : 0;
    svc.pendingRestore = { bundle, expires: Date.now() + 15 * 60e3 };
    return { createdAt: bundle.createdAt, files: files.length, matches: matchesCount, users };
  }, admin);
  add('POST', '/api/admin/restore/apply', async (ctx) => {
    const p = svc.pendingRestore;
    if (!p || p.expires < Date.now()) throw new AppError(400, 'Podgląd przywracania wygasł');
    svc.pendingRestore = null;
    const r = await restoreBundle(store, p.bundle, { validators });
    accounts.tokenIndex = null;
    await rooms.init().catch(() => {});
    await audit('admin.restore', { adminId: ctx.user.id, ...r });
    return r;
  }, admin);
  add('POST', '/api/admin/import/preview', async (ctx) => previewImport(ctx.body.data, svc), { admin: true, bodyLimit: MAX_IMPORT });
  add('POST', '/api/admin/import/apply', async (ctx) => applyImport(String(ctx.body.token || ''), svc, ctx.user.id), admin);
  add('POST', '/api/admin/import/cancel', async (ctx) => ({ cancelled: cancelImport(String(ctx.body.token || '')) }), admin);
  add('GET', '/api/admin/diagnostics', async () => {
    const problems = await store.verifyAll();
    const mem = process.memoryUsage();
    return {
      startedAt: svc.startedAt, node: process.version, uptimeSec: Math.round(process.uptime()), memoryMB: Math.round(mem.rss / 1048576),
      dataDir: config.dataDir.replace(/^.*\/(?=[^/]+\/?$)/, '…/'), documents: (await store.allNames()).length, integrityProblems: problems,
      recovered: store.recovered, rooms: rooms.rooms.size, connections: svc.realtime ? svc.realtime.stats() : null,
      backups: (await listBackups(store)).slice(0, 5),
    };
  }, admin);
  add('POST', '/api/admin/rebuild-stats', async () => {
    // Statystyki nie są zapisywane – liczy się je z historii. Tu: pełna weryfikacja, że każdy mecz da się przeliczyć.
    const { computeMatch } = await import('../../shared/scoring.js');
    const list = await matches.list({ includeDeleted: true });
    const errors = [];
    for (const m of list) { try { computeMatch(m); } catch (e) { errors.push({ id: m.id, error: e.message }); } }
    return { matches: list.length, errors };
  }, admin);

  return async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(res, 404, { ok: false, error: 'Nie ma takiego zasobu' });
    const m = url.pathname.match(route.re);
    const ctx = { req, res, url, params: Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]])), ip: clientIp(req, config), ua: req.headers['user-agent'] || '' };
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      const auth = token ? await accounts.resolveToken(token) : null;
      if (auth) { ctx.user = auth.user; ctx.session = auth.session; }
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating) {
        if (!originAllowed(req, config)) throw new AppError(403, 'Niedozwolone źródło żądania', 'origin');
        if (req.headers['x-tysiac'] !== '1') throw new AppError(403, 'Niedozwolone żądanie', 'csrf');
        if (ctx.user && route.opts.auth && req.headers['x-csrf-token'] !== ctx.session.csrf) throw new AppError(403, 'Sesja wygasła – odśwież stronę', 'csrf');
        const raw = await readBody(req, route.opts.bodyLimit || MAX_BODY);
        try { ctx.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new AppError(400, 'Niepoprawny JSON'); }
        if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new AppError(400, 'Niepoprawne dane');
      } else ctx.body = {};
      if (route.opts.auth && !ctx.user) throw new AppError(401, 'Zaloguj się', 'auth');
      if (route.opts.admin && ctx.user.role !== 'admin') throw new AppError(403, 'Tylko dla administratora', 'forbidden');
      const result = await route.handler(ctx);
      if (ctx.raw) {
        res.writeHead(200, { 'Content-Type': ctx.raw.type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${ctx.raw.filename}"` });
        return res.end(ctx.raw.body);
      }
      return send(res, 200, { ok: true, ...(result || {}) });
    } catch (e) {
      if (e instanceof ConflictError) {
        const cur = e.current;
        return send(res, 409, { ok: false, error: e.message, code: 'conflict', current: cur ? (({ appliedOps, ...x }) => x)(cur) : null });
      }
      if (e instanceof AppError || e instanceof ValidationError) {
        const extra = {};
        if (e.endsAt) extra.endsAt = e.endsAt;
        const hdr = e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {};
        if (e.status === 413) { hdr.Connection = 'close'; res.on('finish', () => req.destroy()); }
        return send(res, e.status || 400, { ok: false, error: e.message, code: e.code, ...extra }, hdr);
      }
      svc.log.error('API', req.method, url.pathname, e.stack || e);
      return send(res, 500, { ok: false, error: 'Błąd serwera' });
    }
  };
}

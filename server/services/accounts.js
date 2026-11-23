// Konta, sesje logowania, aktywacja kont podstawowych, limity prób.
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, needsRehash, dummyVerify, passwordProblem } from './passwords.js';
import { cleanNick, nickKey, nickProblem } from '../../shared/nick.js';

export class AppError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const randId = (p) => p + crypto.randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x');
const SESSION_IDLE_MS = 30 * 864e5;
const SESSION_MAX_MS = 180 * 864e5;
const TOUCH_MS = 10 * 60e3;

// Prosty limiter w pamięci (okno przesuwne + blokada).
export class Limiter {
  constructor({ max, windowMs, lockMs }) { Object.assign(this, { max, windowMs, lockMs }); this.map = new Map(); }
  check(key) {
    const e = this.map.get(key);
    if (e && e.until > Date.now()) return Math.ceil((e.until - Date.now()) / 1000);
    return 0;
  }
  fail(key) {
    const t = Date.now();
    let e = this.map.get(key);
    if (!e || e.first + this.windowMs < t) e = { n: 0, first: t, until: 0 };
    e.n++;
    if (e.n >= this.max) { e.until = t + this.lockMs; e.n = 0; e.first = t; }
    this.map.set(key, e);
    if (this.map.size > 10000) for (const [k, v] of this.map) if (v.until < t && v.first + this.windowMs < t) this.map.delete(k);
  }
  reset(key) { this.map.delete(key); }
}

export function newActivationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class Accounts {
  constructor(store, { audit, getConfig, limits = {} }) {
    this.store = store;
    this.audit = audit;
    this.getConfig = getConfig;
    this.ipLimiter = new Limiter({ max: 10, windowMs: 15 * 60e3, lockMs: 15 * 60e3 });
    this.accountLimiter = new Limiter({ max: 5, windowMs: 15 * 60e3, lockMs: 15 * 60e3 });
    this.registerLimiter = new Limiter({ max: limits.registerPerHour || 20, windowMs: 60 * 60e3, lockMs: 60 * 60e3 });
    this.tokenIndex = null; // tokenHash → sessionId
    this.touched = new Map();
  }

  async usersDoc() { return (await this.store.getData('users')) || { users: {} }; }
  async allUsers() { return Object.values((await this.usersDoc()).users); }
  async getUser(id) { return (await this.usersDoc()).users[id] || null; }
  async findByNick(nick) {
    const key = nickKey(nick);
    return (await this.allUsers()).find((u) => u.nickKey === key) || null;
  }

  static publicUser(u) {
    if (!u) return null;
    return { id: u.id, nick: u.nick, role: u.role, status: u.status, createdAt: u.createdAt, profile: u.profile || {}, guest: !!u.guest };
  }

  #updateUsers(fn) {
    return this.store.update('users', (doc) => fn(doc || { users: {} }));
  }

  // Rejestracja nowego gracza.
  async register({ nick, password }, { ip }) {
    const cfg = await this.getConfig();
    if (!cfg.registrationOpen) throw new AppError(403, 'Rejestracja jest wyłączona przez administratora', 'registration_closed');
    if (this.registerLimiter.check(ip)) throw new AppError(429, 'Za dużo rejestracji z tego adresu – spróbuj później', 'rate');
    const problem = nickProblem(nick) || passwordProblem(password, cleanNick(nick));
    if (problem) throw new AppError(400, problem, 'validation');
    const hash = await hashPassword(password);
    const id = randId('u');
    const clean = cleanNick(nick);
    await this.#updateUsers((doc) => {
      if (Object.values(doc.users).some((u) => u.nickKey === nickKey(clean))) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
      const t = now();
      doc.users[id] = { id, nick: clean, nickKey: nickKey(clean), role: 'player', status: 'active', passwordHash: hash, createdAt: t, updatedAt: t, passwordChangedAt: t, activation: null, profile: {}, nickHistory: [] };
      return doc;
    });
    this.registerLimiter.fail(ip);
    await this.audit('user.register', { userId: id, nick: clean });
    return this.getUser(id);
  }

  async login({ nick, password }, meta) {
    const ip = meta.ip || 'unknown';
    const key = nickKey(nick);
    const wait = this.ipLimiter.check(ip) || this.accountLimiter.check(key);
    if (wait) throw new AppError(429, `Za dużo nieudanych prób. Spróbuj za ${Math.ceil(wait / 60)} min.`, 'rate', { retryAfter: wait });
    const user = await this.findByNick(nick);
    let ok = false;
    if (user && user.status === 'active' && user.passwordHash) ok = await verifyPassword(String(password || ''), user.passwordHash);
    else await dummyVerify(password);
    if (!ok) {
      this.ipLimiter.fail(ip);
      this.accountLimiter.fail(key);
      await this.audit('auth.fail', { nickKey: key, ip });
      if (user && user.status === 'pending') throw new AppError(401, 'To konto nie jest jeszcze aktywne – użyj kodu aktywacyjnego', 'pending');
      throw new AppError(401, 'Zły nick lub hasło', 'bad_credentials');
    }
    this.ipLimiter.reset(ip);
    this.accountLimiter.reset(key);
    if (needsRehash(user.passwordHash)) {
      const h = await hashPassword(password);
      await this.#updateUsers((doc) => { doc.users[user.id].passwordHash = h; return doc; });
    }
    const session = await this.createSession(user.id, meta);
    await this.audit('auth.login', { userId: user.id });
    return { user: await this.getUser(user.id), ...session };
  }

  async #ensureIndex() {
    if (this.tokenIndex) return;
    const doc = (await this.store.getData('auth')) || { sessions: {} };
    this.tokenIndex = new Map(Object.values(doc.sessions).map((s) => [s.tokenHash, s.id]));
  }

  async createSession(userId, meta = {}) {
    await this.#ensureIndex();
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    const s = {
      id: randId('s'), userId, tokenHash: sha(token), csrf: crypto.randomBytes(24).toString('base64url'),
      createdAt: new Date(t).toISOString(), lastSeen: new Date(t).toISOString(),
      expiresAt: new Date(t + SESSION_IDLE_MS).toISOString(), ua: String(meta.ua || '').slice(0, 160),
    };
    await this.store.update('auth', (doc) => {
      doc = doc || { sessions: {} };
      // sprzątanie wygasłych
      for (const [id, x] of Object.entries(doc.sessions)) if (Date.parse(x.expiresAt) < t) delete doc.sessions[id];
      doc.sessions[s.id] = s;
      return doc;
    });
    this.tokenIndex.set(s.tokenHash, s.id);
    return { token, session: s };
  }

  async resolveToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    await this.#ensureIndex();
    const th = sha(token);
    const sid = this.tokenIndex.get(th);
    if (!sid) return null;
    const doc = await this.store.getData('auth');
    const s = doc && doc.sessions[sid];
    if (!s || s.tokenHash !== th) { this.tokenIndex.delete(th); return null; }
    const t = Date.now();
    if (Date.parse(s.expiresAt) < t || Date.parse(s.createdAt) + SESSION_MAX_MS < t) {
      await this.revokeSession(s.userId, s.id);
      return null;
    }
    const user = await this.getUser(s.userId);
    if (!user || user.status !== 'active') return null;
    if (t - Date.parse(s.lastSeen) > TOUCH_MS && !this.touched.has(s.id)) {
      this.touched.set(s.id, true);
      this.store.update('auth', (d) => {
        const x = d && d.sessions[s.id];
        if (!x) return undefined;
        x.lastSeen = new Date().toISOString();
        x.expiresAt = new Date(Math.min(Date.now() + SESSION_IDLE_MS, Date.parse(x.createdAt) + SESSION_MAX_MS)).toISOString();
        return d;
      }).finally(() => this.touched.delete(s.id)).catch(() => {});
    }
    return { session: s, user };
  }

  async listSessions(userId) {
    const doc = (await this.store.getData('auth')) || { sessions: {} };
    return Object.values(doc.sessions).filter((s) => s.userId === userId)
      .map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeen: s.lastSeen, ua: s.ua }));
  }

  async revokeSession(userId, sessionId) {
    await this.#ensureIndex();
    await this.store.update('auth', (doc) => {
      if (!doc || !doc.sessions[sessionId] || doc.sessions[sessionId].userId !== userId) return undefined;
      this.tokenIndex.delete(doc.sessions[sessionId].tokenHash);
      delete doc.sessions[sessionId];
      return doc;
    });
  }

  async revokeAll(userId, exceptSessionId = null) {
    await this.#ensureIndex();
    await this.store.update('auth', (doc) => {
      if (!doc) return undefined;
      let changed = false;
      for (const [id, s] of Object.entries(doc.sessions)) {
        if (s.userId === userId && id !== exceptSessionId) { this.tokenIndex.delete(s.tokenHash); delete doc.sessions[id]; changed = true; }
      }
      return changed ? doc : undefined;
    });
  }

  async changePassword(userId, oldPw, newPw, currentSessionId) {
    const user = await this.getUser(userId);
    if (!user) throw new AppError(404, 'Brak konta');
    const key = 'pw:' + userId;
    if (this.accountLimiter.check(key)) throw new AppError(429, 'Za dużo prób – spróbuj później', 'rate');
    if (!(await verifyPassword(String(oldPw || ''), user.passwordHash))) {
      this.accountLimiter.fail(key);
      throw new AppError(403, 'Obecne hasło jest niepoprawne', 'bad_password');
    }
    const problem = passwordProblem(newPw, user.nick);
    if (problem) throw new AppError(400, problem, 'validation');
    const h = await hashPassword(newPw);
    await this.#updateUsers((doc) => {
      const u = doc.users[userId];
      u.passwordHash = h; u.passwordChangedAt = now(); u.updatedAt = now();
      return doc;
    });
    await this.revokeAll(userId, currentSessionId);
    await this.audit('user.password', { userId });
  }

  async changeNick(userId, nick, password) {
    const user = await this.getUser(userId);
    if (!user) throw new AppError(404, 'Brak konta');
    if (!(await verifyPassword(String(password || ''), user.passwordHash))) throw new AppError(403, 'Hasło jest niepoprawne', 'bad_password');
    const problem = nickProblem(nick);
    if (problem) throw new AppError(400, problem, 'validation');
    const clean = cleanNick(nick);
    const taken = await this.findByNick(clean);
    if (taken && taken.id !== userId) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
    const last = (user.nickHistory || []).slice(-1)[0];
    if (last && Date.now() - Date.parse(last.to) < 24 * 3600e3 && user.role !== 'admin') {
      throw new AppError(429, 'Nick można zmieniać najwyżej raz na 24 godziny', 'rate');
    }
    await this.#updateUsers((doc) => {
      const key = nickKey(clean);
      if (Object.values(doc.users).some((u) => u.id !== userId && u.nickKey === key)) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
      const u = doc.users[userId];
      if (u.nick === clean) return undefined;
      u.nickHistory = [...(u.nickHistory || []), { nick: u.nick, to: now() }].slice(-20);
      u.nick = clean; u.nickKey = key; u.updatedAt = now();
      return doc;
    });
    await this.audit('user.nick', { userId, nick: clean });
    return this.getUser(userId);
  }

  async updateProfile(userId, profile) {
    const color = profile && profile.color;
    if (color != null && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new AppError(400, 'Zły kolor');
    await this.#updateUsers((doc) => {
      const u = doc.users[userId];
      u.profile = { ...(u.profile || {}), ...(color != null ? { color } : {}) };
      u.updatedAt = now();
      return doc;
    });
    return this.getUser(userId);
  }

  // Aktywacja konta (pierwsze ustawienie hasła) albo reset hasła kodem od administratora.
  async activate({ nick, code, password }, { ip, ua }) {
    if (this.ipLimiter.check(ip)) throw new AppError(429, 'Za dużo prób – spróbuj później', 'rate');
    const user = await this.findByNick(nick);
    const valid = user && user.activation && Date.parse(user.activation.expiresAt) > Date.now()
      && crypto.timingSafeEqual(Buffer.from(sha(normCode(code))), Buffer.from(user.activation.codeHash));
    if (!valid) {
      this.ipLimiter.fail(ip);
      throw new AppError(400, 'Nieprawidłowy lub wygasły kod aktywacyjny', 'bad_code');
    }
    const problem = passwordProblem(password, user.nick);
    if (problem) throw new AppError(400, problem, 'validation');
    const h = await hashPassword(password);
    await this.#updateUsers((doc) => {
      const u = doc.users[user.id];
      if (!u.activation || u.activation.codeHash !== user.activation.codeHash) throw new AppError(400, 'Kod został już użyty', 'bad_code');
      u.passwordHash = h; u.status = 'active'; u.activation = null; u.guest = false;
      u.passwordChangedAt = now(); u.updatedAt = now();
      return doc;
    });
    await this.revokeAll(user.id);
    await this.audit('user.activate', { userId: user.id });
    return this.createSession(user.id, { ip, ua }).then(async (s) => ({ user: await this.getUser(user.id), ...s }));
  }

  // --- administracja ---
  async issueActivation(adminId, userId, purpose = 'activate') {
    const code = newActivationCode();
    const hours = purpose === 'reset' ? 24 : 7 * 24;
    await this.#updateUsers((doc) => {
      const u = doc.users[userId];
      if (!u) throw new AppError(404, 'Brak użytkownika');
      if (u.status === 'disabled') throw new AppError(400, 'Konto jest zablokowane');
      u.activation = { codeHash: sha(normCode(code)), expiresAt: new Date(Date.now() + hours * 3600e3).toISOString(), purpose, issuedBy: adminId, issuedAt: now() };
      u.updatedAt = now();
      return doc;
    });
    await this.audit('admin.activation', { adminId, userId, purpose });
    return { code, expiresInHours: hours };
  }

  async setRole(adminId, userId, role) {
    if (!['admin', 'player'].includes(role)) throw new AppError(400, 'Zła rola');
    await this.#updateUsers((doc) => {
      const u = doc.users[userId];
      if (!u) throw new AppError(404, 'Brak użytkownika');
      if (role === 'player' && u.role === 'admin' && Object.values(doc.users).filter((x) => x.role === 'admin' && x.status === 'active').length <= 1) {
        throw new AppError(400, 'Musi zostać co najmniej jeden administrator');
      }
      u.role = role; u.updatedAt = now();
      return doc;
    });
    await this.audit('admin.role', { adminId, userId, role });
  }

  async setStatus(adminId, userId, status) {
    if (!['active', 'disabled', 'pending'].includes(status)) throw new AppError(400, 'Zły status');
    await this.#updateUsers((doc) => {
      const u = doc.users[userId];
      if (!u) throw new AppError(404, 'Brak użytkownika');
      if (userId === adminId) throw new AppError(400, 'Nie możesz zmienić statusu własnego konta');
      if (status === 'active' && !u.passwordHash) throw new AppError(400, 'Konto bez hasła aktywuje się kodem aktywacyjnym');
      u.status = status; u.updatedAt = now();
      return doc;
    });
    if (status === 'disabled') await this.revokeAll(userId);
    await this.audit('admin.status', { adminId, userId, status });
  }

  // Profil gracza bez hasła (np. gość przy stole). Można go później aktywować kodem.
  async createProfile(byUserId, nick) {
    const problem = nickProblem(nick);
    if (problem) throw new AppError(400, problem, 'validation');
    const clean = cleanNick(nick);
    const id = randId('u');
    await this.#updateUsers((doc) => {
      if (Object.values(doc.users).some((u) => u.nickKey === nickKey(clean))) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
      const t = now();
      doc.users[id] = { id, nick: clean, nickKey: nickKey(clean), role: 'player', status: 'pending', guest: true, passwordHash: null, createdAt: t, updatedAt: t, activation: null, profile: {}, nickHistory: [], createdBy: byUserId };
      return doc;
    });
    await this.audit('user.profile', { byUserId, userId: id, nick: clean });
    return this.getUser(id);
  }
}

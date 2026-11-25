// Stan aplikacji, pamięć podręczna w telefonie i kolejka operacji offline z kontrolą wersji.
import { api, get, post, put, setCsrf, NetworkError, ApiError } from './api.js';
import { computeMatch, validateRoundInput } from '/shared/scoring.js';
import { normalizeSettings } from '/shared/rules.js';
import { groupKey } from '/shared/stats.js';
import { uid } from './dom.js';

const listeners = new Set();
export const state = {
  me: null,
  users: [],
  matches: [],
  meets: [],
  rooms: [],
  defaults: normalizeSettings({}),
  online: navigator.onLine,
  loaded: false,
  conflicts: [], // { matchId, ops, server }
  syncing: false,
};
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what) { for (const fn of listeners) fn(what); }

const key = (k) => `tys2:${k}:${state.me ? state.me.id : 'anon'}`;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* brak miejsca */ } };

export const userById = (id) => state.users.find((u) => u.id === id);
export const nick = (id) => (userById(id) || { nick: '?' }).nick;
export const matchById = (id) => state.matches.find((m) => m.id === id);

function persist() {
  if (!state.me) return;
  lsSet(key('data'), { users: state.users, matches: state.matches, meets: state.meets, savedAt: new Date().toISOString() });
}
export const queue = () => lsGet(key('queue'), []);
const setQueue = (q) => lsSet(key('queue'), q);
export const pendingFor = (matchId) => queue().filter((o) => o.matchId === matchId);

export async function loadMe() {
  try {
    const r = await get('/api/me');
    state.me = r.user;
    if (r.csrf) setCsrf(r.csrf);
    if (state.me) lsSet('tys2:lastUser', state.me);
    return state.me;
  } catch (e) {
    if (e instanceof NetworkError) {
      // Bez sieci: pokaż dane ostatnio zalogowanego (zapisane w tym telefonie).
      state.me = lsGet('tys2:lastUser', null);
      state.online = false;
      return state.me;
    }
    throw e;
  }
}

export async function loadData() {
  const cached = lsGet(key('data'), null);
  try {
    const d = await get('/api/data');
    state.users = d.users;
    state.meets = d.meets;
    state.rooms = d.rooms;
    state.defaults = d.settings;
    // Mecze z niewysłanymi operacjami zostają w wersji lokalnej, dopóki się nie zsynchronizują.
    const pend = new Set(queue().map((o) => o.matchId));
    const local = cached ? Object.fromEntries(cached.matches.map((m) => [m.id, m])) : {};
    state.matches = d.matches.map((m) => (pend.has(m.id) && local[m.id] ? local[m.id] : m));
    for (const id of pend) if (!state.matches.find((m) => m.id === id) && local[id]) state.matches.push(local[id]);
    state.online = true;
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    if (cached) Object.assign(state, { users: cached.users, matches: cached.matches, meets: cached.meets });
    state.online = false;
  }
  state.loaded = true;
  persist();
  emit('data');
  if (state.online) flush();
}

export async function refreshMatch(id) {
  if (pendingFor(id).length) return;
  try {
    const { match } = await get('/api/matches/' + encodeURIComponent(id));
    const i = state.matches.findIndex((m) => m.id === id);
    if (match.status === 'deleted' && state.me.role !== 'admin') { if (i >= 0) state.matches.splice(i, 1); }
    else if (i >= 0) state.matches[i] = match; else state.matches.push(match);
    persist();
    emit('match:' + id);
  } catch { /* odświeży się później */ }
}

// --- operacje na meczach (optymistycznie lokalnie + kolejka) ---
function localApply(op) {
  const m = matchById(op.matchId);
  if (op.kind === 'create') {
    if (m) return;
    const seats = op.payload.seats;
    state.matches.push({ id: op.matchId, schema: 2, mode: 'offline', seats, settings: normalizeSettings(op.payload.settings), firstDealerSeat: op.payload.firstDealerSeat || 0, rounds: [], status: 'active', winner: null, createdAt: new Date().toISOString(), createdBy: state.me.id, meetId: null, groupKey: groupKey(seats), rev: 1, local: true, modeHistory: [] });
    return;
  }
  if (!m) throw new Error('Brak meczu w telefonie');
  if (op.kind === 'addRound') {
    const valid = validateRoundInput(m, op.payload.round);
    const c = computeMatch(m);
    m.rounds.push({ id: 'local-' + op.opId, mode: 'offline', ...valid, dealer: c.nextDealer, createdAt: new Date().toISOString(), createdBy: state.me.id, pending: true });
  } else if (op.kind === 'editRound') {
    const i = m.rounds.findIndex((r) => r.id === op.roundId);
    const valid = validateRoundInput(m, op.payload.round);
    m.rounds[i] = { ...m.rounds[i], ...valid, pending: true };
    if (op.payload.truncate) { const c = computeMatch(m); m.rounds = m.rounds.slice(0, c.rows.length); }
  } else if (op.kind === 'undo') {
    m.rounds.pop();
  } else if (op.kind === 'status') {
    m.status = op.payload.status;
  }
  const c = computeMatch(m);
  if (c.winner !== null) { m.winner = c.winner; if (m.status !== 'deleted') m.status = 'finished'; m.finishedAt = m.finishedAt || new Date().toISOString(); }
  else { m.winner = null; if (m.status === 'finished') m.status = 'active'; }
  m.rev = (m.rev || 0) + 1;
}

export async function matchOp(kind, matchId, payload = {}, extra = {}) {
  const m = matchById(matchId);
  const op = { opId: uid('op'), kind, matchId, payload, baseRev: m ? m.rev : 0, at: new Date().toISOString(), ...extra };
  if (kind === 'undo') op.roundId = m.rounds[m.rounds.length - 1].id;
  // Najpierw walidacja i zastosowanie lokalne (to samo, co zrobi serwer) – błąd zasad nie trafia do kolejki.
  localApply(op);
  const q = queue();
  q.push(op);
  setQueue(q);
  persist();
  emit('match:' + matchId);
  await flush();
  return matchById(matchId);
}

const endpoint = (op) => {
  const id = encodeURIComponent(op.matchId);
  switch (op.kind) {
    case 'create': return ['POST', '/api/matches', { ...op.payload, id: op.matchId, opId: op.opId }];
    case 'addRound': return ['POST', `/api/matches/${id}/rounds`, { baseRev: op.baseRev, opId: op.opId, round: op.payload.round }];
    case 'editRound': return ['PUT', `/api/matches/${id}/rounds/${encodeURIComponent(op.roundId)}`, { baseRev: op.baseRev, opId: op.opId, round: op.payload.round, truncate: !!op.payload.truncate }];
    case 'undo': return ['POST', `/api/matches/${id}/undo`, { baseRev: op.baseRev, opId: op.opId, roundId: op.roundId }];
    case 'status': return ['POST', `/api/matches/${id}/status`, { baseRev: op.baseRev, opId: op.opId, status: op.payload.status }];
    default: throw new Error('op');
  }
};

let flushing = null;
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    // Bez tego przy pustej kolejce całość wykonałaby się synchronicznie, a `finally` wyzerowałby
    // `flushing` PRZED przypisaniem – kolejne synchronizacje byłyby po cichu pomijane.
    await Promise.resolve();
    state.syncing = true;
    emit('sync');
    try {
      for (;;) {
        const q = queue();
        const op = q.find((o) => !state.conflicts.some((c) => c.matchId === o.matchId));
        if (!op) break;
        const [method, url, body] = endpoint(op);
        try {
          const res = await api(method, url, body);
          const server = res.match;
          applyServerMatch(server);
          const rest = queue().filter((o) => o.opId !== op.opId);
          // Kolejne operacje tego meczu opierały się na wersji lokalnej – przesuwamy je na wersję serwera.
          let rev = server.rev;
          for (const o of rest) if (o.matchId === op.matchId) o.baseRev = rev++;
          setQueue(rest);
          state.online = true;
        } catch (e) {
          if (e instanceof NetworkError) { state.online = false; break; }
          if (e instanceof ApiError && e.status === 409 && e.code === 'conflict') {
            const ops = queue().filter((o) => o.matchId === op.matchId);
            state.conflicts.push({ matchId: op.matchId, ops, server: e.data.current });
            emit('conflict');
            continue;
          }
          if (e instanceof ApiError && e.status === 401) break;
          // Operacja odrzucona przez serwer (np. zasady) – usuwamy ją i przywracamy stan serwera.
          setQueue(queue().filter((o) => o.matchId !== op.matchId || o.opId !== op.opId));
          state.rejected = { op, error: e.message };
          emit('rejected');
          await refreshMatchForce(op.matchId);
        }
      }
    } finally {
      state.syncing = false;
      persist();
      emit('sync');
      flushing = null;
    }
  })();
  return flushing;
}

function applyServerMatch(server) {
  if (!server) return;
  const { appliedOps, ...m } = server;
  const i = state.matches.findIndex((x) => x.id === m.id);
  const stillPending = queue().filter((o) => o.matchId === m.id).length > 1;
  if (stillPending) {
    // Lokalne rozdania wciąż czekają – zachowujemy wersję lokalną, ale aktualizujemy pola serwera.
    if (i >= 0) Object.assign(state.matches[i], { meetId: m.meetId, local: false });
    return;
  }
  if (i >= 0) state.matches[i] = m; else state.matches.push(m);
  emit('match:' + m.id);
}

async function refreshMatchForce(id) {
  try {
    const { match } = await get('/api/matches/' + encodeURIComponent(id));
    applyServerMatch(match);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) { state.matches = state.matches.filter((m) => m.id !== id); emit('data'); }
  }
}

// Rozwiązanie konfliktu: 'discard' – przyjmij stan serwera; 'reapply' – dodaj moje rozdania na końcu aktualnego meczu.
export async function resolveConflict(matchId, how) {
  const c = state.conflicts.find((x) => x.matchId === matchId);
  if (!c) return;
  state.conflicts = state.conflicts.filter((x) => x !== c);
  setQueue(queue().filter((o) => o.matchId !== matchId));
  if (c.server) applyServerMatch(c.server); else await refreshMatchForce(matchId);
  if (how === 'reapply') {
    for (const op of c.ops.filter((o) => o.kind === 'addRound')) {
      try { await matchOp('addRound', matchId, op.payload); } catch (e) { state.rejected = { op, error: e.message }; emit('rejected'); }
    }
  }
  persist();
  emit('data');
  flush();
}

export async function createMatch({ seats, settings, firstDealerSeat = 0 }) {
  const id = uid('m_');
  await matchOp('create', id, { seats, settings, firstDealerSeat });
  return id;
}

export async function logout() {
  try { await post('/api/auth/logout'); } catch { /* i tak czyścimy */ }
  try { localStorage.removeItem(key('data')); localStorage.removeItem('tys2:lastUser'); } catch { /* */ }
  state.me = null;
  state.matches = [];
  state.users = [];
  setCsrf('');
  emit('auth');
}

export { get, post, put };

// Walidacja dokumentów przed zapisem. Zapis nie przejdzie, jeśli dane łamią schemat.
import { ValidationError } from './jsonStore.js';
import { normalizeSettings, MELD_VALUES } from '../../shared/rules.js';

export const ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function fail(where, msg) { throw new ValidationError(`${where}: ${msg}`); }
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const isIso = (x) => typeof x === 'string' && (ISO_RE.test(x) || !Number.isNaN(Date.parse(x)));
function req(cond, where, msg) { if (!cond) fail(where, msg); }

export function validateUser(u, where = 'user') {
  req(isObj(u), where, 'nie jest obiektem');
  req(ID_RE.test(u.id || ''), where, 'zły identyfikator');
  req(typeof u.nick === 'string' && u.nick.length >= 2 && u.nick.length <= 20, where, 'zły nick');
  req(typeof u.nickKey === 'string' && u.nickKey.length >= 2, where, 'brak klucza nicku');
  req(['admin', 'player'].includes(u.role), where, 'zła rola');
  req(['active', 'pending', 'disabled'].includes(u.status), where, 'zły status');
  req(u.passwordHash === null || typeof u.passwordHash === 'string', where, 'zły hash hasła');
  req(u.status !== 'active' || typeof u.passwordHash === 'string', where, 'aktywne konto bez hasła');
  req(isIso(u.createdAt), where, 'zła data utworzenia');
  if (u.activation != null) {
    req(isObj(u.activation) && typeof u.activation.codeHash === 'string' && isIso(u.activation.expiresAt), where, 'zły kod aktywacji');
  }
}

export function validateUsersDoc(d) {
  req(isObj(d) && isObj(d.users), 'users', 'brak mapy users');
  const keys = new Set();
  for (const [id, u] of Object.entries(d.users)) {
    validateUser(u, `users.${id}`);
    req(u.id === id, `users.${id}`, 'id niezgodne z kluczem');
    req(!keys.has(u.nickKey), `users.${id}`, 'zduplikowany nick');
    keys.add(u.nickKey);
  }
}

export function validateAuthDoc(d) {
  req(isObj(d) && isObj(d.sessions), 'auth', 'brak sesji');
  for (const [id, s] of Object.entries(d.sessions)) {
    req(isObj(s) && s.id === id && typeof s.tokenHash === 'string' && s.tokenHash.length === 64, `auth.${id}`, 'zła sesja');
    req(ID_RE.test(s.userId || ''), `auth.${id}`, 'zły użytkownik sesji');
  }
}

export function validateRound(r, seats, where) {
  req(isObj(r), where, 'rozdanie nie jest obiektem');
  req(ID_RE.test(r.id || ''), where, 'zły identyfikator rozdania');
  req(['offline', 'online'].includes(r.mode), where, 'zły tryb rozdania');
  req(seats.includes(r.bidder), where, 'licytujący spoza meczu');
  req(Number.isInteger(r.bid) && r.bid > 0, where, 'zły kontrakt');
  req(typeof r.made === 'boolean', where, 'brak wyniku kontraktu');
  req(r.got === null || r.got === undefined || Number.isFinite(r.got), where, 'złe ugrane punkty');
  req(isObj(r.cards), where, 'brak punktów z kart');
  for (const [k, v] of Object.entries(r.cards)) {
    req((k === '0' || k === '1') && (v === null || (Number.isInteger(v) && v >= 0 && v <= 120)), where, 'złe punkty z kart');
  }
  req(isObj(r.melds), where, 'złe meldunki');
  for (const [uid, list] of Object.entries(r.melds)) {
    req(seats.includes(uid) && Array.isArray(list) && list.every((s) => s in MELD_VALUES), where, 'złe meldunki');
  }
  req(r.dealer == null || seats.includes(r.dealer), where, 'zły rozdający');
  req(isIso(r.createdAt), where, 'zła data rozdania');
  req(r.scoring === undefined || r.scoring === 'legacy', where, 'zły sposób liczenia');
}

export function validateMatch(m, name = 'match') {
  req(isObj(m), name, 'nie jest obiektem');
  req(ID_RE.test(m.id || ''), name, 'zły identyfikator');
  req(Array.isArray(m.seats) && m.seats.length === 4 && new Set(m.seats).size === 4 && m.seats.every((s) => ID_RE.test(s)), name, 'potrzeba 4 różnych graczy');
  req(['offline', 'online'].includes(m.mode), name, 'zły tryb');
  req(['active', 'finished', 'abandoned', 'deleted'].includes(m.status), name, 'zły status');
  req(m.winner === null || m.winner === 0 || m.winner === 1, name, 'zły zwycięzca');
  req(Array.isArray(m.rounds), name, 'brak rozdań');
  try { normalizeSettings(m.settings); } catch (e) { fail(name, e.message); }
  const ids = new Set();
  m.rounds.forEach((r, i) => {
    validateRound(r, m.seats, `${name}.rounds[${i}]`);
    req(!ids.has(r.id), name, 'zduplikowane id rozdania');
    ids.add(r.id);
  });
  req(typeof m.groupKey === 'string' && m.groupKey === groupKeyOf(m.seats), name, 'zły klucz grupy');
  req(isIso(m.createdAt), name, 'zła data');
  req(Array.isArray(m.appliedOps || []), name, 'złe appliedOps');
}

export function validateMeetsDoc(d) {
  req(isObj(d) && isObj(d.meets), 'meets', 'brak mapy');
  for (const [id, s] of Object.entries(d.meets)) {
    req(isObj(s) && s.id === id && Array.isArray(s.players) && s.players.length === 4, `meets.${id}`, 'zła sesja');
    req(s.groupKey === groupKeyOf(s.players), `meets.${id}`, 'zły klucz grupy');
    req(['open', 'closed'].includes(s.status), `meets.${id}`, 'zły status');
  }
}

export function validateRoom(r, name = 'room') {
  req(isObj(r) && ID_RE.test(r.id || ''), name, 'zły pokój');
  req(typeof r.code === 'string' && /^[A-Z0-9]{6}$/.test(r.code), name, 'zły kod');
  req(Array.isArray(r.seats) && r.seats.length === 4, name, 'złe miejsca');
  req(['lobby', 'playing', 'between', 'finished', 'closed'].includes(r.status), name, 'zły status');
}

export function validateConfig(c) {
  req(isObj(c), 'config', 'nie jest obiektem');
  req(typeof c.registrationOpen === 'boolean', 'config', 'registrationOpen');
  try { normalizeSettings(c.defaultSettings || {}); } catch (e) { fail('config', e.message); }
}

export function groupKeyOf(ids) {
  return ids.slice().sort().join('~');
}

export const validators = {
  users: validateUsersDoc,
  auth: validateAuthDoc,
  meets: validateMeetsDoc,
  config: validateConfig,
  'matches/': (d, name) => validateMatch(d, name),
  'rooms/': (d, name) => validateRoom(d, name),
};

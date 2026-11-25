// Mecze, rozdania i sesje gry (spotkania). Każda zmiana meczu: kontrola wersji (rev),
// idempotencja operacji (opId), walidacja zasad i przeliczenie wyniku po stronie serwera.
import crypto from 'node:crypto';
import { computeMatch, validateRoundInput } from '../../shared/scoring.js';
import { normalizeSettings, RuleError } from '../../shared/rules.js';
import { groupKeyOf, ID_RE } from '../store/schemas.js';
import { AppError } from './accounts.js';
import { ConflictError } from '../store/jsonStore.js';

const now = () => new Date().toISOString();
const rid = (p) => p + crypto.randomBytes(8).toString('hex');
const MEET_GAP_MS = 12 * 3600e3;
const MAX_OPS = 300;

export class Matches {
  constructor(store, { accounts, audit, isLive = async () => false, hasRoom = async () => false, onChange = () => {} }) {
    this.store = store;
    this.accounts = accounts;
    this.audit = audit;
    this.isLive = isLive;       // czy mecz ma trwające rozdanie online
    this.hasRoom = hasRoom;     // czy mecz jest otwarty w pokoju online (także między rozdaniami)
    this.onChange = onChange;   // powiadomienie (np. WebSocket)
  }

  async list({ includeDeleted = false } = {}) {
    const names = await this.store.list('matches');
    const out = [];
    for (const n of names) {
      const d = await this.store.get(n);
      if (d && (includeDeleted || d.data.status !== 'deleted')) out.push({ ...d.data, rev: d.rev });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id) {
    if (!ID_RE.test(id || '')) throw new AppError(400, 'Zły identyfikator meczu');
    const d = await this.store.get('matches/' + id);
    if (!d) throw new AppError(404, 'Nie ma takiego meczu', 'not_found');
    return { ...d.data, rev: d.rev };
  }

  canEdit(user, match) {
    return user.role === 'admin' || match.seats.includes(user.id) || match.createdBy === user.id;
  }

  static applyResult(match) {
    const c = computeMatch(match);
    if (c.winner !== null) {
      match.winner = c.winner;
      if (match.status !== 'deleted') match.status = 'finished';
      match.finishedAt = match.finishedAt || now();
    } else {
      match.winner = null;
      if (match.status === 'finished') match.status = 'active';
      delete match.finishedAt;
    }
    return c;
  }

  async #checkSeats(seats) {
    if (!Array.isArray(seats) || seats.length !== 4 || new Set(seats).size !== 4) throw new AppError(400, 'Wybierz czterech różnych graczy');
    for (const id of seats) {
      const u = await this.accounts.getUser(id);
      if (!u) throw new AppError(400, 'Nieznany gracz');
      if (u.status === 'disabled') throw new AppError(400, `Konto ${u.nick} jest zablokowane`);
    }
  }

  async create(user, { id, seats, settings, firstDealerSeat = 0, meetId, opId, mode = 'offline' }) {
    await this.#checkSeats(seats);
    const S = (() => { try { return normalizeSettings(settings || {}); } catch (e) { throw new AppError(400, e.message, 'validation'); } })();
    if (!Number.isInteger(firstDealerSeat) || firstDealerSeat < 0 || firstDealerSeat > 3) throw new AppError(400, 'Zły pierwszy rozdający');
    const matchId = id || rid('m_');
    if (!ID_RE.test(matchId)) throw new AppError(400, 'Zły identyfikator meczu');
    const meet = await this.resolveMeet(user, seats, meetId);
    let created = false;
    const res = await this.store.update('matches/' + matchId, (cur) => {
      if (cur) {
        if (opId && cur.createdOp === opId) return undefined; // powtórzone żądanie
        throw new AppError(409, 'Mecz o tym identyfikatorze już istnieje', 'exists');
      }
      created = true;
      return {
        id: matchId, schema: 2, mode, seats: seats.slice(), settings: S, firstDealerSeat,
        rounds: [], status: 'active', winner: null, createdAt: now(), createdBy: user.id,
        createdOp: opId || null, meetId: meet.id, groupKey: groupKeyOf(seats), roomId: null,
        modeHistory: [{ mode, at: now(), by: user.id, afterRound: 0 }], appliedOps: opId ? [opId] : [],
      };
    });
    if (created) {
      await this.audit('match.create', { userId: user.id, matchId, seats });
      this.onChange(matchId);
    }
    return { ...res.data, rev: res.rev };
  }

  // --- sesje gry (spotkania) ---
  async meets() { return Object.values(((await this.store.getData('meets')) || { meets: {} }).meets); }

  async resolveMeet(user, players, meetId) {
    const gk = groupKeyOf(players);
    let result = null;
    await this.store.update('meets', (doc) => {
      doc = doc || { meets: {} };
      const t = Date.now();
      if (meetId) {
        const m = doc.meets[meetId];
        if (!m) throw new AppError(404, 'Nie ma takiej sesji');
        if (m.status !== 'open') throw new AppError(400, 'Ta sesja jest zakończona');
        if (m.groupKey !== gk) throw new AppError(400, 'Sesja dotyczy innej czwórki graczy');
        m.lastActivityAt = new Date(t).toISOString();
        result = m;
        return doc;
      }
      for (const m of Object.values(doc.meets)) {
        if (m.groupKey === gk && m.status === 'open') {
          if (t - Date.parse(m.lastActivityAt) <= MEET_GAP_MS) { m.lastActivityAt = new Date(t).toISOString(); result = m; return doc; }
          m.status = 'closed'; m.endedAt = m.lastActivityAt; m.closedReason = 'auto';
        }
      }
      const m = { id: rid('s_'), groupKey: gk, players: players.slice(), status: 'open', startedAt: new Date(t).toISOString(), endedAt: null, lastActivityAt: new Date(t).toISOString(), createdBy: user.id };
      doc.meets[m.id] = m;
      result = m;
      return doc;
    });
    return result;
  }

  async startMeet(user, players) {
    await this.#checkSeats(players);
    const gk = groupKeyOf(players);
    let created = null;
    await this.store.update('meets', (doc) => {
      doc = doc || { meets: {} };
      for (const m of Object.values(doc.meets)) {
        if (m.groupKey === gk && m.status === 'open') { m.status = 'closed'; m.endedAt = now(); m.closedReason = 'new'; }
      }
      created = { id: rid('s_'), groupKey: gk, players: players.slice(), status: 'open', startedAt: now(), endedAt: null, lastActivityAt: now(), createdBy: user.id };
      doc.meets[created.id] = created;
      return doc;
    });
    await this.audit('meet.start', { userId: user.id, meetId: created.id });
    return created;
  }

  async closeMeet(user, meetId) {
    let out = null;
    await this.store.update('meets', (doc) => {
      const m = doc && doc.meets[meetId];
      if (!m) throw new AppError(404, 'Nie ma takiej sesji');
      if (user.role !== 'admin' && !m.players.includes(user.id)) throw new AppError(403, 'To nie twoja sesja');
      if (m.status === 'closed') { out = m; return undefined; }
      m.status = 'closed'; m.endedAt = now(); m.closedReason = 'manual';
      out = m;
      return doc;
    });
    return out;
  }

  async #touchMeet(meetId) {
    if (!meetId) return;
    await this.store.update('meets', (doc) => {
      const m = doc && doc.meets[meetId];
      if (!m) return undefined;
      m.lastActivityAt = now();
      return doc;
    }).catch(() => {});
  }

  // Wspólny szkielet operacji na meczu.
  async #mutate(user, id, { baseRev, opId }, fn, { allowLive = false } = {}) {
    if (opId != null && (typeof opId !== 'string' || opId.length > 64)) throw new AppError(400, 'Zły identyfikator operacji');
    if (!Number.isInteger(baseRev)) throw new AppError(400, 'Brak wersji bazowej (baseRev)');
    let replay = false;
    let res;
    try {
      res = await this.store.update('matches/' + id, async (m, rev) => {
        if (!m) throw new AppError(404, 'Nie ma takiego meczu', 'not_found');
        if (opId && (m.appliedOps || []).includes(opId)) { replay = true; return undefined; }
        if (rev !== baseRev) throw new ConflictError({ ...m, rev });
        if (user && !this.canEdit(user, m)) throw new AppError(403, 'Nie możesz zmieniać tego meczu');
        if (!allowLive && (await this.isLive(id))) throw new AppError(409, 'Trwa rozdanie online w tym meczu – dokończ je przed zmianą wyników', 'live');
        await fn(m);
        Matches.applyResult(m);
        if (opId) m.appliedOps = [...(m.appliedOps || []), opId].slice(-MAX_OPS);
        m.updatedAt = now();
        if (user) m.updatedBy = user.id;
        return m;
      });
    } catch (e) {
      if (e instanceof RuleError) throw new AppError(400, e.message, 'rule');
      throw e;
    }
    if (!replay) this.onChange(id);
    const m = { ...res.data, rev: res.rev };
    if (!replay) await this.#touchMeet(m.meetId);
    return { match: m, replay };
  }

  async addRound(user, id, { baseRev, opId, round }) {
    let added = null;
    const out = await this.#mutate(user, id, { baseRev, opId }, (m) => {
      if (m.status !== 'active') throw new AppError(400, 'Mecz nie jest w toku', 'not_active');
      const valid = validateRoundInput(m, round);
      const c = computeMatch(m);
      added = { id: rid('r_'), mode: 'offline', ...valid, dealer: c.nextDealer, createdAt: now(), createdBy: user.id };
      m.rounds.push(added);
    });
    if (!out.replay) await this.audit('round.add', { userId: user.id, matchId: id, roundId: added.id });
    return out;
  }

  async editRound(user, id, roundId, { baseRev, opId, round, truncate = false }) {
    const out = await this.#mutate(user, id, { baseRev, opId }, (m) => {
      if (m.status === 'abandoned' || m.status === 'deleted') throw new AppError(400, 'Najpierw wznów mecz');
      const i = m.rounds.findIndex((r) => r.id === roundId);
      if (i < 0) throw new AppError(404, 'Nie ma takiego rozdania');
      const old = m.rounds[i];
      if (old.mode === 'online') throw new AppError(400, 'Rozdania rozegranego online nie można poprawiać ręcznie – wynik ustalił serwer z zagranych kart');
      const valid = validateRoundInput(m, round);
      const next = { ...old, ...valid, id: old.id, mode: old.mode, dealer: old.dealer, createdAt: old.createdAt, createdBy: old.createdBy, updatedAt: now(), updatedBy: user.id };
      delete next.scoring; delete next.legacy;
      next.history = [...(old.history || []), { at: now(), by: user.id, before: { bid: old.bid, bidder: old.bidder, made: old.made, cards: old.cards, melds: old.melds, got: old.got, ...(old.scoring ? { scoring: old.scoring } : {}) } }].slice(-20);
      if (old.legacy) next.legacy = old.legacy;
      m.rounds[i] = next;
      const c = computeMatch(m);
      if (c.winner !== null && c.rows.length < m.rounds.length) {
        if (!truncate) throw new AppError(409, `Po tej poprawce mecz kończy się na rozdaniu ${c.rows.length}. Potwierdź usunięcie późniejszych rozdań.`, 'would_truncate', { endsAt: c.rows.length });
        m.removedRounds = [...(m.removedRounds || []), ...m.rounds.slice(c.rows.length).map((r) => ({ ...r, removedAt: now(), removedBy: user.id }))];
        m.rounds = m.rounds.slice(0, c.rows.length);
      }
    });
    if (!out.replay) await this.audit('round.edit', { userId: user.id, matchId: id, roundId });
    return out;
  }

  async undoLast(user, id, { baseRev, opId, roundId }) {
    const out = await this.#mutate(user, id, { baseRev, opId }, (m) => {
      if (m.status !== 'active') throw new AppError(400, 'Cofać można tylko w trwającym meczu');
      const last = m.rounds[m.rounds.length - 1];
      if (!last || last.id !== roundId) throw new AppError(409, 'Ostatnie rozdanie zmieniło się – odśwież', 'conflict');
      if (last.mode === 'online') throw new AppError(400, 'Rozdania online nie można cofnąć');
      m.removedRounds = [...(m.removedRounds || []), { ...last, removedAt: now(), removedBy: user.id }];
      m.rounds.pop();
    });
    if (!out.replay) await this.audit('round.undo', { userId: user.id, matchId: id, roundId });
    return out;
  }

  async restoreRound(user, id, { baseRev, opId, roundId }) {
    return this.#mutate(user, id, { baseRev, opId }, (m) => {
      const i = (m.removedRounds || []).findIndex((r) => r.id === roundId);
      if (i < 0) throw new AppError(404, 'Nie ma takiego usuniętego rozdania');
      if (m.status !== 'active') throw new AppError(400, 'Mecz nie jest w toku');
      const r = { ...m.removedRounds[i] };
      delete r.removedAt; delete r.removedBy;
      m.removedRounds.splice(i, 1);
      m.rounds.push(r);
    });
  }

  async setStatus(user, id, { baseRev, opId, status }) {
    // Usunięcie/przerwanie meczu otwartego w pokoju online zablokowałoby stół (wyniku nie byłoby gdzie zapisać).
    if ((status === 'deleted' || status === 'abandoned') && (await this.hasRoom(id))) {
      throw new AppError(409, 'Ten mecz jest otwarty w pokoju online – najpierw przejdź w pokoju do trybu offline albo zakończ grę', 'live');
    }
    const out = await this.#mutate(user, id, { baseRev, opId }, (m) => {
      if (status === 'abandoned') {
        if (m.status !== 'active') throw new AppError(400, 'Przerwać można tylko trwający mecz');
        m.status = 'abandoned';
      } else if (status === 'active') {
        if (m.status === 'deleted' && user.role !== 'admin') throw new AppError(403, 'Przywrócić usunięty mecz może administrator');
        m.status = 'active';
      } else if (status === 'deleted') {
        m.statusBeforeDelete = m.status;
        m.status = 'deleted';
      } else {
        throw new AppError(400, 'Zły status');
      }
    }, { allowLive: false });
    // applyResult mógł przywrócić 'finished' dla meczu z wygraną – to poprawne.
    await this.audit('match.status', { userId: user.id, matchId: id, status });
    return out;
  }

  // Przełączenie trybu (offline ↔ online) – tylko między rozdaniami.
  async setMode(user, id, mode, { roomId = null } = {}) {
    return this.store.update('matches/' + id, async (m) => {
      if (!m) throw new AppError(404, 'Nie ma takiego meczu');
      if (m.status !== 'active') throw new AppError(400, 'Mecz nie jest w toku');
      if (m.mode === mode && m.roomId === roomId) return undefined;
      if (m.mode !== mode) m.modeHistory = [...(m.modeHistory || []), { mode, at: now(), by: user ? user.id : null, afterRound: m.rounds.length }];
      m.mode = mode;
      m.roomId = roomId;
      m.updatedAt = now();
      return m;
    }).then((r) => { this.onChange(id); return { ...r.data, rev: r.rev }; });
  }

  // Wynik rozdania online (wywołuje wyłącznie serwer gry).
  async appendOnlineRound(id, roundData, handInfo) {
    let added = null;
    const res = await this.store.update('matches/' + id, (m) => {
      if (!m) throw new AppError(404, 'Nie ma meczu');
      if (m.status !== 'active') throw new AppError(400, 'Mecz nie jest w toku');
      if (handInfo && (m.appliedOps || []).includes(handInfo.opId)) return undefined;
      const c = computeMatch(m);
      const valid = validateRoundInput(m, { bidder: roundData.bidder, bid: roundData.bid, cards: roundData.cards, melds: roundData.melds });
      added = {
        id: rid('r_'), mode: 'online', ...valid, dealer: m.seats[handInfo.dealerSeat] ?? c.nextDealer,
        createdAt: now(), createdBy: null, roomId: handInfo.roomId, tricksWon: roundData.tricksWon, plays: roundData.plays,
      };
      m.rounds.push(added);
      Matches.applyResult(m);
      m.appliedOps = [...(m.appliedOps || []), handInfo.opId].slice(-MAX_OPS);
      m.updatedAt = now();
      return m;
    });
    this.onChange(id);
    await this.#touchMeet(res.data.meetId);
    return { match: { ...res.data, rev: res.rev }, round: added };
  }
}

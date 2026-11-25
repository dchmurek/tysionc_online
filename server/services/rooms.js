// Pokoje i rozgrywka online. Serwer autorytatywny: talia, ręce, kolejność, legalność, wynik.
// Stan pokoju (z ukrytymi kartami) zapisywany po każdej akcji w rooms/<id>.json – przeżywa restart.
import crypto from 'node:crypto';
import { createHand, applyAction, viewFor, handToRound } from '../../shared/cards.js';
import { computeMatch } from '../../shared/scoring.js';
import { normalizeSettings, RuleError, teamOfSeat } from '../../shared/rules.js';
import { AppError } from './accounts.js';

const now = () => new Date().toISOString();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE_LOBBY_MS = 24 * 3600e3;

export class Rooms {
  constructor(store, { matches, accounts, audit, randomInt = (n) => crypto.randomInt(n), onUpdate = () => {} }) {
    this.store = store;
    this.matches = matches;
    this.accounts = accounts;
    this.audit = audit;
    this.randomInt = randomInt;
    this.onUpdate = onUpdate;
    this.rooms = new Map();
    this.chains = new Map();
  }

  async init() {
    for (const name of await this.store.list('rooms')) {
      const d = await this.store.getData(name);
      if (d && d.status !== 'closed') this.rooms.set(d.id, d);
    }
    return this.rooms.size;
  }

  #newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (![...this.rooms.values()].some((r) => r.code === c)) return c;
    }
  }

  // Serializacja operacji na jednym pokoju (dwa jednoczesne żądania nie mieszają stanu).
  #serial(roomId, fn) {
    const prev = this.chains.get(roomId) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});
    this.chains.set(roomId, tail);
    return run;
  }

  async #save(room) {
    room.updatedAt = now();
    await this.store.update('rooms/' + room.id, () => structuredClone(room));
  }

  get(roomId) {
    const r = this.rooms.get(roomId);
    if (!r) throw new AppError(404, 'Nie ma takiego pokoju', 'not_found');
    return r;
  }

  async isLive(matchId) {
    return [...this.rooms.values()].some((r) => r.matchId === matchId && r.status === 'playing');
  }

  roomForMatch(matchId) {
    return [...this.rooms.values()].find((r) => r.matchId === matchId && r.status !== 'closed') || null;
  }

  listForUser(userId) {
    return [...this.rooms.values()].filter((r) => r.members.includes(userId) && r.status !== 'closed').map((r) => this.summary(r));
  }

  summary(r) {
    return { id: r.id, code: r.code, status: r.status, seats: r.seats.slice(), matchId: r.matchId, createdAt: r.createdAt };
  }

  async create(user, { fromMatchId = null, settings = null } = {}) {
    let reserved = null;
    let S;
    if (fromMatchId) {
      const m = await this.matches.get(fromMatchId);
      if (m.status !== 'active') throw new AppError(400, 'Ten mecz nie jest w toku');
      if (!m.seats.includes(user.id) && user.role !== 'admin') throw new AppError(403, 'Nie grasz w tym meczu');
      const existing = this.roomForMatch(fromMatchId);
      if (existing) return this.summary(existing);
      reserved = m.seats.slice();
      S = m.settings;
    } else {
      try { S = normalizeSettings(settings || {}); } catch (e) { throw new AppError(400, e.message); }
    }
    const room = {
      id: 'room_' + crypto.randomBytes(8).toString('hex'), code: this.#newCode(), createdBy: user.id, createdAt: now(),
      status: 'lobby', seats: [null, null, null, null], ready: [false, false, false, false], members: [user.id],
      reservedSeats: reserved, matchId: fromMatchId, settings: S, hand: null, handNo: 0, lastHand: null, seq: 0,
      recentActions: [], log: [],
    };
    if (reserved && reserved.includes(user.id)) room.seats[reserved.indexOf(user.id)] = user.id;
    this.rooms.set(room.id, room);
    await this.#save(room);
    await this.audit('room.create', { userId: user.id, roomId: room.id, fromMatchId });
    return this.summary(room);
  }

  async joinByCode(user, code) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = [...this.rooms.values()].find((r) => r.code === c && r.status !== 'closed');
    if (!room) throw new AppError(404, 'Nie ma pokoju z takim kodem', 'not_found');
    return this.#serial(room.id, async () => {
      if (!room.members.includes(user.id)) {
        if (room.members.length >= 12) throw new AppError(400, 'Pokój jest pełny');
        room.members.push(user.id);
      }
      // Kontynuacja meczu: gracz automatycznie siada na swoim miejscu.
      if (room.reservedSeats && room.reservedSeats.includes(user.id) && room.status === 'lobby') {
        room.seats[room.reservedSeats.indexOf(user.id)] = user.id;
      }
      await this.#save(room);
      this.onUpdate(room.id, room);
      return this.summary(room);
    });
  }

  // Główna obsługa akcji z WebSocketu / HTTP.
  async act(user, roomId, msg) {
    const room = this.get(roomId);
    return this.#serial(roomId, async () => {
      if (!room.members.includes(user.id)) throw new AppError(403, 'Najpierw dołącz do pokoju kodem');
      if (msg.actionId) {
        if (typeof msg.actionId !== 'string' || msg.actionId.length > 64) throw new AppError(400, 'Zły identyfikator akcji');
        if (room.recentActions.includes(msg.actionId)) return { duplicate: true };
      }
      if (msg.expectSeq != null && msg.expectSeq !== room.seq && ['bid', 'pass', 'play', 'give', 'give-all'].includes(msg.type)) {
        throw new AppError(409, 'Stan gry się zmienił – odświeżam', 'stale');
      }
      try {
        await this.#dispatch(user, room, msg);
      } catch (e) {
        if (e instanceof RuleError) throw new AppError(400, e.message, e.code === 'turn' ? 'turn' : 'illegal');
        throw e;
      }
      if (msg.actionId) room.recentActions = [...room.recentActions, msg.actionId].slice(-100);
      room.seq++;
      await this.#save(room);
      this.onUpdate(room.id, room);
      return { ok: true };
    });
  }

  #seatOf(room, userId) { return room.seats.indexOf(userId); }

  async #dispatch(user, room, msg) {
    const seat = this.#seatOf(room, user.id);
    switch (msg.type) {
      case 'sit': {
        if (room.status !== 'lobby') throw new AppError(400, 'Miejsca wybiera się przed startem gry');
        const s = msg.seat;
        if (!Number.isInteger(s) || s < 0 || s > 3) throw new AppError(400, 'Złe miejsce');
        if (room.reservedSeats && room.reservedSeats[s] !== user.id) throw new AppError(400, 'To miejsce należy do innego gracza tego meczu');
        if (room.seats[s] && room.seats[s] !== user.id) throw new AppError(400, 'Miejsce zajęte');
        if (seat >= 0) { room.seats[seat] = null; room.ready[seat] = false; }
        room.seats[s] = user.id;
        room.ready[s] = false;
        break;
      }
      case 'stand':
        if (room.status !== 'lobby') throw new AppError(400, 'Nie można wstać w trakcie meczu');
        if (seat >= 0) { room.seats[seat] = null; room.ready[seat] = false; }
        break;
      case 'ready': {
        if (seat < 0) throw new AppError(400, 'Najpierw zajmij miejsce');
        if (!['lobby', 'between'].includes(room.status)) throw new AppError(400, 'Teraz nie można zgłosić gotowości');
        room.ready[seat] = msg.ready !== false;
        if (room.status === 'between' && room.ready.every(Boolean)) await this.#deal(room);
        break;
      }
      case 'start': {
        if (room.status !== 'lobby') throw new AppError(400, 'Gra już trwa');
        if (room.seats.some((s) => !s)) throw new AppError(400, 'Potrzeba czterech graczy');
        if (!room.ready.every(Boolean)) throw new AppError(400, 'Wszyscy muszą być gotowi');
        if (seat < 0) throw new AppError(403, 'Start może wykonać tylko gracz przy stole');
        if (!room.matchId) {
          const m = await this.matches.create(user, { seats: room.seats.slice(), settings: room.settings, mode: 'online', firstDealerSeat: 0 });
          room.matchId = m.id;
        } else {
          const m = await this.matches.get(room.matchId);
          if (m.seats.join() !== room.seats.join()) throw new AppError(400, 'Gracze muszą siedzieć na swoich miejscach z meczu');
          if (m.status !== 'active') throw new AppError(400, 'Mecz jest zakończony');
        }
        await this.matches.setMode(user, room.matchId, 'online', { roomId: room.id });
        await this.#deal(room);
        await this.audit('room.start', { roomId: room.id, matchId: room.matchId });
        break;
      }
      case 'bid':
      case 'pass':
      case 'give':
      case 'give-all':
      case 'play': {
        if (room.status !== 'playing' || !room.hand) throw new AppError(400, 'Rozdanie nie trwa');
        if (seat < 0) throw new AppError(403, 'Nie siedzisz przy stole');
        const action = msg.type === 'play' ? { type: 'play', card: msg.card }
          : msg.type === 'bid' ? { type: 'bid', value: msg.value }
            : msg.type === 'give' ? { type: 'give', card: msg.card, to: msg.to }
              : msg.type === 'give-all' ? { type: 'give-all', gives: Array.isArray(msg.gives) ? msg.gives.slice(0, 3).map((g) => ({ card: g && g.card, to: g && g.to })) : null }
                : { type: 'pass' };
        const meldsBefore = room.hand.melds.length;
        // Akcja jest atomowa: gdy zapis wyniku się nie uda, stan wraca sprzed ruchu (gracz może spróbować ponownie),
        // zamiast zostawić rozdanie „zakończone”, którego nie da się już dokończyć.
        const before = structuredClone(room.hand);
        const logBefore = room.log;
        applyAction(room.hand, seat, action);
        // Dziennik widzą wszyscy – karta oddana z musika jest tajna (widzi ją tylko odbiorca).
        const entry = action.type === 'give' ? { type: 'give', to: action.to }
          : action.type === 'give-all' ? { type: 'give-all', to: action.gives.map((g) => g.to) } : { ...action };
        if (room.hand.melds.length > meldsBefore) entry.meld = room.hand.melds.at(-1).suit;
        room.log = [...room.log, { at: now(), seat, ...entry }].slice(-60);
        if (room.hand.phase === 'finished') {
          try {
            await this.#finishHand(room);
          } catch (e) {
            room.hand = before;
            room.log = logBefore;
            throw e;
          }
        }
        break;
      }
      case 'detach': {
        // Online → offline: tylko między rozdaniami.
        if (room.status === 'playing') throw new AppError(400, 'Dokończ rozdanie przed przejściem do trybu offline');
        if (seat < 0 && user.role !== 'admin') throw new AppError(403, 'Tylko gracz przy stole');
        if (room.matchId) {
          const m = await this.matches.get(room.matchId);
          if (m.status === 'active') await this.matches.setMode(user, room.matchId, 'offline', { roomId: null });
        }
        room.status = 'closed';
        this.rooms.delete(room.id);
        await this.audit('room.detach', { roomId: room.id, matchId: room.matchId, userId: user.id });
        break;
      }
      case 'leave': {
        if (room.status === 'playing' || room.status === 'between') throw new AppError(400, 'Mecz trwa – możesz się rozłączyć i wrócić później');
        if (seat >= 0) { room.seats[seat] = null; room.ready[seat] = false; }
        room.members = room.members.filter((m) => m !== user.id);
        if (!room.members.length) { room.status = 'closed'; this.rooms.delete(room.id); }
        break;
      }
      case 'abort-hand': {
        // Awaryjne unieważnienie rozdania (np. gracz trwale zniknął). Tylko administrator; nic nie trafia do historii.
        if (user.role !== 'admin') throw new AppError(403, 'Unieważnić rozdanie może tylko administrator');
        if (room.status !== 'playing') throw new AppError(400, 'Rozdanie nie trwa');
        room.hand = null;
        room.status = 'between';
        room.ready = [false, false, false, false];
        room.log = [...room.log, { at: now(), seat: -1, type: 'abort', by: user.id }].slice(-60);
        await this.audit('room.abort-hand', { roomId: room.id, matchId: room.matchId, adminId: user.id });
        break;
      }
      case 'rematch': {
        if (room.status !== 'finished') throw new AppError(400, 'Rewanż po zakończeniu meczu');
        if (seat < 0) throw new AppError(403, 'Tylko gracz przy stole');
        const old = await this.matches.get(room.matchId);
        const lastDealer = old.rounds.length ? old.seats.indexOf(old.rounds[old.rounds.length - 1].dealer) : -1;
        const m = await this.matches.create(user, { seats: old.seats.slice(), settings: old.settings, mode: 'online', firstDealerSeat: (lastDealer + 1 + 4) % 4, meetId: old.meetId && (await this.#meetOpen(old.meetId)) ? old.meetId : undefined });
        room.matchId = m.id;
        room.reservedSeats = m.seats.slice();
        room.status = 'lobby';
        room.ready = [false, false, false, false];
        room.lastHand = null;
        room.handNo = 0;
        break;
      }
      default:
        throw new AppError(400, 'Nieznana akcja');
    }
  }

  async #meetOpen(meetId) {
    const meets = await this.matches.meets();
    const m = meets.find((x) => x.id === meetId);
    return m && m.status === 'open';
  }

  async #deal(room) {
    const m = await this.matches.get(room.matchId);
    if (!m || m.status !== 'active') throw new AppError(400, 'Mecz nie jest w toku (usunięty, przerwany albo zakończony) – nie można rozdać kart');
    const c = computeMatch(m);
    room.handNo++;
    room.hand = createHand({ dealerSeat: c.nextDealerSeat, settings: m.settings, randomInt: this.randomInt });
    room.handId = `${room.id}-h${room.handNo}-${crypto.randomBytes(4).toString('hex')}`;
    room.status = 'playing';
    room.ready = [false, false, false, false];
    room.lastHand = null;
  }

  async #finishHand(room) {
    const h = room.hand;
    const round = handToRound(h, room.seats);
    const { match, round: saved } = await this.matches.appendOnlineRound(room.matchId, round, { roomId: room.id, dealerSeat: h.dealerSeat, opId: room.handId });
    const c = computeMatch(match);
    const row = c.rows.find((r) => saved && r.round.id === saved.id) || c.lastRow;
    room.lastHand = {
      handNo: room.handNo, contract: h.contract, cardPoints: h.cardPoints.slice(), melds: h.melds.slice(),
      tricks: h.tricks.map((t) => ({ winner: t.winner, points: t.points, cards: t.cards })),
      made: row ? row.made : null, deltas: row ? row.deltas : null, scores: c.scores, winner: c.winner,
      bidderTeam: teamOfSeat(h.contract.seat),
    };
    room.hand = null;
    room.status = match.status === 'finished' ? 'finished' : 'between';
    room.ready = [false, false, false, false];
  }

  // Widok dla konkretnego użytkownika – tylko jego karty.
  viewFor(room, userId) {
    const seat = this.#seatOf(room, userId);
    return {
      id: room.id, code: room.code, status: room.status, seats: room.seats.slice(), ready: room.ready.slice(),
      members: room.members.slice(), reservedSeats: room.reservedSeats, matchId: room.matchId, createdBy: room.createdBy,
      handNo: room.handNo, seq: room.seq, mySeat: seat,
      hand: room.hand ? viewFor(room.hand, seat) : null,
      lastHand: room.lastHand, log: room.log.slice(-15),
    };
  }

  // Sprzątanie porzuconych lobby.
  async sweep() {
    const t = Date.now();
    for (const r of [...this.rooms.values()]) {
      if (r.status === 'lobby' && t - Date.parse(r.updatedAt || r.createdAt) > IDLE_LOBBY_MS) {
        await this.#serial(r.id, async () => { r.status = 'closed'; this.rooms.delete(r.id); await this.#save(r); });
      }
    }
  }
}

// Silnik rozgrywki kartami (tryb online). Czyste funkcje na obiekcie stanu.
// Serwer jest jedynym właścicielem pełnego stanu; klient dostaje tylko viewFor(seat).
import {
  SUITS, RANKS, RANK_INFO, MELD_VALUES, HAND_SIZE, DEAL_SIZE, MUSIK_SIZE, PLAYERS, CARD_POINTS_TOTAL,
  RuleError, nextSeat, teamOfSeat, normalizeSettings,
} from './rules.js';

export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}
export const cardSuit = (c) => c[1];
export const cardRank = (c) => c[0];
export const cardPoints = (c) => RANK_INFO[cardRank(c)].points;
export const rankIndex = (c) => RANKS.indexOf(cardRank(c)); // 0 = najsilniejsza
export function isCard(c) {
  return typeof c === 'string' && c.length === 2 && RANKS.includes(c[0]) && SUITS.includes(c[1]);
}

// Tasowanie Fishera–Yatesa. randomInt(n) → liczba całkowita z [0, n).
export function shuffle(deck, randomInt) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function sortHand(hand, trump) {
  const order = trump ? [trump, ...SUITS.filter((s) => s !== trump)] : SUITS;
  return hand.slice().sort((a, b) => order.indexOf(cardSuit(a)) - order.indexOf(cardSuit(b)) || rankIndex(a) - rankIndex(b));
}

// Nowe rozdanie: po 5 kart każdemu, 4 karty musika na środek (zakryte).
// Pierwszy po rozdającym ma obowiązkowe otwarcie licytacji (minimalna licytacja).
// Zwycięzca licytacji bierze musik i oddaje po jednej (dowolnej) karcie każdemu z pozostałych graczy.
export function createHand({ dealerSeat, settings, randomInt, deck }) {
  const S = normalizeSettings(settings);
  if (!Number.isInteger(dealerSeat) || dealerSeat < 0 || dealerSeat >= PLAYERS) throw new RuleError('Zły rozdający');
  const cards = deck ? deck.slice() : shuffle(fullDeck(), randomInt);
  if (cards.length !== PLAYERS * DEAL_SIZE + MUSIK_SIZE || new Set(cards).size !== cards.length) throw new RuleError('Zła talia');
  const hands = [[], [], [], []];
  // Rozdawanie zaczyna się od gracza po lewej rozdającego; ostatnie 4 karty to musik.
  const dealt = PLAYERS * DEAL_SIZE;
  for (let i = 0; i < dealt; i++) hands[(dealerSeat + 1 + i) % PLAYERS].push(cards[i]);
  const musik = cards.slice(dealt);
  const opener = nextSeat(dealerSeat);
  const state = {
    phase: 'bidding',
    settings: S,
    dealerSeat,
    hands,
    musik,
    given: [false, false, false, false],
    bidding: {
      highest: S.minBid,
      highestSeat: opener,
      passed: [false, false, false, false],
      history: [{ seat: opener, type: 'bid', value: S.minBid, forced: true }],
    },
    contract: null,
    trump: null,
    melds: [],
    trick: null,
    tricks: [],
    cardPoints: [0, 0],
    tricksWon: [0, 0, 0, 0],
    turn: nextSeat(opener),
    log: [{ type: 'deal', dealerSeat }, { type: 'bid', seat: opener, value: S.minBid, forced: true }],
  };
  return state;
}

function nextActiveBidder(state, from) {
  let s = nextSeat(from);
  for (let i = 0; i < PLAYERS; i++) {
    if (!state.bidding.passed[s]) return s;
    s = nextSeat(s);
  }
  return -1;
}

function finishBidding(state) {
  const b = state.bidding;
  state.contract = { seat: b.highestSeat, team: teamOfSeat(b.highestSeat), value: b.highest };
  state.log.push({ type: 'contract', seat: b.highestSeat, value: b.highest });
  // Zwycięzca licytacji zbiera musik.
  state.hands[b.highestSeat] = state.hands[b.highestSeat].concat(state.musik);
  state.log.push({ type: 'musik', seat: b.highestSeat, cards: state.musik.slice() });
  state.musik = [];
  state.phase = 'giving';
  state.given = [false, false, false, false];
  state.given[b.highestSeat] = true;
  state.turn = b.highestSeat;
}

// Czy karta a bije kartę b (b jest obecnie najwyższa w lewie).
export function beats(a, b, trump) {
  const sa = cardSuit(a), sb = cardSuit(b);
  if (sa === sb) return rankIndex(a) < rankIndex(b);
  return trump != null && sa === trump;
}

export function trickWinnerIndex(cards, trump) {
  let w = 0;
  for (let i = 1; i < cards.length; i++) if (beats(cards[i], cards[w], trump)) w = i;
  return w;
}

// Karty, które gracz może legalnie zagrać.
export function legalCards(state, seat) {
  if (state.phase !== 'playing' || state.turn !== seat) return [];
  const hand = state.hands[seat];
  const trick = state.trick;
  if (!trick.cards.length) return hand.slice();
  const S = state.settings;
  const led = cardSuit(trick.cards[0].card);
  const trump = state.trump;
  const played = trick.cards.map((x) => x.card);
  const best = played[trickWinnerIndex(played, trump)];
  const ofLed = hand.filter((c) => cardSuit(c) === led);
  if (ofLed.length) {
    // Do koloru; przebić trzeba tylko wtedy, gdy lewę wygrywa karta tego koloru (a nie atut).
    if (S.mustBeat && cardSuit(best) === led) {
      const higher = ofLed.filter((c) => beats(c, best, trump));
      if (higher.length) return higher;
    }
    return ofLed;
  }
  const trumps = trump ? hand.filter((c) => cardSuit(c) === trump) : [];
  if (S.mustTrump && trumps.length) {
    if (S.mustBeat && cardSuit(best) === trump) {
      const higher = trumps.filter((c) => beats(c, best, trump));
      if (higher.length) return higher;
    }
    return trumps;
  }
  return hand.slice();
}

export function canMeld(state, seat, card) {
  if (state.phase !== 'playing' || state.turn !== seat || state.trick.cards.length) return false;
  if (!state.settings.meldOnFirstTrick && state.tricks.length === 0) return false;
  const r = cardRank(card), s = cardSuit(card);
  if (r !== 'K' && r !== 'Q') return false;
  const partner = (r === 'K' ? 'Q' : 'K') + s;
  return state.hands[seat].includes(card) && state.hands[seat].includes(partner);
}

export function meldableCards(state, seat) {
  return state.hands[seat].filter((c) => canMeld(state, seat, c));
}

// Wykonuje akcję gracza. Mutuje stan, rzuca RuleError przy nielegalnym ruchu.
export function applyAction(state, seat, action) {
  if (!action || typeof action !== 'object') throw new RuleError('Brak akcji');
  if (state.phase === 'finished') throw new RuleError('Rozdanie jest zakończone');
  if (seat !== state.turn) throw new RuleError('Nie twoja kolej', 'turn');

  if (state.phase === 'bidding') {
    const b = state.bidding;
    const S = state.settings;
    if (action.type === 'bid') {
      const v = action.value;
      if (!Number.isInteger(v) || v % S.bidStep !== 0) throw new RuleError('Zła wartość licytacji');
      if (v < b.highest + S.bidStep) throw new RuleError(`Licytacja musi wynosić co najmniej ${b.highest + S.bidStep}`);
      if (v > S.maxBid) throw new RuleError(`Maksymalna licytacja to ${S.maxBid}`);
      b.highest = v;
      b.highestSeat = seat;
      b.history.push({ seat, type: 'bid', value: v });
      state.log.push({ type: 'bid', seat, value: v });
    } else if (action.type === 'pass') {
      b.passed[seat] = true;
      b.history.push({ seat, type: 'pass' });
      state.log.push({ type: 'pass', seat });
    } else {
      throw new RuleError('Teraz trwa licytacja');
    }
    const active = [0, 1, 2, 3].filter((s) => !b.passed[s]);
    if (active.length === 0 || (active.length === 1 && active[0] === b.highestSeat)) {
      if (active.length === 0) b.passed[b.highestSeat] = false; // najwyższy nie może spasować własnej licytacji
      finishBidding(state);
      return state;
    }
    let nxt = nextActiveBidder(state, seat);
    // Gdy kolejka wraca do najwyższego licytującego, a pozostali spasowali – koniec.
    if (nxt === b.highestSeat && active.length === 1) {
      finishBidding(state);
      return state;
    }
    state.turn = nxt;
    return state;
  }

  if (state.phase === 'giving') {
    // Grający oddaje po jednej karcie każdemu z pozostałych (dowolną ze swoich kart).
    if (action.type !== 'give') throw new RuleError('Najpierw rozdaj karty z musika – po jednej każdemu graczowi');
    const { card, to } = action;
    if (!Number.isInteger(to) || to < 0 || to >= PLAYERS || to === seat) throw new RuleError('Wybierz innego gracza');
    if (state.given[to]) throw new RuleError('Ten gracz dostał już kartę');
    if (!isCard(card) || !state.hands[seat].includes(card)) throw new RuleError('Nie masz tej karty');
    state.hands[seat] = state.hands[seat].filter((c) => c !== card);
    state.hands[to].push(card);
    state.given[to] = true;
    state.log.push({ type: 'give', seat, to, card });
    if (state.given.every(Boolean)) {
      state.phase = 'playing';
      state.trick = { leader: seat, cards: [] };
      state.turn = seat;
    }
    return state;
  }

  // phase === 'playing'
  if (action.type !== 'play') throw new RuleError('Teraz zagrywa się karty');
  const card = action.card;
  if (!isCard(card) || !state.hands[seat].includes(card)) throw new RuleError('Nie masz tej karty');
  const legal = legalCards(state, seat);
  if (!legal.includes(card)) throw new RuleError('Tej karty nie można teraz zagrać (obowiązek koloru, przebicia lub atutu)');
  let meld = null;
  // Meldunek zgłaszany automatycznie: kto wychodzi królem lub damą z pary (gdy meldować wolno), melduje od razu.
  if (canMeld(state, seat, card)) {
    const suit = cardSuit(card);
    meld = { seat, team: teamOfSeat(seat), suit, value: MELD_VALUES[suit], trick: state.tricks.length + 1 };
    state.melds.push(meld);
    state.trump = suit;
  }
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  state.trick.cards.push({ seat, card });
  state.log.push({ type: 'play', seat, card, ...(meld ? { meld: meld.suit } : {}) });

  if (state.trick.cards.length < PLAYERS) {
    state.turn = nextSeat(seat);
    return state;
  }
  const cards = state.trick.cards.map((x) => x.card);
  const wi = trickWinnerIndex(cards, state.trump);
  const winner = state.trick.cards[wi].seat;
  const points = cards.reduce((a, c) => a + cardPoints(c), 0);
  const done = { leader: state.trick.leader, cards: state.trick.cards, winner, points, trump: state.trump };
  state.tricks.push(done);
  state.cardPoints[teamOfSeat(winner)] += points;
  state.tricksWon[winner]++;
  state.log.push({ type: 'trick', winner, points, n: state.tricks.length });
  if (state.tricks.length === HAND_SIZE) {
    state.phase = 'finished';
    state.trick = null;
    state.turn = -1;
    if (state.cardPoints[0] + state.cardPoints[1] !== CARD_POINTS_TOTAL) throw new Error('Suma punktów ≠ 120');
    state.log.push({ type: 'end', cardPoints: state.cardPoints.slice() });
  } else {
    state.trick = { leader: winner, cards: [] };
    state.turn = winner;
  }
  return state;
}

// Rekord rozdania do historii meczu (ten sam format co tryb offline).
export function handToRound(state, seats) {
  if (state.phase !== 'finished') throw new RuleError('Rozdanie nie jest zakończone');
  const melds = {};
  for (const m of state.melds) (melds[seats[m.seat]] = melds[seats[m.seat]] || []).push(m.suit);
  return {
    bidder: seats[state.contract.seat],
    bid: state.contract.value,
    cards: { 0: state.cardPoints[0], 1: state.cardPoints[1] },
    melds,
    tricksWon: Object.fromEntries(seats.map((u, i) => [u, state.tricksWon[i]])),
    plays: state.log.map((e) => (e.seat != null ? { ...e, user: seats[e.seat] } : { ...e })),
  };
}

// Widok stanu dla jednego gracza – bez kart pozostałych graczy.
export function viewFor(state, seat) {
  const v = {
    phase: state.phase,
    dealerSeat: state.dealerSeat,
    turn: state.turn,
    bidding: {
      highest: state.bidding.highest,
      highestSeat: state.bidding.highestSeat,
      passed: state.bidding.passed.slice(),
      history: state.bidding.history.map((h) => ({ ...h })),
    },
    contract: state.contract ? { ...state.contract } : null,
    trump: state.trump,
    melds: state.melds.map((m) => ({ ...m })),
    trick: state.trick ? { leader: state.trick.leader, cards: state.trick.cards.map((x) => ({ ...x })) } : null,
    lastTrick: state.tricks.length ? { ...state.tricks[state.tricks.length - 1], cards: state.tricks[state.tricks.length - 1].cards.map((x) => ({ ...x })) } : null,
    tricksCount: state.tricks.length,
    tricksWon: state.tricksWon.slice(),
    handCounts: state.hands.map((h) => h.length),
    musikCount: state.musik ? state.musik.length : 0,
    given: state.given ? state.given.slice() : [true, true, true, true],
    hand: seat >= 0 ? sortHand(state.hands[seat], state.trump) : [],
    legal: seat >= 0 ? legalCards(state, seat) : [],
    meldable: seat >= 0 ? meldableCards(state, seat) : [],
    settings: { minBid: state.settings.minBid, bidStep: state.settings.bidStep, maxBid: state.settings.maxBid },
  };
  if (state.phase === 'finished') v.cardPoints = state.cardPoints.slice();
  return v;
}

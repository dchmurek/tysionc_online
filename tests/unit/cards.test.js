import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fullDeck, shuffle, createHand, applyAction, legalCards, canMeld, viewFor, handToRound,
  cardPoints, beats, trickWinnerIndex, meldOnSeat, meldableCards, dealSequence,
} from '../../shared/cards.js';
import { DEFAULT_SETTINGS, RuleError } from '../../shared/rules.js';

const seeded = (seed) => {
  let s = seed >>> 0;
  return (n) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; };
};
// Talia ułożona tak, by po rozdaniu musika gracze mieli konkretne 6 kart (rozdający 3 → gracz 0 dostaje pierwszy).
// Gracz 0 wygrywa licytację; dostaje karty 0–4, musik = szósta karta każdego gracza, potem oddaje je właścicielom.
function deckFor(hands, dealerSeat = 3) {
  const idx = [0, 0, 0, 0];
  let m = 0;
  return dealSequence(dealerSeat).map((to) => (to === 'm' ? hands[m++][5] : hands[to][idx[to]++]));
}

test('talia ma 24 unikalne karty i 120 punktów', () => {
  const d = fullDeck();
  assert.equal(d.length, 24);
  assert.equal(new Set(d).size, 24);
  assert.equal(d.reduce((a, c) => a + cardPoints(c), 0), 120);
});

test('rozdanie: po 5 kart każdemu + 4 karty musika; po musiku każdy ma 6', () => {
  const h = createHand({ dealerSeat: 0, settings: {}, randomInt: seeded(7) });
  assert.deepEqual(h.hands.map((x) => x.length), [5, 5, 5, 5]);
  assert.equal(h.musik.length, 4);
  assert.equal(new Set([...h.hands.flat(), ...h.musik]).size, 24);
  const musik = h.musik.slice();
  while (h.phase === 'bidding') applyAction(h, h.turn, { type: 'pass' });
  assert.equal(h.phase, 'giving');
  const b = h.contract.seat;
  assert.equal(h.turn, b);
  assert.equal(h.hands[b].length, 9);
  for (const c of musik) assert.ok(h.hands[b].includes(c), 'grający zebrał musik');
  // oddaje DOWOLNE karty (nie tylko z musika)
  const others = [0, 1, 2, 3].filter((s) => s !== b);
  assert.throws(() => applyAction(h, b, { type: 'play', card: h.hands[b][0] }), /rozdaj karty z musika/);
  assert.throws(() => applyAction(h, others[0], { type: 'give', card: h.hands[others[0]][0], to: b }), /kolej/);
  assert.throws(() => applyAction(h, b, { type: 'give', card: h.hands[b][0], to: b }), /innego gracza/);
  assert.throws(() => applyAction(h, b, { type: 'give', card: h.hands[others[0]][0], to: others[0] }), /Nie masz/);
  const own = h.hands[b].find((c) => !musik.includes(c));
  applyAction(h, b, { type: 'give', card: own, to: others[0] });
  assert.throws(() => applyAction(h, b, { type: 'give', card: h.hands[b][0], to: others[0] }), /już kartę/);
  applyAction(h, b, { type: 'give', card: h.hands[b][0], to: others[1] });
  applyAction(h, b, { type: 'give', card: h.hands[b][0], to: others[2] });
  assert.deepEqual(h.hands.map((x) => x.length), [6, 6, 6, 6]);
  assert.equal(h.phase, 'playing');
  assert.equal(h.turn, b, 'grający wychodzi');
  assert.deepEqual(shuffle(fullDeck(), seeded(1)).slice().sort(), fullDeck().slice().sort());
});

test('licytacja: obowiązkowe 100 u gracza po rozdającym, przebijanie o 10, pas', () => {
  const h = createHand({ dealerSeat: 0, settings: {}, randomInt: seeded(3) });
  assert.equal(h.bidding.highestSeat, 1);
  assert.equal(h.bidding.highest, 100);
  assert.equal(h.turn, 2);
  assert.throws(() => applyAction(h, 3, { type: 'bid', value: 110 }), /kolej/);
  assert.throws(() => applyAction(h, 2, { type: 'bid', value: 105 }), RuleError);
  assert.throws(() => applyAction(h, 2, { type: 'bid', value: 100 }), /tylko 110/);
  assert.throws(() => applyAction(h, 2, { type: 'bid', value: 150 }), /tylko 110/, 'bez skakania – tylko +10');
  applyAction(h, 2, { type: 'bid', value: 110 });
  applyAction(h, 3, { type: 'pass' });
  applyAction(h, 0, { type: 'pass' });
  assert.equal(h.turn, 1);
  applyAction(h, 1, { type: 'bid', value: 120 });
  assert.equal(h.turn, 2); // 3 i 0 spasowali – pomijani
  applyAction(h, 2, { type: 'pass' });
  assert.equal(h.phase, 'giving');
  assert.deepEqual(h.contract, { seat: 1, team: 1, value: 120 });
  assert.equal(h.turn, 1); // grający bierze musik
});

test('licytacja co 10 bez ograniczenia meldunkami (aż do 400) i limit maxBid', () => {
  const h = createHand({ dealerSeat: 0, settings: {}, randomInt: seeded(3) });
  while (h.bidding.highest < 400) applyAction(h, h.turn, { type: 'bid', value: h.bidding.highest + 10 });
  assert.throws(() => applyAction(h, h.turn, { type: 'bid', value: 410 }), /Maksymalna/);
});

test('rozdawanie: rozdający sobie pierwszą kartę, potem lewy, naprzeciwko, prawy, musik – po kolei', () => {
  assert.deepEqual(dealSequence(2).slice(0, 10), [2, 3, 0, 1, 'm', 2, 3, 0, 1, 'm']);
  const seq = dealSequence(0);
  assert.equal(seq.length, 24);
  assert.equal(seq.filter((x) => x === 'm').length, 4);
  for (const s of [0, 1, 2, 3]) assert.equal(seq.filter((x) => x === s).length, 5);
  const deck = fullDeck();
  const h = createHand({ dealerSeat: 1, settings: {}, deck });
  assert.deepEqual(h.hands[1].slice(0, 2), [deck[0], deck[5]]);
  assert.deepEqual(h.hands[2][0], deck[1]);
  assert.deepEqual(h.musik, [deck[4], deck[9], deck[14], deck[19]]);
});

test('tasowanie jest równomierne (każda karta na każdej pozycji ~ tak samo często)', () => {
  const N = 24000;
  const counts = Array.from({ length: 24 }, () => new Array(24).fill(0));
  const deck = fullDeck();
  const rnd = (n) => crypto.randomInt(n);
  for (let i = 0; i < N; i++) shuffle(deck, rnd).forEach((c, pos) => counts[deck.indexOf(c)][pos]++);
  const exp = N / 24;
  for (const row of counts) for (const c of row) assert.ok(Math.abs(c - exp) < exp * 0.2, `odchylenie ${c} vs ${exp}`);
});

test('wszyscy pasują → obowiązkowe 100 gra', () => {
  const h = createHand({ dealerSeat: 2, settings: {}, randomInt: seeded(9) });
  applyAction(h, 0, { type: 'pass' });
  applyAction(h, 1, { type: 'pass' });
  applyAction(h, 2, { type: 'pass' });
  assert.deepEqual(h.contract, { seat: 3, team: 1, value: 100 });
});

test('rozstrzyganie lewy: najwyższa do koloru, atut bije', () => {
  assert.equal(trickWinnerIndex(['KH', 'AH', '9H', 'TH'], null), 1);
  assert.equal(trickWinnerIndex(['AH', '9S', 'TH', 'KD'], null), 0);
  assert.equal(trickWinnerIndex(['AH', '9S', 'TH', 'KD'], 'S'), 1);
  assert.equal(trickWinnerIndex(['AH', '9S', 'JS', 'KD'], 'S'), 2);
  assert.ok(beats('TH', 'KH', null));
  assert.ok(!beats('AD', 'KH', null));
});

function playingState(hands, { dealerSeat = 3, settings = {}, bidder = 0, bid = 100 } = {}) {
  const h = createHand({ dealerSeat, settings, deck: deckFor(hands, dealerSeat) });
  // gracz 0 ma obowiązkowe 100 (dealer 3); reszta pasuje, chyba że inny licytujący
  while (h.phase === 'bidding') {
    if (h.turn === bidder && h.bidding.highestSeat !== bidder) applyAction(h, h.turn, { type: 'bid', value: bid });
    else applyAction(h, h.turn, { type: 'pass' });
  }
  for (const s of [1, 2, 3]) applyAction(h, bidder, { type: 'give', card: hands[s][5], to: s });
  return h;
}

const HANDS = [
  ['AH', 'KH', 'QH', '9C', 'JS', 'TD'],
  ['TH', '9H', 'AC', 'KC', '9S', 'QD'],
  ['JH', 'TC', 'QC', 'AS', 'KS', '9D'],
  ['JC', 'QS', 'TS', 'AD', 'KD', 'JD'],
];

test('obowiązek koloru i przebicia', () => {
  const h = playingState(HANDS);
  assert.equal(h.turn, 0);
  applyAction(h, 0, { type: 'play', card: 'KH' });
  // gracz 1 ma TH (bije K) i 9H → musi przebić
  assert.deepEqual(legalCards(h, 1), ['TH']);
  assert.throws(() => applyAction(h, 1, { type: 'play', card: '9H' }), /Tej karty nie można/);
  assert.throws(() => applyAction(h, 1, { type: 'play', card: 'AC' }), /Tej karty nie można/);
  applyAction(h, 1, { type: 'play', card: 'TH' });
  // gracz 2 ma tylko JH – musi dołożyć do koloru (nie może przebić)
  assert.deepEqual(legalCards(h, 2), ['JH']);
  applyAction(h, 2, { type: 'play', card: 'JH' });
  // gracz 3 nie ma kiera i nie ma atutu → dowolna
  assert.equal(legalCards(h, 3).length, 6);
  applyAction(h, 3, { type: 'play', card: 'JC' });
  assert.equal(h.tricks[0].winner, 1);
  assert.equal(h.tricks[0].points, 4 + 10 + 2 + 2);
  assert.equal(h.turn, 1);
});

test('meldunek: automatyczny przy wyjściu królem/damą z pary, nie w pierwszej lewie, ustawia atut', () => {
  const h = playingState(HANDS);
  assert.ok(!canMeld(h, 0, 'KH'), 'meldunek w pierwszej lewie zabroniony');
  applyAction(h, 0, { type: 'play', card: 'AH' });
  applyAction(h, 1, { type: 'play', card: '9H' }); // ma TH, ale TH nie bije asa → dowolny kier
  applyAction(h, 2, { type: 'play', card: 'JH' });
  applyAction(h, 3, { type: 'play', card: 'JC' });
  assert.equal(h.tricks[0].winner, 0);
  assert.ok(canMeld(h, 0, 'KH') && canMeld(h, 0, 'QH'));
  assert.ok(!canMeld(h, 0, '9C'));
  applyAction(h, 0, { type: 'play', card: 'QH' }); // bez osobnej decyzji – meldunek zgłasza się sam
  assert.equal(h.trump, 'H');
  assert.deepEqual(h.melds[0], { seat: 0, team: 0, suit: 'H', value: 100, trick: 2 });
  // gracz 1 ma TH (bije damę) → musi przebić
  assert.deepEqual(legalCards(h, 1), ['TH']);
  applyAction(h, 1, { type: 'play', card: 'TH' });
  // gracz 2 nie ma kiera, kier = atut, nie ma atutu → dowolna
  assert.equal(legalCards(h, 2).length, 5);
  applyAction(h, 2, { type: 'play', card: 'AS' });
  applyAction(h, 3, { type: 'play', card: 'AD' });
  assert.equal(h.tricks[1].winner, 1);
});

test('brak koloru → obowiązek atutu i nadbicia atutem', () => {
  const hands = [
    ['AH', 'KH', 'QH', 'AC', 'JS', '9D'],
    ['TH', '9H', 'KC', 'QC', '9S', 'QD'],
    ['JH', 'TC', 'JC', 'AS', 'KS', 'TD'],
    ['9C', 'QS', 'TS', 'AD', 'KD', 'JD'],
  ];
  const h = playingState(hands);
  applyAction(h, 0, { type: 'play', card: 'AC' });
  applyAction(h, 1, { type: 'play', card: 'KC' }); // nie bije asa
  applyAction(h, 2, { type: 'play', card: 'TC' });
  applyAction(h, 3, { type: 'play', card: '9C' });
  applyAction(h, 0, { type: 'play', card: 'KH', meld: true }); // atut kier
  applyAction(h, 1, { type: 'play', card: 'TH' });
  applyAction(h, 2, { type: 'play', card: 'JH' });
  // gracz 3 bez kiera i bez atutu
  applyAction(h, 3, { type: 'play', card: 'JD' });
  assert.equal(h.tricks[1].winner, 1);
  // gracz 1 wychodzi karo; gracz 2 ma TD → musi przebić? najwyższa QD (do koloru) → TD bije → musi
  applyAction(h, 1, { type: 'play', card: 'QD' });
  assert.deepEqual(legalCards(h, 2), ['TD']);
  applyAction(h, 2, { type: 'play', card: 'TD' });
  // gracz 3 ma AD i KD: musi przebić TD → tylko AD
  assert.deepEqual(legalCards(h, 3), ['AD']);
  applyAction(h, 3, { type: 'play', card: 'AD' });
  // gracz 0 ma 9D → do koloru
  assert.deepEqual(legalCards(h, 0), ['9D']);
  applyAction(h, 0, { type: 'play', card: '9D' });
  assert.equal(h.tricks[2].winner, 3);
  // gracz 3 wychodzi pik QS; gracz 0 ma JS (nie bije) → JS
  applyAction(h, 3, { type: 'play', card: 'QS' });
  assert.deepEqual(legalCards(h, 0), ['JS']);
  applyAction(h, 0, { type: 'play', card: 'JS' });
  // gracz 1 ma 9S → do koloru
  applyAction(h, 1, { type: 'play', card: '9S' });
  applyAction(h, 2, { type: 'play', card: 'AS' });
  assert.equal(h.tricks[3].winner, 2);
  // gracz 2 wychodzi KS; gracz 3 ma TS (bije K) → musi
  applyAction(h, 2, { type: 'play', card: 'KS' });
  assert.deepEqual(legalCards(h, 3), ['TS']);
  applyAction(h, 3, { type: 'play', card: 'TS' });
  // gracz 0: brak pika, ma atuty AH i QH → musi dać atut (którykolwiek – lewę wygrywa pik)
  assert.deepEqual(legalCards(h, 0), ['AH', 'QH']);
  applyAction(h, 0, { type: 'play', card: 'QH' });
  // gracz 1: brak pika, ma atut 9H; najwyższa to QH (atut) → 9H nie nadbije, ale musi dać atut
  assert.deepEqual(legalCards(h, 1), ['9H']);
  applyAction(h, 1, { type: 'play', card: '9H' });
  assert.equal(h.tricks[4].winner, 0);
});

test('pełne rozdanie losowe: zawsze 120 punktów, legalne ruchy, wynik do historii', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = seeded(seed);
    const h = createHand({ dealerSeat: seed % 4, settings: {}, randomInt: rnd });
    while (h.phase === 'bidding') {
      const t = h.turn;
      if (rnd(3) === 0 && h.bidding.highest + 10 <= 200) applyAction(h, t, { type: 'bid', value: h.bidding.highest + 10 });
      else applyAction(h, t, { type: 'pass' });
    }
    const b = h.contract.seat;
    for (const s of [0, 1, 2, 3].filter((x) => x !== b)) applyAction(h, b, { type: 'give', card: h.hands[b][rnd(h.hands[b].length)], to: s });
    while (h.phase === 'playing') {
      const t = h.turn;
      const legal = legalCards(h, t);
      assert.ok(legal.length > 0);
      const card = legal[rnd(legal.length)];
      const meldable = canMeld(h, t, card) || meldOnSeat(h, t, card) >= 0;
      const before = h.melds.length;
      applyAction(h, t, { type: 'play', card });
      assert.equal(h.melds.length, before + (meldable ? 1 : 0), 'meldunek zawsze zgłaszany automatycznie');
    }
    assert.equal(h.cardPoints[0] + h.cardPoints[1], 120);
    assert.equal(h.tricks.length, 6);
    const seats = ['a', 'b', 'c', 'd'];
    const r = handToRound(h, seats);
    assert.equal(r.cards[0] + r.cards[1], 120);
    assert.equal(r.bidder, seats[h.contract.seat]);
  }
});

test('widok gracza nie zawiera kart przeciwników', () => {
  const h = createHand({ dealerSeat: 0, settings: {}, randomInt: seeded(5) });
  const v = viewFor(h, 2);
  assert.deepEqual(v.hand.slice().sort(), h.hands[2].slice().sort());
  assert.equal(v.hands, undefined);
  assert.equal(v.musikCount, 4);
  const json = JSON.stringify(v);
  for (const s of [0, 1, 3]) for (const c of h.hands[s]) assert.ok(!json.includes(`"${c}"`), `wyciek karty ${c}`);
  for (const c of h.musik) assert.ok(!json.includes(`"${c}"`), `wyciek karty musika ${c}`);
});

test('nie istnieje mechanika bomby', () => {
  const h = createHand({ dealerSeat: 0, settings: {}, randomInt: seeded(5) });
  assert.throws(() => applyAction(h, h.turn, { type: 'bomb' }), RuleError);
  assert.equal('bombPoints' in DEFAULT_SETTINGS, false);
});

test('przebijanie obowiązuje zawsze – także gdy lewę bierze partner (do koloru i atutem)', () => {
  const hands = [
    ['KH', 'QD', 'JD', '9C', 'JS', 'TS'],
    ['TH', 'AD', 'KD', 'TD', 'QS', 'KS'],
    ['9H', 'AC', 'TC', 'KC', 'QC', 'AS'],
    ['AH', 'JH', 'QH', '9D', 'JC', '9S'],
  ];
  const h = playingState(hands);
  applyAction(h, 0, { type: 'play', card: 'KH' });
  applyAction(h, 1, { type: 'play', card: 'TH' }); // lewę bierze gracz 1
  applyAction(h, 2, { type: 'play', card: '9H' });
  // gracz 3 jest partnerem gracza 1, który wygrywa lewę – i tak musi przebić asem
  assert.deepEqual(legalCards(h, 3), ['AH']);
});

// „Meldunek na kimś”: y1 zagrywa damę, następny (x2) dokłada króla tego koloru i melduje.
const ON_HANDS = [
  ['AS', 'TS', 'KS', 'QS', 'JS', '9S'],
  ['QH', 'AH', 'TH', 'JH', '9H', 'AD'],
  ['KH', 'AC', 'TC', 'KC', 'QC', 'JC'],
  ['TD', 'KD', 'QD', 'JD', '9D', '9C'],
];

test('meldunek na kimś: król na damę poprzedniego gracza daje punkty, ale nie zmienia tromfu', () => {
  const h = playingState(ON_HANDS, { settings: { meldOnFirstTrick: true } });
  applyAction(h, 0, { type: 'play', card: 'AS' });
  applyAction(h, 1, { type: 'play', card: 'QH' }); // brak pika – „ucieka” damą
  assert.equal(meldOnSeat(h, 2, 'KH'), 1);
  assert.deepEqual(meldableCards(h, 2), ['KH']);
  const v = viewFor(h, 2);
  assert.deepEqual(v.meldable, ['KH']);
  applyAction(h, 2, { type: 'play', card: 'KH' });
  assert.deepEqual(h.melds[0], { seat: 2, team: 0, suit: 'H', value: 100, trick: 1, on: 1 });
  assert.equal(h.trump, null, 'tromf ustala tylko meldunek z ręki');
  applyAction(h, 3, { type: 'play', card: '9C' });
  assert.equal(h.tricks[0].winner, 0, 'król nie bije wszystkiego – lewę bierze as pik');
});

test('meldunek na kimś: tylko na damę gracza tuż przed, tylko gdy król jest dozwolony, nie w 1. lewie domyślnie', () => {
  // domyślnie nie w pierwszej lewie
  let h = playingState(ON_HANDS);
  applyAction(h, 0, { type: 'play', card: 'AS' });
  applyAction(h, 1, { type: 'play', card: 'QH' });
  assert.equal(meldOnSeat(h, 2, 'KH'), -1);
  // wyłączone ustawienie
  h = playingState(ON_HANDS, { settings: { meldOnFirstTrick: true, meldOnPlayed: false } });
  applyAction(h, 0, { type: 'play', card: 'AS' });
  applyAction(h, 1, { type: 'play', card: 'QH' });
  applyAction(h, 2, { type: 'play', card: 'KH' });
  assert.equal(h.melds.length, 0);
  assert.equal(h.trump, null);
  // król niedozwolony (trzeba dołożyć do koloru) → brak meldunku
  const hands2 = [
    ['AH', 'TS', 'KS', 'QS', 'JS', '9S'],
    ['QH', 'AS', 'TH', 'JH', '9H', 'AD'],
    ['KH', 'AC', 'TC', 'KC', 'QC', 'JC'],
    ['TD', 'KD', 'QD', 'JD', '9D', '9C'],
  ];
  h = playingState(hands2, { settings: { meldOnFirstTrick: true } });
  applyAction(h, 0, { type: 'play', card: 'TS' });
  applyAction(h, 1, { type: 'play', card: 'AS' });
  assert.equal(meldOnSeat(h, 2, 'KH'), -1, 'poprzedni nie zagrał damy');
  // dama zagrana nie bezpośrednio przed → brak meldunku
  const hands3 = [
    ['AS', 'TS', 'KS', 'QS', 'JS', '9S'],
    ['QH', 'AH', 'TH', 'JH', '9H', 'AD'],
    ['9C', 'AC', 'TC', 'KC', 'QC', 'JC'],
    ['TD', 'KD', 'QD', 'JD', 'KH', '9D'],
  ];
  h = playingState(hands3, { settings: { meldOnFirstTrick: true } });
  applyAction(h, 0, { type: 'play', card: 'AS' });
  applyAction(h, 1, { type: 'play', card: 'QH' });
  applyAction(h, 2, { type: 'play', card: '9C' });
  assert.equal(meldOnSeat(h, 3, 'KH'), -1);
});

test('musik: rozdanie wszystkich kart jedną akcją (wszystko albo nic) i widok „dostałeś”', () => {
  const h = createHand({ dealerSeat: 3, settings: {}, deck: deckFor(HANDS, 3) });
  while (h.phase === 'bidding') applyAction(h, h.turn, { type: 'pass' });
  const b = h.contract.seat;
  const others = [0, 1, 2, 3].filter((s) => s !== b);
  const v = viewFor(h, b);
  assert.equal(v.musikCards.length, 4, 'grający widzi, które karty są z musika');
  assert.deepEqual(viewFor(h, others[0]).musikCards, []);
  const [c1, c2, c3] = h.hands[b];
  assert.throws(() => applyAction(h, b, { type: 'give-all', gives: [{ card: c1, to: others[0] }, { card: c2, to: others[1] }] }), /każdemu/);
  assert.throws(() => applyAction(h, b, { type: 'give-all', gives: [{ card: c1, to: others[0] }, { card: c1, to: others[1] }, { card: c3, to: others[2] }] }), /jedną, inną/);
  assert.throws(() => applyAction(h, b, { type: 'give-all', gives: [{ card: c1, to: others[0] }, { card: c2, to: others[0] }, { card: c3, to: others[2] }] }), /jedną, inną/);
  assert.equal(h.hands[b].length, 9, 'nieudana próba niczego nie zmienia');
  applyAction(h, b, { type: 'give-all', gives: [{ card: c1, to: others[0] }, { card: c2, to: others[1] }, { card: c3, to: others[2] }] });
  assert.equal(h.phase, 'playing');
  assert.deepEqual(h.hands.map((x) => x.length), [6, 6, 6, 6]);
  assert.deepEqual(viewFor(h, others[1]).received, { card: c2, from: b });
  assert.equal(viewFor(h, b).received, null);
});

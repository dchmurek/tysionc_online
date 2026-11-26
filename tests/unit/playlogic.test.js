// Logika stukania w karty przy stole online (public/js/playlogic.js) – na prawdziwym silniku rozdania.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, viewFor, dealSequence } from '../../shared/cards.js';
import { tapCard, meldKind, giveTapCard, giveTapSlot, giveReady } from '../../public/js/playlogic.js';

function deckFor(hands, dealerSeat = 3) {
  const idx = [0, 0, 0, 0];
  let m = 0;
  return dealSequence(dealerSeat).map((to) => (to === 'm' ? hands[m++][5] : hands[to][idx[to]++]));
}
// Gracz 0 gra obowiązkowe 100, oddaje szóste karty właścicielom → faza zagrywania, gracz 0 wychodzi.
function playing(hands, settings = {}) {
  const h = createHand({ dealerSeat: 3, settings, deck: deckFor(hands) });
  while (h.phase === 'bidding') applyAction(h, h.turn, { type: 'pass' });
  for (const s of [1, 2, 3]) applyAction(h, 0, { type: 'give', card: hands[s][5], to: s });
  return h;
}

const HANDS = [
  ['AH', 'KH', 'QH', '9C', 'JS', 'TD'],
  ['TH', '9H', 'AC', 'KC', '9S', 'QD'],
  ['JH', 'TC', 'QC', 'AS', 'KS', '9D'],
  ['JC', 'QS', 'TS', 'AD', 'KD', 'JD'],
];

test('zagranie w dwóch krokach: pierwsze stuknięcie wybiera, drugie zagrywa', () => {
  const v = viewFor(playing(HANDS), 0);
  assert.equal(tapCard(v, 0, null, '9C').action, 'select');
  assert.equal(tapCard(v, 0, '9C', '9C').action, 'play');
  assert.equal(tapCard(v, 0, '9C', 'AH').action, 'select', 'inna karta tylko zmienia wybór');
});

test('nie moja kolej / nie mam karty → nic się nie dzieje', () => {
  const v1 = viewFor(playing(HANDS), 1);
  assert.equal(tapCard(v1, 1, null, 'TH').action, 'ignore');
  const v0 = viewFor(playing(HANDS), 0);
  assert.equal(tapCard(v0, 0, null, 'TH').action, 'ignore');
});

test('karta niedozwolona (obowiązek koloru) → komunikat, bez wyboru', () => {
  const h = playing(HANDS);
  applyAction(h, 0, { type: 'play', card: 'AH' });
  const v = viewFor(h, 1);
  assert.equal(tapCard(v, 1, null, 'AC').action, 'illegal');
  assert.equal(tapCard(v, 1, null, '9H').action, 'select');
});

test('wyjście królem/damą z pary w PIERWSZEJ lewie: dwa stuknięcia i meldunek sam (bez dodatkowego pytania)', () => {
  const h = playing(HANDS);
  const v = viewFor(h, 0);
  assert.deepEqual(v.meldable.sort(), ['KH', 'QH']);
  assert.equal(meldKind(v, 'KH'), 'lead');
  assert.equal(meldKind(v, '9C'), null);
  assert.equal(tapCard(v, 0, null, 'KH').action, 'select');
  const t = tapCard(v, 0, 'KH', 'KH');
  assert.equal(t.action, 'play');
  applyAction(h, 0, { type: 'play', card: t.card });
  assert.equal(h.melds.length, 1, 'meldunek zgłoszony');
  assert.equal(h.trump, 'H');
  assert.equal(h.melds[0].trick, 1);
});

test('meldunek na kimś: król na damę zagraną tuż przed – zwykłe dwa stuknięcia i meldunek się liczy', () => {
  // gracz 0 wychodzi kierem, gracz 1 (bez kiera) daje damę wino (pik), gracz 2 (bez kiera, bez tromfu) dokłada króla pik
  const hands = [
    ['AH', '9H', 'TS', 'JS', '9S', 'TD'],
    ['QS', 'AC', 'TC', 'KC', 'QC', 'AD'],
    ['KS', 'AS', 'JC', '9C', 'KD', 'QD'],
    ['KH', 'QH', 'TH', 'JH', 'JD', '9D'],
  ];
  const h = playing(hands);
  applyAction(h, 0, { type: 'play', card: 'AH' });
  applyAction(h, 1, { type: 'play', card: 'QS' });
  const v = viewFor(h, 2);
  assert.ok(v.legal.includes('KS'));
  assert.equal(meldKind(v, 'KS'), 'on');
  assert.equal(tapCard(v, 2, null, 'KS').action, 'select');
  assert.equal(tapCard(v, 2, 'KS', 'KS').action, 'play');
  applyAction(h, 2, { type: 'play', card: 'KS' });
  assert.deepEqual(h.melds[0], { seat: 2, team: 0, suit: 'S', value: 60, trick: 1, on: 1 });
  assert.equal(h.trump, null, 'meldunek na kimś nie zmienia tromfu');
});

test('musik: stuknięcie karty trafia do kolejnego wolnego gracza, potem zatwierdzenie', () => {
  const targets = [1, 2, 3];
  let st = { draft: {}, target: null };
  st = giveTapCard(st.draft, targets, st.target, '9C');
  assert.deepEqual(st.draft, { 1: '9C' });
  assert.equal(st.target, 2);
  st = giveTapCard(st.draft, targets, st.target, 'JS');
  st = giveTapCard(st.draft, targets, st.target, 'TD');
  assert.deepEqual(st.draft, { 1: '9C', 2: 'JS', 3: 'TD' });
  assert.ok(giveReady(st.draft, targets));
  // czwarta karta, gdy wszyscy mają – nic się nie zmienia
  assert.deepEqual(giveTapCard(st.draft, targets, st.target, 'AH').draft, st.draft);
});

test('musik: wybór gracza stuknięciem, cofnięcie karty stuknięciem karty albo gracza', () => {
  const targets = [1, 2, 3];
  let st = giveTapSlot({}, targets, 3);
  assert.equal(st.target, 3);
  st = giveTapCard(st.draft, targets, st.target, 'AH');
  assert.deepEqual(st.draft, { 3: 'AH' });
  assert.equal(st.target, 1, 'następna karta do pierwszego wolnego');
  st = giveTapCard(st.draft, targets, st.target, 'AH'); // stuknięcie przydzielonej karty → cofa
  assert.deepEqual(st.draft, {});
  assert.equal(st.target, 3);
  st = giveTapCard(st.draft, targets, st.target, 'KH');
  st = giveTapSlot(st.draft, targets, 3); // stuknięcie gracza z kartą → cofa
  assert.deepEqual(st.draft, {});
  assert.ok(!giveReady(st.draft, targets));
});

test('musik: przydział z logiki jest przyjmowany przez silnik (give-all)', () => {
  const h = createHand({ dealerSeat: 3, settings: {}, deck: deckFor(HANDS) });
  while (h.phase === 'bidding') applyAction(h, h.turn, { type: 'pass' });
  let st = { draft: {}, target: null };
  for (const c of h.hands[0].slice(0, 3)) st = giveTapCard(st.draft, [1, 2, 3], st.target, c);
  applyAction(h, 0, { type: 'give-all', gives: Object.entries(st.draft).map(([to, card]) => ({ card, to: Number(to) })) });
  assert.equal(h.phase, 'playing');
  assert.deepEqual(h.hands.map((x) => x.length), [6, 6, 6, 6]);
});

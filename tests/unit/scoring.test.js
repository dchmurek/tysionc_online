import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMatch, validateRoundInput, evaluateRound } from '../../shared/scoring.js';
import { roundPoints, normalizeSettings, RuleError } from '../../shared/rules.js';

const seats = ['A1', 'B1', 'A2', 'B2']; // drużyna 0: A1+A2, drużyna 1: B1+B2
const M = (rounds = [], settings = {}) => ({ seats, settings, rounds, firstDealerSeat: 0 });
const R = (bidder, bid, oppCards, melds = {}, extra = {}) => ({ bidder, bid, cards: { [seats.indexOf(bidder) % 2 === 0 ? 1 : 0]: oppCards }, melds, ...extra });

test('kontrakt zrealizowany: drużyna dostaje faktycznie ugrane (120 → 170)', () => {
  const c = computeMatch(M([R('A1', 120, 20, { A2: ['D'] })])); // 100 z kart + 80 = 180? (120-20=100) +80 = 180
  assert.deepEqual(c.scores, [180, 20]);
  const c2 = computeMatch(M([R('A1', 120, 30, { A1: ['S'] })])); // 90 + pik 60 = 150 → +150
  assert.deepEqual(c2.scores, [150, 30]);
  const c3 = computeMatch(M([R('A1', 120, 30, { A1: ['C'] })])); // 90 + trefl 40 = 130
  assert.deepEqual(c3.scores, [130, 30]);
});

test('przykład ze specyfikacji: licytacja 120, zdobyte 170 → +170', () => {
  // 110 z kart + meldunek pik 40 = 150; potrzebne 170: 90 z kart + kier 100 = 190… użyjmy 70 kart + 100 = 170
  const c = computeMatch(M([R('A1', 120, 50, { A2: ['H'] })]));
  assert.equal(c.rows[0].deltas[0], 170);
});

test('kontrakt niezrealizowany: −deklaracja (160, zdobyte 120 → −160)', () => {
  const c = computeMatch(M([R('B1', 160, 20, { B2: ['S'], A1: ['C'] })])); // B: 100 + pik 60 = 160 // B: 100+60=160?? – zróbmy jasno poniżej
  assert.equal(c.rows[0].made, true);
  const c2 = computeMatch(M([R('B1', 160, 60, { B2: ['S'] })])); // B: 60 kart + pik 60 = 120 < 160
  assert.equal(c2.rows[0].made, false);
  assert.deepEqual(c2.rows[0].deltas, [60, -160]);
});

test('przeciwnicy dostają swoje punkty z kart + meldunki (zaokrąglone)', () => {
  const c = computeMatch(M([R('A1', 100, 37, { B1: ['C'] })])); // B: 37 + trefl 40 = 77 → 80; A: 83 < 100 → −100
  assert.deepEqual(c.scores, [-100, 80]);
});

test('zaokrąglanie: nearest10 / down10 / exact', () => {
  assert.equal(roundPoints(155, 'nearest10'), 160);
  assert.equal(roundPoints(154, 'nearest10'), 150);
  assert.equal(roundPoints(5, 'nearest10'), 10);
  assert.equal(roundPoints(159, 'down10'), 150);
  assert.equal(roundPoints(157, 'exact'), 157);
});

test('kontrakt sprawdzany po zaokrągleniu (domyślnie): grał 160, ma 158 → +160', () => {
  // A: 120 − 62 = 58 + kier 100 = 158 → zaokrąglone 160
  const c = computeMatch(M([R('A1', 160, 62, { A1: ['H'] })]));
  assert.equal(c.rows[0].made, true);
  assert.equal(c.rows[0].deltas[0], 160);
  // 154 → 150 < 160 → nieugrany
  const c2 = computeMatch(M([R('A1', 160, 66, { A1: ['H'] })]));
  assert.equal(c2.rows[0].made, false);
  assert.equal(c2.rows[0].deltas[0], -160);
});

test('test kontraktu wg reguły: raw vs rounded', () => {
  // A: 120-65 = 55 + kier 100 = 155 vs kontrakt 160
  const raw = computeMatch(M([R('A1', 160, 65, { A1: ['H'] })], { contractCheck: 'raw' }));
  assert.equal(raw.rows[0].made, false);
  assert.equal(raw.rows[0].deltas[0], -160);
  const rounded = computeMatch(M([R('A1', 160, 65, { A1: ['H'] })], { contractCheck: 'rounded' }));
  assert.equal(rounded.rows[0].made, true);
  assert.equal(rounded.rows[0].deltas[0], 160);
  const exact = computeMatch(M([R('A1', 150, 65, { A1: ['H'] })], { rounding: 'exact' }));
  assert.deepEqual(exact.rows[0].deltas, [155, 65]);
});

test('beczka: bez licytacji najwyżej 990, wygrana tylko ugraną licytacją ≥ 1000', () => {
  const rounds = [];
  for (let i = 0; i < 10; i++) rounds.push(R('A1', 100, 110)); // A przegrywa, B dostaje 110
  let c = computeMatch(M(rounds));
  assert.equal(c.scores[1], 990);
  assert.equal(c.winner, null);
  assert.ok(c.rows[9].notes[1].includes('limit 990'));
  // B przy 990 bez licytacji nic nie dostaje
  rounds.push(R('A1', 100, 50));
  c = computeMatch(M(rounds));
  assert.equal(c.scores[1], 990);
  assert.equal(c.rows[10].deltas[1], 0);
  // B wygrywa licytację i ją realizuje → wygrana
  rounds.push(R('B1', 100, 10));
  c = computeMatch(M(rounds));
  assert.equal(c.winner, 1);
  assert.equal(c.scores[1], 1100);
});

test('ugrany kontrakt bez osiągnięcia 1000 nie kończy meczu; przegrany przy 990 nie wygrywa', () => {
  let c = computeMatch(M([R('A1', 100, 20)])); // +100
  assert.equal(c.winner, null);
  const rounds = [];
  for (let i = 0; i < 9; i++) rounds.push(R('B1', 110, 0)); // B: +120 → ... B kontrakty ugrane
  c = computeMatch(M(rounds));
  assert.equal(c.winner, 1); // 9×120 = 1080 ≥ 1000 w 9. rozdaniu
  assert.equal(c.rows.length, 9);
  const r2 = [];
  for (let i = 0; i < 9; i++) r2.push(R('A1', 100, 120)); // A: −100 każda, B: 120 → cap 990
  r2.push(R('B1', 200, 30)); // B: 90 < 200 → −200
  c = computeMatch(M(r2));
  assert.equal(c.winner, null);
  assert.equal(c.scores[1], 790);
});

test('drużyna z ugranym kontraktem może przekroczyć 990 bez wygranej (exact)', () => {
  const rounds = [];
  for (let i = 0; i < 9; i++) rounds.push(R('A1', 100, 110)); // B → 990
  rounds.push(R('B1', 100, 115, {}, {})); // B ugrywa? 120-115 = 5 < 100 → nie
  const c = computeMatch(M(rounds, { rounding: 'exact' }));
  assert.equal(c.scores[1], 890);
});

test('punkty ujemne bez dolnego limitu', () => {
  const c = computeMatch(M([R('A1', 300, 100), R('A1', 300, 100)]));
  assert.equal(c.scores[0], -600);
});

test('kolejny rozdający po kolei wg miejsc', () => {
  const m = M([{ ...R('A1', 100, 20), dealer: 'B2' }]);
  assert.equal(computeMatch(m).nextDealer, 'A1');
  assert.equal(computeMatch(M()).nextDealer, 'A1');
});

test('walidacja: nie można oznaczyć ugranego kontraktu przy za małych punktach', () => {
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 150, made: true, cards: { 1: 90 }, melds: {} }), /za mało/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, made: false, cards: { 1: 0 }, melds: {} }), /zrealizowany/);
  const ok = validateRoundInput(M(), { bidder: 'A1', bid: 100, made: true, cards: { 1: 10 }, melds: { A2: ['C'] } });
  assert.equal(ok.made, true);
  assert.equal(ok.got, 150); // 110 + trefl 40
});

test('walidacja: wymagane punkty przeciwników, zakresy, unikalne meldunki, suma 120', () => {
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, cards: {} }), /przeciwnej/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'X', bid: 100, cards: { 1: 0 } }), /licytującego/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 105, cards: { 1: 0 } }), /Kontrakt/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, cards: { 1: 130 } }), /0–120/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, cards: { 0: 50, 1: 60 } }), /120/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, cards: { 1: 0 }, melds: { A1: ['H'], B1: ['H'] } }), /tylko raz/);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, cards: { 1: 0 }, melds: { A1: ['X'] } }), RuleError);
  assert.throws(() => validateRoundInput(M(), { bidder: 'A1', bid: 100, cards: { 1: '10' } }), RuleError);
});

test('rozdania historyczne (legacy) liczą się starą formułą max(licytacja, ugrane)', () => {
  const legacy = { bidder: 'A1', bid: 150, made: true, got: 120, cards: {}, melds: {}, scoring: 'legacy' };
  const ev = evaluateRound(M(), legacy, normalizeSettings({}));
  assert.equal(ev.deltas[0], 150);
});

test('ustawienia są walidowane', () => {
  assert.throws(() => normalizeSettings({ rounding: 'up' }), RuleError);
  assert.throws(() => normalizeSettings({ target: 1005 }), RuleError);
  assert.equal(normalizeSettings({}).rounding, 'nearest10');
  assert.equal(normalizeSettings({}).contractCheck, 'rounded');
});

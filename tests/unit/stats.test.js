import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, rivalryFor, ranking, wilson, groupKey, pairKey } from '../../shared/stats.js';

let n = 0;
const iso = (d) => new Date(Date.parse('2026-11-01T10:00:00Z') + d * 3600e3).toISOString();
// Mecz zakończony wygraną drużyny `win` (0 = seats[0]+seats[2]).
function match(seats, win, { day = 0, meetId = 'S1', status = 'finished', mode = 'offline' } = {}) {
  const bidder = seats[win];
  const opp = String(1 - win);
  const rounds = [];
  for (let i = 0; i < 9; i++) rounds.push({ id: 'r' + ++n, mode, bidder, bid: 100, made: true, got: 120, cards: { [opp]: 0 }, melds: {}, dealer: seats[i % 4], createdAt: iso(day) });
  return { id: 'm' + ++n, seats, settings: {}, rounds: status === 'active' ? rounds.slice(0, 2) : rounds, status, winner: status === 'finished' ? win : null, createdAt: iso(day), meetId, groupKey: groupKey(seats) };
}
const [K, D, R, A, M] = ['kamil', 'daniel', 'karol', 'akuro', 'mati'];

test('grupy: ta sama czwórka w różnych składach drużyn i różnych dniach = jedna grupa', () => {
  const ms = [
    match([K, D, R, A], 0, { day: 0 }), match([K, D, R, A], 1, { day: 1 }), match([D, K, A, R], 0, { day: 2 }),
    match([K, R, D, A], 0, { day: 200, meetId: 'S2' }), match([A, K, R, D], 1, { day: 201, meetId: 'S2' }),
    match([K, R, D, A], 0, { day: 202, meetId: 'S2' }), match([K, A, D, R], 0, { day: 203, meetId: 'S2' }),
  ];
  const s = computeStats(ms);
  const g = s.groups[groupKey([K, D, R, A])];
  assert.equal(Object.keys(s.groups).length, 1);
  assert.equal(g.matches, 7);
  assert.equal(g.meetCount, 2);
  assert.equal(g.rounds, 63);
  // zastąpienie Kamila Matim → nowa grupa
  const s2 = computeStats([...ms, match([M, D, R, A], 0, { day: 300 })]);
  assert.equal(Object.keys(s2.groups).length, 2);
  assert.equal(s2.groups[groupKey([M, D, R, A])].matches, 1);
});

test('pary: sumują się niezależnie od przeciwników; filtr wg grupy', () => {
  const ms = [];
  for (let i = 0; i < 10; i++) ms.push(match([A, D, R, K], i < 7 ? 0 : 1, { day: i })); // Akuro+Karol vs Daniel+Kamil
  for (let i = 0; i < 5; i++) ms.push(match([A, M, R, D], 0, { day: 100 + i, meetId: 'S9' })); // Akuro+Karol vs Mati+Daniel
  const s = computeStats(ms);
  const p = s.pairs[pairKey(A, R)];
  assert.equal(p.matches, 15);
  assert.equal(p.wins, 12);
  assert.equal(p.losses, 3);
  assert.equal(p.groups.length, 2);
  const onlyFirst = computeStats(ms, { groupKey: groupKey([A, D, R, K]) });
  assert.equal(onlyFirst.pairs[pairKey(A, R)].matches, 10);
});

test('globalne: mecze, wygrane, przegrane, serie; nieukończone nie liczą się do wygranych', () => {
  const ms = [match([K, D, R, A], 0, { day: 0 }), match([K, D, R, A], 0, { day: 1 }), match([K, D, R, A], 1, { day: 2 }), match([K, D, R, A], 0, { day: 3, status: 'active' }), match([K, D, R, A], 0, { day: 4, status: 'abandoned' })];
  const s = computeStats(ms);
  const k = s.players[K];
  assert.equal(k.matches, 3);
  assert.equal(k.wins, 2);
  assert.equal(k.losses, 1);
  assert.equal(k.bestStreak, 2);
  assert.equal(k.streak, 0);
  assert.equal(k.active, 1);
  assert.equal(k.abandoned, 1);
  assert.ok(k.rounds > 27, 'rozdania z gier nieukończonych liczą się do rozdań');
  assert.equal(s.players[D].wins, 1);
  assert.equal(k.bids, 18 + 2 + 9); // licytował w wygranych przez drużynę 0
});

test('ranking z uwzględnieniem liczby meczów: 75% z 40 > 100% z 1', () => {
  assert.ok(wilson(30, 40) > wilson(1, 1));
  const ms = [match([K, D, R, A], 0)];
  for (let i = 0; i < 40; i++) ms.push(match([M, D, A, R], i < 30 ? 0 : 1, { day: i + 1 }));
  const s = computeStats(ms);
  const byRate = ranking(s, 'winRate');
  assert.equal(byRate[0].id, M);
  assert.equal(ranking(s, 'winRate', 5).some((p) => p.id === K), false, 'filtr minimalnej liczby meczów');
});

test('rywalizacja: najlepszy partner, najczęstszy przeciwnik, bilans', () => {
  const ms = [];
  for (let i = 0; i < 6; i++) ms.push(match([K, D, R, A], 0, { day: i })); // K+R wygrywają z D+A
  for (let i = 0; i < 4; i++) ms.push(match([K, R, A, D], 1, { day: 10 + i })); // K+A przegrywają z R+D
  const s = computeStats(ms);
  const r = rivalryFor(s, K, 1);
  assert.equal(r.bestPartner.id, R);
  assert.equal(r.worstPartner.id, A);
  assert.equal(r.mostFrequentPartner.id, R);
  const vsD = r.opponents.find((o) => o.id === D);
  assert.deepEqual([vsD.matches, vsD.wins, vsD.losses], [10, 6, 4]);
});

test('sesje: wyniki spotkania', () => {
  const ms = [match([K, D, R, A], 0, { meetId: 'X' }), match([K, D, R, A], 0, { meetId: 'X' }), match([K, D, R, A], 1, { meetId: 'Y', day: 30 })];
  const s = computeStats(ms);
  assert.equal(s.meets.X.finished, 2);
  assert.equal(s.meets.X.wins[K], 2);
  assert.equal(s.meets.X.pairWins[pairKey(K, R)], 2);
  assert.equal(s.meets.Y.matchIds.length, 1);
});

test('zmiana nicku nie wpływa na statystyki (liczone po ID); korekta wyniku zmienia statystyki', () => {
  const m = match([K, D, R, A], 0);
  const s1 = computeStats([m]);
  assert.equal(s1.players[K].wins, 1);
  // korekta: ostatnie rozdanie przegrane → brak zwycięzcy
  const fixed = { ...m, rounds: m.rounds.map((r, i) => (i === 8 ? { ...r, made: false, cards: { 1: 100 }, got: 20 } : r)), status: 'active', winner: null };
  const s2 = computeStats([fixed]);
  assert.equal(s2.players[K].wins, 0);
  assert.equal(s2.players[K].matches, 0);
});

test('mecz z rozdaniami online i offline liczy się jako jeden mecz', () => {
  const m = match([K, D, R, A], 0);
  m.rounds = m.rounds.map((r, i) => ({ ...r, mode: i % 2 ? 'online' : 'offline', ...(i % 2 ? { tricksWon: { [K]: 2, [R]: 1, [D]: 2, [A]: 1 } } : {}) }));
  const s = computeStats([m]);
  assert.equal(s.players[K].matches, 1);
  assert.equal(s.players[K].tricks, 8);
  assert.equal(s.players[K].trickRounds, 4);
  assert.deepEqual(s.players[K].history[0].modes.sort(), ['offline', 'online']);
});

test('brak danych nie jest traktowany jako zero (punkty z kart nieznane w starych rozdaniach)', () => {
  const m = match([K, D, R, A], 0);
  m.rounds = m.rounds.map((r) => ({ ...r, cards: {}, scoring: 'legacy' }));
  const s = computeStats([m]);
  assert.equal(s.players[K].cardRounds, 0);
  assert.equal(s.players[D].cardRounds, 0);
});

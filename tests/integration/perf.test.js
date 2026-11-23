// Testy wydajności (orientacyjne progi na zwykłym laptopie).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../../shared/stats.js';
import { startServer, Client } from '../helpers.js';

test('statystyki dla 2000 meczów (30 000 rozdań) w < 2 s', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 'u' + i);
  const matches = [];
  for (let k = 0; k < 2000; k++) {
    const seats = [ids[k % 12], ids[(k + 3) % 12], ids[(k + 6) % 12], ids[(k + 9) % 12]];
    const rounds = Array.from({ length: 15 }, (_, i) => ({ id: `r${k}-${i}`, mode: 'offline', bidder: seats[i % 4], bid: 100, made: i % 3 !== 0, got: 120, cards: { [String(1 - (i % 2))]: i % 3 ? 0 : 110 }, melds: {}, dealer: seats[i % 4], createdAt: new Date(1e12 + k * 1e6).toISOString() }));
    matches.push({ id: 'm' + k, seats, settings: {}, rounds, status: 'active', createdAt: new Date(1e12 + k * 1e6).toISOString() });
  }
  const t0 = performance.now();
  const s = computeStats(matches);
  const ms = performance.now() - t0;
  assert.ok(Object.keys(s.players).length === 12);
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
});

test('200 równoległych zapisów rozdań do 20 meczów – bez utraty danych, sensowny czas', async () => {
  const srv = await startServer();
  try {
    const c = new Client(srv.base);
    const ids = [(await c.register('P1')).id];
    for (const n of ['P2', 'P3', 'P4']) ids.push((await new Client(srv.base).register(n)).id);
    const ms = [];
    for (let i = 0; i < 20; i++) ms.push((await c.post('/api/matches', { seats: ids })).data.match);
    const t0 = performance.now();
    // każdy mecz: 10 rozdań po kolei, mecze równolegle
    await Promise.all(ms.map(async (m) => {
      let rev = m.rev;
      for (let k = 0; k < 10; k++) {
        const r = await c.post(`/api/matches/${m.id}/rounds`, { baseRev: rev, opId: `${m.id}-${k}`, round: { bidder: ids[k % 4], bid: 100, cards: { [String(1 - (k % 2))]: 30 }, melds: {} } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        rev = r.data.match.rev;
      }
    }));
    const dt = performance.now() - t0;
    const data = (await c.get('/api/data')).data;
    assert.equal(data.matches.reduce((a, m) => a + m.rounds.length, 0), 200);
    assert.ok(dt < 20000, `${Math.round(dt)} ms`);
    console.log(`  200 zapisów: ${Math.round(dt)} ms (${Math.round(dt / 200)} ms/zapis z fsync)`);
  } finally {
    await srv.close();
  }
});

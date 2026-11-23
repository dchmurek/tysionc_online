import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from '../helpers.js';

let srv, a, b, outsider, ids;
before(async () => {
  srv = await startServer();
  a = new Client(srv.base);
  const ua = await a.register('Kamil');
  const others = [];
  for (const n of ['Daniel', 'Karol', 'Akuro']) { const c = new Client(srv.base); others.push(await c.register(n)); }
  b = new Client(srv.base);
  await b.login('Daniel');
  outsider = new Client(srv.base);
  await outsider.register('Obcy');
  ids = [ua.id, others[0].id, others[1].id, others[2].id]; // drużyny: Kamil+Karol vs Daniel+Akuro
});
after(async () => { await srv.close(); });

async function newMatch(extra = {}) {
  const r = await a.post('/api/matches', { seats: ids, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.match;
}

test('tworzenie meczu, dodanie rozdania, wynik liczony przez serwer', async () => {
  const m = await newMatch();
  assert.equal(m.rev, 1);
  assert.ok(m.meetId, 'mecz przypisany do sesji');
  const r = await a.post(`/api/matches/${m.id}/rounds`, { baseRev: 1, opId: 'op1', round: { bidder: ids[0], bid: 120, made: true, cards: { 1: 20 }, melds: { [ids[2]]: ['D'] } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const round = r.data.match.rounds[0];
  assert.equal(round.got, 180);
  assert.equal(round.made, true);
  assert.equal(round.dealer, ids[0]);
  assert.equal(r.data.match.rev, 2);
});

test('nie można ręcznie oznaczyć kontraktu jako ugranego przy za małych punktach', async () => {
  const m = await newMatch();
  const r = await a.post(`/api/matches/${m.id}/rounds`, { baseRev: m.rev, opId: 'x1', round: { bidder: ids[0], bid: 160, made: true, cards: { 1: 70 }, melds: {} } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /za mało/);
});

test('konflikt wersji: dwa telefony – drugi zapis odrzucony, nic nie ginie', async () => {
  const m = await newMatch();
  const round = { bidder: ids[0], bid: 100, cards: { 1: 10 }, melds: {} };
  const [r1, r2] = await Promise.all([
    a.post(`/api/matches/${m.id}/rounds`, { baseRev: m.rev, opId: 'pa', round }),
    b.post(`/api/matches/${m.id}/rounds`, { baseRev: m.rev, opId: 'pb', round: { ...round, bidder: ids[1], cards: { 0: 30 } } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = r1.status === 409 ? r1 : r2;
  assert.equal(loser.data.code, 'conflict');
  assert.equal(loser.data.current.rounds.length, 1, 'odpowiedź 409 zawiera aktualny stan');
  const now = (await a.get(`/api/matches/${m.id}`)).data.match;
  assert.equal(now.rounds.length, 1);
});

test('powtórzona operacja (ten sam opId) nie dubluje rozdania', async () => {
  const m = await newMatch();
  const body = { baseRev: m.rev, opId: 'same-op', round: { bidder: ids[0], bid: 100, cards: { 1: 10 }, melds: {} } };
  const r1 = await a.post(`/api/matches/${m.id}/rounds`, body);
  const r2 = await a.post(`/api/matches/${m.id}/rounds`, body);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.replay, true);
  assert.equal(r2.data.match.rounds.length, 1);
});

test('uprawnienia: osoba spoza meczu nie może go zmieniać', async () => {
  const m = await newMatch();
  const r = await outsider.post(`/api/matches/${m.id}/rounds`, { baseRev: m.rev, opId: 'o', round: { bidder: ids[0], bid: 100, cards: { 1: 0 }, melds: {} } });
  assert.equal(r.status, 403);
  const d = await outsider.post(`/api/matches/${m.id}/status`, { baseRev: m.rev, status: 'deleted' });
  assert.equal(d.status, 403);
});

test('cofnięcie, korekta rozdania, zakończenie meczu i obcięcie po korekcie', async () => {
  const m = await newMatch({ settings: { target: 300 } });
  let rev = m.rev;
  const add = async (round, op) => { const r = await a.post(`/api/matches/${m.id}/rounds`, { baseRev: rev, opId: op, round }); assert.equal(r.status, 200, JSON.stringify(r.data)); rev = r.data.match.rev; return r.data.match; };
  await add({ bidder: ids[0], bid: 100, cards: { 1: 0 }, melds: {} }, 'a1'); // +120
  let mm = await add({ bidder: ids[1], bid: 100, cards: { 0: 0 }, melds: {} }, 'a2'); // B +120
  const lastId = mm.rounds[1].id;
  const u = await a.post(`/api/matches/${m.id}/undo`, { baseRev: rev, opId: 'u1', roundId: lastId });
  assert.equal(u.status, 200);
  assert.equal(u.data.match.rounds.length, 1);
  rev = u.data.match.rev;
  mm = await add({ bidder: ids[1], bid: 100, cards: { 0: 0 }, melds: {} }, 'a3');
  mm = await add({ bidder: ids[0], bid: 100, cards: { 1: 0 }, melds: {} }, 'a4'); // A: 240
  assert.equal(mm.status, 'active');
  // korekta pierwszego rozdania: A dostaje 120+kier 100 = 220 → w drugim rozdaniu A ma… nadal; zróbmy korektę rozdania 4 tak, by wygrało
  const fix = await a.put(`/api/matches/${m.id}/rounds/${mm.rounds[0].id}`, { baseRev: rev, opId: 'f1', round: { bidder: ids[0], bid: 300, cards: { 1: 0 }, melds: { [ids[0]]: ['H'], [ids[2]]: ['D'] } } }); // 120+100+80 = 300 → wygrana już w 1. rozdaniu
  assert.equal(fix.status, 409);
  assert.equal(fix.data.code, 'would_truncate');
  const fix2 = await a.put(`/api/matches/${m.id}/rounds/${mm.rounds[2].id}`, { baseRev: rev, opId: 'f2', round: { bidder: ids[0], bid: 100, cards: { 1: 0 }, melds: { [ids[2]]: ['D'] } } });
  assert.equal(fix2.status, 200);
  assert.equal(fix2.data.match.status, 'finished');
  assert.equal(fix2.data.match.winner, 0);
  assert.equal(fix2.data.match.rounds[2].history.length, 1, 'zapisana historia korekty');
  // dodanie rozdania do zakończonego meczu – odrzucone
  const late = await a.post(`/api/matches/${m.id}/rounds`, { baseRev: fix2.data.match.rev, opId: 'late', round: { bidder: ids[0], bid: 100, cards: { 1: 0 }, melds: {} } });
  assert.equal(late.status, 400);
});

test('zasady meczu niezmienne: zaokrąglanie zapisane w meczu', async () => {
  const m = await newMatch({ settings: { rounding: 'exact', contractCheck: 'raw' } });
  assert.equal(m.settings.rounding, 'exact');
  const r = await a.post(`/api/matches/${m.id}/rounds`, { baseRev: m.rev, opId: 'e1', round: { bidder: ids[0], bid: 100, cards: { 1: 17 }, melds: {} } });
  assert.equal(r.data.match.rounds[0].got, 103);
  const bad = await a.post('/api/matches', { seats: ids, settings: { rounding: 'up' } });
  assert.equal(bad.status, 400);
});

test('sesje: kolejny mecz tej samej czwórki trafia do tej samej sesji; nowa sesja na żądanie', async () => {
  const m1 = await newMatch();
  const m2 = await newMatch();
  assert.equal(m1.meetId, m2.meetId);
  const s = await a.post('/api/meets', { players: ids });
  assert.equal(s.status, 200);
  const m3 = await newMatch();
  assert.equal(m3.meetId, s.data.meet.id);
  assert.notEqual(m3.meetId, m1.meetId);
  const closed = await a.post(`/api/meets/${s.data.meet.id}/close`);
  assert.equal(closed.data.meet.status, 'closed');
  const m4 = await newMatch();
  assert.notEqual(m4.meetId, s.data.meet.id);
});

test('eksport JSON bez hashy haseł i sesji; eksport CSV', async () => {
  const r = await a.get('/api/export/json');
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('argon2') && !text.includes('passwordHash') && !text.includes('tokenHash'));
  assert.equal(r.data.format, 'tysiac-export');
  for (const kind of ['matches', 'rounds', 'players', 'groups', 'pairs']) {
    const c = await a.get('/api/export/csv/' + kind);
    assert.equal(c.status, 200, kind);
    assert.match(c.headers.get('content-type'), /text\/csv/);
    assert.ok(c.data.split('\r\n').length > 1);
  }
});

test('usunięcie meczu jest miękkie; przywraca administrator', async () => {
  const m = await newMatch();
  const d = await a.post(`/api/matches/${m.id}/status`, { baseRev: m.rev, opId: 'del', status: 'deleted' });
  assert.equal(d.data.match.status, 'deleted');
  const data = await a.get('/api/data');
  assert.ok(!data.data.matches.some((x) => x.id === m.id), 'gracz nie widzi usuniętego');
  const back = await a.post(`/api/matches/${m.id}/status`, { baseRev: d.data.match.rev, opId: 'undel', status: 'active' });
  assert.equal(back.status, 403);
});

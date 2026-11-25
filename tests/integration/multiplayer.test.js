// Symulacja czterech niezależnych graczy (osobne sesje i połączenia WebSocket).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, sleep } from '../helpers.js';

const seeded = (seed) => { let s = seed >>> 0; return (n) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; }; };
let srv, dataDir;
const players = [];
const NICKS = ['Kamil', 'Daniel', 'Karol', 'Akuro'];

before(async () => {
  srv = await startServer({ randomInt: seeded(42) });
  dataDir = srv.dataDir;
  for (const n of NICKS) {
    const c = new Client(srv.base);
    await c.register(n);
    players.push(c);
  }
});
after(async () => { for (const p of players) p.wsc && p.wsc.close(); await srv.close(); });

async function connectAll() {
  for (const p of players) {
    p.wsc = p.ws();
    await p.wsc.ready;
    await p.wsc.wait((m) => m.type === 'hello');
  }
}
async function subscribeAll(roomId) {
  for (const p of players) {
    p.wsc.send({ type: 'subscribe', roomId });
    await p.wsc.wait((m) => m.type === 'room' && m.roomId === roomId);
  }
}
const view = (p, roomId) => p.wsc.rooms[roomId];
async function waitSeq(p, roomId, seq) {
  for (let i = 0; i < 200; i++) {
    const v = view(p, roomId);
    if (v && v.seq >= seq) return v;
    await sleep(5);
  }
  throw new Error('nie doszła aktualizacja seq ' + seq);
}

// Rozgrywa bieżące rozdanie: wszyscy pasują (gra obowiązkowe 100), zagrania – pierwsza legalna karta, meldunek gdy można.
async function playHand(roomId) {
  let guard = 0;
  for (;;) {
    const v0 = view(players[0], roomId);
    if (!v0 || v0.status !== 'playing') return v0;
    const turn = v0.hand.turn;
    const p = players.find((x) => view(x, roomId).mySeat === turn);
    const v = await waitSeq(p, roomId, v0.seq);
    if (v.hand.phase === 'bidding') await p.wsc.act(roomId, { type: 'pass', expectSeq: v.seq, actionId: `a${v.seq}` });
    else if (v.hand.phase === 'giving') {
      const to = [0, 1, 2, 3].find((s) => s !== v.mySeat && !v.hand.given[s]);
      await p.wsc.act(roomId, { type: 'give', card: v.hand.hand[0], to, expectSeq: v.seq, actionId: `a${v.seq}` });
    }
    else {
      const card = v.hand.legal[0];
      await p.wsc.act(roomId, { type: 'play', card, expectSeq: v.seq, actionId: `a${v.seq}` });
    }
    for (const x of players) await waitSeq(x, roomId, v.seq + 1);
    if (++guard > 60) throw new Error('rozdanie się nie kończy');
  }
}

let roomId, matchId;

test('pokój: tworzenie, dołączanie kodem, miejsca, gotowość, start', async () => {
  await connectAll();
  const r = await players[0].post('/api/rooms', { settings: { target: 300 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  roomId = r.data.room.id;
  assert.match(r.data.room.code, /^[A-Z0-9]{6}$/);
  for (const p of players.slice(1)) assert.equal((await p.post('/api/rooms/join', { code: r.data.room.code.toLowerCase() })).status, 200);
  assert.equal((await new Client(srv.base).post('/api/rooms/join', { code: 'ZZZZZZ' })).status, 401);
  await subscribeAll(roomId);
  for (let i = 0; i < 4; i++) await players[i].wsc.act(roomId, { type: 'sit', seat: i });
  await assert.rejects(players[1].wsc.act(roomId, { type: 'sit', seat: 0 }), /zajęte/);
  await assert.rejects(players[0].wsc.act(roomId, { type: 'start' }), /gotowi/);
  for (const p of players) await p.wsc.act(roomId, { type: 'ready' });
  await players[0].wsc.act(roomId, { type: 'start' });
  const v = await waitSeq(players[2], roomId, view(players[0], roomId).seq);
  assert.equal(v.status, 'playing');
  matchId = v.matchId;
  assert.ok(matchId);
});

test('każdy widzi tylko swoje karty (serwer nie wysyła kart przeciwników)', async () => {
  const room = srv.app.services.rooms.rooms.get(roomId);
  for (let s = 0; s < 4; s++) {
    const v = view(players[s], roomId);
    assert.equal(v.hand.hand.length, 5);
    assert.equal(v.hand.musikCount, 4);
    assert.deepEqual(v.hand.hand.slice().sort(), room.hand.hands[s].slice().sort());
    const json = JSON.stringify(v);
    for (let o = 0; o < 4; o++) if (o !== s) for (const c of room.hand.hands[o]) assert.ok(!json.includes(`"${c}"`), `gracz ${s} widzi kartę ${c}`);
    for (const c of room.hand.musik) assert.ok(!json.includes(`"${c}"`), `gracz ${s} widzi musik ${c}`);
  }
});

test('ochrona przed oszustwem: ruch poza kolejką, cudza karta, zła licytacja, powtórzona akcja', async () => {
  const v = view(players[0], roomId);
  const turn = v.hand.turn;
  const notTurn = players.find((p) => view(p, roomId).mySeat !== turn);
  await assert.rejects(notTurn.wsc.act(roomId, { type: 'pass' }), (e) => e.code === 'turn');
  const actor = players.find((p) => view(p, roomId).mySeat === turn);
  await assert.rejects(actor.wsc.act(roomId, { type: 'bid', value: 105 }), /Zła wartość/);
  await assert.rejects(actor.wsc.act(roomId, { type: 'play', card: 'AH' }), /licytacja/);
  await assert.rejects(actor.wsc.act(roomId, { type: 'bid', value: 100, expectSeq: 0 }), (e) => e.code === 'stale');
  const seq = view(actor, roomId).seq;
  await actor.wsc.act(roomId, { type: 'bid', value: 110, actionId: 'dup-1', expectSeq: seq });
  const again = await actor.wsc.act(roomId, { type: 'bid', value: 110, actionId: 'dup-1' });
  assert.equal(again.duplicate, true);
  const room = srv.app.services.rooms.rooms.get(roomId);
  assert.equal(room.hand.bidding.history.filter((h) => h.value === 110).length, 1, 'akcja wykonana raz');
  // osoba spoza pokoju
  const obcy = new Client(srv.base);
  await obcy.register('Podgladacz');
  const w = obcy.ws();
  await w.ready;
  w.send({ type: 'subscribe', roomId, reqId: 1 });
  const err = await w.wait((m) => m.reqId === 1);
  assert.equal(err.type, 'error');
  w.close();
  for (const p of players) await waitSeq(p, roomId, room.seq);
});

test('pełne rozdanie online zapisuje się w historii meczu (z przebiegiem zagrań)', async () => {
  await playHand(roomId);
  const v = view(players[0], roomId);
  assert.ok(['between', 'finished'].includes(v.status));
  assert.equal(v.lastHand.cardPoints[0] + v.lastHand.cardPoints[1], 120);
  const m = (await players[0].get(`/api/matches/${matchId}`)).data.match;
  assert.equal(m.rounds.length, 1);
  assert.equal(m.rounds[0].mode, 'online');
  assert.ok(m.rounds[0].plays.filter((p) => p.type === 'play').length === 24);
  assert.equal(m.mode, 'online');
});

test('podczas rozdania online nie można dopisać wyniku offline do tego meczu', async () => {
  for (const p of players) await p.wsc.act(roomId, { type: 'ready' });
  const v = await waitSeq(players[0], roomId, view(players[3], roomId).seq);
  assert.equal(v.status, 'playing');
  const m = (await players[0].get(`/api/matches/${matchId}`)).data.match;
  const r = await players[0].post(`/api/matches/${matchId}/rounds`, { baseRev: m.rev, opId: 'off', round: { bidder: m.seats[0], bid: 100, cards: { 1: 0 } } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'live');
  await assert.rejects(players[0].wsc.act(roomId, { type: 'detach' }), /Dokończ rozdanie/);
});

test('meczu otwartego w pokoju online nie da się usunąć ani przerwać (stół by się zablokował na ostatniej karcie)', async () => {
  const m = (await players[0].get(`/api/matches/${matchId}`)).data.match;
  for (const status of ['deleted', 'abandoned']) {
    const r = await players[0].post(`/api/matches/${matchId}/status`, { baseRev: m.rev, opId: 'del-' + status, status });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.error, /pokoju online/);
  }
});

test('unieważnienie rozdania: tylko administrator, bez zapisu punktów', async () => {
  await assert.rejects(players[0].wsc.act(roomId, { type: 'abort-hand' }), /administrator/);
});

test('rozłączenie i ponowne połączenie: stan odtworzony', async () => {
  const p = players[1];
  const before = view(p, roomId);
  p.wsc.close();
  await sleep(50);
  p.wsc = p.ws();
  await p.wsc.ready;
  p.wsc.send({ type: 'subscribe', roomId });
  const m = await p.wsc.wait((x) => x.type === 'room' && x.roomId === roomId);
  assert.deepEqual(m.room.hand.hand, before.hand.hand);
  assert.equal(m.room.seq, before.seq);
});

test('restart serwera w trakcie rozdania: mecz i rozdanie trwają dalej', async () => {
  // dwa ruchy przed restartem
  const v0 = view(players[0], roomId);
  const roomBefore = structuredClone(srv.app.services.rooms.rooms.get(roomId));
  for (const p of players) p.wsc.close();
  await srv.close();
  srv = await startServer({ dataDir, randomInt: seeded(7) });
  // te same ciasteczka – sesje są w JSON
  for (const p of players) p.base = srv.base;
  await connectAll();
  await subscribeAll(roomId);
  const roomAfter = srv.app.services.rooms.rooms.get(roomId);
  assert.deepEqual(roomAfter.hand.hands, roomBefore.hand.hands);
  assert.equal(view(players[0], roomId).seq, v0.seq);
  await playHand(roomId);
  const m = (await players[0].get(`/api/matches/${matchId}`)).data.match;
  assert.equal(m.rounds.length, 2);
});

test('przełączenie online → offline między rozdaniami i dalej offline → online (ten sam mecz)', async () => {
  let v = view(players[0], roomId);
  if (v.status === 'finished') return; // mecz mógł się już skończyć (target 300)
  await players[2].wsc.act(roomId, { type: 'detach' });
  let m = (await players[0].get(`/api/matches/${matchId}`)).data.match;
  assert.equal(m.mode, 'offline');
  const scoresBefore = m.rounds.length;
  // rozdanie offline (prawdziwe karty)
  const r = await players[0].post(`/api/matches/${matchId}/rounds`, { baseRev: m.rev, opId: 'offline-1', round: { bidder: m.seats[1], bid: 100, cards: { 0: 50 }, melds: {} } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  m = r.data.match;
  assert.equal(m.rounds.length, scoresBefore + 1);
  assert.equal(m.rounds.at(-1).mode, 'offline');
  // i znowu online – nowy pokój dla tego samego meczu, gracze siadają na swoich miejscach automatycznie
  const nr = await players[3].post('/api/rooms', { fromMatchId: matchId });
  assert.equal(nr.status, 200);
  const newRoom = nr.data.room.id;
  for (const p of players) await p.post('/api/rooms/join', { code: nr.data.room.code });
  await subscribeAll(newRoom);
  v = view(players[0], newRoom);
  assert.deepEqual(v.seats, m.seats);
  for (const p of players) await p.wsc.act(newRoom, { type: 'ready' });
  await players[0].wsc.act(newRoom, { type: 'start' });
  v = await waitSeq(players[0], newRoom, view(players[1], newRoom).seq);
  assert.equal(v.status, 'playing');
  // rozdający kontynuuje kolejkę z meczu
  const lastDealerSeat = m.seats.indexOf(m.rounds.at(-1).dealer);
  assert.equal(v.hand.dealerSeat, (lastDealerSeat + 1) % 4);
  roomId = newRoom;
  // grać do końca meczu
  for (let i = 0; i < 40; i++) {
    await playHand(roomId);
    v = view(players[0], roomId);
    if (v.status === 'finished') break;
    for (const p of players) await p.wsc.act(roomId, { type: 'ready' });
    await waitSeq(players[0], roomId, view(players[3], roomId).seq);
  }
  assert.equal(view(players[0], roomId).status, 'finished');
  m = (await players[0].get(`/api/matches/${matchId}`)).data.match;
  assert.equal(m.status, 'finished');
  assert.ok(m.rounds.some((x) => x.mode === 'offline') && m.rounds.some((x) => x.mode === 'online'));
  const modes = m.modeHistory.map((h) => h.mode);
  assert.deepEqual(modes.slice(0, 3), ['online', 'offline', 'online']);
  // jeden mecz w statystykach
  const data = (await players[0].get('/api/data')).data;
  assert.equal(data.matches.filter((x) => x.id === matchId).length, 1);
});

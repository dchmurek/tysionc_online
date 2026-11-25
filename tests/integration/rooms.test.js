// Testy usług pokoju bez WebSocketu: unieważnienie rozdania, uprawnienia miejsc w kontynuacji meczu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from '../helpers.js';

let srv, users, svc;
before(async () => {
  srv = await startServer();
  svc = srv.app.services;
  users = [];
  for (const n of ['R1', 'R2', 'R3', 'R4', 'Obcy2']) users.push(await new Client(srv.base).register(n));
});
after(async () => { await srv.close(); });

async function startedRoom() {
  const u = users.slice(0, 4).map((x) => ({ ...x, role: 'player' }));
  const room = await svc.rooms.create(u[0], {});
  for (const x of u.slice(1)) await svc.rooms.joinByCode(x, room.code);
  for (let i = 0; i < 4; i++) await svc.rooms.act(u[i], room.id, { type: 'sit', seat: i });
  for (let i = 0; i < 4; i++) await svc.rooms.act(u[i], room.id, { type: 'ready' });
  await svc.rooms.act(u[0], room.id, { type: 'start' });
  return { room: svc.rooms.get(room.id), u };
}

test('administrator może unieważnić rozdanie – bez punktów w historii', async () => {
  const { room, u } = await startedRoom();
  assert.equal(room.status, 'playing');
  await assert.rejects(svc.rooms.act(u[1], room.id, { type: 'abort-hand' }), /administrator/);
  await svc.rooms.act({ ...u[0], role: 'admin' }, room.id, { type: 'abort-hand' });
  assert.equal(room.status, 'between');
  const m = await svc.matches.get(room.matchId);
  assert.equal(m.rounds.length, 0);
  // kolejne rozdanie po gotowości wszystkich
  for (let i = 0; i < 4; i++) await svc.rooms.act(u[i], room.id, { type: 'ready' });
  assert.equal(room.status, 'playing');
});

test('kontynuacja meczu online: miejsca zarezerwowane dla graczy meczu; obcy nie usiądzie', async () => {
  const u = users.slice(0, 4).map((x) => ({ ...x, role: 'player' }));
  const m = await svc.matches.create(u[0], { seats: u.map((x) => x.id) });
  const room = await svc.rooms.create(u[1], { fromMatchId: m.id });
  const obcy = { ...users[4], role: 'player' };
  await svc.rooms.joinByCode(obcy, room.code);
  await assert.rejects(svc.rooms.act(obcy, room.id, { type: 'sit', seat: 0 }), /należy do innego gracza/);
  const again = await svc.rooms.create(u[2], { fromMatchId: m.id });
  assert.equal(again.id, room.id, 'jeden pokój na mecz');
  await assert.rejects(svc.rooms.create(obcy, { fromMatchId: m.id }), /Nie grasz/);
});

test('musik: grający oddaje karty; oddana karta widoczna tylko dla odbiorcy (dziennik bez karty)', async () => {
  const { room, u } = await startedRoom();
  const h = room.hand;
  while (h.phase === 'bidding') await svc.rooms.act(u[h.turn], room.id, { type: 'pass' });
  const b = h.contract.seat;
  assert.equal(h.hands[b].length, 9);
  const others = [0, 1, 2, 3].filter((s) => s !== b);
  const card = h.hands[b][0];
  await svc.rooms.act(u[b], room.id, { type: 'give', card, to: others[0] });
  const viewRecipient = JSON.stringify(svc.rooms.viewFor(room, u[others[0]].id));
  const viewThird = JSON.stringify(svc.rooms.viewFor(room, u[others[1]].id));
  assert.ok(viewRecipient.includes(`"${card}"`), 'odbiorca widzi kartę');
  assert.ok(!viewThird.includes(`"${card}"`), 'inni nie widzą oddanej karty');
  assert.equal(room.log.at(-1).type, 'give');
  assert.equal(room.log.at(-1).card, undefined);
});

test('nieudany zapis wyniku przy ostatniej karcie nie blokuje stołu – ruch się cofa i można go powtórzyć', async () => {
  const { room, u } = await startedRoom();
  const play = async (card) => svc.rooms.act(u[room.hand.turn], room.id, { type: 'play', card: card ?? room.hand.hands[room.hand.turn].find((c) => legal(c)) });
  const { legalCards } = await import('../../shared/cards.js');
  const legal = (c) => legalCards(room.hand, room.hand.turn).includes(c);
  while (room.hand.phase === 'bidding') await svc.rooms.act(u[room.hand.turn], room.id, { type: 'pass' });
  const b = room.hand.turn;
  const gives = [0, 1, 2, 3].filter((s) => s !== b).map((to, i) => ({ card: room.hand.hands[b][i], to }));
  await svc.rooms.act(u[b], room.id, { type: 'give-all', gives });
  while (!(room.hand.tricks.length === 5 && room.hand.trick.cards.length === 3)) await play();
  const last = room.hand.turn;
  const card = room.hand.hands[last][0];
  const orig = svc.matches.appendOnlineRound.bind(svc.matches);
  svc.matches.appendOnlineRound = async () => { throw new Error('dysk pełny'); };
  await assert.rejects(svc.rooms.act(u[last], room.id, { type: 'play', card }), /dysk pełny/);
  assert.equal(room.status, 'playing');
  assert.equal(room.hand.phase, 'playing', 'rozdanie nie utknęło jako „zakończone”');
  assert.deepEqual(room.hand.hands[last], [card], 'karta wróciła do ręki');
  svc.matches.appendOnlineRound = orig;
  await svc.rooms.act(u[last], room.id, { type: 'play', card });
  assert.equal(room.status === 'between' || room.status === 'finished', true);
  assert.equal((await svc.matches.get(room.matchId)).rounds.length, 1);
});

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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { startServer, Client } from '../helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const rawGet = (path) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: srv.port, path, method: 'GET' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); });
  r.on('error', reject);
  r.end();
});

test('pliki serwera i danych nie są dostępne przez HTTP (path traversal)', async () => {
  for (const p of ['/../server/config.js', '/..%2fserver%2fconfig.js', '/shared/../server/app.js', '/shared/..%2f..%2fpackage.json', '/storage/users.json', '/.env', '/%2e%2e/%2e%2e/etc/passwd']) {
    const r = await rawGet(p);
    assert.ok(!r.body.includes('createApp') && !r.body.includes('"dependencies"') && !r.body.includes('root:'), p + ' → ' + r.status);
    assert.ok(r.status === 403 || r.status === 404 || (r.status === 200 && r.headers['content-type'].startsWith('text/html')), p + ' → ' + r.status);
  }
  const users = await rawGet(`/${encodeURIComponent('..')}/${encodeURIComponent('..')}${srv.dataDir}/users.json`);
  assert.notEqual(users.status, 200);
});

test('nagłówki bezpieczeństwa i CSP na stronie', async () => {
  const r = await rawGet('/');
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('WebSocket: bez sesji, bez Origin lub z obcego Origin – odrzucony', async () => {
  const c = new Client(srv.base);
  await c.register('Wsuser');
  const url = srv.base.replace('http', 'ws') + '/ws';
  const attempt = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  assert.equal(await attempt({ Origin: srv.base }), 401);
  assert.equal(await attempt({ Cookie: c.cookie }), 403);
  assert.equal(await attempt({ Cookie: c.cookie, Origin: 'https://evil.example' }), 403);
  assert.equal(await attempt({ Cookie: c.cookie, Origin: srv.base }), 'open');
});

test('za duże żądanie odrzucone (413), zły JSON (400)', async () => {
  const c = new Client(srv.base);
  await c.register('Duzy');
  const big = await c.req('POST', '/api/account/profile', { x: 'a'.repeat(1.2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const bad = await fetch(srv.base + '/api/account/profile', { method: 'POST', headers: { Cookie: c.cookie, 'X-CSRF-Token': c.csrf, 'X-Tysiac': '1', 'Content-Type': 'application/json' }, body: '{nie-json' });
  assert.equal(bad.status, 400);
});

test('manipulacja wynikiem: serwer liczy wynik sam, ignoruje pola od klienta', async () => {
  const a = new Client(srv.base);
  const ids = [await a.register('M1')];
  for (const n of ['M2', 'M3', 'M4']) ids.push(await new Client(srv.base).register(n));
  const m = (await a.post('/api/matches', { seats: ids.map((u) => u.id), status: 'finished', winner: 0 })).data.match;
  assert.equal(m.status, 'active', 'klient nie ustawia statusu przy tworzeniu');
  assert.equal(m.winner, null);
  const r = await a.post(`/api/matches/${m.id}/rounds`, { baseRev: m.rev, opId: 'x', round: { bidder: ids[0].id, bid: 100, cards: { 1: 0 }, melds: {}, made: true, got: 9999, dealer: ids[3].id, mode: 'online', id: 'hack' } });
  assert.equal(r.status, 200);
  const round = r.data.match.rounds[0];
  assert.equal(round.got, 120);
  assert.equal(round.mode, 'offline');
  assert.notEqual(round.id, 'hack');
  assert.equal(round.dealer, ids[0].id, 'rozdającego wyznacza serwer');
});

test('nieznane akcje i identyfikatory – bez wycieku błędów wewnętrznych', async () => {
  const c = new Client(srv.base);
  await c.register('Ciekawski');
  const r = await c.get('/api/matches/..%2F..%2Fusers');
  assert.equal(r.status, 400);
  const r2 = await c.get('/api/nie-ma');
  assert.equal(r2.status, 404);
  const r3 = await c.get('/api/rooms/room_nieistniejacy');
  assert.equal(r3.status, 404);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, Client } from '../helpers.js';

const rawPost = (port, path, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode); });
  r.on('error', reject);
  r.end(body);
});

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

test('rejestracja, logowanie, wylogowanie', async () => {
  const c = new Client(srv.base);
  const u = await c.register('Mati');
  assert.equal(u.nick, 'Mati');
  assert.equal(u.role, 'player');
  assert.equal(u.passwordHash, undefined, 'hash hasła nie może wyjść z serwera');
  let me = await c.get('/api/me');
  assert.equal(me.data.user.id, u.id);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  me = await c.get('/api/me');
  assert.equal(me.data.user, null);
  const c2 = new Client(srv.base);
  await c2.login('mati'); // wielkość liter nie ma znaczenia
  assert.equal(c2.user.id, u.id);
});

test('ciasteczko sesji: HttpOnly, SameSite=Strict', async () => {
  const c = new Client(srv.base);
  const r = await c.post('/api/auth/register', { nick: 'Ciastek', password: 'bardzo-tajne-haslo' });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
});

test('unikalność nicków z normalizacją (wielkość liter, znaki diakrytyczne, separatory)', async () => {
  const c = new Client(srv.base);
  await c.register('Akuro');
  for (const n of ['akuro', 'AKURO', 'Akúro', 'Aku-ro', ' akuro ']) {
    const r = await new Client(srv.base).post('/api/auth/register', { nick: n, password: 'bardzo-tajne-haslo' });
    assert.equal(r.status, 409, n);
  }
  const bad = await new Client(srv.base).post('/api/auth/register', { nick: '<script>', password: 'bardzo-tajne-haslo' });
  assert.equal(bad.status, 400);
  const cyr = await new Client(srv.base).post('/api/auth/register', { nick: 'Аkuro', password: 'bardzo-tajne-haslo' }); // cyrylica
  assert.equal(cyr.status, 400);
});

test('słabe hasło odrzucone', async () => {
  const r = await new Client(srv.base).post('/api/auth/register', { nick: 'Slaby', password: 'krotkie' });
  assert.equal(r.status, 400);
  const r2 = await new Client(srv.base).post('/api/auth/register', { nick: 'Slaby', password: '1234567890' });
  assert.equal(r2.status, 400);
});

test('CSRF: żądanie bez tokenu lub z obcego originu odrzucone', async () => {
  const c = new Client(srv.base);
  await c.register('Csrf');
  const noToken = await c.req('POST', '/api/account/profile', { color: '#112233' }, { 'X-CSRF-Token': '' });
  assert.equal(noToken.status, 403);
  const noHeader = await fetch(srv.base + '/api/account/profile', { method: 'POST', headers: { Cookie: c.cookie, 'X-CSRF-Token': c.csrf, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const evil = await rawPost(srv.port, '/api/account/profile', { Cookie: c.cookie, 'X-CSRF-Token': c.csrf, 'X-Tysiac': '1', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, '{}');
  assert.equal(evil, 403);
  const ok = await c.post('/api/account/profile', { color: '#112233' });
  assert.equal(ok.status, 200);
});

test('limit prób logowania', async () => {
  const c = new Client(srv.base);
  await c.register('Limit');
  let last;
  for (let i = 0; i < 6; i++) last = await new Client(srv.base).post('/api/auth/login', { nick: 'Limit', password: 'zle-haslo-xyz' });
  assert.equal(last.status, 429);
  const blocked = await new Client(srv.base).post('/api/auth/login', { nick: 'Limit', password: 'bardzo-tajne-haslo' });
  assert.equal(blocked.status, 429, 'nawet poprawne hasło blokowane w czasie blokady');
});

test('zmiana hasła unieważnia inne sesje; stare hasło nie działa', async () => {
  const a = new Client(srv.base);
  await a.register('Zmiana');
  const b = new Client(srv.base);
  await b.login('Zmiana');
  const r = await a.post('/api/account/password', { old: 'bardzo-tajne-haslo', new: 'nowe-dlugie-haslo-2' });
  assert.equal(r.status, 200);
  assert.equal((await b.get('/api/me')).data.user, null, 'druga sesja wylogowana');
  assert.equal((await a.get('/api/me')).data.user.nick, 'Zmiana', 'bieżąca sesja zostaje');
  assert.equal((await new Client(srv.base).post('/api/auth/login', { nick: 'Zmiana', password: 'bardzo-tajne-haslo' })).status, 401);
  await new Client(srv.base).login('Zmiana', 'nowe-dlugie-haslo-2');
  const wrong = await a.post('/api/account/password', { old: 'zle', new: 'jeszcze-inne-haslo' });
  assert.equal(wrong.status, 403);
});

test('zmiana nicku nie zmienia ID; wymaga hasła; unikalność', async () => {
  const a = new Client(srv.base);
  const u = await a.register('Stary');
  assert.equal((await a.post('/api/account/nick', { nick: 'Nowy', password: 'zle' })).status, 403);
  const r = await a.post('/api/account/nick', { nick: 'Nowy', password: 'bardzo-tajne-haslo' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.id, u.id);
  assert.equal(r.data.user.nick, 'Nowy');
  assert.equal((await a.post('/api/account/nick', { nick: 'mati', password: 'bardzo-tajne-haslo' })).status, 409);
  await new Client(srv.base).login('Nowy');
});

test('autoryzacja: gracz nie ma dostępu do panelu administratora', async () => {
  const c = new Client(srv.base);
  await c.register('Zwykly');
  assert.equal((await c.get('/api/admin/users')).status, 403);
  assert.equal((await c.post('/api/admin/backups')).status, 403);
  assert.equal((await new Client(srv.base).get('/api/data')).status, 401);
});

test('aktywacja konta kodem od administratora (konto bez hasła)', async () => {
  const { accounts } = srv.app.services;
  const admin = new Client(srv.base);
  const au = await admin.register('Szef');
  await accounts.setRole('test', au.id, 'admin');
  const prof = await admin.post('/api/users/profile', { nick: 'Kamil' });
  assert.equal(prof.data.user.status, 'pending');
  // bez kodu nie da się zalogować
  assert.equal((await new Client(srv.base).post('/api/auth/login', { nick: 'Kamil', password: 'cokolwiek-123' })).status, 401);
  const code = (await admin.post(`/api/admin/users/${prof.data.user.id}/activation`, {})).data.code;
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const bad = await new Client(srv.base).post('/api/auth/activate', { nick: 'Kamil', code: 'AAAA-BBBB-CCCC', password: 'sekretne-zdanie-77' });
  assert.equal(bad.status, 400);
  const k = new Client(srv.base);
  const ok = await k.post('/api/auth/activate', { nick: 'kamil', code: code.toLowerCase(), password: 'sekretne-zdanie-77' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.status, 'active');
  // kod jednorazowy
  assert.equal((await new Client(srv.base).post('/api/auth/activate', { nick: 'Kamil', code, password: 'inne-sekretne-77x' })).status, 400);
  await new Client(srv.base).login('Kamil', 'sekretne-zdanie-77');
  // administrator nie widzi hashy
  const list = await admin.get('/api/admin/users');
  assert.ok(list.data.users.every((x) => x.passwordHash === undefined));
});

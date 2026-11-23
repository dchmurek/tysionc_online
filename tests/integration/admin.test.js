import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, Client } from '../helpers.js';

let srv, admin;
before(async () => {
  srv = await startServer();
  admin = new Client(srv.base);
  const u = await admin.register('Szef');
  await srv.app.services.accounts.setRole('test', u.id, 'admin');
});
after(async () => { await srv.close(); });

test('import starej bazy przez panel: podgląd → zastosowanie → kopia przed importem', async () => {
  const data = JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-db.json', import.meta.url)));
  const p = await admin.post('/api/admin/import/preview', { data });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.kind, 'legacy');
  assert.deepEqual(p.data.summary.players.sort(), ['Akuro → Akuro', 'Damazy → Daniel', 'Dollat → Kamil', 'Karol → Karol']);
  // przed zastosowaniem nic się nie zmienia
  assert.equal((await admin.get('/api/data')).data.matches.length, 0);
  const a = await admin.post('/api/admin/import/apply', { token: p.data.token });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.createdMatches.length, 3);
  const d = (await admin.get('/api/data')).data;
  assert.equal(d.matches.length, 3);
  assert.deepEqual(d.users.filter((u) => u.status === 'pending').map((u) => u.nick).sort(), ['Akuro', 'Daniel', 'Kamil', 'Karol']);
  assert.equal((await admin.post('/api/admin/import/apply', { token: p.data.token })).status, 400, 'token jednorazowy');
});

test('eksport → import do drugiej instancji: duplikaty wykryte, anulowanie możliwe', async () => {
  const exp = (await admin.get('/api/export/json')).data;
  const p = await admin.post('/api/admin/import/preview', { data: exp });
  assert.equal(p.data.kind, 'export');
  assert.equal(p.data.summary.duplicates, 3);
  assert.equal(p.data.summary.matchesToAdd, 0);
  assert.equal((await admin.post('/api/admin/import/cancel', { token: p.data.token })).data.cancelled, true);

  const srv2 = await startServer();
  const adm2 = new Client(srv2.base);
  const u2 = await adm2.register('Admin2');
  await srv2.app.services.accounts.setRole('t', u2.id, 'admin');
  const p2 = await adm2.post('/api/admin/import/preview', { data: exp });
  assert.equal(p2.data.summary.matchesToAdd, 3);
  assert.equal(p2.data.summary.newUsers, 5);
  const a2 = await adm2.post('/api/admin/import/apply', { token: p2.data.token });
  assert.equal(a2.data.createdMatches.length, 3);
  const bad = await adm2.post('/api/admin/import/preview', { data: { format: 'cos-innego' } });
  assert.equal(bad.status, 400);
  const future = await adm2.post('/api/admin/import/preview', { data: { ...exp, version: 99 } });
  assert.equal(future.status, 400);
  await srv2.close();
});

test('kopie: ręczna kopia, pobranie zaszyfrowane, przywrócenie z podglądem', async () => {
  const c = await admin.post('/api/admin/backups');
  assert.equal(c.status, 200);
  const list = (await admin.get('/api/admin/backups')).data.backups;
  assert.ok(list.some((b) => b.name === c.data.backup.name));
  const short = await admin.post('/api/admin/backups/download', { passphrase: 'krotkie' });
  assert.equal(short.status, 400);
  const res = await fetch(srv.base + '/api/admin/backups/download', { method: 'POST', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf, 'X-Tysiac': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'bardzo-dlugie-haslo-kopii' }) });
  assert.equal(res.status, 200);
  const enc = Buffer.from(await res.arrayBuffer());
  assert.ok(!enc.toString().includes('argon2'), 'zaszyfrowane');
  // zmiana danych po kopii
  const m = (await admin.get('/api/data')).data.matches[0];
  await admin.post(`/api/matches/${m.id}/status`, { baseRev: m.rev, opId: 'del1', status: 'deleted' });
  const pv = await admin.post('/api/admin/restore/preview', { file: enc.toString('base64'), passphrase: 'bardzo-dlugie-haslo-kopii' });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.matches, 3);
  const wrong = await admin.post('/api/admin/restore/preview', { file: enc.toString('base64'), passphrase: 'zle-haslo-zle-haslo' });
  assert.equal(wrong.status, 400);
  // podgląd z poprawnym hasłem jeszcze raz (zły nadpisał? nie – zły nie ustawia podglądu)
  await admin.post('/api/admin/restore/preview', { file: enc.toString('base64'), passphrase: 'bardzo-dlugie-haslo-kopii' });
  const ap = await admin.post('/api/admin/restore/apply');
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  // sesja administratora jest w kopii → nadal zalogowany
  const after = (await admin.get('/api/data')).data.matches.find((x) => x.id === m.id);
  assert.equal(after.status, m.status);
});

test('diagnostyka i weryfikacja integralności', async () => {
  const d = await admin.get('/api/admin/diagnostics');
  assert.equal(d.status, 200);
  assert.deepEqual(d.data.integrityProblems, []);
  const r = await admin.post('/api/admin/rebuild-stats');
  assert.deepEqual(r.data.errors, []);
});

test('zarządzanie użytkownikami: rola, blokada (wylogowuje), ostatni admin chroniony', async () => {
  const p = new Client(srv.base);
  const u = await p.register('Gracz1');
  assert.equal((await admin.post(`/api/admin/users/${u.id}/status`, { status: 'disabled' })).status, 200);
  assert.equal((await p.get('/api/me')).data.user, null);
  assert.equal((await new Client(srv.base).post('/api/auth/login', { nick: 'Gracz1', password: 'bardzo-tajne-haslo' })).status, 401);
  const me = admin.user;
  const demote = await admin.post(`/api/admin/users/${me.id}/role`, { role: 'player' });
  assert.equal(demote.status, 400);
  const cfg = await admin.post('/api/admin/config', { registrationOpen: false });
  assert.equal(cfg.data.config.registrationOpen, false);
  assert.equal((await new Client(srv.base).post('/api/auth/register', { nick: 'Nowy2', password: 'bardzo-tajne-haslo' })).status, 403);
  await admin.post('/api/admin/config', { registrationOpen: true });
});

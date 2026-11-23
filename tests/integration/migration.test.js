import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planMigration, applyMigration, canonicalUserId, NAME_MAP, MigrationError } from '../../server/migrate/legacy.js';
import { JsonStore } from '../../server/store/jsonStore.js';
import { validators } from '../../server/store/schemas.js';
import { createBackup, listBackups, readBackup } from '../../server/store/backup.js';
import { computeStats } from '../../shared/stats.js';
import { tmpDir } from '../helpers.js';

const fixture = () => JSON.parse(fs.readFileSync(new URL('../fixtures/legacy-db.json', import.meta.url)));
const ID = { Daniel: canonicalUserId('Daniel'), Kamil: canonicalUserId('Kamil'), Karol: canonicalUserId('Karol'), Akuro: canonicalUserId('Akuro') };

test('mapowanie jest dokładnie: Damazy→Daniel, Dollat→Kamil, Karol→Karol, Akuro→Akuro', () => {
  assert.deepEqual({ ...NAME_MAP }, { Damazy: 'Daniel', Dollat: 'Kamil', Karol: 'Karol', Akuro: 'Akuro' });
  const plan = planMigration(fixture());
  const map = Object.fromEntries(plan.report.players.map((p) => [p.legacyName, p.mappedTo]));
  assert.deepEqual(map, { Damazy: 'Daniel', Dollat: 'Kamil', Karol: 'Karol', Akuro: 'Akuro' });
  assert.notEqual(map.Damazy, 'Kamil');
  assert.notEqual(map.Dollat, 'Daniel');
  assert.deepEqual(plan.users.map((u) => u.nick).sort(), ['Akuro', 'Daniel', 'Kamil', 'Karol']);
  assert.ok(plan.users.every((u) => u.role === 'admin'), 'każdy z czterech graczy jest administratorem');
  assert.ok(plan.matches.every((m) => m.settings.contractCheck === 'rounded'));
});

test('historia przypisana właściwym osobom (licytacje Damazego → Daniel, Dollata → Kamil)', () => {
  const src = fixture();
  const plan = planMigration(src);
  const count = (legacyId) => src.games.reduce((a, g) => a + g.rounds.filter((r) => r.bidder === legacyId).length, 0);
  const countNew = (uid) => plan.matches.reduce((a, m) => a + m.rounds.filter((r) => r.bidder === uid).length, 0);
  assert.equal(countNew(ID.Daniel), count('p_dam'));
  assert.equal(countNew(ID.Kamil), count('p_dol'));
  assert.equal(countNew(ID.Karol), count('p_kar'));
  assert.equal(countNew(ID.Akuro), count('p_aku'));
  // miejsca przy stole zachowane
  const g2 = plan.matches.find((m) => m.id === 'g_two');
  assert.deepEqual(g2.seats, [ID.Karol, ID.Kamil, ID.Daniel, ID.Akuro]);
});

test('wyniki po migracji identyczne co do punktu; nic nie zgubione', () => {
  const plan = planMigration(fixture());
  assert.ok(plan.report.checks.every((c) => c.identical));
  assert.equal(plan.matches.length, 3);
  assert.equal(plan.report.summary.rounds, 13);
  assert.ok(plan.report.warnings.some((w) => /ugrane 120 < kontrakt 150/.test(w)), 'anomalia zgłoszona w raporcie');
});

test('duplikat Akuro bez historii łączony jako alias; usunięte rekordy w archiwum', () => {
  const plan = planMigration(fixture());
  assert.equal(plan.report.duplicates.length, 1);
  assert.match(plan.report.duplicates[0].resolution, /alias/);
  const akuro = plan.users.find((u) => u.nick === 'Akuro');
  assert.deepEqual(akuro.legacy.playerIds.sort(), ['p_aku', 'p_aku2']);
  const archived = plan.report.archived.map((a) => a.legacyName).sort();
  assert.deepEqual(archived, ['Akuro', 'Banderowiec', 'Daniel']);
  const daniel = plan.users.find((u) => u.nick === 'Daniel');
  assert.deepEqual(daniel.legacy.playerIds, ['p_dam'], 'stary pusty rekord „Daniel” nie jest doklejany');
});

test('dwa rekordy z historią na ten sam profil → migracja wstrzymana do decyzji', () => {
  const src = fixture();
  src.games[2].players = ['p_aku2', 'p_dam', 'p_kar', 'p_dol'];
  src.games[2].rounds[0].bidder = 'p_aku2';
  src.games[2].rounds[0].dealer = 'p_aku2';
  assert.throws(() => planMigration(src), (e) => e instanceof MigrationError && /rozstrzygnięcie/.test(e.message));
});

test('nieznany gracz w historii → przerwanie (bez zgadywania)', () => {
  const src = fixture();
  src.players.find((p) => p.id === 'p_kar').name = 'Ktoś';
  assert.throws(() => planMigration(src), /tabeli mapowania/);
});

test('meldunki: stare ♠ 60 → pik 60, stare ♣ 40 → trefl 40 (symbol i wartość zgodne z zasadami)', () => {
  const plan = planMigration(fixture());
  const r = plan.matches.find((m) => m.id === 'g_two').rounds[0];
  assert.deepEqual(r.melds[ID.Kamil], ['C']); // stare 'c' (♣ 40)
  assert.deepEqual(r.legacy.melds.p_dol, ['c']);
  const r1 = plan.matches.find((m) => m.id === 'g_one').rounds[0];
  assert.deepEqual(r1.melds[ID.Karol], ['S']); // stare 's' (♠ 60)
  assert.ok(plan.matches.every((m) => m.meldsV2 === true));
});

test('zastosowanie: kopia przed migracją, idempotencja, brak duplikatów, statystyki zachowane', async () => {
  const dir = tmpDir();
  const store = await new JsonStore(dir, { validators }).init();
  await store.update('users', () => ({ users: {} }));
  const plan = planMigration(fixture());
  const res1 = await applyMigration(store, plan, { backup: (l) => createBackup(store, l) });
  assert.equal(res1.createdMatches.length, 3);
  assert.deepEqual(res1.createdUsers.sort(), ['Akuro', 'Daniel', 'Kamil', 'Karol']);
  assert.ok((await listBackups(store)).some((b) => b.name.includes('pre-migration')));
  const matches1 = [];
  for (const n of await store.list('matches')) matches1.push((await store.get(n)).data);
  const statsBefore = computeStats(matches1);

  // ponowna migracja – nic się nie zmienia
  const res2 = await applyMigration(store, planMigration(fixture()), {});
  assert.equal(res2.alreadyApplied, true);
  assert.equal(res2.createdMatches.length, 0);
  assert.equal(res2.createdUsers.length, 0);
  assert.equal((await store.list('matches')).length, 3);
  const users = Object.values((await store.getData('users')).users);
  assert.equal(users.length, 4);
  const matches2 = [];
  for (const n of await store.list('matches')) matches2.push((await store.get(n)).data);
  assert.deepEqual(computeStats(matches2).players, statsBefore.players);
  assert.equal(statsBefore.players[ID.Daniel].bids, 8); // 7 rozegranych w g_one (wygrana w 7.) + 1 w g_two
  assert.equal((await store.verifyAll()).length, 0);
  // wycofanie: kopia sprzed migracji zawiera stan początkowy
  const pre = (await listBackups(store)).find((b) => b.name.includes('pre-migration'));
  const bundle = await readBackup(store, pre.name);
  assert.ok(!Object.keys(bundle.files).some((f) => f.startsWith('matches/')));
  store.close();
});

test('istniejące konto „Kamil” innej osoby blokuje migrację (bez nadpisania)', async () => {
  const dir = tmpDir();
  const store = await new JsonStore(dir, { validators }).init();
  await store.update('users', () => ({ users: { uOTHER123: { id: 'uOTHER123', nick: 'kamil', nickKey: 'kamil', role: 'player', status: 'pending', passwordHash: null, createdAt: new Date().toISOString() } } }));
  await assert.rejects(applyMigration(store, planMigration(fixture()), {}), /zajęty/);
  store.close();
});

// Test na prawdziwych danych – tylko lokalnie (plik nie trafia do repozytorium).
const REAL = path.resolve('data/db.json');
test('prawdziwe dane (lokalnie): 4 profile, wszystkie wyniki identyczne', { skip: !fs.existsSync(REAL) && 'brak data/db.json' }, () => {
  const plan = planMigration(JSON.parse(fs.readFileSync(REAL, 'utf8')));
  const map = Object.fromEntries(plan.report.players.map((p) => [p.legacyName, p.mappedTo]));
  assert.deepEqual(map, { Damazy: 'Daniel', Dollat: 'Kamil', Karol: 'Karol', Akuro: 'Akuro' });
  assert.ok(plan.report.checks.every((c) => c.identical));
  assert.equal(plan.matches.length, plan.report.checks.length);
});

test('konwersja melds-v2 danych zmigrowanych przed zmianą zasad: tylko stare rozdania, jednorazowo, wyniki bez zmian', async () => {
  const { upgradeMeldsV2 } = await import('../../server/migrate/meldsV2.js');
  const { computeMatch } = await import('../../shared/scoring.js');
  const dir = tmpDir();
  const store = await new JsonStore(dir, { validators }).init();
  const plan = planMigration(fixture());
  // symulacja starej migracji: meldunki zapisane odwrotnie (C↔S), bez znacznika meldsV2
  const swap = { C: 'S', S: 'C' };
  const oldStyle = plan.matches.map((m) => { const x = structuredClone(m); delete x.meldsV2; for (const r of x.rounds) for (const u of Object.keys(r.melds)) r.melds[u] = r.melds[u].map((s) => swap[s] || s); return x; });
  // w aktywnym meczu nowe rozdanie dopisane w nowej aplikacji (pik klikany jako symbol)
  const active = oldStyle.find((m) => m.status === 'active');
  active.rounds.push({ id: 'r_new1', mode: 'offline', bidder: active.seats[0], bid: 100, made: true, got: 160, cards: { 1: 20 }, melds: { [active.seats[0]]: ['S'] }, dealer: active.seats[0], createdAt: new Date().toISOString() });
  for (const m of oldStyle) await store.update('matches/' + m.id, () => m);
  const res = await upgradeMeldsV2(store, { backup: (l) => createBackup(store, l) });
  assert.equal(res.converted, oldStyle.length);
  for (const m of plan.matches) {
    const now = (await store.get('matches/' + m.id)).data;
    const legacyRounds = now.rounds.filter((r) => r.scoring === 'legacy');
    assert.deepEqual(legacyRounds.map((r) => r.melds), m.rounds.map((r) => r.melds), 'stare rozdania = poprawne mapowanie');
    const cOld = computeMatch(m);
    const cNow = computeMatch({ ...now, rounds: legacyRounds });
    assert.deepEqual(cNow.scores, cOld.scores, 'wyniki historyczne co do punktu');
  }
  const act = (await store.get('matches/' + active.id)).data;
  assert.deepEqual(act.rounds.at(-1).melds[active.seats[0]], ['S'], 'nowe rozdanie bez zmian');
  assert.equal((await upgradeMeldsV2(store)).converted, 0, 'drugi raz nic nie robi');
  assert.ok((await listBackups(store)).some((b) => b.name.includes('pre-melds-v2')));
  store.close();
});

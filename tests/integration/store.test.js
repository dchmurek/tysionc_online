import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore, ConflictError, ValidationError } from '../../server/store/jsonStore.js';
import { validators } from '../../server/store/schemas.js';
import { createBackup, readBackup, restoreBundle, encryptBundle, decryptBundle, buildBundle } from '../../server/store/backup.js';
import { tmpDir } from '../helpers.js';

test('zapis atomowy: koperta z sumą kontrolną i wersją', async () => {
  const dir = tmpDir();
  const s = await new JsonStore(dir).init();
  const r = await s.update('config', () => ({ registrationOpen: true, defaultSettings: {} }));
  assert.equal(r.rev, 1);
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(env._meta.rev, 1);
  assert.equal(env._meta.sha256.length, 64);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')));
  s.close();
});

test('100 równoległych zmian – żadna nie ginie (kolejka operacji)', async () => {
  const s = await new JsonStore(tmpDir()).init();
  await Promise.all(Array.from({ length: 100 }, () => s.update('meta', (d) => ({ n: ((d && d.n) || 0) + 1 }))));
  const d = await s.get('meta');
  assert.equal(d.data.n, 100);
  assert.equal(d.rev, 100);
  s.close();
});

test('kontrola wersji: zapis ze starą wersją odrzucony (ConflictError)', async () => {
  const s = await new JsonStore(tmpDir()).init();
  await s.update('meta', () => ({ v: 1 }));
  await s.update('meta', () => ({ v: 2 }), { expectRev: 1 });
  await assert.rejects(s.update('meta', () => ({ v: 3 }), { expectRev: 1 }), ConflictError);
  assert.equal((await s.getData('meta')).v, 2);
  s.close();
});

test('walidacja przed zapisem: zły dokument nie trafia na dysk', async () => {
  const dir = tmpDir();
  const s = await new JsonStore(dir, { validators }).init();
  await assert.rejects(s.update('users', () => ({ users: { x: { id: 'x' } } })), ValidationError);
  assert.ok(!fs.existsSync(path.join(dir, 'users.json')));
  s.close();
});

test('odzyskiwanie po awarii: uszkodzony plik → poprzednia wersja (.prev); osierocone .tmp usunięte', async () => {
  const dir = tmpDir();
  let s = await new JsonStore(dir).init();
  await s.update('meta', () => ({ v: 1 }));
  await s.update('meta', () => ({ v: 2 }));
  s.close();
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"_meta":{"rev":2,"sha256":"zle"},"data":{"v":999}}');
  fs.writeFileSync(path.join(dir, 'meta.json.tmp-123-abcd'), 'połowa zapisu');
  s = await new JsonStore(dir, { log: { error() {}, warn() {} } }).init();
  assert.equal((await s.getData('meta')).v, 1);
  assert.ok(s.recovered.length >= 2);
  assert.ok(!fs.existsSync(path.join(dir, 'meta.json.tmp-123-abcd')));
  s.close();
});

test('jedna instancja zapisująca: druga odmawia startu', async () => {
  const dir = tmpDir();
  const s = await new JsonStore(dir).init();
  // symulacja innego żywego procesu: PID rodzica
  fs.writeFileSync(path.join(dir, '.writer.lock'), String(process.ppid));
  await assert.rejects(new JsonStore(dir).init(), /inny proces/);
  fs.writeFileSync(path.join(dir, '.writer.lock'), String(process.pid));
  s.close();
});

test('kopia zapasowa: utworzenie, odczyt, przywrócenie (test przywracania)', async () => {
  const dir = tmpDir();
  const s = await new JsonStore(dir, { validators }).init();
  await s.update('config', () => ({ registrationOpen: true, defaultSettings: {} }));
  await s.update('meta', () => ({ v: 'przed' }));
  const b = await createBackup(s, 'test');
  await s.update('meta', () => ({ v: 'po' }));
  await s.update('config', () => ({ registrationOpen: false, defaultSettings: {} }));
  const bundle = await readBackup(s, b.name);
  const r = await restoreBundle(s, bundle, { validators });
  assert.ok(r.preRestoreBackup.includes('pre-restore'));
  assert.equal((await s.getData('meta')).v, 'przed');
  assert.equal((await s.getData('config')).registrationOpen, true);
  assert.equal((await s.verifyAll()).length, 0);
  s.close();
});

test('kopia szyfrowana AES-256-GCM: złe hasło odrzucone, dobre odtwarza dane', async () => {
  const s = await new JsonStore(tmpDir()).init();
  await s.update('meta', () => ({ tajne: 'dane' }));
  const bundle = await buildBundle(s);
  const enc = await encryptBundle(bundle, 'dlugie-haslo-kopii');
  assert.ok(!enc.toString().includes('tajne'));
  await assert.rejects(decryptBundle(enc, 'zle-haslo-kopii!'), /Złe hasło/);
  const back = await decryptBundle(enc, 'dlugie-haslo-kopii');
  assert.equal(back.files.meta.data.tajne, 'dane');
  await assert.rejects(encryptBundle(bundle, 'krotkie'), /12 znaków/);
  s.close();
});

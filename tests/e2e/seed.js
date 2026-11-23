// Przygotowanie katalogu danych do testów E2E: migracja bazy (domyślnie syntetycznej)
// i aktywacja czterech kont testowym hasłem. NIGDY nie uruchamiaj na danych produkcyjnych.
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from '../../server/store/jsonStore.js';
import { validators } from '../../server/store/schemas.js';
import { planMigration, applyMigration } from '../../server/migrate/legacy.js';
import { hashPassword } from '../../server/services/passwords.js';

export const TEST_PASSWORD = 'test-haslo-e2e-123';

export async function seed(dataDir, source = new URL('../fixtures/legacy-db.json', import.meta.url)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  const store = await new JsonStore(dataDir, { validators }).init();
  await store.update('config', () => ({ registrationOpen: true, defaultSettings: {} }));
  await applyMigration(store, planMigration(JSON.parse(fs.readFileSync(source, 'utf8'))));
  const hash = await hashPassword(TEST_PASSWORD);
  await store.update('users', (doc) => {
    for (const u of Object.values(doc.users)) {
      u.passwordHash = hash;
      u.status = 'active';
      if (u.nick === 'Daniel') u.role = 'admin';
    }
    return doc;
  });
  store.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2];
  if (!dir || !dir.includes('tmp') && !dir.includes('.tmp') && !dir.includes('scratch')) { console.error('Podaj katalog tymczasowy'); process.exit(1); }
  await seed(path.resolve(dir), process.argv[3] ? path.resolve(process.argv[3]) : undefined);
  console.log('Gotowe:', dir);
}

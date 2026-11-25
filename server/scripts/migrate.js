// Migracja danych ze starej wersji PHP.
// Użycie:  npm run migrate -- --source data/db.json [--dry-run] [--prefer-source]
//   --prefer-source  mecze ze starej aplikacji zmienione lokalnie w nowej zastępuje wersją ze źródła (po kopii)
// Uruchamiaj przy zatrzymanym serwerze (magazyn ma jednego zapisującego).
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, getConfig, ROOT } from '../config.js';
import { JsonStore } from '../store/jsonStore.js';
import { validators } from '../store/schemas.js';
import { createBackup } from '../store/backup.js';
import { planMigration, applyMigration, MigrationError } from '../migrate/legacy.js';

loadEnvFile();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes('--dry-run');
const preferSource = args.includes('--prefer-source');
const source = path.resolve(ROOT, opt('--source') || 'data/db.json');
const config = getConfig();

if (!fs.existsSync(source)) { console.error('Brak pliku źródłowego:', source); process.exit(1); }
const legacy = JSON.parse(fs.readFileSync(source, 'utf8'));
let plan;
try {
  plan = planMigration(legacy);
} catch (e) {
  console.error('MIGRACJA PRZERWANA:', e.message);
  if (e instanceof MigrationError) console.error(JSON.stringify(e.report, null, 2));
  process.exit(2);
}
const r = plan.report;
console.log('== Raport migracji ==');
console.log('Źródło:', path.relative(ROOT, source), 'sha256', r.sourceSha256.slice(0, 16) + '…');
for (const p of r.players) console.log(`  ${p.legacyName.padEnd(12)} → ${p.mappedTo.padEnd(7)} (odwołań: ${p.references})`);
for (const a of r.archived) console.log(`  archiwum: ${a.legacyName}${a.deleted ? ' (usunięty)' : ''}, odwołań ${a.references}${a.aliasOf ? ` – alias ${a.aliasOf}` : ''}`);
for (const d of r.duplicates) console.log(`  duplikat ${d.target}: ${d.resolution || 'WYMAGA DECYZJI'}`);
for (const w of r.warnings) console.log('  uwaga:', w);
console.log('Kontrola wyników:', r.checks.every((c) => c.identical) ? `wszystkie ${r.checks.length} mecze identyczne co do punktu` : 'RÓŻNICE!');
console.log('Podsumowanie:', JSON.stringify(r.summary));
if (dry) { console.log('(--dry-run: nic nie zapisano)'); process.exit(0); }

const store = await new JsonStore(config.dataDir, { validators }).init();
try {
  const res = await applyMigration(store, plan, { backup: (label) => createBackup(store, label), preferSource });
  const dir = path.join(config.dataDir, 'migrations');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `report-${stamp}.json`), JSON.stringify({ report: r, result: res }, null, 2), { mode: 0o600 });
  fs.copyFileSync(source, path.join(dir, `source-${r.sourceSha256.slice(0, 16)}.json`));
  console.log(res.alreadyApplied ? 'Migracja była już wykonana – nic nie nadpisano.' : 'Migracja zakończona.');
  console.log('Utworzone konta:', res.createdUsers.join(', ') || '–', '| istniejące:', res.keptUsers.join(', ') || '–');
  console.log('Mecze – nowe:', res.createdMatches.length, '| zaktualizowane:', res.updatedMatches.length, '| pominięte:', res.skippedMatches.length);
  for (const u of res.updatedMatches.filter((x) => !x.unchanged)) console.log(`  ${u.id}: rozdania ${u.rounds}, status ${u.status}${u.replaced ? ' (zastąpiony wersją ze źródła)' : ''}`);
  for (const s of res.skippedMatches) if (s.reason !== 'już zmigrowany') console.log(`  pominięto ${s.id}: ${s.reason}`);
  console.log('Sesje – nowe:', res.createdMeets.length, '| zaktualizowane:', res.updatedMeets.length, '| usunięte:', res.removedMeets.length);
  console.log('Kopia przed migracją:', res.backup && res.backup.name);
} catch (e) {
  console.error('BŁĄD:', e.message);
  process.exitCode = 3;
} finally {
  store.close();
}

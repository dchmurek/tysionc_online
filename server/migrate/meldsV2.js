// Jednorazowa konwersja danych zmigrowanych przed zmianą zasad meldunków (23.11.2026).
// Wcześniejsza migracja zapisała stare „♠ 60” jako trefl i stare „♣ 40” jako pik (wg ówczesnej specyfikacji).
// Zasady właściciela: pik 60, trefl 40 – zamieniamy C↔S w rozdaniach ze starej aplikacji, wyniki zostają co do punktu.
// Rozdania dopisane w nowej aplikacji zostają bez zmian (gracz klikał symbol koloru).
const swap = { C: 'S', S: 'C' };

export async function upgradeMeldsV2(store, { backup, log } = {}) {
  const todo = [];
  for (const name of await store.list('matches')) {
    const d = await store.getData(name);
    if (d && d.migratedFrom && !d.meldsV2) todo.push(name);
  }
  if (!todo.length) return { converted: 0 };
  if (backup) await backup('pre-melds-v2');
  let rounds = 0;
  for (const name of todo) {
    await store.update(name, (m) => {
      if (!m || m.meldsV2) return undefined;
      for (const r of m.rounds) {
        if (r.scoring !== 'legacy') continue;
        for (const uid of Object.keys(r.melds || {})) r.melds[uid] = r.melds[uid].map((s) => swap[s] || s);
        rounds++;
      }
      m.meldsV2 = true;
      return m;
    });
  }
  await store.update('meta', (d) => {
    d = d || { schemaVersion: 2, migrations: [] };
    d.migrations.push({ id: 'melds-v2', at: new Date().toISOString(), matches: todo.length });
    return d;
  });
  if (log) log.info(`Konwersja meldunków (pik 60 / trefl 40): ${todo.length} meczów`);
  return { converted: todo.length, rounds };
}

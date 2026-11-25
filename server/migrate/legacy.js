// Migracja danych ze starej aplikacji PHP (data/db.json) do nowego modelu.
// OSTATECZNE MAPOWANIE GRACZY (ustalone przez właściciela projektu):
//   Damazy → Daniel,  Dollat → Kamil,  Karol → Karol,  Akuro → Akuro
// Migracja jest powtarzalna i idempotentna: ten sam plik źródłowy daje te same identyfikatory.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMatch } from '../../shared/scoring.js';
import { nickKey } from '../../shared/nick.js';
import { groupKeyOf } from '../store/schemas.js';

export const MIGRATION_ID = 'legacy-php-v1';
export const NAME_MAP = Object.freeze({ Damazy: 'Daniel', Dollat: 'Kamil', Karol: 'Karol', Akuro: 'Akuro' });
export const CANONICAL = Object.freeze(['Kamil', 'Daniel', 'Karol', 'Akuro']);

// Stara aplikacja zapisywała meldunki kodami h/d/s/c = kier 100, karo 80, pik ♠ 60, trefl ♣ 40 –
// dokładnie jak w zasadach właściciela, więc symbol i wartość się zgadzają (wyniki co do punktu).
export const LEGACY_MELD_MAP = Object.freeze({ h: 'H', d: 'D', s: 'S', c: 'C' });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const canonicalUserId = (nick) => 'u' + sha('tysiac-canonical-user:' + nick.toLowerCase()).slice(0, 20);
const roundId = (gameId, i) => 'r_' + sha(`tysiac-legacy-round:${gameId}:${i}`).slice(0, 20);
const meetId = (key) => 's_' + sha('tysiac-legacy-meet:' + key).slice(0, 20);
const MEET_GAP_MS = 12 * 3600e3;

export class MigrationError extends Error {
  constructor(msg, report) { super(msg); this.report = report; }
}

function legacyEngine() {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return require(path.join(here, 'legacyEngine.cjs'));
}

// Czysta funkcja: stara baza → nowe dokumenty + raport. Nie dotyka dysku.
export function planMigration(legacy, { now = new Date().toISOString() } = {}) {
  const sourceSha = sha(JSON.stringify(legacy));
  const report = { migration: MIGRATION_ID, sourceSha256: sourceSha, at: now, players: [], games: [], duplicates: [], archived: [], warnings: [], checks: [] };
  if (!legacy || !Array.isArray(legacy.players) || !Array.isArray(legacy.games)) throw new MigrationError('Źródło nie wygląda jak db.json starej aplikacji', report);

  // 1. Odwołania do graczy w meczach.
  const refs = {};
  const addRef = (id, kind) => { refs[id] = refs[id] || { players: 0, bidder: 0, melds: 0, dealer: 0 }; refs[id][kind]++; };
  for (const g of legacy.games) {
    g.players.forEach((p) => addRef(p, 'players'));
    for (const r of g.rounds) {
      addRef(r.bidder, 'bidder');
      if (r.dealer) addRef(r.dealer, 'dealer');
      for (const k of Object.keys(r.melds && !Array.isArray(r.melds) ? r.melds : {})) addRef(k, 'melds');
    }
  }
  const byId = Object.fromEntries(legacy.players.map((p) => [p.id, p]));
  for (const id of Object.keys(refs)) {
    if (!byId[id]) throw new MigrationError(`Mecz odwołuje się do nieistniejącego gracza ${id}`, report);
  }

  // 2. Mapowanie rekordów → konta kanoniczne.
  const legacyToUser = {};
  const usedBy = {};
  for (const p of legacy.players) {
    const referenced = !!refs[p.id];
    const total = refs[p.id] ? Object.values(refs[p.id]).reduce((a, b) => a + b, 0) : 0;
    const target = NAME_MAP[p.name];
    const entry = { legacyId: p.id, legacyName: p.name, deleted: !!p.deleted, references: total };
    if (referenced) {
      if (!target) throw new MigrationError(`Gracz „${p.name}” (${p.id}) występuje w meczach, ale nie ma go w tabeli mapowania`, report);
      if (usedBy[target]) {
        // Dwa różne rekordy z historią mapują się na ten sam profil – sprawdź, czy kiedykolwiek grali razem.
        const together = legacy.games.some((g) => g.players.includes(p.id) && g.players.includes(usedBy[target]));
        report.duplicates.push({ target, ids: [usedBy[target], p.id], playedTogether: together });
        throw new MigrationError(`Dwa rekordy z historią wskazują na profil ${target} – wymagane rozstrzygnięcie przed połączeniem`, report);
      }
      usedBy[target] = p.id;
      legacyToUser[p.id] = canonicalUserId(target);
      report.players.push({ ...entry, mappedTo: target, userId: legacyToUser[p.id] });
    } else {
      // Rekord bez żadnej historii – nie ma czego przenosić; trafia tylko do archiwum migracji.
      const same = target && legacy.players.find((x) => x.id !== p.id && x.name === p.name && refs[x.id]);
      if (same) report.duplicates.push({ target, ids: [same.id, p.id], playedTogether: false, resolution: 'drugi rekord nie ma żadnych odwołań – połączono (alias) bez przenoszenia danych' });
      report.archived.push({ ...entry, aliasOf: same ? NAME_MAP[p.name] : null });
    }
  }
  for (const nick of CANONICAL) {
    if (!usedBy[nick]) report.warnings.push(`Profil ${nick} nie ma historii w źródle – zostanie utworzony pusty`);
  }

  // 3. Konta kanoniczne (oczekujące na aktywację, bez hasła).
  const users = CANONICAL.map((nick) => {
    const legacyIds = legacy.players.filter((p) => legacyToUser[p.id] === canonicalUserId(nick) || (!refs[p.id] && NAME_MAP[p.name] === nick)).map((p) => p.id);
    const names = [...new Set(legacy.players.filter((p) => legacyIds.includes(p.id)).map((p) => p.name))];
    return {
      id: canonicalUserId(nick), nick, nickKey: nickKey(nick), role: 'admin', // ustalenie właściciela: każdy z czterech graczy jest administratorem
      status: 'pending', passwordHash: null,
      createdAt: now, updatedAt: now, activation: null, profile: {}, nickHistory: [],
      legacy: { playerIds: legacyIds, names, migration: MIGRATION_ID },
    };
  });

  // 4. Mecze.
  const engine = legacyEngine();
  const matches = [];
  for (const g of legacy.games) {
    if (g.mode !== '4x') throw new MigrationError(`Mecz ${g.id}: tryb ${g.mode} nie jest obsługiwany (tylko 4 na krzyż)`, report);
    const st = g.settings || {};
    if (st.zeroRule) throw new MigrationError(`Mecz ${g.id} używa zasady „3 zera” – wymagana decyzja`, report);
    if (g.rounds.some((r) => r.type === 'bomb')) throw new MigrationError(`Mecz ${g.id} zawiera bombę – wymagana decyzja`, report);
    const seats = g.players.map((p) => legacyToUser[p]);
    const rounds = g.rounds.map((r, i) => {
      const pts = Array.isArray(r.points) ? Object.fromEntries(r.points.map((v, k) => [k, v]).filter(([, v]) => v != null)) : (r.points || {});
      const cards = {};
      for (const [k, v] of Object.entries(pts)) cards[String(k)] = v;
      const legacyMelds = r.melds && !Array.isArray(r.melds) ? r.melds : {};
      const melds = {};
      for (const [pid, list] of Object.entries(legacyMelds)) if (list && list.length) melds[legacyToUser[pid]] = list.map((c) => LEGACY_MELD_MAP[c]);
      return {
        id: roundId(g.id, i), mode: 'offline', bidder: legacyToUser[r.bidder], bid: r.bid, made: !!r.made,
        got: r.got ?? null, cards, melds, dealer: r.dealer ? legacyToUser[r.dealer] : seats[(i + 0) % 4],
        createdAt: r.t || g.created, createdBy: null, scoring: 'legacy',
        legacy: { bidder: r.bidder, dealer: r.dealer || null, points: r.points ?? null, melds: legacyMelds, got: r.got ?? null, gotAuto: !!r.gotAuto, made: !!r.made, t: r.t || null },
      };
    });
    const match = {
      id: g.id, schema: 2, mode: 'offline', seats, firstDealerSeat: 0,
      settings: {
        target: st.target ?? 1000, passiveCap: st.passiveCap ?? 990, minBid: st.minBid ?? 100, bidStep: 10, maxBid: 400,
        rounding: st.round10 === false ? 'exact' : 'nearest10', contractCheck: 'rounded', mustBeat: true, mustTrump: true, meldOnFirstTrick: false,
      },
      rounds, status: g.status, winner: g.winner ?? null, createdAt: g.created, createdBy: null,
      finishedAt: g.finished, updatedAt: g.updated || g.updatedLocal || g.created, groupKey: groupKeyOf(seats), roomId: null,
      modeHistory: [{ mode: 'offline', at: g.created, by: null, afterRound: 0 }], appliedOps: [], meldsV2: true,
      migratedFrom: { migration: MIGRATION_ID, legacyId: g.id, sourceSha256: sourceSha, legacyPlayers: g.players.slice(), legacySettings: st },
    };
    if (!match.finishedAt) delete match.finishedAt;
    if (match.status === 'finished' && match.winner == null) report.warnings.push(`Mecz ${g.id}: status finished bez zwycięzcy`);

    // 5. Kontrola: nowa punktacja = stara punktacja, co do punktu, w każdym rozdaniu.
    const oldC = engine.computeGame(g);
    const newC = computeMatch(match);
    const same = oldC.rows.length === newC.rows.length && oldC.rows.every((row, i) => row.scores[0] === newC.rows[i].after[0] && row.scores[1] === newC.rows[i].after[1])
      && oldC.winner === newC.winner;
    report.checks.push({ matchId: g.id, rounds: g.rounds.length, oldScores: oldC.scores, newScores: newC.scores, oldWinner: oldC.winner, newWinner: newC.winner, identical: same });
    if (!same) throw new MigrationError(`Mecz ${g.id}: wynik po migracji różni się od oryginału – przerwano`, report);
    if (match.status === 'finished' && match.winner !== newC.winner) throw new MigrationError(`Mecz ${g.id}: zapisany zwycięzca niezgodny z przeliczonym`, report);
    for (const [i, r] of g.rounds.entries()) {
      if (r.made && r.got != null && r.got < r.bid) report.warnings.push(`Mecz ${g.id}, rozdanie ${i + 1}: oznaczone jako ugrane, ale ugrane ${r.got} < kontrakt ${r.bid} (zachowano historyczny wynik +${r.bid})`);
    }
    report.games.push({ id: g.id, created: g.created, status: g.status, rounds: g.rounds.length, teams: [[seats[0], seats[2]], [seats[1], seats[3]]] });
    matches.push(match);
  }

  // 6. Sesje (spotkania): ta sama czwórka; spotkanie = skupisko aktywności (rozpoczęcia meczów i rozdań)
  //    bez przerwy dłuższej niż 12 h. Mecz należy do spotkania, w którym się zaczął
  //    (mecz dokończony innego dnia pozostaje w spotkaniu, w którym go rozpoczęto).
  const meets = {};
  const byGroup = {};
  for (const m of matches) (byGroup[m.groupKey] = byGroup[m.groupKey] || []).push(m);
  for (const [gk, list] of Object.entries(byGroup)) {
    const times = [];
    for (const m of list) { times.push(m.createdAt); for (const r of m.rounds) times.push(r.createdAt); }
    times.sort();
    const clusters = [];
    for (const t of times) {
      const last = clusters[clusters.length - 1];
      if (!last || Date.parse(t) - Date.parse(last.end) > MEET_GAP_MS) clusters.push({ start: t, end: t });
      else last.end = t;
    }
    for (const c of clusters) {
      const s = { id: meetId(`${gk}:${c.start}`), groupKey: gk, players: list[0].seats.slice().sort(), status: 'closed', startedAt: c.start, endedAt: c.end, lastActivityAt: c.end, createdBy: null, migration: MIGRATION_ID };
      meets[s.id] = s;
      c.id = s.id;
    }
    for (const m of list) m.meetId = clusters.find((c) => m.createdAt >= c.start && m.createdAt <= c.end).id;
  }
  // Skupiska aktywności bez żadnego rozpoczętego meczu (np. dzień, w którym tylko dokończono mecz) nie tworzą sesji.
  for (const id of Object.keys(meets)) if (!matches.some((m) => m.meetId === id)) delete meets[id];
  // Ostatnia sesja z trwającym meczem zostaje otwarta.
  for (const m of matches) if (m.status === 'active' && meets[m.meetId]) { meets[m.meetId].status = 'open'; meets[m.meetId].endedAt = null; }
  report.meets = Object.values(meets).map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, status: s.status, matches: matches.filter((m) => m.meetId === s.id).map((m) => m.id) }));
  report.summary = { users: users.length, matches: matches.length, rounds: matches.reduce((a, m) => a + m.rounds.length, 0), meets: Object.keys(meets).length, archivedPlayers: report.archived.length, allScoresIdentical: report.checks.every((c) => c.identical) };
  return { users, matches, meets, report, sourceSha };
}

// Czy mecz w magazynie nadal jest „czystą” kopią starej aplikacji (nikt go nie zmienił w nowej):
// wszystkie rozdania pochodzą z migracji i są początkiem rozdań z nowego źródła, status bez ingerencji.
function isPristineLegacy(cur, next) {
  if (!cur.migratedFrom || cur.migratedFrom.legacyId !== next.id) return false;
  if (cur.status === 'deleted' || cur.status === 'abandoned' || cur.roomId) return false;
  if (cur.rounds.length > next.rounds.length) return false;
  return cur.rounds.every((r, i) => r.scoring === 'legacy' && r.id === next.rounds[i].id
    && JSON.stringify(r.legacy) === JSON.stringify(next.rounds[i].legacy));
}

// Zastosowanie planu w magazynie. Nie nadpisuje danych zmienionych po migracji
// (chyba że preferSource: wtedy mecze ze starej aplikacji są zastępowane wersją ze źródła – po kopii zapasowej).
// Ponowne uruchomienie z NOWSZYM plikiem źródłowym dosynchronizowuje: nowe mecze, nowe rozdania w meczach
// nietkniętych w nowej aplikacji, status/zwycięzca, sesje.
export async function applyMigration(store, plan, { backup, preferSource = false } = {}) {
  const meta = (await store.getData('meta')) || { schemaVersion: 2, migrations: [] };
  const prev = meta.migrations.find((m) => m.id === MIGRATION_ID && m.sourceSha256 === plan.sourceSha);
  const result = { alreadyApplied: !!prev, createdUsers: [], keptUsers: [], createdMatches: [], updatedMatches: [], skippedMatches: [], createdMeets: [], updatedMeets: [], removedMeets: [], backup: null };
  if (backup) result.backup = await backup('pre-migration');

  await store.update('users', (doc) => {
    doc = doc || { users: {} };
    for (const u of plan.users) {
      const existing = doc.users[u.id];
      const clash = Object.values(doc.users).find((x) => x.nickKey === u.nickKey && x.id !== u.id);
      if (clash) throw new MigrationError(`Nick ${u.nick} jest zajęty przez inne konto (${clash.id}) – wymagane rozstrzygnięcie`, plan.report);
      if (existing) { result.keptUsers.push(u.nick); continue; } // nie resetujemy haseł ani statusu
      doc.users[u.id] = u;
      result.createdUsers.push(u.nick);
    }
    return result.createdUsers.length ? doc : undefined;
  });

  for (const m of plan.matches) {
    const name = 'matches/' + m.id;
    const cur = await store.get(name);
    if (!cur) {
      await store.update(name, () => m);
      result.createdMatches.push(m.id);
      continue;
    }
    const c = cur.data;
    if (c.migratedFrom && c.migratedFrom.sourceSha256 === plan.sourceSha) { result.skippedMatches.push({ id: m.id, reason: 'już zmigrowany' }); continue; }
    const pristine = isPristineLegacy(c, m);
    if (!pristine && !(preferSource && c.migratedFrom && c.migratedFrom.legacyId === m.id)) {
      result.skippedMatches.push({ id: m.id, reason: c.migratedFrom ? 'zmieniony w nowej aplikacji (nie nadpisano; --prefer-source zastępuje)' : 'istnieje (nie nadpisano)' });
      continue;
    }
    const same = c.rounds.length === m.rounds.length && c.status === m.status && c.winner === m.winner && c.meetId === m.meetId;
    await store.update(name, () => m);
    result.updatedMatches.push({ id: m.id, rounds: `${c.rounds.length} → ${m.rounds.length}`, status: `${c.status} → ${m.status}`, replaced: !pristine, unchanged: same });
  }

  await store.update('meets', (doc) => {
    doc = doc || { meets: {} };
    let changed = false;
    for (const s of Object.values(plan.meets)) {
      const cur = doc.meets[s.id];
      if (!cur) { doc.meets[s.id] = s; result.createdMeets.push(s.id); changed = true; continue; }
      if (cur.migration !== MIGRATION_ID) continue;
      if (JSON.stringify(cur) !== JSON.stringify(s)) { doc.meets[s.id] = s; result.updatedMeets.push(s.id); changed = true; }
    }
    return changed ? doc : undefined;
  });
  // Sesje z migracji, których nie ma już w planie i do których nie należy żaden mecz – usuwamy.
  const stale = [];
  const curMeets = ((await store.getData('meets')) || { meets: {} }).meets;
  for (const s of Object.values(curMeets)) if (s.migration === MIGRATION_ID && !plan.meets[s.id]) stale.push(s.id);
  if (stale.length) {
    const used = new Set();
    for (const n of await store.list('matches')) { const d = await store.getData(n); if (d && d.meetId) used.add(d.meetId); }
    const drop = stale.filter((id) => !used.has(id));
    if (drop.length) {
      await store.update('meets', (doc) => { for (const id of drop) delete doc.meets[id]; return doc; });
      result.removedMeets.push(...drop);
    }
  }

  if (!prev) {
    await store.update('meta', (d) => {
      d = d || { schemaVersion: 2, migrations: [] };
      d.migrations.push({ id: MIGRATION_ID, sourceSha256: plan.sourceSha, at: new Date().toISOString(), summary: plan.report.summary });
      return d;
    });
  }
  return result;
}

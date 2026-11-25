// Eksport (JSON, CSV), import z podglądem i przywracanie kopii.
import crypto from 'node:crypto';
import { computeMatch } from '../../shared/scoring.js';
import { computeStats, ranking } from '../../shared/stats.js';
import { validateMatch, validateUser, groupKeyOf } from '../store/schemas.js';
import { Accounts, AppError } from './accounts.js';
import { planMigration, applyMigration } from '../migrate/legacy.js';
import { nickKey } from '../../shared/nick.js';

export const EXPORT_FORMAT = 'tysiac-export';
export const EXPORT_VERSION = 2;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Eksport bez hashy haseł, kodów aktywacyjnych i sesji.
export async function exportData({ accounts, matches, store }) {
  const users = (await accounts.allUsers()).map((u) => ({ ...Accounts.publicUser(u), nickHistory: u.nickHistory || [], legacy: u.legacy || undefined }));
  return {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
    users, matches: (await matches.list()).map(({ rev, appliedOps, ...m }) => m), meets: await matches.meets(),
    settings: (await store.getData('config')) || {},
  };
}

const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // ochrona przed wstrzyknięciem formuł w arkuszu
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

export async function exportCsv(kind, { accounts, matches }) {
  const users = Object.fromEntries((await accounts.allUsers()).map((u) => [u.id, u.nick]));
  const nick = (id) => users[id] || id;
  const list = await matches.list();
  if (kind === 'matches') {
    const rows = [['id', 'rozpoczęty', 'zakończony', 'status', 'drużyna A', 'drużyna B', 'wynik A', 'wynik B', 'zwycięzca', 'rozdań', 'tryby', 'sesja']];
    for (const m of list) {
      const c = computeMatch(m);
      rows.push([m.id, m.createdAt, m.finishedAt || '', m.status, c.teams[0].map(nick).join(' + '), c.teams[1].map(nick).join(' + '), c.scores[0], c.scores[1], c.winner == null ? '' : (c.winner === 0 ? 'A' : 'B'), c.rows.length, [...new Set(m.rounds.map((r) => r.mode))].join('/'), m.meetId || '']);
    }
    return toCsv(rows);
  }
  if (kind === 'rounds') {
    const rows = [['mecz', 'nr', 'id', 'tryb', 'data', 'rozdający', 'licytujący', 'kontrakt', 'ugrany', 'ugrane pkt', 'karty A', 'karty B', 'meldunki', 'zmiana A', 'zmiana B', 'wynik A przed', 'wynik B przed', 'wynik A po', 'wynik B po']];
    for (const m of list) {
      const c = computeMatch(m);
      for (const row of c.rows) {
        const r = row.round;
        const melds = Object.entries(r.melds || {}).map(([u, l]) => `${nick(u)}:${l.join('')}`).join(' ');
        rows.push([m.id, row.index + 1, r.id, r.mode, r.createdAt, nick(r.dealer), nick(r.bidder), r.bid, r.made ? 'tak' : 'nie', r.got ?? '', r.cards['0'] ?? '', r.cards['1'] ?? '', melds, row.deltas[0], row.deltas[1], row.before[0], row.before[1], row.after[0], row.after[1]]);
      }
    }
    return toCsv(rows);
  }
  const stats = computeStats(list);
  const pct = (x) => (x == null ? '' : Math.round(x * 1000) / 10);
  if (kind === 'players') {
    const rows = [['gracz', 'mecze', 'wygrane', 'przegrane', '% wygranych', 'rozdania', 'wygrane licytacje', 'kontrakty ugrane', 'kontrakty przegrane', '% kontraktów', 'punkty', 'meldunki pkt', 'najwyższy kontrakt', 'najwyższy wynik', 'najdłuższa seria']];
    for (const p of ranking(stats, 'wins')) rows.push([nick(p.id), p.matches, p.wins, p.losses, pct(p.winRate), p.rounds, p.bids, p.made, p.failed, pct(p.contractRate), p.points, p.meldPts, p.maxBid || '', p.highestScore ?? '', p.bestStreak]);
    return toCsv(rows);
  }
  if (kind === 'groups') {
    const rows = [['grupa', 'mecze ukończone', 'mecze wszystkie', 'rozdania', 'sesje', 'pierwsza gra', 'ostatnia gra', 'najlepszy gracz', 'najlepsza para']];
    for (const g of Object.values(stats.groups)) rows.push([g.players.map(nick).join(', '), g.matches, g.allMatches, g.rounds, g.meetCount, g.first, g.last, g.bestPlayer ? nick(g.bestPlayer) : '', g.bestPair ? g.bestPair.ids.map(nick).join(' + ') : '']);
    return toCsv(rows);
  }
  if (kind === 'pairs') {
    const rows = [['para', 'mecze', 'wygrane', 'przegrane', '% wygranych', 'rozdania', 'punkty', 'kontrakty', 'ugrane kontrakty', 'meldunki pkt']];
    for (const p of Object.values(stats.pairs).sort((a, b) => b.matches - a.matches)) rows.push([p.ids.map(nick).join(' + '), p.matches, p.wins, p.losses, pct(p.winRate), p.rounds, p.points, p.bids, p.made, p.meldPts]);
    return toCsv(rows);
  }
  throw new AppError(400, 'Nieznany typ eksportu');
}

// --- import z podglądem ---
const pending = new Map(); // token → { plan, expires, kind }
setInterval(() => { const t = Date.now(); for (const [k, v] of pending) if (v.expires < t) pending.delete(k); }, 60e3).unref();

export async function previewImport(data, { accounts, matches }) {
  if (!data || typeof data !== 'object') throw new AppError(400, 'Plik nie zawiera danych JSON');
  let plan;
  if (Array.isArray(data.players) && Array.isArray(data.games) && !data.format) {
    // Stara aplikacja PHP – ścieżka migracji.
    const mig = planMigration(data);
    plan = { kind: 'legacy', migration: mig, summary: { ...mig.report.summary, warnings: mig.report.warnings, players: mig.report.players.map((p) => `${p.legacyName} → ${p.mappedTo}`) } };
  } else {
    if (data.format !== EXPORT_FORMAT) throw new AppError(400, 'Nieznany format pliku');
    if (!Number.isInteger(data.version) || data.version > EXPORT_VERSION) throw new AppError(400, 'Plik pochodzi z nowszej wersji aplikacji');
    if (!Array.isArray(data.matches) || !Array.isArray(data.users)) throw new AppError(400, 'Brak meczów lub graczy');
    const current = await accounts.allUsers();
    const byId = Object.fromEntries(current.map((u) => [u.id, u]));
    const newUsers = [];
    const userConflicts = [];
    for (const u of data.users) {
      if (byId[u.id]) continue;
      const clash = current.find((x) => x.nickKey === nickKey(u.nick));
      if (clash) { userConflicts.push({ id: u.id, nick: u.nick, clashWith: clash.id }); continue; }
      newUsers.push({ id: u.id, nick: u.nick, nickKey: nickKey(u.nick), role: 'player', status: 'pending', guest: true, passwordHash: null, createdAt: u.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), activation: null, profile: u.profile || {}, nickHistory: u.nickHistory || [], importedAt: new Date().toISOString() });
    }
    for (const u of newUsers) validateUser(u, 'import.user');
    const existing = Object.fromEntries((await matches.list({ includeDeleted: true })).map((m) => [m.id, m]));
    const add = [];
    const same = [];
    const conflicts = [];
    const invalid = [];
    const known = new Set([...current.map((u) => u.id), ...newUsers.map((u) => u.id)]);
    for (const m of data.matches) {
      try {
        const clean = { ...m, groupKey: groupKeyOf(m.seats || []), appliedOps: [] };
        validateMatch(clean, `import.${m.id}`);
        if (clean.seats.some((s) => !known.has(s))) throw new Error('nieznany gracz');
        computeMatch(clean);
        const ex = existing[m.id];
        if (!ex) add.push(clean);
        else if (sha(JSON.stringify(ex.rounds)) === sha(JSON.stringify(m.rounds))) same.push(m.id);
        else conflicts.push({ id: m.id, local: ex.rounds.length, incoming: m.rounds.length });
      } catch (e) {
        invalid.push({ id: m && m.id, error: e.message });
      }
    }
    const meets = (Array.isArray(data.meets) ? data.meets : []).filter((s) => s && s.id);
    plan = { kind: 'export', newUsers, add, meets, summary: { newUsers: newUsers.length, userConflicts, matchesToAdd: add.length, duplicates: same.length, conflicts, invalid } };
  }
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { plan, expires: Date.now() + 15 * 60e3 });
  return { token, summary: plan.summary, kind: plan.kind };
}

export function cancelImport(token) { return pending.delete(token); }

export async function applyImport(token, services, adminId) {
  const p = pending.get(token);
  if (!p) throw new AppError(400, 'Podgląd importu wygasł – wczytaj plik ponownie');
  pending.delete(token);
  const { store, backup, audit } = services;
  if (p.plan.kind === 'legacy') {
    const res = await applyMigration(store, p.plan.migration, { backup });
    await audit('admin.import.legacy', { adminId, created: res.createdMatches.length, updated: res.updatedMatches.length });
    return res;
  }
  const b = await backup('pre-import');
  const { newUsers, add, meets } = p.plan;
  if (newUsers.length) {
    await store.update('users', (doc) => {
      for (const u of newUsers) if (!doc.users[u.id] && !Object.values(doc.users).some((x) => x.nickKey === u.nickKey)) doc.users[u.id] = u;
      return doc;
    });
  }
  const created = [];
  for (const m of add) {
    await store.update('matches/' + m.id, (cur) => (cur ? undefined : m));
    created.push(m.id);
  }
  await store.update('meets', (doc) => {
    doc = doc || { meets: {} };
    let ch = false;
    for (const s of meets) if (!doc.meets[s.id] && Array.isArray(s.players) && s.players.length === 4) { doc.meets[s.id] = { ...s, groupKey: groupKeyOf(s.players) }; ch = true; }
    return ch ? doc : undefined;
  });
  await audit('admin.import', { adminId, created: created.length });
  return { backup: b.name, createdMatches: created, createdUsers: newUsers.map((u) => u.nick) };
}

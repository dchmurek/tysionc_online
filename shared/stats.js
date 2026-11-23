// Statystyki – zawsze liczone od nowa z historii meczów (można je w każdej chwili odbudować).
// Poziomy: globalne (gracze), grupy czteroosobowe, pary, sesje (spotkania), współpraca i rywalizacja.
import { computeMatch } from './scoring.js';
import { MELD_VALUES } from './rules.js';

export const groupKey = (ids) => ids.slice().sort().join('~');
export const pairKey = (a, b) => [a, b].sort().join('~');

// Dolna granica przedziału Wilsona (95%) – uwzględnia liczbę meczów:
// 1/1 = 0.21, 3/4 = 0.30, 30/40 = 0.60 → 75% z 40 meczów wygrywa ze 100% z jednego.
export function wilson(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c - m) / d;
}
export const rate = (a, b) => (b ? a / b : null);

function blankPlayer(id) {
  return {
    id, matches: 0, wins: 0, losses: 0, abandoned: 0, active: 0, rounds: 0,
    bids: 0, made: 0, failed: 0, bidSum: 0, maxBid: 0, maxMadeBid: 0, bidNet: 0,
    points: 0, cardPoints: 0, cardRounds: 0, melds: { H: 0, D: 0, C: 0, S: 0 }, meldPts: 0,
    tricks: 0, trickRounds: 0, highestScore: null, bestStreak: 0, streak: 0, history: [], byBid: {},
  };
}
function blankPair(ids) {
  return { key: pairKey(ids[0], ids[1]), ids: ids.slice().sort(), matches: 0, wins: 0, losses: 0, rounds: 0, points: 0, bids: 0, made: 0, meldPts: 0, history: [], groups: new Set() };
}

// Przygotowanie meczów: pomija usunięte, wylicza wyniki raz.
export function prepare(matches, { from = null, to = null, groupKey: gk = null, meetId = null } = {}) {
  return matches
    .filter((m) => m.status !== 'deleted')
    .filter((m) => (!from || m.createdAt >= from) && (!to || m.createdAt <= to))
    .filter((m) => (!gk || (m.groupKey || groupKey(m.seats)) === gk) && (!meetId || m.meetId === meetId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => ({ m, c: computeMatch(m), gk: m.groupKey || groupKey(m.seats) }));
}

export const isFinished = ({ m, c }) => m.status === 'finished' && c.winner !== null;

export function computeStats(matches, opts = {}) {
  const list = prepare(matches, opts);
  const P = {};
  const pairs = {};
  const groups = {};
  const meets = {};
  const rivals = {}; // rivals[a][b] = { together, togetherWins, against, againstWins }
  const ensure = (id) => (P[id] = P[id] || blankPlayer(id));
  const rv = (a, b) => {
    rivals[a] = rivals[a] || {};
    return (rivals[a][b] = rivals[a][b] || { together: 0, togetherWins: 0, against: 0, againstWins: 0 });
  };
  const records = { maxMadeBid: null, maxFailedBid: null, maxRound: null, longest: null, shortest: null };

  for (const item of list) {
    const { m, c, gk } = item;
    const done = isFinished(item);
    const teams = c.teams;
    m.seats.forEach(ensure);
    const g = (groups[gk] = groups[gk] || { key: gk, players: m.seats.slice().sort(), matches: 0, allMatches: 0, rounds: 0, meets: new Set(), first: m.createdAt, last: m.createdAt, matchIds: [], wins: {}, pairKeys: new Set(), bids: 0, made: 0, bidSum: 0, meldPts: 0, melds: { H: 0, D: 0, C: 0, S: 0 } });
    g.allMatches++;
    g.rounds += c.rows.length;
    if (m.meetId) g.meets.add(m.meetId);
    g.last = m.updatedAt && m.updatedAt > g.last ? m.updatedAt : (m.createdAt > g.last ? m.createdAt : g.last);
    g.matchIds.push(m.id);
    if (m.meetId) {
      const s = (meets[m.meetId] = meets[m.meetId] || { id: m.meetId, groupKey: gk, players: m.seats.slice().sort(), matchIds: [], finished: 0, rounds: 0, wins: {}, pairWins: {}, first: m.createdAt, last: m.createdAt });
      s.matchIds.push(m.id);
      s.rounds += c.rows.length;
      if (m.createdAt < s.first) s.first = m.createdAt;
      if ((m.finishedAt || m.createdAt) > s.last) s.last = m.finishedAt || m.createdAt;
      if (done) {
        s.finished++;
        for (const pid of teams[c.winner]) s.wins[pid] = (s.wins[pid] || 0) + 1;
        const wk = pairKey(...teams[c.winner]);
        s.pairWins[wk] = (s.pairWins[wk] || 0) + 1;
      }
    }

    if (m.status === 'abandoned') m.seats.forEach((id) => P[id].abandoned++);
    if (m.status === 'active') m.seats.forEach((id) => P[id].active++);

    teams.forEach((team, t) => {
      const pk = pairKey(team[0], team[1]);
      const pr = (pairs[pk] = pairs[pk] || blankPair(team));
      pr.groups.add(gk);
      g.pairKeys.add(pk);
      for (const row of c.rows) { pr.rounds++; pr.points += row.deltas[t]; }
      if (done) {
        pr.matches++;
        if (c.winner === t) pr.wins++; else pr.losses++;
        pr.history.push({ matchId: m.id, date: m.finishedAt || m.createdAt, won: c.winner === t, score: c.scores[t], opp: c.scores[1 - t], opponents: teams[1 - t] });
      }
    });

    if (done) {
      g.matches++;
      if (!records.longest || c.rows.length > records.longest.n) records.longest = { n: c.rows.length, matchId: m.id, date: m.createdAt };
      if (!records.shortest || c.rows.length < records.shortest.n) records.shortest = { n: c.rows.length, matchId: m.id, date: m.createdAt };
      teams.forEach((team, t) => {
        const won = c.winner === t;
        for (const pid of team) {
          const p = P[pid];
          p.matches++;
          if (won) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); g.wins[pid] = (g.wins[pid] || 0) + 1; } else { p.losses++; p.streak = 0; }
          p.highestScore = p.highestScore == null ? c.scores[t] : Math.max(p.highestScore, c.scores[t]);
          const partner = team.find((x) => x !== pid);
          p.history.push({ matchId: m.id, date: m.finishedAt || m.createdAt, won, score: c.scores[t], opp: c.scores[1 - t], partner, opponents: teams[1 - t], meetId: m.meetId || null, modes: modesOf(m) });
          const r1 = rv(pid, partner);
          r1.together++; if (won) r1.togetherWins++;
          for (const o of teams[1 - t]) { const r2 = rv(pid, o); r2.against++; if (won) r2.againstWins++; }
        }
      });
    }

    for (const row of c.rows) {
      const r = row.round;
      teams.forEach((team, t) => team.forEach((pid) => {
        const p = P[pid];
        p.rounds++;
        p.points += row.deltas[t];
        const cp = r.cards ? r.cards[t] ?? r.cards[String(t)] : null;
        if (cp != null) { p.cardPoints += cp; p.cardRounds++; }
        else if (r.cards && (r.cards[1 - t] ?? r.cards[String(1 - t)]) != null && r.scoring !== 'legacy') {
          p.cardPoints += 120 - (r.cards[1 - t] ?? r.cards[String(1 - t)]); p.cardRounds++;
        }
      }));
      if (r.tricksWon) for (const [pid, n] of Object.entries(r.tricksWon)) if (P[pid]) { P[pid].tricks += n; P[pid].trickRounds++; }
      const b = ensure(r.bidder);
      b.bids++;
      b.bidSum += r.bid;
      b.maxBid = Math.max(b.maxBid, r.bid);
      g.bids++; g.bidSum += r.bid;
      const k = r.bid;
      b.byBid[k] = b.byBid[k] || { n: 0, made: 0 };
      b.byBid[k].n++;
      const pk = pairKey(...teams[row.bidderTeam]);
      pairs[pk].bids++;
      if (row.made) {
        b.made++; g.made++; pairs[pk].made++;
        b.byBid[k].made++;
        b.maxMadeBid = Math.max(b.maxMadeBid, r.bid);
        if (!records.maxMadeBid || r.bid > records.maxMadeBid.bid) records.maxMadeBid = { bid: r.bid, userId: r.bidder, matchId: m.id, date: r.createdAt };
      } else {
        b.failed++;
        if (!records.maxFailedBid || r.bid > records.maxFailedBid.bid) records.maxFailedBid = { bid: r.bid, userId: r.bidder, matchId: m.id, date: r.createdAt };
      }
      b.bidNet += row.deltas[row.bidderTeam];
      const best = Math.max(...row.deltas);
      if (!records.maxRound || best > records.maxRound.points) records.maxRound = { points: best, team: teams[row.deltas.indexOf(best)], matchId: m.id, date: r.createdAt };
      for (const [pid, ms] of Object.entries(r.melds || {})) {
        const p = ensure(pid);
        for (const s of ms) {
          p.melds[s] = (p.melds[s] || 0) + 1; p.meldPts += MELD_VALUES[s] || 0;
          g.melds[s] = (g.melds[s] || 0) + 1; g.meldPts += MELD_VALUES[s] || 0;
          const t = teams.findIndex((tm) => tm.includes(pid));
          if (t >= 0) pairs[pairKey(...teams[t])].meldPts += MELD_VALUES[s] || 0;
        }
      }
    }
  }

  for (const p of Object.values(P)) {
    p.winRate = rate(p.wins, p.matches);
    p.contractRate = rate(p.made, p.bids);
    p.avgBid = p.bids ? Math.round(p.bidSum / p.bids) : null;
    p.avgPoints = p.rounds ? Math.round(p.points / p.rounds) : null;
    p.wilson = wilson(p.wins, p.matches);
    p.recent = p.history.slice(-10).reverse();
  }
  for (const pr of Object.values(pairs)) {
    pr.winRate = rate(pr.wins, pr.matches);
    pr.wilson = wilson(pr.wins, pr.matches);
    pr.contractRate = rate(pr.made, pr.bids);
    pr.groups = [...pr.groups];
  }
  for (const g of Object.values(groups)) {
    g.meetCount = g.meets.size;
    g.meets = [...g.meets];
    g.pairKeys = [...g.pairKeys];
    g.ranking = g.players.map((id) => ({ id, wins: g.wins[id] || 0, matches: g.matches, winRate: rate(g.wins[id] || 0, g.matches) }))
      .sort((a, b) => b.wins - a.wins);
    g.bestPlayer = g.matches ? g.ranking[0].id : null;
    const gp = g.pairKeys.map((k) => pairStatsWithin(list.filter((x) => x.gk === g.key), k)).filter((x) => x.matches > 0)
      .sort((a, b) => b.wilson - a.wilson || b.wins - a.wins);
    g.pairs = gp;
    g.bestPair = gp[0] || null;
    g.contractRate = rate(g.made, g.bids);
  }
  return { players: P, pairs, groups, meets, rivals, records, matchCount: list.length, finishedCount: list.filter(isFinished).length };
}

function pairStatsWithin(list, pk) {
  const ids = pk.split('~');
  const out = { key: pk, ids, matches: 0, wins: 0, losses: 0 };
  for (const item of list) {
    if (!isFinished(item)) continue;
    const t = item.c.teams.findIndex((tm) => pairKey(tm[0], tm[1]) === pk);
    if (t < 0) continue;
    out.matches++;
    if (item.c.winner === t) out.wins++; else out.losses++;
  }
  out.winRate = rate(out.wins, out.matches);
  out.wilson = wilson(out.wins, out.matches);
  return out;
}

export function modesOf(m) {
  const set = new Set(m.rounds.map((r) => r.mode || 'offline'));
  return [...set];
}

// Współpraca i rywalizacja jednego gracza. minMatches – próg minimalnej liczby meczów.
export function rivalryFor(stats, userId, minMatches = 1) {
  const r = stats.rivals[userId] || {};
  const partners = Object.entries(r).filter(([, v]) => v.together > 0)
    .map(([id, v]) => ({ id, matches: v.together, wins: v.togetherWins, winRate: rate(v.togetherWins, v.together), wilson: wilson(v.togetherWins, v.together) }));
  const opponents = Object.entries(r).filter(([, v]) => v.against > 0)
    .map(([id, v]) => ({ id, matches: v.against, wins: v.againstWins, losses: v.against - v.againstWins, winRate: rate(v.againstWins, v.against), wilson: wilson(v.againstWins, v.against), lossWilson: wilson(v.against - v.againstWins, v.against) }));
  const eligibleP = partners.filter((p) => p.matches >= minMatches);
  const eligibleO = opponents.filter((p) => p.matches >= minMatches);
  const pick = (arr, f) => (arr.length ? arr.slice().sort(f)[0] : null);
  return {
    partners: partners.sort((a, b) => b.matches - a.matches),
    opponents: opponents.sort((a, b) => b.matches - a.matches),
    bestPartner: pick(eligibleP, (a, b) => b.wilson - a.wilson || b.matches - a.matches),
    worstPartner: pick(eligibleP, (a, b) => wilson(b.matches - b.wins, b.matches) - wilson(a.matches - a.wins, a.matches) || b.matches - a.matches),
    mostFrequentPartner: pick(partners, (a, b) => b.matches - a.matches),
    mostFrequentOpponent: pick(opponents, (a, b) => b.matches - a.matches),
    mostBeatenOpponent: pick(eligibleO, (a, b) => b.wilson - a.wilson || b.wins - a.wins),
    toughestOpponent: pick(eligibleO, (a, b) => b.lossWilson - a.lossWilson || b.losses - a.losses),
  };
}

export const RANKING_SORTS = {
  matches: (a, b) => b.matches - a.matches,
  wins: (a, b) => b.wins - a.wins || (b.winRate ?? 0) - (a.winRate ?? 0),
  winRate: (a, b) => b.wilson - a.wilson || b.matches - a.matches,
  points: (a, b) => b.points - a.points,
  contracts: (a, b) => (b.contractRate ?? -1) - (a.contractRate ?? -1) || b.bids - a.bids,
};

export function ranking(stats, sort = 'wins', minMatches = 0) {
  return Object.values(stats.players).filter((p) => p.matches >= minMatches && (p.matches > 0 || p.rounds > 0)).sort(RANKING_SORTS[sort] || RANKING_SORTS.wins);
}

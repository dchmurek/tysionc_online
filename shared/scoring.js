// Punktacja meczu. Wynik zawsze liczony od zera z listy rozdań:
// poprawka rozdania automatycznie poprawia wynik, historię i statystyki.
import {
  CARD_POINTS_TOTAL, MELD_VALUES, RuleError, normalizeSettings, roundPoints, nextSeat, teamOfSeat, PLAYERS,
} from './rules.js';

export function teamsOf(match) {
  const s = match.seats;
  return [[s[0], s[2]], [s[1], s[3]]];
}

export function teamOfUser(match, userId) {
  const i = match.seats.indexOf(userId);
  return i < 0 ? -1 : teamOfSeat(i);
}

export function meldPointsOf(melds, userIds) {
  let sum = 0;
  for (const uid of userIds) for (const s of (melds && melds[uid]) || []) sum += MELD_VALUES[s] || 0;
  return sum;
}

// Zasada właściciela: meldunki drużyny liczą się tylko wtedy, gdy drużyna zdobyła jakiekolwiek punkty z kart.
// cards = punkty drużyny z kart (null = jeszcze nie wpisane – wtedy meldunki pokazujemy warunkowo jako liczone).
export function meldsCount(cards) {
  return cards == null || cards > 0;
}

// Ocena jednego rozdania (bez limitu 990 – ten zależy od wyniku przed rozdaniem).
export function evaluateRound(match, round, settings) {
  const S = settings || normalizeSettings(match.settings);
  const teams = teamsOf(match);
  const bs = teamOfUser(match, round.bidder);
  if (bs < 0) throw new RuleError('Licytujący nie gra w tym meczu');
  const os = 1 - bs;
  const cards = round.cards || {};
  const cardsO = cards[os] ?? null;
  const cardsB = cards[bs] ?? (cardsO != null ? CARD_POINTS_TOTAL - cardsO : null);
  const meldsBAll = meldPointsOf(round.melds, teams[bs]);
  const meldsOAll = meldPointsOf(round.melds, teams[os]);
  const deltas = [0, 0];

  if (round.scoring === 'legacy') {
    // Rozdania przeniesione ze starej aplikacji: dokładnie dawna formuła (max(licytacja, ugrane)),
    // żeby historyczne wyniki nie zmieniły się ani o punkt.
    const got = round.got != null ? roundPoints(round.got, S.rounding) : 0;
    deltas[bs] = round.made ? Math.max(round.bid, got) : -round.bid;
    deltas[os] = roundPoints(cardsO ?? 0, S.rounding) + meldsOAll;
    return { bidderTeam: bs, made: !!round.made, bidderRaw: round.got ?? null, oppRaw: cardsO == null ? null : cardsO + meldsOAll, deltas };
  }

  // Meldunki bez żadnych punktów z kart przepadają.
  const meldsB = meldsCount(cardsB) ? meldsBAll : 0;
  const meldsO = meldsCount(cardsO) ? meldsOAll : 0;

  const bidderRaw = cardsB == null ? null : cardsB + meldsB;
  const oppRaw = cardsO == null ? null : cardsO + meldsO;
  const checkValue = bidderRaw == null ? null : (S.contractCheck === 'rounded' ? roundPoints(bidderRaw, S.rounding) : bidderRaw);
  const made = checkValue != null && checkValue >= round.bid;
  deltas[bs] = made ? roundPoints(bidderRaw, S.rounding) : -round.bid;
  deltas[os] = oppRaw == null ? 0 : roundPoints(oppRaw, S.rounding);
  return { bidderTeam: bs, made, bidderRaw, oppRaw, deltas, meldsLost: [bs, os].filter((t) => (t === bs ? meldsBAll && !meldsB : meldsOAll && !meldsO)) };
}

// Przelicza cały mecz.
export function computeMatch(match) {
  const S = normalizeSettings(match.settings);
  const scores = [0, 0];
  const rows = [];
  let winner = null;
  const cap = Math.min(S.passiveCap, S.target - 10);

  for (let i = 0; i < match.rounds.length; i++) {
    const round = match.rounds[i];
    const ev = evaluateRound(match, round, S);
    const before = scores.slice();
    const deltas = ev.deltas.slice();
    const notes = [[], []];
    // Punkty bez wygranej licytacji: najwyżej do limitu (990).
    const os = 1 - ev.bidderTeam;
    if (deltas[os] > 0 && before[os] + deltas[os] > cap) {
      deltas[os] = Math.max(0, cap - before[os]);
      notes[os].push('limit ' + cap);
    }
    scores[0] += deltas[0];
    scores[1] += deltas[1];
    if (ev.made && scores[ev.bidderTeam] >= S.target) winner = ev.bidderTeam;
    rows.push({
      index: i, round, before, after: scores.slice(), deltas, notes,
      bidderTeam: ev.bidderTeam, made: ev.made, bidderRaw: ev.bidderRaw, oppRaw: ev.oppRaw,
    });
    if (winner !== null) break;
  }

  const lastRow = rows[rows.length - 1];
  let nextDealerSeat = match.firstDealerSeat || 0;
  if (match.rounds.length) {
    const lastDealer = match.rounds[match.rounds.length - 1].dealer;
    const ds = match.seats.indexOf(lastDealer);
    nextDealerSeat = ds >= 0 ? nextSeat(ds) : (match.rounds.length + (match.firstDealerSeat || 0)) % PLAYERS;
  }
  return {
    settings: S, teams: teamsOf(match), scores, rows, winner, cap,
    atCap: scores.map((v) => v >= cap),
    roundsAfterWin: winner !== null ? match.rounds.length - rows.length : 0,
    nextDealerSeat, nextDealer: match.seats[nextDealerSeat], lastRow,
  };
}

// Walidacja nowego / poprawianego rozdania (tryb offline lub wynik rozdania online).
// Zwraca znormalizowany rekord rozdania; rzuca RuleError, gdy dane są sprzeczne.
export function validateRoundInput(match, input) {
  const S = normalizeSettings(match.settings);
  if (!input || typeof input !== 'object') throw new RuleError('Brak danych rozdania');
  const bidder = input.bidder;
  if (!match.seats.includes(bidder)) throw new RuleError('Wybierz licytującego z tego meczu');
  const bid = input.bid;
  if (!Number.isInteger(bid) || bid < S.minBid || bid > S.maxBid || bid % S.bidStep !== 0) {
    throw new RuleError(`Kontrakt musi być liczbą od ${S.minBid} do ${S.maxBid} (co ${S.bidStep})`);
  }
  const bs = teamOfUser(match, bidder);
  const os = 1 - bs;
  const cards = {};
  for (const t of [0, 1]) {
    const v = input.cards ? input.cards[t] ?? input.cards[String(t)] : undefined;
    if (v === undefined || v === null || v === '') continue;
    if (!Number.isInteger(v) || v < 0 || v > CARD_POINTS_TOTAL) throw new RuleError('Punkty z kart muszą być liczbą 0–120');
    cards[t] = v;
  }
  if (cards[os] === undefined) throw new RuleError('Wpisz punkty drużyny przeciwnej (może być 0)');
  if (cards[bs] !== undefined && cards[bs] + cards[os] !== CARD_POINTS_TOTAL) {
    throw new RuleError('Punkty z kart obu drużyn muszą dawać razem 120');
  }
  const melds = {};
  const usedSuits = new Set();
  for (const [uid, list] of Object.entries(input.melds || {})) {
    if (!match.seats.includes(uid)) throw new RuleError('Meldunek gracza spoza meczu');
    if (!Array.isArray(list)) throw new RuleError('Niepoprawne meldunki');
    const clean = [];
    for (const s of list) {
      if (!(s in MELD_VALUES)) throw new RuleError('Nieznany meldunek');
      if (usedSuits.has(s)) throw new RuleError('Ten sam meldunek może wystąpić tylko raz w rozdaniu');
      usedSuits.add(s);
      clean.push(s);
    }
    if (clean.length) melds[uid] = clean;
  }
  const round = {
    bidder, bid, cards: { [os]: cards[os], ...(cards[bs] !== undefined ? { [bs]: cards[bs] } : {}) }, melds,
  };
  const ev = evaluateRound(match, round, S);
  if (typeof input.made === 'boolean' && input.made !== ev.made) {
    throw new RuleError(ev.made
      ? `Drużyna licytującego ma ${ev.bidderRaw} pkt – kontrakt ${bid} jest zrealizowany`
      : `Drużyna licytującego ma ${ev.bidderRaw} pkt – za mało na kontrakt ${bid}`);
  }
  round.made = ev.made;
  round.got = ev.bidderRaw;
  return round;
}

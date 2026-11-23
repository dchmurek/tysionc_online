// Silnik liczenia punktów w Tysiąca. Wynik gry zawsze przeliczany od zera
// z listy rozdań, więc edycja/usunięcie rozdania automatycznie poprawia stan.
(function (root) {
  const MELDS = {
    h: { label: '♥', name: 'kier', value: 100, red: true },
    d: { label: '♦', name: 'karo', value: 80, red: true },
    s: { label: '♠', name: 'wino', value: 60 },
    c: { label: '♣', name: 'żołądź', value: 40 },
  };

  const DEFAULT_SETTINGS = {
    target: 1000,
    round10: true,       // zaokrąglanie punktów przeciwników do pełnych dziesiątek
    passiveCap: 990,     // do tylu można dojść punktami z kart i meldunków bez wygranej licytacji
    bombPoints: 60,      // ile dostaje każdy przeciwnik (gra w 3) / drużyna (gra w 4)
    bombLimit: 1,        // ile bomb może rzucić gracz w jednej grze (0 = bez limitu)
    zeroRule: false,     // trzy zera z rzędu = kara
    zeroPenalty: 120,
    minBid: 100,
    scoreActual: true,   // ugrana licytacja daje faktycznie ugrane punkty, jeśli są wyższe (np. szedł 160, ugrał 200 → +200)
  };

  // Strony gry: w 3 osoby każdy gracz to osobna strona, w 4 na krzyż – dwie drużyny
  // (gracze siedzą na przemian: 1 i 3 vs 2 i 4).
  function sidesOf(game) {
    if (game.mode === '4x') {
      const p = game.players;
      return [[p[0], p[2]], [p[1], p[3]]];
    }
    return game.players.map((id) => [id]);
  }

  function sideOfPlayer(game, pid) {
    return sidesOf(game).findIndex((s) => s.includes(pid));
  }

  function meldValue(list) {
    return (list || []).reduce((a, k) => a + (MELDS[k] ? MELDS[k].value : 0), 0);
  }

  function roundPts(x, s) {
    x = Number(x) || 0;
    return s.round10 ? Math.round(x / 10) * 10 : x;
  }

  // Ile dostaje grający za ugraną licytację.
  function bidderGain(r, s) {
    const got = s.scoreActual && r.got != null ? roundPts(r.got, s) : 0;
    return Math.max(r.bid, got);
  }

  function computeGame(game) {
    const S = Object.assign({}, DEFAULT_SETTINGS, game.settings || {});
    const sides = sidesOf(game);
    const n = sides.length;
    const scores = Array(n).fill(0);
    const zeroStreak = Array(n).fill(0);
    const bombsUsed = {};
    const rows = [];
    let winner = null;

    // Limit nie może sięgać celu – inaczej dałoby się wygrać bez licytacji.
    const cap = Math.min(S.passiveCap, S.target - 10);
    const atCap = (v) => v >= cap;

    for (let i = 0; i < game.rounds.length; i++) {
      const r = game.rounds[i];
      const bs = sideOfPlayer(game, r.bidder);
      const before = scores.slice();
      const deltas = Array(n).fill(0);
      const notes = Array.from({ length: n }, () => []);
      const isBomb = r.type === 'bomb';
      if (isBomb) bombsUsed[r.bidder] = (bombsUsed[r.bidder] || 0) + 1;

      for (let s = 0; s < n; s++) {
        if (isBomb) {
          deltas[s] = s === bs ? 0 : S.bombPoints;
          continue;
        }
        if (s === bs) {
          deltas[s] = r.made ? bidderGain(r, S) : -r.bid;
        } else {
          const melds = sides[s].reduce((a, pid) => a + meldValue((r.melds || {})[pid]), 0);
          deltas[s] = roundPts((r.points || {})[s], S) + melds;
        }
      }

      // Punkty bierne (karty, meldunki, bomba) – bez wygranej licytacji najwyżej do limitu.
      for (let s = 0; s < n; s++) {
        if (s === bs && !isBomb) continue;
        if (deltas[s] > 0 && before[s] + deltas[s] > cap) {
          deltas[s] = Math.max(0, cap - before[s]);
          notes[s].push('limit ' + cap);
        }
      }

      for (let s = 0; s < n; s++) scores[s] += deltas[s];
      const penalties = Array(n).fill(0);

      // Wygrana – wyłącznie ugraną licytacją, która dobija do celu.
      if (!isBomb && r.made && scores[bs] >= S.target) winner = bs;

      if (winner === null) {
        for (let s = 0; s < n; s++) {
          // Trzy zera
          if (S.zeroRule) {
            if (deltas[s] === 0 && !(isBomb && s === bs)) {
              zeroStreak[s]++;
              if (zeroStreak[s] >= 3) {
                penalties[s] -= S.zeroPenalty;
                notes[s].push('3 zera');
                zeroStreak[s] = 0;
              }
            } else zeroStreak[s] = 0;
          }
        }
        for (let s = 0; s < n; s++) scores[s] += penalties[s];
      }

      rows.push({
        index: i,
        round: r,
        bidderSide: bs,
        deltas: deltas.map((d, s) => d + penalties[s]),
        notes,
        scores: scores.slice(),
      });
      if (winner !== null) break;
    }

    return {
      settings: S,
      sides,
      scores,
      rows,
      winner,
      cap,
      bombsUsed,
      atCap: scores.map(atCap),
      dealerIndex: game.rounds.length % game.players.length,
    };
  }

  const api = { MELDS, DEFAULT_SETTINGS, sidesOf, sideOfPlayer, meldValue, roundPts, bidderGain, computeGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);

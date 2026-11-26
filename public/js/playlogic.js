// Decyzje przy stukaniu w karty przy stole online – czyste funkcje (bez DOM), testowane w tests/unit/playlogic.test.js.

// Zagranie: zawsze dwa kroki – 1. stuknięcie wybiera kartę, 2. stuknięcie tej samej karty (albo przycisk) zagrywa.
// Meldunek zgłasza serwer sam przy zagraniu (wyjście królem/damą z pary albo król na damę gracza tuż przed),
// więc nie ma żadnego dodatkowego pytania o meldunek.
// h – widok rozdania z serwera; zwraca { action: 'ignore' | 'illegal' | 'select' | 'play', card }
export function tapCard(h, mySeat, selected, card) {
  if (!h || h.phase !== 'playing' || h.turn !== mySeat || mySeat < 0) return { action: 'ignore', card };
  if (!h.hand.includes(card)) return { action: 'ignore', card };
  if (!h.legal.includes(card)) return { action: 'illegal', card };
  if (selected === card) return { action: 'play', card };
  return { action: 'select', card };
}

// Czy zagranie tej karty zamelduje (do opisu przycisku): 'lead' – meldunek z ręki (ustala tromf),
// 'on' – król na damę zagraną tuż przed, null – bez meldunku.
export function meldKind(h, card) {
  if (!h || !h.meldable || !h.meldable.includes(card)) return null;
  const last = h.trick && h.trick.cards.length ? h.trick.cards[h.trick.cards.length - 1] : null;
  return last && card[0] === 'K' && last.card === 'Q' + card[1] ? 'on' : 'lead';
}

// Rozdawanie kart z musika: stuknięcie karty wkłada ją do wybranego (albo pierwszego wolnego) gracza,
// stuknięcie karty, która już jest przydzielona – cofa ją. Na końcu jedno zatwierdzenie.
// draft – { [seat]: card }, targets – miejsca do obdzielenia w kolejności (lewy, naprzeciwko, prawy),
// target – miejsce wybrane stuknięciem gracza (albo null). Zwraca { draft, target }.
export function giveTapCard(draft, targets, target, card) {
  const next = { ...draft };
  const had = Object.keys(next).find((s) => next[s] === card);
  if (had !== undefined) { delete next[had]; return { draft: next, target: Number(had) }; }
  let to = target != null && targets.includes(target) && !next[target] ? target : targets.find((s) => !next[s]);
  if (to === undefined) return { draft: next, target: null }; // wszyscy mają już kartę – najpierw cofnij którąś
  next[to] = card;
  const free = targets.find((s) => !next[s]);
  return { draft: next, target: free === undefined ? null : free };
}

// Stuknięcie gracza: zajęte miejsce – cofa kartę do ręki i wybiera to miejsce; wolne – tylko je wybiera.
export function giveTapSlot(draft, targets, seat) {
  if (!targets.includes(seat)) return { draft, target: null };
  const next = { ...draft };
  delete next[seat];
  return { draft: next, target: seat };
}

export const giveReady = (draft, targets) => targets.length > 0 && targets.every((s) => draft[s]);

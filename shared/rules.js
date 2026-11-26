// Zasady Tysiąca na krzyż – wspólne dla serwera i przeglądarki.
// Kolory kart: H kier, D karo, C trefl (żołądź), S pik (wino).

export const SUITS = ['H', 'D', 'S', 'C'];
// Meldunki wg zasad właściciela: kier 100, karo 80, pik 60, trefl 40.
export const SUIT_INFO = {
  H: { symbol: '♥', name: 'kier', meld: 100, red: true },
  D: { symbol: '♦', name: 'karo', meld: 80, red: true },
  S: { symbol: '♠', name: 'pik', meld: 60, red: false },
  C: { symbol: '♣', name: 'trefl', meld: 40, red: false },
};
export const MELD_VALUES = { H: 100, D: 80, S: 60, C: 40 };

// Figury od najsilniejszej. Wartości punktowe kart.
export const RANKS = ['A', 'T', 'K', 'Q', 'J', '9'];
export const RANK_INFO = {
  A: { label: 'A', name: 'as', points: 11 },
  T: { label: '10', name: 'dziesiątka', points: 10 },
  K: { label: 'K', name: 'król', points: 4 },
  Q: { label: 'Q', name: 'dama', points: 3 },
  J: { label: 'J', name: 'walet', points: 2 },
  9: { label: '9', name: 'dziewiątka', points: 0 },
};
export const CARD_POINTS_TOTAL = 120;
export const HAND_SIZE = 6;   // kart w ręce po rozdaniu musika = liczba lew
export const DEAL_SIZE = 5;   // każdy dostaje po 5 kart
export const MUSIK_SIZE = 4;  // 4 karty musika na środku stołu
export const PLAYERS = 4;

export const ROUNDING_MODES = ['nearest10', 'down10', 'exact'];
export const CONTRACT_CHECKS = ['raw', 'rounded'];

// Domyślne ustawienia nowego meczu.
// rounding: 'nearest10' – zachowanie dotychczasowej aplikacji (Math.round do dziesiątek, 5 w górę).
// contractCheck: 'rounded' – kontrakt sprawdzany PO zaokrągleniu (ustalenie właściciela:
//   grał 160, ma 158 → zaokrąglone 160 → kontrakt ugrany, +160).
export const DEFAULT_SETTINGS = Object.freeze({
  target: 1000,
  passiveCap: 990,
  minBid: 100,
  bidStep: 10,
  maxBid: 400,
  rounding: 'nearest10',
  contractCheck: 'rounded',
  // Zasady rozgrywki online (wariantowe – zapisywane w meczu):
  mustBeat: true,          // dokładając do koloru trzeba przebić, jeśli się da
  mustTrump: true,         // brak koloru → trzeba dać atut, jeśli się ma
  meldOnFirstTrick: true,  // nieużywane – meldować można zawsze od pierwszej lewy
  meldOnPlayed: true,      // „meldunek na kimś”: król dołożony na damę tego samego koloru zagraną tuż przed nim
});

const SETTING_RULES = {
  target: (v) => Number.isInteger(v) && v >= 100 && v <= 10000 && v % 10 === 0,
  passiveCap: (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
  minBid: (v) => Number.isInteger(v) && v >= 10 && v <= 400 && v % 10 === 0,
  bidStep: (v) => v === 10 || v === 5 || v === 20,
  maxBid: (v) => Number.isInteger(v) && v >= 100 && v <= 400,
  rounding: (v) => ROUNDING_MODES.includes(v),
  contractCheck: (v) => CONTRACT_CHECKS.includes(v),
  mustBeat: (v) => typeof v === 'boolean',
  mustTrump: (v) => typeof v === 'boolean',
  meldOnFirstTrick: (v) => typeof v === 'boolean',
  meldOnPlayed: (v) => typeof v === 'boolean',
};

// Zwraca pełne, zweryfikowane ustawienia albo rzuca błąd z opisem.
export function normalizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in SETTING_RULES)) continue;
    if (!SETTING_RULES[k](v)) throw new RuleError(`Niepoprawne ustawienie: ${k}`);
    out[k] = v;
  }
  if (out.maxBid < out.minBid) throw new RuleError('Maksymalna licytacja mniejsza od minimalnej');
  return out;
}

export class RuleError extends Error {
  constructor(message, code = 'rule') {
    super(message);
    this.code = code;
  }
}

export function roundPoints(x, mode) {
  const n = Number(x) || 0;
  if (mode === 'exact') return n;
  if (mode === 'down10') return Math.floor(n / 10) * 10;
  return Math.round(n / 10) * 10; // nearest10 (połówki w górę: 5→10, 155→160)
}

export function nextSeat(seat) {
  return (seat + 1) % PLAYERS;
}
export function teamOfSeat(seat) {
  return seat % 2;
}

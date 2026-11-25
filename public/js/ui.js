// Wspólne elementy interfejsu: ikony, karty, gracze, kolory.
import { html, raw, esc } from './dom.js';
import { SUIT_INFO, RANK_INFO } from '/shared/rules.js';
import { userById, nick } from './state.js';

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  backspace: '<path d="M10 5a2 2 0 0 0-1.34.52l-6.33 5.74a1 1 0 0 0 0 1.48l6.33 5.74A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/>',
  crown: '<path d="M11.56 3.27a.5.5 0 0 1 .88 0l2.95 5.6a1 1 0 0 0 1.52.3l4.27-3.67a.5.5 0 0 1 .8.52l-2.83 10.25a1 1 0 0 1-.96.73H5.81a1 1 0 0 1-.96-.73L2.02 6.02a.5.5 0 0 1 .8-.52l4.27 3.67a1 1 0 0 0 1.52-.3z"/><path d="M5 21h14"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>', chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  cards: '<rect x="3" y="5" width="11" height="15" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v13"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  stats: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  swap: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  dice: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="16" r="1"/><circle cx="12" cy="12" r="1"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="ic ${esc(cls)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);

const PALETTE = ['#e0a33a', '#4fb3a0', '#d9668f', '#6ea0e6', '#a98be6', '#7fbf5f', '#e57b4a', '#5fc0d6', '#c9b26a', '#e05a5a'];
export function colorOf(id) {
  const u = userById(id);
  if (u && u.profile && u.profile.color) return u.profile.color;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const dot = (id) => html`<i class="dot" style="--pc:${colorOf(id)}" aria-hidden="true"></i>`;
export const who = (id) => html`<span class="who-n">${dot(id)}${nick(id)}</span>`;
export const teamName = (team) => team.map((id) => nick(id)).join(' & ');
// Kolory drużyn: A (miejsca 1+3) = --c1, B (2+4) = --c2. Przy stole obaj partnerzy mają ten sam kolor.
export const TEAM_COLOR = ['var(--c1)', 'var(--c2)'];
export const teamDot = (t) => html`<i class="dot" style="--pc:${TEAM_COLOR[t]}" aria-hidden="true"></i>`;
export const teamDots = (team, t) => (t === 0 || t === 1 ? teamDot(t) : html`${team.map((id) => dot(id))}`);

export const suitSym = (s) => html`<span class="suit ${SUIT_INFO[s].red ? 'red' : ''}" title="${SUIT_INFO[s].name}">${SUIT_INFO[s].symbol}︎</span>`;

// Karta do gry (SVG-free, czysty CSS). opts: { playable, selected, small, back, tag, tagCls }
export const cardName = (c) => `${RANK_INFO[c[0]].name} ${SUIT_INFO[c[1]].name}`;
export function card(c, opts = {}) {
  if (opts.back) return html`<span class="pcard back ${opts.small ? 'sm' : ''}" aria-hidden="true"></span>`;
  const r = c[0], s = c[1];
  const info = SUIT_INFO[s];
  const label = `${RANK_INFO[r].name} ${info.name}`;
  // opts.span: karta jako zwykły element (np. wewnątrz innego przycisku – przycisk w przycisku łamie układ)
  if (opts.span) return html`<span class="pcard ${info.red ? 'red' : ''} ${opts.small ? 'sm' : ''}" role="img" aria-label="${label}"><span class="cr">${RANK_INFO[r].label}</span><span class="cs">${info.symbol}︎</span><span class="cc">${info.symbol}︎</span></span>`;
  return html`<button type="button" class="pcard ${info.red ? 'red' : ''} ${opts.playable ? 'playable' : ''} ${opts.dim ? 'dim' : ''} ${opts.selected ? 'sel' : ''} ${opts.small ? 'sm' : ''} ${opts.meld ? 'meld' : ''}"
    ${opts.act ? raw(`data-act="${esc(opts.act)}" data-card="${esc(c)}"`) : raw('tabindex="-1"')} aria-label="${label}" ${opts.disabled ? raw('disabled') : ''}>
    <span class="cr">${RANK_INFO[r].label}</span><span class="cs">${info.symbol}︎</span><span class="cc">${info.symbol}︎</span>${opts.tag ? html`<span class="ctag ${esc(opts.tagCls || '')}">${opts.tag}</span>` : ''}</button>`;
}

export const loading = () => html`<div class="loading"><span class="spinner"></span>Tasowanie…</div>`;
export const empty = (text) => html`<div class="card empty"><div class="suits">♠ <span class="red">♥</span> ♣ <span class="red">♦</span></div>${text}</div>`;

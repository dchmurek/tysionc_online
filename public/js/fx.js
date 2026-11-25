// Animacje stołu (tylko wygląd – stan gry zawsze pochodzi z serwera).
// Warstwa efektów leży nad całą stroną (position: fixed), więc przerysowanie stołu jej nie przerywa.
import { mount, html, raw } from './dom.js';

let layer = null;
function fxLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  return layer;
}
export function clearFx() { if (layer) layer.replaceChildren(); }
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const animationsOn = () => localStorage.getItem('tys2:anim') !== '0' && !reducedMotion();

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Karta lecąca z elementu `from` do elementu `to`. face = HTML karty (albo null → rewers).
export function flyCard({ from, to, face = null, delay = 0, duration = 380, size = 44, spin = 0, fadeOut = false }) {
  if (!from || !to || !animationsOn()) return Promise.resolve();
  const a = centerOf(from), b = centerOf(to);
  const wrap = document.createElement('div');
  wrap.className = 'fx-card';
  wrap.style.setProperty('--w', size + 'px');
  mount(wrap, face || raw('<span class="pcard back"></span>'));
  wrap.style.left = a.x + 'px';
  wrap.style.top = a.y + 'px';
  wrap.style.opacity = '0';
  fxLayer().appendChild(wrap);
  const dx = b.x - a.x, dy = b.y - a.y;
  const anim = wrap.animate([
    { transform: 'translate(-50%, -50%) scale(.85) rotate(0deg)', opacity: 1 },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin}deg)`, opacity: fadeOut ? 0 : 1 },
  ], { duration, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
  return anim.finished.then(() => wrap.remove(), () => wrap.remove());
}

// Napis na środku elementu (stołu): meldunek, wynik rozdania itp.
// kind: 'meld' | 'good' | 'bad' | ''
export function centerBanner(over, { title, sub = '', kind = '', duration = 2000 }) {
  if (!over || !animationsOn()) return;
  const c = centerOf(over);
  const el = document.createElement('div');
  el.className = `fx-banner ${kind}`;
  el.style.left = c.x + 'px';
  el.style.top = c.y + 'px';
  mount(el, html`<div class="fx-t">${title}</div>${sub ? html`<div class="fx-s">${sub}</div>` : ''}`);
  fxLayer().appendChild(el);
  const anim = el.animate([
    { transform: 'translate(-50%, -50%) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%, -50%) scale(1.08)', opacity: 1, offset: 0.12 },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.2 },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.85 },
    { transform: 'translate(-50%, -60%) scale(.96)', opacity: 0 },
  ], { duration, easing: 'ease-out', fill: 'forwards' });
  anim.finished.then(() => el.remove(), () => el.remove());
}

// Karta, która właśnie wylądowała na stole – wjazd od strony gracza.
export function slideIn(el, fromEl, duration = 280) {
  if (!el || !fromEl || !animationsOn()) return;
  const a = centerOf(fromEl), b = centerOf(el);
  el.animate([
    { transform: `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(.7)`, opacity: 0.4 },
    { transform: 'none', opacity: 1 },
  ], { duration, easing: 'cubic-bezier(.2,.7,.3,1)' });
}

// Zebranie lewy: karty zjeżdżają do zwycięzcy.
export function sweepTo(els, toEl, duration = 360) {
  if (!toEl || !els.length || !animationsOn()) return Promise.resolve();
  const b = centerOf(toEl);
  return Promise.all(els.map((el) => {
    const a = centerOf(el);
    return el.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(.5)`, opacity: 0 },
    ], { duration, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
  }));
}

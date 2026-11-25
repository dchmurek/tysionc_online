// Narzędzia DOM. Szablony `html` ZAWSZE escapują wstawiane wartości (ochrona przed XSS);
// surowy HTML tylko przez raw() dla fragmentów zbudowanych przez ten sam mechanizm.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

function part(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function mount(el, content) { el.innerHTML = part(content); }

let toastTimer;
export function toast(msg, { action, onAction, kind = '' } = {}) {
  const t = document.getElementById('toast');
  mount(t, html`<span>${msg}</span>${action ? html`<button type="button">${action}</button>` : ''}`);
  t.className = 'toast ' + kind;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3200);
}

export function banner(msg, kind = '') {
  const b = document.getElementById('banner');
  b.hidden = !msg;
  b.className = 'banner ' + kind;
  b.textContent = msg || '';
}

// Okno dialogowe (zamiast systemowych confirm/prompt). Zwraca Promise z wybraną wartością.
export function dialog({ title, body = '', buttons = [{ label: 'OK', value: true, kind: 'gold' }], fields = null }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = part(html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mdl-t">
      <h2 id="mdl-t">${title}</h2>
      <div class="modal-body">${body}</div>
      ${fields ? html`<form class="modal-form">${fields.map((f) => html`<label class="field"><span>${f.label}</span>
        <input name="${f.name}" type="${f.type || 'text'}" value="${f.value || ''}" ${f.autocomplete ? raw(`autocomplete="${esc(f.autocomplete)}"`) : ''} ${f.required ? raw('required') : ''} ${f.minlength ? raw(`minlength="${Number(f.minlength)}"`) : ''}></label>`)}</form>` : ''}
      <div class="modal-actions">${buttons.map((b, i) => html`<button type="button" class="btn ${b.kind || ''}" data-i="${i}">${b.label}</button>`)}</div>
    </div>`);
    document.body.appendChild(wrap);
    const prevFocus = document.activeElement;
    const close = (v) => { wrap.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); resolve(v); };
    const values = () => (fields ? Object.fromEntries(new FormData(wrap.querySelector('form'))) : null);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const def = buttons[Number(b.dataset.i)];
      if (def.value && fields) {
        const f = wrap.querySelector('form');
        if (!f.reportValidity()) return;
        return close({ value: def.value, fields: values() });
      }
      close(fields ? { value: def.value, fields: values() } : def.value);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && fields && e.target.tagName === 'INPUT') { e.preventDefault(); wrap.querySelector('.btn.gold, .btn.danger')?.click(); }
    });
    (wrap.querySelector('input') || wrap.querySelector('.btn.gold') || wrap.querySelector('.btn')).focus();
  });
}

export const confirmBox = (title, body, okLabel = 'Tak', kind = 'gold') => dialog({ title, body, buttons: [{ label: 'Anuluj', value: false }, { label: okLabel, value: true, kind }] });

export function fmtNum(n) { return (Number(n) || 0).toLocaleString('pl-PL'); }
export function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtNum(Math.abs(n)); }
export function pct(x) { return x == null ? '–' : Math.round(x * 100) + '%'; }
export function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : '–'; }
export function fmtDateTime(iso) { return iso ? new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–'; }
export function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, h = n % 100;
  return d >= 2 && d <= 4 && (h < 10 || h >= 20) ? few : many;
}
export const vibrate = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* brak */ } };
export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// Kopiowanie do schowka. navigator.clipboard działa tylko na https/localhost – na zwykłym http
// (np. adres w sieci domowej) używamy starego sposobu przez ukryte pole tekstowe.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* spróbuj starego sposobu */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

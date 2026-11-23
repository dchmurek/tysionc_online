// Start aplikacji, nawigacja (hash router), pasek stanu, rejestracja Service Workera.
import { html, mount, banner, toast, dialog } from './dom.js';
import { state, loadMe, loadData, subscribe, flush, resolveConflict, nick, refreshMatch, logout } from './state.js';
import { connect, onWs, wsState, disconnect } from './ws.js';
import { icon } from './ui.js';

const routes = [];
const route = (pattern, loader, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, loader, opts });
};
route('/login', () => import('./views/auth.js').then((m) => m.login), { public: true });
route('/register', () => import('./views/auth.js').then((m) => m.register), { public: true });
route('/activate', () => import('./views/auth.js').then((m) => m.activate), { public: true });
route('/', () => import('./views/home.js').then((m) => m.home), { tab: 'home' });
route('/offline/new', () => import('./views/offline.js').then((m) => m.newMatch), { tab: 'play' });
route('/match/:id', () => import('./views/offline.js').then((m) => m.table), { tab: 'play' });
route('/match/:id/details', () => import('./views/match.js').then((m) => m.details), { tab: 'history' });
route('/online', () => import('./views/online.js').then((m) => m.lobby), { tab: 'play' });
route('/room/:id', () => import('./views/online.js').then((m) => m.room), { tab: 'play', game: true });
route('/play', () => import('./views/home.js').then((m) => m.play), { tab: 'play' });
route('/stats', () => import('./views/stats.js').then((m) => m.overview), { tab: 'stats' });
route('/stats/ranking', () => import('./views/stats.js').then((m) => m.rankingView), { tab: 'stats' });
route('/stats/groups', () => import('./views/stats.js').then((m) => m.groupsView), { tab: 'stats' });
route('/stats/group/:key', () => import('./views/stats.js').then((m) => m.groupView), { tab: 'stats' });
route('/stats/pairs', () => import('./views/stats.js').then((m) => m.pairsView), { tab: 'stats' });
route('/stats/player/:id', () => import('./views/stats.js').then((m) => m.playerView), { tab: 'stats' });
route('/history', () => import('./views/history.js').then((m) => m.history), { tab: 'history' });
route('/session/:id', () => import('./views/history.js').then((m) => m.session), { tab: 'history' });
route('/profile', () => import('./views/profile.js').then((m) => m.profile), { tab: 'profile' });
route('/admin', () => import('./views/admin.js').then((m) => m.admin), { tab: 'profile' });
route('/roulette', () => import('./views/roulette.js').then((m) => m.roulette), { tab: 'profile' });

const $app = document.getElementById('app');
const $cta = document.getElementById('cta');
const $bar = document.getElementById('barAction');
let cleanup = null;
let current = null;

export function go(path, { replace = false } = {}) {
  const h = '#' + path;
  if (replace) history.replaceState(null, '', h); else if (location.hash !== h) location.hash = h;
  else render();
  if (replace) render();
}
export function setCta(content) {
  mount($cta, content || '');
  $cta.hidden = !content;
  document.body.classList.toggle('has-cta', !!content);
  measure();
}
export function setBar(content) { mount($bar, content || ''); }

function measure() {
  const dock = document.getElementById('dock');
  const h = (document.body.classList.contains('has-cta') ? $cta.offsetHeight : 0) + (dock.hidden || getComputedStyle(dock).display === 'none' ? 0 : dock.offsetHeight);
  document.documentElement.style.setProperty('--bottom-space', h + 'px');
}
new ResizeObserver(measure).observe($cta);
window.addEventListener('resize', measure);

async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  let match = null;
  let r = null;
  for (const x of routes) { const m = path.match(x.re); if (m) { r = x; match = m; break; } }
  if (!r) { go('/', { replace: true }); return; }
  if (!r.opts.public && !state.me) { go('/login', { replace: true }); return; }
  if (r.opts.public && state.me && state.me.status === 'active' && path !== '/activate') { go('/', { replace: true }); return; }
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
  document.body.classList.toggle('auth', !!r.opts.public);
  document.body.classList.toggle('in-game', !!r.opts.game);
  document.getElementById('dock').hidden = !!r.opts.public;
  document.querySelectorAll('#dock [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === r.opts.tab));
  setCta('');
  setBar('');
  const view = document.createElement('div');
  view.className = 'view';
  $app.replaceChildren(view);
  current = { path, params };
  try {
    const fn = await r.loader();
    if (current.path !== path) return;
    cleanup = (await fn({ el: view, params, go, setCta, setBar })) || null;
  } catch (e) {
    console.error(e);
    mount(view, html`<div class="card empty">Coś poszło nie tak: ${e.message}<br><a class="btn" href="/">Odśwież</a></div>`);
  }
  if (!r.opts.keepScroll) window.scrollTo(0, 0);
  measure();
}
export const rerender = () => render();

function statusBanner() {
  if (state.conflicts.length) { banner('Mecz zmienił się na innym urządzeniu – wybierz, co zrobić z niewysłanymi rozdaniami.', 'warn'); return; }
  const q = JSON.parse(localStorage.getItem(`tys2:queue:${state.me ? state.me.id : 'anon'}`) || '[]').length;
  if (!state.online) banner(q ? `Brak internetu – ${q} ${q === 1 ? 'zmiana czeka' : 'zmian czeka'} w telefonie i wyśle się automatycznie.` : 'Brak internetu – pracujesz na danych zapisanych w telefonie.', 'warn');
  else if (q) banner('Wysyłanie zapisanych wyników…');
  else banner('');
}

let conflictOpen = false;
async function showConflict() {
  if (conflictOpen || !state.conflicts.length) return;
  conflictOpen = true;
  const c = state.conflicts[0];
  const adds = c.ops.filter((o) => o.kind === 'addRound').length;
  const v = await dialog({
    title: 'Konflikt zapisu',
    body: html`<p>Ktoś zmienił ten mecz na innym urządzeniu, zanim dotarły Twoje zmiany (${c.ops.length}).</p>
      <p class="muted small">Twoje zmiany nie zostały zapisane na serwerze i nic nie nadpisało cudzych danych.</p>`,
    buttons: [{ label: 'Odśwież (odrzuć moje)', value: 'discard' }, ...(adds ? [{ label: `Dodaj moje rozdania (${adds}) na końcu`, value: 'reapply', kind: 'gold' }] : [])],
  });
  await resolveConflict(c.matchId, v || 'discard');
  conflictOpen = false;
  if (state.conflicts.length) showConflict();
}

subscribe((what) => {
  if (what === 'sync' || what === 'data') statusBanner();
  if (what === 'conflict') { statusBanner(); showConflict(); }
  if (what === 'rejected' && state.rejected) toast('Serwer odrzucił zmianę: ' + state.rejected.error, { kind: 'bad' });
  if (what === 'auth' && !state.me) { disconnect(); go('/login', { replace: true }); }
});
onWs((m) => {
  if (m.type === 'match') refreshMatch(m.matchId);
  if (m.type === 'status') document.body.classList.toggle('ws-off', !m.connected);
  if (m.type === 'auth') { toast('Sesja wygasła – zaloguj się ponownie'); logout(); }
});
window.addEventListener('tys:unauthorized', () => { if (state.me && state.online) { state.me = null; disconnect(); go('/login', { replace: true }); } });
window.addEventListener('online', () => { state.online = true; flush(); statusBanner(); });
window.addEventListener('offline', () => { state.online = false; statusBanner(); });
setInterval(() => { if (state.me) flush(); }, 20000);
window.addEventListener('hashchange', render);

document.getElementById('dock').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});
document.querySelector('.brand').addEventListener('click', () => go('/'));

export async function afterLogin() {
  await loadData();
  connect();
  statusBanner();
}

(async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    await loadMe();
  } catch (e) {
    console.error(e);
  }
  if (state.me && state.me.status === 'active') await afterLogin();
  render();
})();

export { nick, wsState, icon };

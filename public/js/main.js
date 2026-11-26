// Start aplikacji, nawigacja (hash router), pasek stanu, rejestracja Service Workera.
import { html, mount, banner, toast, dialog, confirmBox } from './dom.js';
import { state, loadMe, loadData, subscribe, flush, resolveConflict, nick, refreshMatch, logout, matchById, matchOp, pendingFor, post } from './state.js';
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
route('/join/:code', () => import('./views/online.js').then((m) => m.joinLink), { tab: 'play' });
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
  document.documentElement.style.setProperty('--bar-h', document.querySelector('.bar').offsetHeight + 'px');
  const h = (document.body.classList.contains('has-cta') ? $cta.offsetHeight : 0) + (dock.hidden || getComputedStyle(dock).display === 'none' ? 0 : dock.offsetHeight);
  document.documentElement.style.setProperty('--bottom-space', h + 'px');
}
new ResizeObserver(measure).observe($cta);
window.addEventListener('resize', measure);

async function render() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  let match = null;
  let r = null;
  for (const x of routes) { const m = path.match(x.re); if (m) { r = x; match = m; break; } }
  if (!r) { go('/', { replace: true }); return; }
  if (!r.opts.public && !state.me) {
    if (/^\/(join|room)\//.test(path)) sessionStorage.setItem('tys2:next', path);
    go('/login', { replace: true }); return;
  }
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

// Opcje meczu z listy (ekran główny, historia, sesje) – usuwanie bez wchodzenia do licznika offline.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-match-menu]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const id = b.dataset.matchMenu;
  const m = matchById(id);
  if (!m) return;
  const room = (state.rooms || []).find((r) => r.matchId === id);
  const names = [[m.seats[0], m.seats[2]], [m.seats[1], m.seats[3]]].map((t) => t.map(nick).join(' & ')).join(' vs ');
  const v = await dialog({
    title: 'Mecz',
    body: html`<p class="muted small">${names} · ${m.rounds.length} rozdań</p>`,
    buttons: [
      ...(room ? [{ label: `Wejdź do stołu ${room.code}`, value: 'room', kind: 'gold' }] : []),
      ...(m.status === 'active' && !room ? [{ label: 'Otwórz stół (czat, gra online)', value: 'open-room', kind: 'gold' }, { label: 'Licznik punktów', value: 'table' }] : []),
      { label: 'Szczegóły', value: 'details' },
      ...(m.status === 'active' ? [{ label: 'Przerwij mecz', value: 'abandon' }] : []),
      ...(m.status === 'abandoned' ? [{ label: 'Wznów mecz', value: 'reopen' }] : []),
      { label: 'Usuń mecz', value: 'delete', kind: 'danger' },
      { label: 'Anuluj', value: null },
    ],
  });
  try {
    if (v === 'room') go('/room/' + encodeURIComponent(room.id));
    if (v === 'table') go('/match/' + encodeURIComponent(id));
    if (v === 'details') go('/match/' + encodeURIComponent(id) + '/details');
    if (v === 'open-room') {
      if (pendingFor(id).length) { toast('Najpierw muszą się wysłać zapisane wyniki (brak internetu?)'); return; }
      const { room: r } = await post('/api/rooms', { fromMatchId: id, mode: 'offline' });
      await loadData();
      go('/room/' + encodeURIComponent(r.id));
    }
    if (v === 'abandon' && (await confirmBox('Przerwać mecz?', 'Przerwany mecz nie liczy się do wygranych. Można go później wznowić.' + (room ? ' Stół zostanie zamknięty.' : ''), 'Przerwij'))) { await matchOp('status', id, { status: 'abandoned' }); await loadData(); }
    if (v === 'reopen') await matchOp('status', id, { status: 'active' });
    if (v === 'delete' && (await confirmBox('Usunąć mecz?', 'Mecz zniknie z historii i statystyk.' + (room ? ' Stół zostanie zamknięty.' : '') + ' Administrator może go przywrócić.', 'Usuń', 'danger'))) {
      await matchOp('status', id, { status: 'deleted' });
      if (state.me.role !== 'admin') state.matches = state.matches.filter((x) => x.id !== id);
      await loadData();
      toast('Mecz usunięty');
    }
  } catch (ex) { toast(ex.network ? 'Wymaga internetu' : ex.message, { kind: 'bad' }); }
}, true);

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

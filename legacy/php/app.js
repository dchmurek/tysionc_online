/* global Engine, Chart */
(function () {
  'use strict';

  const { MELDS, DEFAULT_SETTINGS, sidesOf, sideOfPlayer, computeGame } = Engine;
  const LS_DB = 'tys_db';
  const LS_PENDING = 'tys_pending';
  const LS_LAST = 'tys_last_game';
  const LS_STATS = 'tys_stats_filter';

  const state = {
    db: { version: 1, players: [], games: [] },
    user: null,            // zalogowany login
    view: 'game',          // game | detail | history | stats
    gameId: null,
    draft: null,
    editIndex: null,
    sheet: null,           // round | menu
    topOpen: true,         // rozwinięta górna część arkusza (kto / za ile / wynik)
    meldsOpen: false,
    logAll: false,
    freshRow: null,
    historyMode: 'all',
    stats: { mode: 'all', period: '90' },
    newGame: null,
    offline: false,
  };
  const shownScores = {};
  const charts = {};
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet');
  const $backdrop = document.getElementById('sheetBackdrop');
  const $cta = document.getElementById('cta');
  const $barAction = document.getElementById('barAction');

  // ---------- Narzędzia ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const fmt = (n) => (Number(n) || 0).toLocaleString('pl-PL');
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* brak miejsca / tryb prywatny */ } };
  const vibrate = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* brak wsparcia */ } };
  const suit = (k) => `<span class="${MELDS[k].red ? 'red-suit' : ''}">${MELDS[k].label}&#xFE0E;</span>`;


  // Ikony liniowe (styl Lucide, licencja ISC) – jeden spójny zestaw zamiast emoji.
  const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    backspace: '<path d="M10 5a2 2 0 0 0-1.34.52l-6.33 5.74a1 1 0 0 0 0 1.48l6.33 5.74A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/>',
    crown: '<path d="M11.56 3.27a.5.5 0 0 1 .88 0l2.95 5.6a1 1 0 0 0 1.52.3l4.27-3.67a.5.5 0 0 1 .8.52l-2.83 10.25a1 1 0 0 1-.96.73H5.81a1 1 0 0 1-.96-.73L2.02 6.02a.5.5 0 0 1 .8-.52l4.27 3.67a1 1 0 0 0 1.52-.3z"/><path d="M5 21h14"/>',
    down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    reopen: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    times2: '<path d="M4 4l6 6M10 4l-6 6"/><path d="M14 9a3 3 0 0 1 6 0c0 2-6 4-6 7h6"/>',
  };
  const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  function toast(msg, actionLabel, onAction) {
    const t = document.getElementById('toast');
    t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
    t.hidden = false;
    if (actionLabel) t.querySelector('button').onclick = () => { t.hidden = true; onAction(); };
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, actionLabel ? 5000 : 2600);
  }

  function banner(msg) {
    const b = document.getElementById('banner');
    b.hidden = !msg;
    b.textContent = msg || '';
  }

  const player = (id) => state.db.players.find((p) => p.id === id);
  const activePlayers = () => state.db.players.filter((p) => !p.deleted);
  // Wybrane nicki dostają flagę Izraela (bez względu na wielkość liter).
  const IL_NICKS = ['daniel', 'damazy', 'danielek'];
  const withFlag = (name) => (IL_NICKS.includes(String(name).trim().toLowerCase()) ? name + ' 🇮🇱' : name);
  const rawName = (id) => (player(id) || { name: '?' }).name;
  const pname = (id) => withFlag(rawName(id));
  const game = (id) => state.db.games.find((g) => g.id === id);

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  // Kolor przypisany na stałe do gracza (kolejność dodania), żeby był taki sam we wszystkich widokach.
  function pcolor(id) {
    const i = state.db.players.findIndex((p) => p.id === id);
    return i >= 0 && i < 8 ? cssVar('--c' + (i + 1)) : cssVar('--muted');
  }
  function sideName(g, s) {
    return sidesOf(g)[s].map(pname).join(' & ');
  }
  function sideColor(g, s) {
    return pcolor(sidesOf(g)[s][0]);
  }
  const dots = (g, s) => sidesOf(g)[s].map((pid) => `<i class="dot" style="--pc:${pcolor(pid)}"></i>`).join('');

  // ---------- Komunikacja z serwerem ----------
  async function api(action, payload) {
    const opts = { method: payload ? 'POST' : 'GET', headers: { 'X-Tysiac': '1' }, credentials: 'same-origin' };
    if (payload) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(payload);
    }
    const res = await fetch('api.php?action=' + action, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* odpowiedź nie-JSON */ }
    if (!res.ok || !data || !data.ok) {
      const err = new Error((data && data.error) || 'Błąd serwera (' + res.status + ')');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Zapis na serwer; wygasła sesja przenosi do ekranu logowania (dane zostają w telefonie).
  async function write(action, payload) {
    try {
      return await api(action, payload);
    } catch (e) {
      if (e.status === 401) { state.user = null; closeSheet(); renderLogin('Sesja wygasła – zaloguj się ponownie.'); }
      throw e;
    }
  }

  function cacheDb() { lsSet(LS_DB, state.db); }

  async function persistGame(g) {
    g.updatedLocal = new Date().toISOString();
    const pending = lsGet(LS_PENDING, {});
    pending[g.id] = true;
    lsSet(LS_PENDING, pending);
    cacheDb();
    try {
      await write('saveGame', { game: g, players: state.db.players });
      const p2 = lsGet(LS_PENDING, {});
      delete p2[g.id];
      lsSet(LS_PENDING, p2);
      setOffline(false);
    } catch (e) {
      setOffline(true, e.message);
    }
  }

  async function flushPending() {
    const pending = lsGet(LS_PENDING, {});
    const ids = Object.keys(pending);
    if (!ids.length) return;
    for (const id of ids) {
      const g = game(id);
      if (!g) { delete pending[id]; continue; }
      try {
        await write('saveGame', { game: g, players: state.db.players });
        delete pending[id];
      } catch (e) {
        lsSet(LS_PENDING, pending);
        setOffline(true, e.message);
        return;
      }
    }
    lsSet(LS_PENDING, pending);
    setOffline(false);
  }

  function setOffline(off, msg) {
    state.offline = off;
    const n = Object.keys(lsGet(LS_PENDING, {})).length;
    banner(off ? `Brak zapisu na serwerze (${msg || 'brak połączenia'}). Wynik jest w telefonie – wyślę go automatycznie.` : (n ? 'Wysyłanie zaległych wyników…' : ''));
  }

  async function loadDb() {
    const pending = lsGet(LS_PENDING, {});
    const cached = lsGet(LS_DB, null);
    try {
      const data = await api('load');
      state.user = data.user;
      const db = data.db;
      // Zachowaj lokalne gry, które jeszcze nie dotarły na serwer.
      if (cached) {
        for (const id of Object.keys(pending)) {
          const local = cached.games.find((g) => g.id === id);
          if (!local) continue;
          const i = db.games.findIndex((g) => g.id === id);
          if (i >= 0) db.games[i] = local; else db.games.push(local);
        }
        for (const p of cached.players) if (!db.players.find((x) => x.id === p.id)) db.players.push(p);
      }
      state.db = db;
      cacheDb();
      setOffline(false);
      flushPending();
    } catch (e) {
      if (e.status === 401) { state.user = null; return false; }
      if (cached) state.db = cached;
      setOffline(true, 'tryb offline');
    }
    return true;
  }

  // ---------- Logowanie ----------
  function renderLogin(msg) {
    document.body.classList.add('auth');
    setCta('');
    $barAction.innerHTML = '';
    $app.innerHTML = `
      <form class="login" id="loginForm" autocomplete="on">
        <div class="login-suits">♠ <span class="red-suit">♥</span> ♣ <span class="red-suit">♦</span></div>
        <h1 class="title-xl">Stół jest zamknięty</h1>
        <p class="muted">Podaj hasło do stołu, żeby zobaczyć wyniki i zapisywać rozdania.</p>
        <input type="text" name="username" value="tysiac" autocomplete="username" hidden>
        <label class="seat"><span>Hasło do stołu</span><input type="password" name="password" autocomplete="current-password" required></label>
        <div class="login-err" id="loginErr">${esc(msg || '')}</div>
        <button class="btn-gold" type="submit" style="width:100%">Wejdź do gry</button>
        <p class="muted small" style="text-align:center;margin-top:14px">Telefon zapamięta logowanie na 180 dni.</p>
      </form>`;
    const f = document.getElementById('loginForm');
    f.password.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button');
      btn.disabled = true;
      try {
        await api('login', { password: f.password.value });
        document.body.classList.remove('auth');
        await loadDb();
        const last = lsGet(LS_LAST, null);
        const lg = last && game(last);
        state.gameId = lg && lg.status === 'active' ? last : null;
        state.view = 'game';
        render();
      } catch (err) {
        document.getElementById('loginErr').textContent = err.message;
        f.password.value = '';
        f.password.focus();
        btn.disabled = false;
      }
    });
  }

  async function logout() {
    const pending = Object.keys(lsGet(LS_PENDING, {})).length;
    if (pending && !confirm('Są wyniki, które jeszcze nie dotarły na serwer. Wylogowanie je usunie z telefonu. Kontynuować?')) return;
    if (!pending && !confirm('Wylogować?')) return;
    try { await api('logout', {}); } catch (e) { /* i tak czyścimy lokalnie */ }
    [LS_DB, LS_PENDING, LS_LAST].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* brak dostępu */ } });
    state.db = { version: 1, players: [], games: [] };
    state.user = null;
    state.gameId = null;
    banner('');
    renderLogin();
  }

  async function changePassword(form) {
    const err = form.querySelector('.login-err');
    const [adminP, newP, newP2] = [form.admin.value, form.new1.value, form.new2.value];
    if (newP !== newP2) { err.textContent = 'Nowe hasła się różnią.'; return; }
    if (newP.length < 8) { err.textContent = 'Nowe hasło musi mieć co najmniej 8 znaków.'; return; }
    try {
      await write('changePassword', { admin: adminP, new: newP });
      form.reset();
      err.textContent = '';
      toast('Hasło zmienione – podaj nowe hasło pozostałym graczom');
    } catch (e) {
      err.textContent = e.message;
    }
  }

  // ---------- Nawigacja ----------
  function go(view, gameId) {
    state.view = view;
    if (gameId !== undefined) {
      state.gameId = gameId;
      state.draft = null;
      state.editIndex = null;
      state.logAll = false;
      if (gameId) lsSet(LS_LAST, gameId);
    }
    closeSheet(true);
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (!state.user) return renderLogin();
    Object.values(charts).forEach((c) => c.destroy());
    for (const k in charts) delete charts[k];
    const tab = state.view === 'detail' ? 'game' : state.view;
    document.querySelectorAll('#dock button').forEach((b) => b.classList.toggle('active', b.dataset.nav === tab));
    $app.classList.toggle('wide', state.view === 'stats');
    $barAction.innerHTML = '';
    setCta('');
    if (state.view === 'history') renderHistory();
    else if (state.view === 'stats') renderStats();
    else if (state.view === 'roulette') renderRoulette();
    else if (state.view === 'detail' && game(state.gameId)) renderDetail();
    else if (state.gameId && game(state.gameId)) renderTable();
    else renderHome();
  }

  function setCta(html) {
    $cta.innerHTML = html;
    $cta.hidden = !html;
    document.body.classList.toggle('has-cta', !!html);
  }

  // ---------- Ekran startowy / nowa gra ----------
  function lastPlayersFor(mode) {
    const g = [...state.db.games].filter((x) => x.mode === mode).sort((a, b) => b.created.localeCompare(a.created))[0];
    return g ? g.players.filter((id) => !(player(id) || {}).deleted).map(pname) : [];
  }

  function renderHome() {
    if (!state.newGame) {
      state.newGame = { mode: '4x', names: lastPlayersFor('4x'), settings: Object.assign({}, DEFAULT_SETTINGS, { scoreActual: true }, lsGet('tys_settings', {})) };
    }
    const ng = state.newGame;
    const active = state.db.games.filter((g) => g.status === 'active').sort((a, b) => (b.updated || b.created).localeCompare(a.updated || a.created));
    const S = ng.settings;
    const seatInput = (i, label) => `<label class="seat"><span>${label}</span>
      <input type="text" list="plist" data-seat="${i}" value="${esc(ng.names[i] || '')}" placeholder="Imię" autocomplete="off" autocapitalize="words" maxlength="30"></label>`;
    const used = new Set(ng.names.map((n) => (n || '').trim().toLowerCase()));
    const known = activePlayers().filter((p) => !used.has(p.name.toLowerCase()));

    const seats = ng.mode === '4x'
      ? `<div class="teams">
          <div class="team"><div class="team-h">Para A</div>${seatInput(0, 'Miejsce 1')}${seatInput(2, 'Miejsce 3 · naprzeciwko')}</div>
          <div class="team"><div class="team-h">Para B</div>${seatInput(1, 'Miejsce 2')}${seatInput(3, 'Miejsce 4 · naprzeciwko')}</div>
        </div>
        <p class="hint">Miejsca w kolejności siedzenia przy stole – tak też idzie rozdawanie.</p>`
      : `<div class="team">${seatInput(0, 'Gracz 1 · rozdaje pierwszy')}${seatInput(1, 'Gracz 2')}${seatInput(2, 'Gracz 3')}</div>`;

    $app.innerHTML = `
      ${active.length ? `<div class="section-head" style="margin-top:4px"><span class="eyebrow">Trwające gry</span></div>
        ${active.map(gameCard).join('')}<div style="height:14px"></div>` : ''}
      <div class="page-head"><div><div class="eyebrow">Nowa partia</div><h1 class="title-xl">Kto siada do stołu?</h1></div></div>
      <div class="modes">
        <button class="mode ${ng.mode === '4x' ? 'on' : ''}" data-act="ng-mode" data-mode="4x">
          <div class="ms">♠♥♣♦</div><div class="mt">4 na krzyż</div><div class="md">dwie pary</div></button>
        <button class="mode ${ng.mode === '3' ? 'on' : ''}" data-act="ng-mode" data-mode="3">
          <div class="ms">♠♥♣</div><div class="mt">3 osoby</div><div class="md">każdy na siebie</div></button>
      </div>
      <datalist id="plist">${activePlayers().map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
      ${seats}
      ${known.length ? `<div class="quick-players">${known.map((p) => `<button class="qp" data-act="qp" data-name="${esc(p.name)}"><i class="dot" style="--pc:${pcolor(p.id)}"></i>${esc(withFlag(p.name))}</button>`).join('')}</div>` : ''}
      <details class="rules">
        <summary>Zasady i ustawienia</summary>
        <div class="form-grid">
          <label><span>Gra do</span><input type="number" data-set="target" value="${S.target}" step="10"></label>
          <label><span>Min. licytacja</span><input type="number" data-set="minBid" value="${S.minBid}" step="10"></label>
          <label><span>Bez licytacji max do</span><input type="number" data-set="passiveCap" value="${S.passiveCap}" step="10"></label>
          <label><span>Kara za 3 zera</span><input type="number" data-set="zeroPenalty" value="${S.zeroPenalty}" step="10"></label>
        </div>
        <label class="check"><input type="checkbox" data-set="scoreActual" ${S.scoreActual ? 'checked' : ''}> Ugrana licytacja = faktycznie ugrane punkty (szedł 160, ugrał 200 → +200)</label>
        <label class="check"><input type="checkbox" data-set="round10" ${S.round10 ? 'checked' : ''}> Zaokrąglaj punkty do 10</label>
        <label class="check"><input type="checkbox" data-set="zeroRule" ${S.zeroRule ? 'checked' : ''}> Trzy zera z rzędu = kara</label>
      </details>`;
    setCta('<button class="btn-gold" data-act="ng-start">Rozdaj karty <span>♠</span></button>');
  }

  function gameCard(g) {
    const c = computeGame(g);
    const order = c.sides.map((_, s) => s).sort((a, b) => c.scores[b] - c.scores[a]);
    const parts = order.map((s) => `<span class="${c.winner === s ? 'w' : ''}">${c.winner === s ? icon('crown', 'win-ic') : ''}${esc(sideName(g, s))} <span class="num">${fmt(c.scores[s])}</span></span>`).join('');
    const status = g.status === 'active' ? '<span class="badge live">w grze</span>' : g.status === 'abandoned' ? '<span class="badge">przerwana</span>' : '';
    return `<div class="game-card" data-act="open" data-id="${g.id}">
      <div class="gc-main"><div class="gc-sides">${parts}</div>
      <div class="gc-meta">${fmtDateTime(g.created)} · ${g.mode === '4x' ? '4 na krzyż' : '3 osoby'} · ${g.rounds.length} rozdań ${status}</div></div>
      <span class="chev">${icon('chevronRight')}</span></div>`;
  }

  function startGame() {
    const ng = state.newGame;
    const seats = ng.mode === '4x' ? 4 : 3;
    const names = Array.from({ length: seats }, (_, i) => (ng.names[i] || '').trim());
    if (names.some((n) => !n)) return toast('Wpisz wszystkich graczy');
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return toast('Imiona muszą być różne');
    const ids = names.map((name) => {
      let p = state.db.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!p) {
        p = { id: uid('p'), name, created: new Date().toISOString() };
        state.db.players.push(p);
      } else if (p.deleted) {
        p.deleted = false;  // wraca do gry – przywróć gracza
      }
      return p.id;
    });
    const settings = {};
    for (const k in DEFAULT_SETTINGS) settings[k] = ng.settings[k];
    lsSet('tys_settings', settings);
    const g = { id: uid('g'), mode: ng.mode, players: ids, settings, rounds: [], status: 'active', created: new Date().toISOString() };
    state.db.games.push(g);
    state.newGame = null;
    persistGame(g);
    go('game', g.id);
  }

  // ---------- Stół (ekran główny gry) ----------
  function renderTable() {
    const g = game(state.gameId);
    const c = computeGame(g);
    const n = c.sides.length;
    const finished = g.status !== 'active';
    const dealer = g.players[c.dealerIndex];
    const lead = Math.max(...c.scores);
    const prev = shownScores[g.id] || c.scores;

    $barAction.innerHTML = `<button class="icon-btn" data-act="menu" aria-label="Opcje gry">${icon('more')}</button>`;

    const tiles = c.sides.map((side, s) => {
      const sc = c.scores[s];
      const pills = [];
      if (c.winner === s) pills.push(`<span class="pill win">${icon('crown')}wygrana</span>`);
      if (c.atCap[s] && c.winner === null) pills.push(`<span class="pill barrel">${c.cap} · tylko licytacja</span>`);
      if (!finished && side.includes(dealer)) pills.push(`<span class="pill deal">rozdaje${g.mode === '4x' ? ' ' + esc(pname(dealer)) : ''}</span>`);
      const w = Math.max(0, Math.min(100, (sc / c.settings.target) * 100));
      const isLead = c.winner === null && sc === lead && sc > 0 && c.scores.filter((x) => x === lead).length === 1;
      return `<div class="tile ${c.winner === s ? 'win' : ''} ${isLead ? 'lead' : ''}" style="--pc:${sideColor(g, s)}">
        <div class="tname">${dots(g, s)}<span>${g.mode === '4x' ? side.map((pid) => esc(pname(pid))).join('<br>') : esc(sideName(g, s))}</span></div>
        <div class="tscore ${sc < 0 ? 'neg' : ''}" data-from="${prev[s]}" data-to="${sc}">${fmt(prev[s])}</div>
        <div class="tmeta">${pills.join('')}</div>
        <div class="tbar"><i style="width:${w}%"></i><span class="mark" style="left:${(c.cap / c.settings.target) * 100}%"></span></div>
      </div>`;
    }).join('');

    const metaLeft = g.mode === '4x' ? '4 na krzyż' : 'Gra w 3';
    const metaRight = finished
      ? (g.status === 'abandoned' ? 'przerwana' : `${g.rounds.length} rozdań`)
      : `<span class="dealer">rozdanie ${g.rounds.length + 1} · rozdaje <b>${esc(pname(dealer))}</b></span>`;

    $app.innerHTML = `
      <section class="felt">
        <div class="felt-meta"><span>${metaLeft}</span>${metaRight}</div>
        <div class="scores n${n}">${tiles}</div>
      </section>
      <section class="log">
        <div class="section-head"><span class="eyebrow">Ostatnie rozdania</span>
          ${g.rounds.length && !finished ? `<button class="btn sm" data-act="undo">${icon('undo')}Cofnij</button>` : ''}</div>
        ${logHTML(g, c)}
      </section>`;

    if (finished) {
      setCta('<button class="btn-ghost" data-act="new">Nowa gra</button><button class="btn-gold" data-act="rematch">Rewanż <span>♠</span></button>');
    } else {
      setCta(`<button class="btn-gold" data-act="add">${icon('plus', 'lg')}Dodaj rozdanie</button>`);
    }

    animateScores();
    shownScores[g.id] = c.scores.slice();
    state.freshRow = null;
  }

  function animateScores() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $app.querySelectorAll('.tscore[data-to]').forEach((el) => {
      const from = Number(el.dataset.from), to = Number(el.dataset.to);
      if (from === to || reduce) { el.textContent = fmt(to); return; }
      const t0 = performance.now(), dur = 650;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmt(Math.round(from + (to - from) * e));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function logHTML(g, c) {
    if (!c.rows.length) {
      return `<div class="log-list"><div class="empty"><div class="suits">♠ <span class="red-suit">♥</span> ♣ <span class="red-suit">♦</span></div>Jeszcze nic nie zagrano.<br>Dodaj pierwsze rozdanie przyciskiem poniżej.</div></div>`;
    }
    const n = c.sides.length;
    const cols = `grid-template-columns: minmax(0,1fr) repeat(${n}, ${n === 3 ? '54px' : '68px'})`;
    const all = c.rows.slice().reverse();
    const rows = state.logAll ? all : all.slice(0, 5);
    const head = `<div class="lrow head" style="${cols}"><div>Kto · za ile</div>${c.sides.map((_, s) => `<div style="text-align:right">${esc(g.mode === '4x' ? sidesOf(g)[s].map((p) => rawName(p).slice(0, 5) + pname(p).slice(rawName(p).length)).join('/') : pname(sidesOf(g)[s][0]))}</div>`).join('')}</div>`;
    const body = rows.map((row) => {
      const r = row.round;
      const res = r.type === 'bomb' ? '<span class="tagx">bomba</span>' : r.made ? `<span class="res ok">${icon('check')}</span>` : `<span class="res ko">${icon('x')}</span>`;
      const melds = Object.values(r.melds || {}).flat().map(suit).join('');
      const cells = c.sides.map((_, s) => {
        const d = row.deltas[s];
        const note = row.notes[s].includes('3 zera') ? `<span class="note bad" title="3 zera">${icon('down')}</span>` : row.notes[s].length ? `<span class="note gold" title="${esc(row.notes[s].join(', '))}">${icon('lock')}</span>` : '';
        return `<div class="cell ${d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero'}">${d === 0 ? '0' : signed(d)}${note}</div>`;
      }).join('');
      return `<div class="lrow ${state.freshRow === row.index ? 'fresh' : ''}" style="${cols}" data-act="edit-round" data-i="${row.index}">
        <div class="who"><span class="n">${row.index + 1}</span><i class="dot" style="--pc:${pcolor(r.bidder)}"></i>
          <span class="pn">${esc(pname(r.bidder))}</span>${r.type === 'bomb' ? '' : `<span class="bid">${r.bid}</span>`}${res}
          ${melds ? `<span class="melds-mini">${melds}</span>` : ''}</div>${cells}</div>`;
    }).join('');
    const more = all.length > 5 ? `<button class="log-more" data-act="log-all">${state.logAll ? 'Pokaż mniej' : `Pokaż wszystkie (${all.length})`}</button>` : '';
    return `<div class="log-list">${head}${body}${more}</div>`;
  }

  // ---------- Arkusz: dodawanie / poprawa rozdania ----------
  function newDraft(g) {
    return { bidder: null, bid: g.settings.minBid || 100, result: null, points: {}, got: '', melds: {}, active: null };
  }

  function draftRound(g, d) {
    const r = { bidder: d.bidder, bid: Number(d.bid) || 0, type: d.result === 'bomb' ? 'bomb' : 'normal', made: d.result === 'made', points: {}, melds: {} };
    for (const k in d.points) if (d.points[k] !== '' && d.points[k] != null) r.points[k] = Number(d.points[k]) || 0;
    for (const k in d.melds) if (d.melds[k] && d.melds[k].length) r.melds[k] = d.melds[k].slice();
    if (d.result === 'made') {
      if (d.got !== '' && d.got != null) r.got = Number(d.got) || 0;
      else {
        const auto = autoGot(g, d);
        if (auto !== null) { r.got = auto; r.gotAuto = true; }
      }
    }
    return r;
  }

  // Ile ugrał grający: 120 pkt w kartach minus punkty przeciwników z kart, plus meldunki strony grającego.
  // Liczone tylko, gdy wpisano punkty przeciwników (choćby 0) – inaczej nie wiadomo, ile ugrał.
  function autoGot(g, d) {
    if (!d.bidder) return null;
    const opps = opponentSides(g, d);
    if (!opps.some((s) => d.points[s] !== '' && d.points[s] != null)) return null;
    const cards = 120 - opps.reduce((a, s) => a + (Number(d.points[s]) || 0), 0);
    const bs = sideOfPlayer(g, d.bidder);
    const melds = sidesOf(g)[bs].reduce((a, pid) => a + Engine.meldValue(d.melds[pid]), 0);
    return Math.max(0, cards) + melds;
  }

  // Ugrane punkty grającego, które pójdą do zapisu (ręczne > automatyczne > kwota licytacji).
  function effectiveGot(g, d) {
    if (d.got !== '' && d.got != null) return { v: Number(d.got) || 0, how: 'manual' };
    const auto = autoGot(g, d);
    if (auto !== null) return { v: auto, how: 'auto' };
    return { v: Number(d.bid) || 0, how: 'bid' };
  }

  // Wynik gry tak, jakby rozdanie z formularza zostało już zapisane.
  function previewWith(g, d) {
    if (!d.bidder || !d.result) return null;
    const rounds = g.rounds.slice();
    const idx = state.editIndex ?? rounds.length;
    rounds[idx] = draftRound(g, d);
    const c = computeGame(Object.assign({}, g, { rounds }));
    return c.rows[idx] || null;
  }


  function opponentSides(g, d) {
    const bs = d.bidder ? sideOfPlayer(g, d.bidder) : -1;
    return sidesOf(g).map((_, s) => s).filter((s) => s !== bs);
  }

  function openRoundSheet(editIndex) {
    const g = game(state.gameId);
    if (editIndex !== undefined && editIndex !== null) {
      const r = g.rounds[editIndex];
      state.editIndex = editIndex;
      state.draft = {
        bidder: r.bidder, bid: r.bid || g.settings.minBid, result: r.type === 'bomb' ? 'bomb' : r.made ? 'made' : 'failed',
        points: Object.fromEntries(Object.entries(r.points || {}).map(([k, v]) => [k, String(v)])),
        got: r.got != null && !r.gotAuto ? String(r.got) : '',
        melds: JSON.parse(JSON.stringify(r.melds || {})), active: null,
      };
      state.meldsOpen = Object.keys(r.melds || {}).length > 0;
      state.topOpen = false;
    } else if (!state.draft || state.editIndex !== null) {
      state.editIndex = null;
      state.draft = newDraft(g);
      state.meldsOpen = false;
      state.topOpen = true;
    }
    if (state.draft.result && state.draft.result !== 'bomb' && state.draft.active == null) state.draft.active = opponentSides(g, state.draft)[0];
    state.sheet = 'round';
    showSheet();
    renderRoundSheet(true);
  }

  function showSheet() {
    $sheet.hidden = false;
    $backdrop.hidden = false;
    document.body.classList.add('locked');
  }

  function closeSheet() {
    if (state.sheet === 'round' && state.editIndex !== null) { state.editIndex = null; state.draft = null; }
    state.sheet = null;
    $sheet.hidden = true;
    $backdrop.hidden = true;
    $sheet.innerHTML = '';
    document.body.classList.remove('locked');
  }

  function renderRoundSheet(first) {
    const g = game(state.gameId);
    const c = computeGame(g);
    const d = state.draft;
    const S = c.settings;
    const editing = state.editIndex !== null;
    const body = $sheet.querySelector('.sheet-body');
    const scroll = body ? body.scrollTop : 0;
    const chipsEl = $sheet.querySelector('.chips');
    const chipsScroll = chipsEl ? chipsEl.scrollLeft : null;
    const opps = opponentSides(g, d);
    const n = g.players.length;
    const dealer = editing ? g.rounds[state.editIndex].dealer : g.players[c.dealerIndex];

    const pbtns = g.players.map((pid, i) => `<button class="pbtn ${d.bidder === pid ? 'on' : ''}" data-act="bidder" data-pid="${pid}">
      <i class="dot" style="--pc:${pcolor(pid)}"></i><span>${esc(pname(pid))}</span>${g.mode === '4x' ? `<small>${i % 2 === 0 ? 'A' : 'B'}</small>` : ''}</button>`).join('');

    const chips = [];
    for (let b = S.minBid; b <= Math.max(S.minBid + 200, Number(d.bid) + 30); b += 10) chips.push(`<button class="chip ${Number(d.bid) === b ? 'on' : ''}" data-act="bid" data-v="${b}">${b}</button>`);

    let pointsHTML = '';
    if (d.bidder && d.result && d.result !== 'bomb') {
      const fields = opps.map((s) => {
        const v = d.points[s] ?? '';
        const meldPts = sidesOf(g)[s].reduce((a, pid) => a + Engine.meldValue(d.melds[pid]), 0);
        return `<button class="ofield ${d.active === s ? 'on' : ''}" data-act="opp" data-s="${s}">
          <div class="on-name">${dots(g, s)}${esc(sideName(g, s))}</div>
          <div class="ov ${v === '' ? 'ph' : ''}">${v === '' ? '0' : esc(v)}${meldPts ? `<span class="mb">+${meldPts}</span>` : ''}</div></button>`;
      }).join('');
      const bsx = sideOfPlayer(g, d.bidder);
      const eg = effectiveGot(g, d);
      // Jawne działanie pod polem, żeby było widać odejmowanie od 120.
      const oppCards = opps.reduce((a, s) => a + (Number(d.points[s]) || 0), 0);
      const ownMelds = sidesOf(g)[bsx].reduce((a, pid) => a + Engine.meldValue(d.melds[pid]), 0);
      const gain = Math.max(Number(d.bid) || 0, Engine.roundPts(eg.v, S));
      const calc = eg.how === 'auto'
        ? `120 − ${oppCards}${ownMelds ? ` + ${ownMelds}` : ''} = ${eg.v}`
        : eg.how === 'manual' ? 'wpisane ręcznie' : 'wpisz punkty przeciwników';
      const gotField = d.result === 'made' && S.scoreActual ? `<button class="ofield got ${d.active === 'g' ? 'on' : ''}" data-act="opp" data-s="g">
          <div class="on-name">${dots(g, bsx)}${g.mode === '4x' ? 'ugrali' : esc(pname(d.bidder)) + ' ugrał'}${eg.how === 'auto' ? ' <span class="auto">· auto</span>' : ''}</div>
          <div class="ov ${eg.how === 'bid' ? 'ph' : ''}">${esc(eg.how === 'bid' ? '—' : eg.v)}</div>
          <div class="calc">${calc}</div></button>` : '';
      const gainNote = gotField && eg.how !== 'bid'
        ? `<p class="hint gain">Zapisze się <b>+${gain}</b> ${eg.v > Number(d.bid) ? '– ugrali więcej niż licytacja' : eg.v < Number(d.bid) ? `– mniej niż licytacja, więc liczy się ${esc(d.bid)}` : ''}</p>`
        : '';
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del']
        .map((k) => `<button class="key ${k.length > 1 ? 'fn' : ''}" data-act="key" data-k="${k}">${k === 'del' ? icon('backspace') : k === 'clr' ? 'C' : k}</button>`).join('');
      const meldCount = Object.values(d.melds).flat().length;
      const taken = {};
      for (const pid in d.melds) for (const m of d.melds[pid] || []) taken[m] = pid;
      const meldRows = state.meldsOpen ? g.players.map((pid) => `<div class="meld-row">
          <div class="mn"><i class="dot" style="--pc:${pcolor(pid)}"></i>${esc(pname(pid))}${sideOfPlayer(g, pid) === sideOfPlayer(g, d.bidder) ? ' <small>grający</small>' : ''}</div>
          ${Object.entries(MELDS).map(([k, m]) => {
            const on = (d.melds[pid] || []).includes(k);
            return `<button class="mbtn ${m.red ? 'red' : ''} ${on ? 'on' : ''}" data-act="meld" data-pid="${pid}" data-m="${k}" ${taken[k] && taken[k] !== pid ? 'disabled' : ''}><span class="s">${m.label}</span><span class="v">${m.value}</span></button>`;
          }).join('')}</div>`).join('') + `<p class="hint">Meldunki przeciwników doliczają się do ich punktów. Meldunki grającego ${S.scoreActual ? 'doliczają się do ugranych.' : '– tylko do statystyk.'}</p>` : '';
      pointsHTML = `
        <div class="lbl">${gotField ? 'Punkty' : 'Punkty przeciwników'} <span style="text-transform:none;letter-spacing:0;font-weight:500">· z kart</span></div>
        <div class="opps n${opps.length + (gotField ? 1 : 0)}">${fields}${gotField}</div>
        ${gainNote}
        <div class="keypad">${keys}</div>
        <button class="meld-toggle" data-act="melds-toggle">${state.meldsOpen ? 'Ukryj meldunki' : `Meldunki <span class="s">♠<span class="red-suit">♥</span>♣<span class="red-suit">♦</span></span>`}${meldCount ? ` · ${meldCount}` : ''}</button>
        ${meldRows}`;
    }

    $sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div><h2>${editing ? `Poprawka #${state.editIndex + 1}` : `Rozdanie ${g.rounds.length + 1}`}</h2>
          <div class="sub">${dealer ? `rozdający: ${esc(pname(dealer))}` : ''}</div></div>
        <button class="icon-btn" data-act="close-sheet" aria-label="Zamknij">${icon('x')}</button>
      </div>
      <div class="sheet-body">
        ${d.bidder && d.result && !state.topOpen ? `
        <button class="summary" data-act="expand-top">
          <i class="dot" style="--pc:${pcolor(d.bidder)}"></i><b>${esc(pname(d.bidder))}</b>
          ${d.result === 'bomb' ? '<span class="tagx">bomba</span>' : `<span class="sb">${esc(d.bid)}</span><span class="res-txt ${d.result === 'made' ? 'good' : 'bad'}">${d.result === 'made' ? icon('check') + 'ugrał' : icon('x') + 'nie ugrał'}</span>`}
          <span class="chg">zmień</span></button>` : `
        <div class="lbl">Kto grał</div>
        <div class="pgrid n${n}">${pbtns}</div>
        <div class="lbl">Za ile</div>
        <div class="bidrow">
          <button class="round-btn" data-act="bid-step" data-v="-10" aria-label="Mniej">−</button>
          <div class="bidval">${esc(d.bid)}</div>
          <button class="round-btn" data-act="bid-step" data-v="10" aria-label="Więcej">+</button>
        </div>
        <div class="chips">${chips.join('')}</div>
        <div class="lbl">Wynik</div>
        <div class="results">
          <button class="rbtn ok ${d.result === 'made' ? 'on' : ''}" data-act="result" data-v="made">${icon('check')}Ugrał</button>
          <button class="rbtn ko ${d.result === 'failed' ? 'on' : ''}" data-act="result" data-v="failed">${icon('x')}Nie ugrał</button>
        </div>
        `}
        ${pointsHTML}
      </div>
      <div class="sheet-foot">
        <div class="preview" id="preview">${previewHTML(g, c)}</div>
        <button class="btn-gold" style="width:100%" data-act="save-round" ${d.bidder && d.result ? '' : 'disabled'}>${editing ? 'Zapisz poprawkę' : 'Zapisz rozdanie'}</button>
      </div>`;

    const nb = $sheet.querySelector('.sheet-body');
    if (!first) nb.scrollTop = scroll;
    const nc = $sheet.querySelector('.chips');
    if (!nc) return;
    const on = nc.querySelector('.chip.on');
    if (chipsScroll !== null && !first) nc.scrollLeft = chipsScroll;
    if (on && (first || on.offsetLeft < nc.scrollLeft || on.offsetLeft + on.offsetWidth > nc.scrollLeft + nc.clientWidth)) {
      nc.scrollLeft = on.offsetLeft - nc.clientWidth / 2 + on.offsetWidth / 2;
    }
  }

  function previewHTML(g, c) {
    const d = state.draft;
    if (!d.bidder) return '<span class="muted">Wybierz, kto grał i czy ugrał.</span>';
    if (!d.result) return `<span class="muted">${esc(pname(d.bidder))} za ${esc(d.bid)} – ugrał czy nie?</span>`;
    const row = previewWith(g, d);
    if (!row) return '';
    const bs = sideOfPlayer(g, d.bidder);
    const oppSum = c.sides.reduce((a, _, s) => a + (s !== bs ? Number(d.points[s]) || 0 : 0), 0);
    let warn = d.result !== 'bomb' && oppSum > 120 ? '<span class="warnline">Przeciwnicy mają razem ponad 120 pkt z kart – sprawdź.</span>' : '';
    if (d.result === 'made' && c.settings.scoreActual) {
      const eg = effectiveGot(g, d);
      if (eg.how !== 'bid' && eg.v < Number(d.bid)) warn += `<span class="warnline">Wychodzi ${esc(eg.v)} – mniej niż licytacja ${esc(d.bid)}. Sprawdź punkty albo zaznacz „Nie ugrał”.</span>`;
    }
    return c.sides.map((_, s) => `<span>${esc(g.mode === '4x' ? sidesOf(g)[s].map(pname).join('/') : sideName(g, s))} <b class="${row.deltas[s] < 0 ? 'bad' : row.deltas[s] > 0 ? 'good' : ''}">${row.deltas[s] === 0 ? '0' : signed(row.deltas[s])}</b> <span class="arrow">→</span> <b>${fmt(row.scores[s])}</b>${row.notes[s].length ? ` <span class="note">${row.notes[s].join(', ')}</span>` : ''}</span>`).join('') + warn;
  }

  async function saveRound() {
    const g = game(state.gameId);
    const d = state.draft;
    if (!d || !d.bidder || !d.result) return;
    const bid = Number(d.bid);
    if (d.result !== 'bomb' && (!bid || bid < g.settings.minBid)) return toast('Licytacja musi wynosić co najmniej ' + g.settings.minBid);
    const r = draftRound(g, d);
    r.t = new Date().toISOString();
    let idx;
    if (state.editIndex !== null) {
      idx = state.editIndex;
      const old = g.rounds[idx];
      r.t = old.t || r.t;
      r.dealer = old.dealer;
      g.rounds[idx] = r;
    } else {
      r.dealer = g.players[g.rounds.length % g.players.length];
      g.rounds.push(r);
      idx = g.rounds.length - 1;
    }
    let c = computeGame(g);
    // Poprawka mogła sprawić, że gra skończyła się wcześniej – dalsze rozdania nie mają sensu.
    if (c.winner !== null && c.rows.length < g.rounds.length) {
      if (confirm(`Po tej poprawce gra kończy się na rozdaniu #${c.rows.length}. Usunąć późniejsze rozdania?`)) {
        g.rounds = g.rounds.slice(0, c.rows.length);
      }
      c = computeGame(g);
    }
    if (c.winner !== null) {
      g.status = 'finished';
      g.winner = c.winner;
      g.finished = g.finished || new Date().toISOString();
      setTimeout(() => toast('Wygrywa ' + sideName(g, c.winner) + '!'), 300);
    } else if (g.status === 'finished') {
      g.status = 'active';
      delete g.winner;
      delete g.finished;
    }
    vibrate(15);
    state.draft = null;
    state.editIndex = null;
    state.freshRow = idx;
    closeSheet(true);
    render();
    persistGame(g);
  }

  function keyPress(k) {
    const g = game(state.gameId);
    const d = state.draft;
    if (!d || !d.result || d.result === 'bomb') return;
    const opps = opponentSides(g, d);
    const gotOn = d.result === 'made' && g.settings.scoreActual;
    if (d.active == null || (!opps.includes(d.active) && !(d.active === 'g' && gotOn))) d.active = opps[0];
    let v = (d.active === 'g' ? d.got : d.points[d.active]) ?? '';
    if (k === 'del') v = v.slice(0, -1);
    else if (k === 'clr') v = '';
    else if (v.length < 3) v = (v === '0' ? '' : v) + k;
    if (d.active === 'g') d.got = v; else d.points[d.active] = v;
    renderRoundSheet();
  }

  // ---------- Menu gry ----------
  function openMenu() {
    const g = game(state.gameId);
    const finished = g.status !== 'active';
    state.sheet = 'menu';
    showSheet();
    $sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="sheet-head"><div><h2>Gra</h2><div class="sub">${fmtDateTime(g.created)} · ${g.mode === '4x' ? '4 na krzyż' : '3 osoby'}</div></div>
        <button class="icon-btn" data-act="close-sheet" aria-label="Zamknij">${icon('x')}</button></div>
      <div class="sheet-body"><div class="menu-list">
        <button class="menu-item" data-act="detail"><span class="mi">${icon('chart')}</span><span>Szczegóły i wykres<small>przebieg gry, wszystkie rozdania, licytacje</small></span></button>
        ${finished ? `<button class="menu-item" data-act="rematch"><span class="mi">${icon('repeat')}</span><span>Rewanż<small>ci sami gracze, rozdaje następny</small></span></button>` : ''}
        <button class="menu-item" data-act="new"><span class="mi">${icon('plus')}</span><span>Nowa gra</span></button>
        ${finished ? `<button class="menu-item" data-act="reopen"><span class="mi">${icon('reopen')}</span><span>Wznów grę<small>żeby poprawić lub dograć rozdania</small></span></button>` : `<button class="menu-item" data-act="abandon"><span class="mi">${icon('pause')}</span><span>Przerwij grę<small>nie liczy się do wygranych</small></span></button>`}
        <button class="menu-item danger" data-act="delete"><span class="mi">${icon('trash')}</span><span>Usuń grę</span></button>
      </div></div>
      <div style="height:calc(10px + var(--safe-b))"></div>`;
  }

  // ---------- Szczegóły gry ----------
  function renderDetail() {
    const g = game(state.gameId);
    const c = computeGame(g);
    const S = c.settings;
    const winnerTxt = c.winner !== null ? `wygrali: <b class="gold">${esc(sideName(g, c.winner))}</b>` : g.status === 'abandoned' ? 'przerwana' : 'w trakcie';
    const rules = [
      `do ${S.target}`, `min. ${S.minBid}`, S.scoreActual ? 'grający dostaje ugrane punkty' : 'grający dostaje kwotę licytacji', S.round10 ? 'zaokr. do 10' : 'bez zaokrąglania',
      `bez licytacji max ${c.cap}`,
      S.zeroRule ? `3 zera −${S.zeroPenalty}` : '',
    ].filter(Boolean).join(' · ');

    $app.innerHTML = `
      <button class="back" data-nav="game">${icon('chevronLeft')}Stół</button>
      <div class="page-head"><div><h1 class="title-xl">${g.mode === '4x' ? '4 na krzyż' : 'Gra w 3'}</h1>
        <p>${fmtDateTime(g.created)} · ${g.rounds.length} rozdań · ${winnerTxt}</p></div></div>
      ${g.rounds.length ? `<section class="card"><h3>Przebieg gry</h3>
        <div class="legend">${c.sides.map((_, s) => `<span><i class="dot" style="--pc:${sideColor(g, s)}"></i>${esc(sideName(g, s))}</span>`).join('')}
        <span><i class="dash"></i>limit ${c.cap}</span></div>
        <div class="chart-box"><canvas id="chGame"></canvas></div></section>` : ''}
      <section class="card"><h3>Wszystkie rozdania</h3>
        <p class="muted small" style="margin:-6px 0 8px">Dotknij rozdania, żeby je poprawić.</p>${roundsTable(g, c)}</section>
      ${g.rounds.length ? `<section class="card"><h3>Licytacje w tej grze</h3>${bidSummaryTable([g], g.players)}</section>` : ''}
      <section class="card"><h3>Zasady tej gry</h3><p class="muted small" style="margin:0 0 12px">${rules}</p>
        <label class="check"><input type="checkbox" data-act="toggle-actual" ${S.scoreActual ? 'checked' : ''}> Ugrana licytacja = faktycznie ugrane punkty (szedł 160, ugrał 200 → +200)</label></section>
      <div class="actions" style="justify-content:flex-end">
        <button class="btn sm danger" data-act="delete">Usuń grę</button></div>`;
    if (g.rounds.length) drawGameChart(g, c);
  }

  function roundsTable(g, c) {
    if (!g.rounds.length) return '<p class="muted">Jeszcze nic nie zagrano.</p>';
    const head = `<tr><th>#</th><th style="text-align:left">Licytacja</th>${c.sides.map((_, s) => `<th>${esc(sideName(g, s))}</th>`).join('')}</tr>`;
    const body = c.rows.map((row) => {
      const r = row.round;
      const res = r.type === 'bomb' ? '<span class="tagx">bomba</span>' : r.made ? `<span class="res ok">${icon('check')}</span>` : `<span class="res ko">${icon('x')}</span>`;
      const melds = Object.values(r.melds || {}).flat().map(suit).join('');
      const cells = c.sides.map((_, s) => {
        const dd = row.deltas[s];
        return `<td><b>${fmt(row.scores[s])}</b><span class="d ${dd > 0 ? 'pos' : dd < 0 ? 'neg' : 'zero'}">${dd === 0 ? '0' : signed(dd)}${row.notes[s].length ? ' · ' + row.notes[s].join(', ') : ''}</span></td>`;
      }).join('');
      return `<tr class="click" data-act="edit-round" data-i="${row.index}">
        <td class="muted">${row.index + 1}</td>
        <td style="text-align:left">${esc(pname(r.bidder))} <b>${r.type === 'bomb' ? '' : r.bid}</b> ${res} ${melds}</td>${cells}</tr>`;
    }).reverse().join('');
    return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function drawGameChart(g, c) {
    const labels = ['0', ...c.rows.map((r) => String(r.index + 1))];
    const datasets = c.sides.map((_, s) => ({
      label: sideName(g, s),
      data: [0, ...c.rows.map((r) => r.scores[s])],
      borderColor: sideColor(g, s),
      backgroundColor: sideColor(g, s),
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBorderColor: cssVar('--surface'),
      pointBorderWidth: 2,
      tension: 0,
    }));
    const ref = (v, label) => ({ label, data: labels.map(() => v), borderColor: 'rgba(201,164,92,.55)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, tooltip: false });
    datasets.push(ref(c.cap, 'limit'));
    datasets.push(ref(c.settings.target, 'cel'));
    const opts = baseOpts();
    opts.interaction = { mode: 'index', intersect: false };
    opts.plugins.tooltip.filter = (item) => item.dataset.tooltip !== false;
    opts.scales.x.title = { display: true, text: 'rozdanie', color: cssVar('--muted') };
    mkChart('chGame', { type: 'line', data: { labels, datasets }, options: opts });
  }

  // ---------- Statystyki ----------
  function collectStats(games) {
    const P = {};
    const ensure = (pid) => (P[pid] = P[pid] || {
      id: pid, games: 0, wins: 0, rounds: 0, bids: 0, made: 0, bidSum: 0, maxBid: 0, maxMade: 0, net: 0,
      bombs: 0, melds: { h: 0, d: 0, c: 0, s: 0 }, meldPts: 0, pts: 0, byBid: {},
    });
    const pairs = {};
    const records = { maxMade: null, maxFailed: null, longest: null, shortest: null };

    for (const g of games) {
      const c = computeGame(g);
      const done = g.status === 'finished' && c.winner !== null;
      g.players.forEach(ensure);
      if (done) {
        for (const pid of g.players) {
          P[pid].games++;
          if (c.sides[c.winner].includes(pid)) P[pid].wins++;
        }
        if (g.mode === '4x') {
          c.sides.forEach((side, s) => {
            const key = side.slice().sort().join('|');
            pairs[key] = pairs[key] || { ids: side, games: 0, wins: 0 };
            pairs[key].games++;
            if (s === c.winner) pairs[key].wins++;
          });
        }
        if (!records.longest || c.rows.length > records.longest.n) records.longest = { n: c.rows.length, g };
        if (!records.shortest || c.rows.length < records.shortest.n) records.shortest = { n: c.rows.length, g };
      }
      for (const row of c.rows) {
        const r = row.round;
        c.sides.forEach((side, s) => side.forEach((pid) => {
          P[pid].rounds++;
          P[pid].pts += row.deltas[s];
        }));
        const b = ensure(r.bidder);
        if (r.type === 'bomb') b.bombs++;
        else {
          b.bids++;
          b.bidSum += r.bid;
          b.maxBid = Math.max(b.maxBid, r.bid);
          const k = r.bid;
          b.byBid[k] = b.byBid[k] || { n: 0, made: 0 };
          b.byBid[k].n++;
          if (r.made) {
            b.made++;
            b.net += Engine.bidderGain(r, c.settings);
            b.maxMade = Math.max(b.maxMade, r.bid);
            if (!records.maxMade || r.bid > records.maxMade.bid) records.maxMade = { bid: r.bid, pid: r.bidder, g };
            b.byBid[k].made++;
          } else {
            b.net -= r.bid;
            if (!records.maxFailed || r.bid > records.maxFailed.bid) records.maxFailed = { bid: r.bid, pid: r.bidder, g };
          }
        }
        for (const [pid, ms] of Object.entries(r.melds || {})) {
          const p = ensure(pid);
          for (const m of ms) { p.melds[m]++; p.meldPts += MELDS[m].value; }
        }
      }
    }
    return { P, pairs, records };
  }

  const BUCKETS = [
    { label: '100', lo: 0, hi: 100 },
    { label: '110–120', lo: 110, hi: 120 },
    { label: '130–150', lo: 130, hi: 150 },
    { label: '160–190', lo: 160, hi: 190 },
    { label: '200–240', lo: 200, hi: 240 },
    { label: '250+', lo: 250, hi: Infinity },
  ];

  function bidSummaryTable(games, ids) {
    const { P } = collectStats(games);
    const rows = ids.map((pid) => P[pid]).filter(Boolean);
    return `<div class="table-wrap"><table>
      <thead><tr><th>Gracz</th><th>Licytacje</th><th>Ugrane</th><th>Skuteczność</th><th>Śr. licytacja</th><th>Najwyższa</th><th>Bilans</th><th>Meldunki</th></tr></thead>
      <tbody>${rows.map((p) => `<tr>
        <td><i class="dot" style="--pc:${pcolor(p.id)}"></i> ${esc(pname(p.id))}</td>
        <td>${p.bids}</td><td>${p.made}</td><td>${pct(p.made, p.bids)}</td>
        <td>${p.bids ? Math.round(p.bidSum / p.bids) : '–'}</td><td>${p.maxBid || '–'}</td>
        <td class="${p.net > 0 ? 'good' : p.net < 0 ? 'bad' : ''}">${p.net ? signed(p.net) : '0'}</td>
        <td>${meldStr(p.melds)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function meldStr(m) {
    const s = Object.entries(m).filter(([, n]) => n).map(([k, n]) => `${suit(k)}${n > 1 ? '×' + n : ''}`).join(' ');
    return s || '–';
  }

  function filteredGames() {
    const f = state.stats;
    const since = f.period === 'all' ? 0 : Date.now() - Number(f.period) * 86400000;
    return state.db.games
      .filter((g) => (f.mode === 'all' || g.mode === f.mode) && new Date(g.created).getTime() >= since)
      .sort((a, b) => a.created.localeCompare(b.created));
  }

  function renderStats() {
    const f = state.stats;
    const games = filteredGames();
    const { P, pairs, records } = collectStats(games);
    const ids = activePlayers().map((p) => p.id).filter((id) => P[id] && P[id].rounds > 0);
    const finished = games.filter((g) => g.status === 'finished');
    const totalRounds = games.reduce((a, g) => a + g.rounds.length, 0);
    const allBids = ids.reduce((a, id) => a + P[id].bids, 0);
    const allMade = ids.reduce((a, id) => a + P[id].made, 0);
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-act="sf" data-k="${key}" data-v="${v}" class="${f[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;

    const head = `<div class="page-head"><div><div class="eyebrow">Analiza</div><h1 class="title-xl">Statystyki</h1></div></div>
      <div class="filters">
        ${seg('mode', [['all', 'Wszystkie'], ['4x', 'Na krzyż'], ['3', 'W 3']])}
        ${seg('period', [['30', '30 dni'], ['90', '3 mies.'], ['365', 'Rok'], ['all', 'Całość']])}
      </div>`;

    if (!ids.length) {
      $app.innerHTML = `${head}<div class="card empty"><div class="suits">♠ <span class="red-suit">♥</span> ♣ <span class="red-suit">♦</span></div>Brak rozegranych rozdań w wybranym okresie.</div>`;
      return;
    }

    const legend = `<div class="legend">${ids.map((id) => `<span><i class="dot" style="--pc:${pcolor(id)}"></i>${esc(pname(id))}</span>`).join('')}</div>`;
    const sortedByWins = ids.slice().sort((a, b) => (P[b].wins - P[a].wins) || (P[b].wins / (P[b].games || 1) - P[a].wins / (P[a].games || 1)));
    const recordLine = (label, r, text) => r ? `<tr><td>${label}</td><td style="text-align:left">${text}</td><td class="muted">${fmtDate(r.g.created)}</td></tr>` : '';
    const pairRows = Object.values(pairs).sort((a, b) => b.wins - a.wins || b.games - a.games);

    $app.innerHTML = `
      ${head}
      <div class="kpis">
        <div class="kpi"><div class="v">${finished.length}</div><div class="l">rozegranych gier</div></div>
        <div class="kpi"><div class="v">${fmt(totalRounds)}</div><div class="l">rozdań</div></div>
        <div class="kpi"><div class="v">${pct(allMade, allBids)}</div><div class="l">licytacji ugranych</div></div>
        <div class="kpi"><div class="v">${allBids ? Math.round(ids.reduce((a, id) => a + P[id].bidSum, 0) / allBids) : '–'}</div><div class="l">średnia licytacja</div></div>
      </div>

      <section class="card">
        <h3>Ranking graczy</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Gracz</th><th>Gry</th><th>Wygrane</th><th>% wygr.</th><th>Rozdania</th><th>Śr. pkt / rozdanie</th></tr></thead>
          <tbody>${sortedByWins.map((id, i) => { const p = P[id]; return `<tr>
            <td><span class="rank ${i === 0 && p.wins ? 'r1' : ''}">${i + 1}</span><i class="dot" style="--pc:${pcolor(id)}"></i> <b>${esc(pname(id))}</b></td>
            <td>${p.games}</td><td><b>${p.wins}</b></td><td>${pct(p.wins, p.games)}</td><td>${p.rounds}</td>
            <td>${p.rounds ? Math.round(p.pts / p.rounds) : '–'}</td></tr>`; }).join('')}</tbody>
        </table></div>
        <p class="muted small" style="margin:8px 0 0">W grze na krzyż punkty pary liczą się obu partnerom.</p>
      </section>

      <div class="grid-2">
        <section class="card"><h3>Wygrane gry</h3><div class="chart-box"><canvas id="chWins"></canvas></div></section>
        <section class="card"><h3>Skuteczność licytacji</h3><div class="chart-box"><canvas id="chSucc"></canvas></div></section>
      </div>

      <section class="card"><h3>Wygrane w czasie</h3>${legend}<div class="chart-box tall"><canvas id="chTime"></canvas></div></section>

      <section class="card"><h3>Licytacje – kto ile szedł</h3>
        ${bidSummaryTable(games, ids)}
        <h3 style="margin-top:20px">Ile razy i za ile <span class="muted small" style="font-weight:500">ugrane / wszystkie</span></h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Gracz</th>${BUCKETS.map((b) => `<th class="heat">${b.label}</th>`).join('')}</tr></thead>
          <tbody>${ids.map((id) => `<tr><td><i class="dot" style="--pc:${pcolor(id)}"></i> ${esc(pname(id))}</td>${BUCKETS.map((b) => {
            let n = 0, m = 0;
            for (const [k, v] of Object.entries(P[id].byBid)) if (+k >= b.lo && +k <= b.hi) { n += v.n; m += v.made; }
            return `<td class="heat">${n ? `${m}/${n}` : '<span class="muted">–</span>'}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </section>

      <section class="card"><h3>Rozkład licytacji</h3>
        <div class="legend"><span><i class="dot" style="--pc:var(--chart-good)"></i>ugrane</span><span><i class="dot" style="--pc:var(--chart-bad)"></i>nieugrane</span></div>
        <div class="chart-box"><canvas id="chBids"></canvas></div></section>

      <div class="grid-2">
        <section class="card"><h3>Meldunki</h3>
          <div class="table-wrap"><table><thead><tr><th>Gracz</th>${Object.keys(MELDS).map((k) => `<th>${suit(k)} ${MELDS[k].value}</th>`).join('')}<th>Razem</th></tr></thead>
          <tbody>${ids.map((id) => `<tr><td>${esc(pname(id))}</td>${Object.keys(MELDS).map((k) => `<td>${P[id].melds[k]}</td>`).join('')}<td><b>${fmt(P[id].meldPts)}</b></td></tr>`).join('')}</tbody></table></div>
        </section>
        <section class="card"><h3>Rekordy</h3>
          <div class="table-wrap"><table><tbody>
            ${recordLine('Najwyższa ugrana', records.maxMade, records.maxMade && `<b class="gold">${records.maxMade.bid}</b> – ${esc(pname(records.maxMade.pid))}`)}
            ${recordLine('Najwyższa nieugrana', records.maxFailed, records.maxFailed && `<b>${records.maxFailed.bid}</b> – ${esc(pname(records.maxFailed.pid))}`)}
            ${recordLine('Najdłuższa gra', records.longest, records.longest && `<b>${records.longest.n}</b> rozdań`)}
            ${recordLine('Najkrótsza gra', records.shortest, records.shortest && `<b>${records.shortest.n}</b> rozdań`)}
          </tbody></table></div>
        </section>
      </div>

      ${pairRows.length ? `<section class="card"><h3>Pary (4 na krzyż)</h3>
        <div class="table-wrap"><table><thead><tr><th>Para</th><th>Gry</th><th>Wygrane</th><th>% wygr.</th></tr></thead>
        <tbody>${pairRows.map((p) => `<tr><td>${p.ids.map((id) => esc(pname(id))).join(' & ')}</td><td>${p.games}</td><td><b>${p.wins}</b></td><td>${pct(p.wins, p.games)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    `;

    drawStatsCharts(games, P, ids, sortedByWins);
  }

  function drawStatsCharts(games, P, ids, sortedByWins) {
    // Wygrane
    {
      const opts = baseOpts();
      opts.indexAxis = 'y';
      swapAxes(opts);
      opts.scales.x.ticks.precision = 0;
      mkChart('chWins', {
        type: 'bar',
        data: { labels: sortedByWins.map(pname), datasets: [{ label: 'Wygrane', data: sortedByWins.map((id) => P[id].wins), backgroundColor: sortedByWins.map(pcolor), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26 }] },
        options: opts,
      });
    }
    // Skuteczność
    {
      const order = ids.filter((id) => P[id].bids).sort((a, b) => P[b].made / P[b].bids - P[a].made / P[a].bids);
      const opts = baseOpts();
      opts.indexAxis = 'y';
      swapAxes(opts);
      opts.scales.x.max = 100;
      opts.scales.x.ticks.callback = (v) => v + '%';
      opts.plugins.tooltip.callbacks = { label: (ctx) => { const p = P[order[ctx.dataIndex]]; return ` ${Math.round(ctx.raw)}% (${p.made}/${p.bids})`; } };
      mkChart('chSucc', {
        type: 'bar',
        data: { labels: order.map(pname), datasets: [{ data: order.map((id) => (P[id].made / P[id].bids) * 100), backgroundColor: order.map(pcolor), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26 }] },
        options: opts,
      });
    }
    // Wygrane w czasie (narastająco)
    {
      const done = games.filter((g) => g.status === 'finished');
      const acc = Object.fromEntries(ids.map((id) => [id, 0]));
      const series = Object.fromEntries(ids.map((id) => [id, [0]]));
      const labels = ['start'];
      for (const g of done) {
        const c = computeGame(g);
        if (c.winner === null) continue;
        for (const pid of c.sides[c.winner]) if (pid in acc) acc[pid]++;
        for (const id of ids) series[id].push(acc[id]);
        labels.push(fmtDate(g.created));
      }
      const opts = baseOpts();
      opts.interaction = { mode: 'index', intersect: false };
      opts.scales.y.ticks.precision = 0;
      opts.scales.x.ticks.maxTicksLimit = 8;
      mkChart('chTime', {
        type: 'line',
        data: { labels, datasets: ids.map((id) => ({ label: pname(id), data: series[id], borderColor: pcolor(id), backgroundColor: pcolor(id), borderWidth: 2, pointRadius: labels.length > 30 ? 0 : 3, pointHoverRadius: 5, pointBorderColor: cssVar('--surface'), pointBorderWidth: 2, stepped: true })) },
        options: opts,
      });
    }
    // Rozkład licytacji
    {
      const all = {};
      for (const id of ids) for (const [k, v] of Object.entries(P[id].byBid)) {
        all[k] = all[k] || { n: 0, made: 0 };
        all[k].n += v.n;
        all[k].made += v.made;
      }
      const keys = Object.keys(all).map(Number).sort((a, b) => a - b);
      const opts = baseOpts();
      opts.scales.x.stacked = true;
      opts.scales.y.stacked = true;
      opts.scales.y.ticks.precision = 0;
      opts.interaction = { mode: 'index', intersect: false };
      const gap = cssVar('--surface');
      mkChart('chBids', {
        type: 'bar',
        data: {
          labels: keys.map(String),
          datasets: [
            { label: 'ugrane', data: keys.map((k) => all[k].made), backgroundColor: cssVar('--chart-good'), borderColor: gap, borderWidth: { top: 2 }, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 34 },
            { label: 'nieugrane', data: keys.map((k) => all[k].n - all[k].made), backgroundColor: cssVar('--chart-bad'), borderColor: gap, borderWidth: { bottom: 2 }, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 34 },
          ],
        },
        options: opts,
      });
    }
  }

  // ---------- Wykresy ----------
  function baseOpts() {
    const muted = cssVar('--muted');
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#f4efe2', titleColor: '#14110a', bodyColor: '#14110a', padding: 10, boxPadding: 4, usePointStyle: true, cornerRadius: 10 },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: muted }, border: { color: cssVar('--axis') } },
        y: { grid: { color: cssVar('--grid') }, ticks: { color: muted }, border: { display: false } },
      },
    };
  }
  function swapAxes(opts) {
    const { x, y } = opts.scales;
    opts.scales = { x: Object.assign({}, y, { ticks: Object.assign({}, y.ticks) }), y: Object.assign({}, x, { ticks: Object.assign({}, x.ticks, { color: cssVar('--ink-2') }) }) };
    opts.scales.x.beginAtZero = true;
  }
  function mkChart(id, config) {
    const el = document.getElementById(id);
    if (!el || !window.Chart) return;
    if (charts[id]) charts[id].destroy();
    Chart.defaults.font.family = cssVar('--sans');
    charts[id] = new Chart(el, config);
  }

  // ---------- Historia ----------
  function renderHistory() {
    const list = state.db.games
      .filter((g) => state.historyMode === 'all' || g.mode === state.historyMode)
      .sort((a, b) => b.created.localeCompare(a.created));
    const seg = [['all', 'Wszystkie'], ['4x', 'Na krzyż'], ['3', 'W 3']]
      .map(([v, l]) => `<button data-act="hm" data-v="${v}" class="${state.historyMode === v ? 'on' : ''}">${l}</button>`).join('');
    $app.innerHTML = `
      <div class="page-head"><div><div class="eyebrow">Archiwum</div><h1 class="title-xl">Historia gier</h1></div><div class="seg">${seg}</div></div>
      ${list.length ? list.map(gameCard).join('') : '<div class="card empty">Brak gier.</div>'}
      <section class="card" style="margin-top:18px">
        <h3>Gracze</h3>
        <div class="plist">${activePlayers().map((p) => {
          const n = state.db.games.filter((g) => g.players.includes(p.id)).length;
          return `<div class="prow"><i class="dot" style="--pc:${pcolor(p.id)}"></i><span class="pn">${esc(withFlag(p.name))}</span>
            <span class="muted small">${n} ${n === 1 ? 'gra' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'gry' : 'gier'}</span>
            <button class="icon-btn sm" data-act="rename" data-pid="${p.id}" aria-label="Zmień imię">${icon('pencil')}</button>
            <button class="icon-btn sm danger" data-act="del-player" data-pid="${p.id}" aria-label="Usuń gracza">${icon('trash')}</button></div>`;
        }).join('') || '<span class="muted">Brak graczy</span>'}</div>
        <p class="muted small" style="margin:10px 0 0">Usunięty gracz znika z list i statystyk. Jego rozegrane gry zostają w historii, a gdy kiedyś wróci – wystarczy wpisać to samo imię.</p>
      </section>
      <section class="card">
        <h3>Dostęp</h3>
        <div class="row" style="justify-content:space-between;margin-bottom:12px">
          <span class="muted small">Jedno wspólne hasło do stołu dla wszystkich graczy.</span>
          <button class="btn sm" data-act="logout">${icon('logout')}Wyloguj</button></div>
        <details class="rules"><summary>Zmień hasło do stołu</summary>
          <p class="muted small" style="margin:6px 0 0">Do zmiany potrzebne jest hasło administratora. Po zmianie wszystkie inne telefony zostaną wylogowane – podaj graczom nowe hasło.</p>
          <form id="pwForm" class="pw-form">
            <input type="text" name="username" value="tysiac" autocomplete="username" hidden>
            <label class="seat"><span>Hasło administratora</span><input type="password" name="admin" autocomplete="off" required></label>
            <label class="seat"><span>Nowe hasło (min. 8 znaków)</span><input type="password" name="new1" autocomplete="new-password" required minlength="8"></label>
            <label class="seat"><span>Powtórz nowe hasło</span><input type="password" name="new2" autocomplete="new-password" required minlength="8"></label>
            <div class="login-err"></div>
            <button class="btn gold" type="submit">Zapisz nowe hasło</button>
          </form></details>
      </section>
      <section class="card">
        <h3>Kopia danych</h3>
        <p class="muted small" style="margin:-4px 0 12px">Wyniki są w pliku <code>data/db.json</code> na serwerze, a serwer codziennie robi kopię w <code>data/backups/</code>.</p>
        <a class="btn sm" href="api.php?action=export">${icon('download')}Pobierz JSON</a>
      </section>`;
  }


  // ---------- Ruletka (dla zabawy, wirtualne żetony trzymane w telefonie) ----------
  const LS_RL = 'tys_roulette';
  const RL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const RL_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const RL_START = 1000;
  const RL_CHIPS = [10, 25, 100, 500];
  const RL_SPIN_MS = 5200;
  const RL_BETS = {
    red: { label: 'Czerwone', pay: 1, win: (n) => RL_RED.has(n) },
    black: { label: 'Czarne', pay: 1, win: (n) => n > 0 && !RL_RED.has(n) },
    even: { label: 'Parzyste', pay: 1, win: (n) => n > 0 && n % 2 === 0 },
    odd: { label: 'Nieparzyste', pay: 1, win: (n) => n % 2 === 1 },
    low: { label: '1–18', pay: 1, win: (n) => n >= 1 && n <= 18 },
    high: { label: '19–36', pay: 1, win: (n) => n >= 19 },
    d1: { label: '1–12', pay: 2, win: (n) => n >= 1 && n <= 12 },
    d2: { label: '13–24', pay: 2, win: (n) => n >= 13 && n <= 24 },
    d3: { label: '25–36', pay: 2, win: (n) => n >= 25 },
  };
  const rl = {
    data: Object.assign({ balance: RL_START, hist: [] }, lsGet(LS_RL, {})),
    bets: {}, lastBets: null, chip: 25, rot: 0, ballRot: 0, spinning: false, result: null,
  };
  const rlColor = (n) => (n === 0 ? 'green' : RL_RED.has(n) ? 'red' : 'black');
  const rlStaked = () => Object.values(rl.bets).reduce((a, v) => a + v, 0);
  const rlBetWins = (key, n) => (key.startsWith('n') ? Number(key.slice(1)) === n : RL_BETS[key].win(n));
  const rlBetPay = (key) => (key.startsWith('n') ? 35 : RL_BETS[key].pay);
  function rlSave() { lsSet(LS_RL, rl.data); }
  function rlRandom() {
    const a = new Uint32Array(1);
    // Odrzucanie próbek eliminuje przewagę niektórych liczb przy modulo.
    const lim = Math.floor(0x100000000 / 37) * 37;
    do { crypto.getRandomValues(a); } while (a[0] >= lim);
    return a[0] % 37;
  }

  function wheelSVG() {
    const step = 360 / 37;
    const pt = (r, deg) => { const a = (deg * Math.PI) / 180; return [(r * Math.sin(a)).toFixed(2), (-r * Math.cos(a)).toFixed(2)]; };
    const fill = { red: '#b3261e', black: '#141414', green: '#0f7a43' };
    const pockets = RL_ORDER.map((n, i) => {
      const a0 = (i - 0.5) * step, a1 = (i + 0.5) * step;
      const [x0, y0] = pt(148, a0), [x1, y1] = pt(148, a1), [x2, y2] = pt(104, a1), [x3, y3] = pt(104, a0);
      const [tx, ty] = pt(130, i * step);
      return `<path d="M${x0} ${y0} A148 148 0 0 1 ${x1} ${y1} L${x2} ${y2} A104 104 0 0 0 ${x3} ${y3}Z" fill="${fill[rlColor(n)]}" stroke="#c9a45c" stroke-width=".6"/>
        <text x="${tx}" y="${ty}" transform="rotate(${(i * step).toFixed(2)} ${tx} ${ty})" class="wn">${n}</text>`;
    }).join('');
    const spokes = [0, 90, 180, 270].map((d) => { const [x, y] = pt(60, d); return `<line x1="0" y1="0" x2="${x}" y2="${y}" stroke="#c9a45c" stroke-width="5" stroke-linecap="round"/>`; }).join('');
    return `<svg viewBox="-170 -170 340 340" class="wheel-svg" aria-label="Koło ruletki">
      <defs>
        <radialGradient id="wood" cx="50%" cy="50%" r="50%"><stop offset="70%" stop-color="#3a2412"/><stop offset="100%" stop-color="#1c1108"/></radialGradient>
        <radialGradient id="cone" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="#2b4d3f"/><stop offset="100%" stop-color="#0c2219"/></radialGradient>
      </defs>
      <circle r="168" fill="url(#wood)"/>
      <circle r="160" fill="none" stroke="#c9a45c" stroke-width="2" opacity=".7"/>
      <g class="wheel-rot" style="transform:rotate(${rl.rot}deg)">
        ${pockets}
        <circle r="104" fill="url(#cone)" stroke="#c9a45c" stroke-width="1.5"/>
        <circle r="70" fill="none" stroke="rgba(201,164,92,.35)" stroke-width="1"/>
        ${spokes}
        <circle r="16" fill="#c9a45c"/><circle r="7" fill="#f1dca6"/>
      </g>
      <g class="ball-rot" style="transform:rotate(${rl.ballRot}deg)">
        <circle r="158" fill="none"/>
        <circle class="ball ${rl.spinning ? '' : 'in'}" cx="0" cy="-156" r="7"/>
      </g>
      <path d="M0 -150 L-9 -168 L9 -168Z" fill="#e6cc8f" stroke="#1b1508" stroke-width="1"/>
    </svg>`;
  }

  function renderRoulette() {
    const staked = rlStaked();
    const free = rl.data.balance - staked;
    const res = rl.result;
    const chipBadge = (key) => (rl.bets[key] ? `<span class="rchip">${fmt(rl.bets[key])}</span>` : '');
    const resultHTML = res
      ? `<div class="rl-result"><span class="rnum ${rlColor(res.n)}">${res.n}</span>
          <div><div class="rl-rtitle">${res.n === 0 ? 'Zero' : (RL_RED.has(res.n) ? 'Czerwone' : 'Czarne') + ' · ' + (res.n % 2 ? 'nieparzyste' : 'parzyste')}</div>
          <div class="${res.net > 0 ? 'good' : res.net < 0 ? 'bad' : 'muted'}">${!res.staked ? 'Bez zakładu' : res.net > 0 ? `Wygrana +${fmt(res.net)}` : res.net < 0 ? `Przegrana −${fmt(-res.net)}` : 'Wyszło na zero'}</div></div></div>`
      : '<div class="rl-result muted">Postaw żetony i zakręć kołem.</div>';

    $app.innerHTML = `
      <div class="page-head" style="margin-bottom:8px"><div><div class="eyebrow">Na nudę</div><h1 class="title-xl">Ruletka</h1></div>
        <div class="rl-balance"><span class="muted small">żetony</span><b>${fmt(free)}</b></div></div>
      <div class="wheel-wrap">${wheelSVG()}</div>
      ${resultHTML}
      <div class="rl-hist">${rl.data.hist.slice(0, 14).map((n) => `<span class="rnum sm ${rlColor(n)}">${n}</span>`).join('')}</div>
      <div class="rl-chips">${RL_CHIPS.map((v) => `<button class="pchip c${v} ${rl.chip === v ? 'on' : ''}" data-act="rl-chip" data-v="${v}">${v}</button>`).join('')}</div>
      <div class="rl-board">
        <div class="rl-outside">${['red', 'black', 'even', 'odd', 'low', 'high'].map((k) => `<button class="rcell out ${k}" data-act="rl-bet" data-k="${k}">${RL_BETS[k].label}${chipBadge(k)}</button>`).join('')}</div>
        <div class="rl-dozens">${['d1', 'd2', 'd3'].map((k) => `<button class="rcell out" data-act="rl-bet" data-k="${k}">${RL_BETS[k].label} <small>2:1</small>${chipBadge(k)}</button>`).join('')}</div>
        <button class="rcell zero" data-act="rl-bet" data-k="n0">0${chipBadge('n0')}</button>
        <div class="rl-nums">${Array.from({ length: 36 }, (_, i) => i + 1).map((n) => `<button class="rcell num ${rlColor(n)}" data-act="rl-bet" data-k="n${n}">${n}${chipBadge('n' + n)}</button>`).join('')}</div>
      </div>
      <div class="rl-actions">
        <button class="btn sm" data-act="rl-clear" ${staked && !rl.spinning ? '' : 'disabled'}>${icon('eraser')}Wyczyść</button>
        <button class="btn sm" data-act="rl-repeat" ${rl.lastBets && !staked && !rl.spinning ? '' : 'disabled'}>${icon('repeat')}Powtórz zakład</button>
        <button class="btn sm" data-act="rl-double" ${staked && !rl.spinning && free >= staked ? '' : 'disabled'}>Podwój</button>
        ${rl.data.balance < RL_CHIPS[0] ? '<button class="btn sm gold" data-act="rl-refill">Doładuj 1000</button>' : ''}
      </div>
      <p class="muted small" style="text-align:center;margin:14px 0 0">Gra dla zabawy – żetony są wirtualne i zapisują się tylko w tym telefonie.<br>Proste zakłady 1:1, tuziny 2:1, pojedyncza liczba 35:1.</p>`;
    setCta(`<button class="btn-gold" data-act="rl-spin" ${rl.spinning ? 'disabled' : ''}>${rl.spinning ? 'Kręci się…' : `Zakręć ${staked ? `· stawka ${fmt(staked)}` : ''}`}</button>`);
  }

  function rlBet(key) {
    if (rl.spinning) return;
    const free = rl.data.balance - rlStaked();
    if (free < rl.chip) return toast(free > 0 ? 'Za mało żetonów – wybierz mniejszy żeton' : 'Brak żetonów');
    rl.bets[key] = (rl.bets[key] || 0) + rl.chip;
    vibrate(5);
    renderRoulette();
  }

  function rlSpin() {
    if (rl.spinning) return;
    const staked = rlStaked();
    if (staked > rl.data.balance) return toast('Za mało żetonów');
    const n = rlRandom();
    const step = 360 / 37;
    const idx = RL_ORDER.indexOf(n);
    const jitter = (Math.random() - 0.5) * step * 0.6;
    // Koło kręci się w prawo i zatrzymuje wylosowaną kieszeń pod wskaźnikiem; kulka biegnie w lewo.
    const base = rl.rot - (((rl.rot % 360) + 360) % 360);
    const targetRot = base + 360 * 6 + ((360 - idx * step - jitter) % 360 + 360) % 360;
    rl.spinning = true;
    rl.result = null;
    const bets = rl.bets;
    renderRoulette();  // rysuje koło w starym położeniu, animacja startuje poniżej
    rl.rot = targetRot;
    rl.ballRot -= 360 * 5;
    const wheel = $app.querySelector('.wheel-rot');
    const ballG = $app.querySelector('.ball-rot');
    const ball = $app.querySelector('.ball');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wheel.classList.add('spin');
      ballG.classList.add('spin');
      wheel.style.transform = `rotate(${rl.rot}deg)`;
      ballG.style.transform = `rotate(${rl.ballRot}deg)`;
      setTimeout(() => ball.classList.add('in'), RL_SPIN_MS - 1400);
    }));
    setTimeout(() => {
      let win = 0;
      for (const [k, v] of Object.entries(bets)) if (rlBetWins(k, n)) win += v * (rlBetPay(k) + 1);
      rl.data.balance += win - staked;
      rl.data.hist.unshift(n);
      rl.data.hist = rl.data.hist.slice(0, 50);
      rlSave();
      rl.lastBets = Object.keys(bets).length ? bets : rl.lastBets;
      rl.bets = {};
      rl.result = { n, staked, net: win - staked };
      rl.spinning = false;
      vibrate(win > staked ? [20, 40, 20] : 15);
      if (state.view === 'roulette') renderRoulette();
    }, RL_SPIN_MS + 150);
  }

  // ---------- Obsługa zdarzeń ----------
  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { go(nav.dataset.nav); return; }
    if (e.target === $backdrop) { closeSheet(); return; }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    const g = state.gameId ? game(state.gameId) : null;
    const d = state.draft;

    switch (act) {
      case 'ng-mode': {
        const mode = el.dataset.mode;
        const last = lastPlayersFor(mode);
        state.newGame.mode = mode;
        state.newGame.names = last.length ? last : state.newGame.names.slice(0, mode === '4x' ? 4 : 3);
        render();
        break;
      }
      case 'qp': {
        const seats = state.newGame.mode === '4x' ? 4 : 3;
        const i = Array.from({ length: seats }, (_, k) => k).find((k) => !(state.newGame.names[k] || '').trim());
        if (i === undefined) return toast('Wszystkie miejsca zajęte');
        state.newGame.names[i] = el.dataset.name;
        render();
        break;
      }
      case 'ng-start': startGame(); break;
      case 'open': go('game', el.dataset.id); break;
      case 'new': state.newGame = null; go('game', null); break;
      case 'add': openRoundSheet(); break;
      case 'menu': openMenu(); break;
      case 'close-sheet': closeSheet(); break;
      case 'detail': state.view = 'detail'; closeSheet(true); render(); window.scrollTo(0, 0); break;
      case 'toggle-actual':
        g.settings.scoreActual = el.checked;
        render();
        persistGame(g);
        toast(el.checked ? 'Grający dostaje ugrane punkty' : 'Grający dostaje kwotę licytacji');
        break;
      case 'log-all': state.logAll = !state.logAll; render(); break;
      case 'bidder': {
        d.bidder = el.dataset.pid;
        // Punkty wpisane wcześniej dla nowej strony grającego tracą sens.
        delete d.points[sideOfPlayer(g, d.bidder)];
        const opps = opponentSides(g, d);
        if (!opps.includes(d.active)) d.active = opps[0];
        if (d.result) state.topOpen = false;
        renderRoundSheet();
        break;
      }
      case 'bid': d.bid = Number(el.dataset.v); renderRoundSheet(); break;
      case 'bid-step': d.bid = Math.max(g.settings.minBid, (Number(d.bid) || 0) + Number(el.dataset.v)); renderRoundSheet(); break;
      case 'expand-top': state.topOpen = true; renderRoundSheet(); break;
      case 'result':
        d.result = el.dataset.v;
        if (d.bidder) state.topOpen = false;
        if (d.result !== 'bomb' && d.active == null && d.bidder) d.active = opponentSides(g, d)[0];
        renderRoundSheet();
        $sheet.querySelector('.sheet-body').scrollTop = 0;
        break;
      case 'opp': d.active = el.dataset.s === 'g' ? 'g' : Number(el.dataset.s); renderRoundSheet(); break;
      case 'key': keyPress(el.dataset.k); break;
      case 'melds-toggle': state.meldsOpen = !state.meldsOpen; renderRoundSheet(); break;
      case 'meld': {
        const pid = el.dataset.pid, m = el.dataset.m;
        const list = d.melds[pid] = d.melds[pid] || [];
        const i = list.indexOf(m);
        if (i >= 0) list.splice(i, 1); else list.push(m);
        renderRoundSheet();
        break;
      }
      case 'save-round': saveRound(); break;
      case 'edit-round': openRoundSheet(Number(el.dataset.i)); break;
      case 'undo': {
        const removed = g.rounds.pop();
        const n = g.rounds.length + 1;
        state.draft = null;
        state.editIndex = null;
        render();
        persistGame(g);
        vibrate(10);
        toast(`Cofnięto rozdanie ${n}`, 'Przywróć', () => {
          g.rounds.push(removed);
          const c = computeGame(g);
          if (c.winner !== null) { g.status = 'finished'; g.winner = c.winner; g.finished = g.finished || new Date().toISOString(); }
          render();
          persistGame(g);
        });
        break;
      }
      case 'abandon':
        if (!confirm('Przerwać grę? Nie będzie liczona do wygranych (licytacje zostaną w statystykach).')) return;
        g.status = 'abandoned';
        closeSheet(true);
        render();
        persistGame(g);
        break;
      case 'reopen':
        g.status = 'active';
        delete g.winner;
        delete g.finished;
        closeSheet(true);
        render();
        persistGame(g);
        break;
      case 'rematch': {
        const ng = { id: uid('g'), mode: g.mode, players: g.players.slice(), settings: Object.assign({}, g.settings), rounds: [], status: 'active', created: new Date().toISOString() };
        // Przesunięcie kolejności, żeby rozdawał następny gracz.
        ng.players.push(ng.players.shift());
        state.db.games.push(ng);
        persistGame(ng);
        go('game', ng.id);
        break;
      }
      case 'delete':
        if (!confirm('Na pewno usunąć całą grę? Tego nie da się cofnąć.')) return;
        try {
          await write('deleteGame', { id: g.id });
          state.db.games = state.db.games.filter((x) => x.id !== g.id);
          cacheDb();
          toast('Gra usunięta');
          go('history', null);
        } catch (err) {
          toast('Nie udało się usunąć: ' + err.message);
        }
        break;
      case 'logout': logout(); break;
      case 'hm': state.historyMode = el.dataset.v; render(); break;
      case 'sf': state.stats[el.dataset.k] = el.dataset.v; lsSet(LS_STATS, state.stats); render(); break;
      case 'del-player': {
        const p = player(el.dataset.pid);
        if (state.db.games.some((g) => g.status === 'active' && g.players.includes(p.id))) return toast('Gracz jest w trwającej grze – najpierw ją zakończ lub przerwij');
        if (!confirm(`Usunąć gracza ${p.name}? Zniknie z list i statystyk, jego gry zostaną w historii.`)) return;
        p.deleted = true;
        cacheDb();
        render();
        const saveP = async () => { try { await write('savePlayers', { players: [p] }); } catch (err) { toast('Nie zapisano: ' + err.message); } };
        await saveP();
        toast(`Usunięto: ${p.name}`, 'Cofnij', async () => { p.deleted = false; cacheDb(); render(); await saveP(); });
        break;
      }
      case 'rl-chip': rl.chip = Number(el.dataset.v); renderRoulette(); break;
      case 'rl-bet': rlBet(el.dataset.k); break;
      case 'rl-spin': rlSpin(); break;
      case 'rl-clear': rl.bets = {}; renderRoulette(); break;
      case 'rl-repeat': {
        const total = Object.values(rl.lastBets || {}).reduce((a, v) => a + v, 0);
        if (total > rl.data.balance) return toast('Za mało żetonów na powtórkę');
        rl.bets = Object.assign({}, rl.lastBets);
        renderRoulette();
        break;
      }
      case 'rl-double':
        for (const k in rl.bets) rl.bets[k] *= 2;
        renderRoulette();
        break;
      case 'rl-refill': rl.data.balance = RL_START; rlSave(); toast('Doładowano 1000 żetonów'); renderRoulette(); break;
      case 'rename': {
        const p = player(el.dataset.pid);
        const name = (prompt('Nowe imię:', p.name) || '').trim();
        if (!name || name === p.name) return;
        if (state.db.players.some((x) => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) return toast('Takie imię już istnieje');
        p.name = name.slice(0, 30);
        cacheDb();
        render();
        try { await write('savePlayers', { players: [p] }); } catch (err) { toast('Nie zapisano: ' + err.message); }
        break;
      }
    }
  });

  $app.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.seat !== undefined) {
      state.newGame.names[Number(el.dataset.seat)] = el.value;
    } else if (el.dataset.set !== undefined) {
      state.newGame.settings[el.dataset.set] = el.type === 'checkbox' ? el.checked : Number(el.value) || 0;
    }
  });
  $app.addEventListener('change', (e) => {
    if (e.target.dataset.set !== undefined && e.target.type === 'checkbox') state.newGame.settings[e.target.dataset.set] = e.target.checked;
    // Po wybraniu imienia odśwież podpowiedzi graczy.
    if (e.target.dataset.seat !== undefined) render();
  });

  $app.addEventListener('submit', (e) => {
    if (e.target.id === 'pwForm') { e.preventDefault(); changePassword(e.target); }
  });

  // Klawiatura fizyczna w arkuszu rozdania (komputer / tablet z klawiaturą).
  document.addEventListener('keydown', (e) => {
    if (!state.sheet) return;
    if (e.key === 'Escape') return closeSheet();
    if (state.sheet !== 'round') return;
    if (/^[0-9]$/.test(e.key)) { keyPress(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { keyPress('del'); e.preventDefault(); }
    else if (e.key === 'Enter') { saveRound(); e.preventDefault(); }
  });

  // ---------- Start ----------
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // Dwuklik nie powiększa strony; drugie szybkie stuknięcie i tak działa jak zwykłe kliknięcie (np. „11” na klawiaturze).
  let lastTap = 0, tapX = 0, tapY = 0, moved = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    tapX = t.clientX; tapY = t.clientY; moved = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10) moved = true;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (!moved && now - lastTap < 400 && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      const el = e.target.closest('button, a, label, [data-act], [data-nav]');
      if (el && !el.disabled) el.click();
    }
    if (!moved) lastTap = now;
  }, { passive: false });
  window.addEventListener('online', () => state.user && flushPending());
  setInterval(() => state.user && flushPending(), 20000);
  document.addEventListener('visibilitychange', async () => {
    if (!state.user || document.visibilityState !== 'visible' || Object.keys(lsGet(LS_PENDING, {})).length || state.sheet) return;
    await loadDb();
    render();
  });

  (async function init() {
    state.stats = Object.assign(state.stats, lsGet(LS_STATS, {}));
    if (!(await loadDb())) return renderLogin();
    // Brak sieci: pokaż wyniki z telefonu, jeśli ktoś już się tu wcześniej logował.
    if (!state.user && lsGet(LS_DB, null)) state.user = '…';
    const last = lsGet(LS_LAST, null);
    const lg = last && game(last);
    if (lg && lg.status === 'active') state.gameId = last;
    render();
  })();
})();

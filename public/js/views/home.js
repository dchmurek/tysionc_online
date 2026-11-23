// Strona główna i wybór trybu gry.
import { html, mount, fmtDateTime, fmtNum, pct } from '../dom.js';
import { state, nick, subscribe } from '../state.js';
import { computeMatch } from '/shared/scoring.js';
import { computeStats, ranking } from '/shared/stats.js';
import { icon, teamDots, colorOf } from '../ui.js';

export function matchCard(m, { link = null } = {}) {
  const c = computeMatch(m);
  const order = [0, 1].sort((a, b) => c.scores[b] - c.scores[a]);
  const modes = [...new Set(m.rounds.map((r) => r.mode))];
  const status = m.status === 'active' ? html`<span class="badge live">w grze</span>` : m.status === 'abandoned' ? html`<span class="badge">przerwany</span>` : m.status === 'deleted' ? html`<span class="badge bad">usunięty</span>` : '';
  const href = link || (m.status === 'active' ? `#/match/${encodeURIComponent(m.id)}` : `#/match/${encodeURIComponent(m.id)}/details`);
  return html`<a class="game-card" href="${href}">
    <div class="gc-main"><div class="gc-sides">${order.map((t) => html`<span class="${c.winner === t ? 'w' : ''}">${c.winner === t ? icon('crown', 'win-ic') : ''}${teamDots(c.teams[t])} ${c.teams[t].map(nick).join(' & ')} <b class="num">${fmtNum(c.scores[t])}</b></span>`)}</div>
    <div class="gc-meta">${fmtDateTime(m.createdAt)} · ${m.rounds.length} rozdań${modes.length ? ' · ' + modes.map((x) => (x === 'online' ? 'online' : 'offline')).join(' + ') : ''} ${status} ${m.pendingSync ? html`<span class="badge warn">czeka na wysłanie</span>` : ''}</div></div>
    <span class="chev">${icon('chevronRight')}</span></a>`;
}

export function home({ el }) {
  const draw = () => {
    const mine = state.matches.filter((m) => m.seats.includes(state.me.id));
    const active = state.matches.filter((m) => m.status === 'active').sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const stats = computeStats(state.matches);
    const me = stats.players[state.me.id];
    const top = ranking(stats, 'wins').slice(0, 4);
    const rooms = state.rooms || [];
    mount(el, html`
      <section class="hero">
        <div><div class="eyebrow">Witaj przy stole</div><h1 class="title-xl">${state.me.nick}</h1>
        <p class="muted">${me && me.matches ? html`${me.matches} meczów · ${me.wins} wygranych · ${pct(me.winRate)} skuteczności` : 'Jeszcze nie masz rozegranych meczów.'}</p></div>
      </section>
      <div class="tiles-2">
        <a class="big-tile online" href="#/online"><div class="bt-ic">${icon('wifi')}</div><div class="bt-t">Graj online</div><div class="bt-d">każdy na swoim telefonie, prawdziwa rozgrywka</div></a>
        <a class="big-tile offline" href="#/offline/new"><div class="bt-ic">${icon('cards')}</div><div class="bt-t">Graj offline</div><div class="bt-d">prawdziwe karty – aplikacja liczy punkty</div></a>
      </div>
      ${rooms.length ? html`<div class="section-head"><span class="eyebrow">Twoje pokoje online</span></div>
        ${rooms.map((r) => html`<a class="game-card" href="#/room/${encodeURIComponent(r.id)}"><div class="gc-main"><div class="gc-sides"><span>Pokój <b class="mono">${r.code}</b></span></div><div class="gc-meta">${r.status === 'lobby' ? 'poczekalnia' : r.status === 'playing' ? 'trwa rozdanie' : r.status === 'between' ? 'przerwa między rozdaniami' : 'mecz zakończony'}</div></div><span class="chev">${icon('chevronRight')}</span></a>`)}` : ''}
      <div class="section-head"><span class="eyebrow">Kontynuuj mecz</span></div>
      ${active.length ? active.slice(0, 6).map((m) => matchCard(m)) : html`<p class="muted small">Brak trwających meczów.</p>`}
      <div class="grid-2">
        <section class="card">
          <div class="card-h"><h3>Ranking</h3><a class="link" href="#/stats/ranking">pełny ${icon('chevronRight')}</a></div>
          ${top.length ? html`<ol class="mini-rank">${top.map((p, i) => html`<li><span class="rank ${i === 0 ? 'r1' : ''}">${i + 1}</span><i class="dot" style="--pc:${colorOf(p.id)}"></i><a href="#/stats/player/${encodeURIComponent(p.id)}">${nick(p.id)}</a><span class="muted small">${p.wins} / ${p.matches}</span></li>`)}</ol>` : html`<p class="muted small">Brak danych.</p>`}
        </section>
        <section class="card">
          <div class="card-h"><h3>Na skróty</h3></div>
          <div class="quick">
            <a href="#/stats">${icon('stats')}Statystyki</a><a href="#/stats/groups">${icon('users')}Grupy</a>
            <a href="#/history">${icon('history')}Historia</a><a href="#/profile">${icon('user')}Profil</a>
            ${state.me.role === 'admin' ? html`<a href="#/admin">${icon('shield')}Administracja</a>` : ''}
          </div>
        </section>
      </div>
      ${mine.length ? '' : ''}`);
  };
  draw();
  return subscribe((w) => { if (w === 'data' || w === 'sync' || String(w).startsWith('match:')) draw(); });
}

export function play({ el }) {
  const active = state.matches.filter((m) => m.status === 'active');
  mount(el, html`
    <div class="page-head"><div><div class="eyebrow">Nowa gra</div><h1 class="title-xl">Jak gracie?</h1></div></div>
    <div class="tiles-2">
      <a class="big-tile online" href="#/online"><div class="bt-ic">${icon('wifi')}</div><div class="bt-t">Online</div><div class="bt-d">Utwórz pokój albo dołącz kodem. Serwer rozdaje karty i pilnuje zasad.</div></a>
      <a class="big-tile offline" href="#/offline/new"><div class="bt-ic">${icon('cards')}</div><div class="bt-t">Offline</div><div class="bt-d">Gracie prawdziwymi kartami – wpisujecie licytację, punkty i meldunki.</div></a>
    </div>
    ${active.length ? html`<div class="section-head"><span class="eyebrow">Trwające mecze</span></div>${active.map((m) => matchCard(m))}
      <p class="muted small">Trwający mecz możesz kontynuować w dowolnym trybie – wynik, drużyny i historia zostają.</p>` : ''}`);
}

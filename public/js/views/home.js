// Strona główna i wybór trybu gry.
import { html, mount, fmtDateTime, fmtNum, pct, raw, toast } from '../dom.js';
import { state, nick, subscribe, post, matchById } from '../state.js';
import { DEFAULT_SETTINGS } from '/shared/rules.js';
import { computeMatch } from '/shared/scoring.js';
import { computeStats, ranking } from '/shared/stats.js';
import { icon, teamDots, colorOf } from '../ui.js';

const ROOM_STATUS = { lobby: 'poczekalnia – wybór trybu', playing: 'online · trwa rozdanie', between: 'online · przerwa', finished: 'mecz zakończony', offline: 'prawdziwe karty' };

// Mecz na liście: link + przycisk opcji (usuń, przerwij, otwórz stół) – bez wchodzenia do licznika.
export function matchCard(m, { link = null } = {}) {
  const c = computeMatch(m);
  const order = [0, 1].sort((a, b) => c.scores[b] - c.scores[a]);
  const modes = [...new Set(m.rounds.map((r) => r.mode))];
  const status = m.status === 'active' ? html`<span class="badge live">w grze</span>` : m.status === 'abandoned' ? html`<span class="badge">przerwany</span>` : m.status === 'deleted' ? html`<span class="badge bad">usunięty</span>` : '';
  const room = (state.rooms || []).find((r) => r.matchId === m.id);
  const href = link || (room ? `#/room/${encodeURIComponent(room.id)}` : m.status === 'active' ? `#/match/${encodeURIComponent(m.id)}` : `#/match/${encodeURIComponent(m.id)}/details`);
  const canEdit = state.me.role === 'admin' || m.seats.includes(state.me.id) || m.createdBy === state.me.id;
  return html`<div class="gc-wrap"><a class="game-card" href="${href}">
    <div class="gc-main"><div class="gc-sides">${order.map((t) => html`<span class="${c.winner === t ? 'w' : ''}">${c.winner === t ? icon('crown', 'win-ic') : ''}${teamDots(c.teams[t])} ${c.teams[t].map(nick).join(' & ')} <b class="num">${fmtNum(c.scores[t])}</b></span>`)}</div>
    <div class="gc-meta">${fmtDateTime(m.createdAt)} · ${m.rounds.length} rozdań${modes.length ? ' · ' + modes.map((x) => (x === 'online' ? 'online' : 'offline')).join(' + ') : ''} ${status} ${room ? html`<span class="badge">stół ${room.code}</span>` : ''} ${m.pendingSync ? html`<span class="badge warn">czeka na wysłanie</span>` : ''}</div></div>
    <span class="chev">${icon('chevronRight')}</span></a>
    ${canEdit && m.status !== 'deleted' ? html`<button type="button" class="gc-menu" data-match-menu="${m.id}" aria-label="Opcje meczu">${icon('more')}</button>` : ''}</div>`;
}

function roomCard(r) {
  const m = r.matchId ? matchById(r.matchId) : null;
  const c = m ? computeMatch(m) : null;
  const seats = r.seats.some(Boolean) ? r.seats : (r.reservedSeats || r.seats);
  const teams = c ? c.teams : [[seats[0], seats[2]], [seats[1], seats[3]]];
  return html`<a class="room-card ${r.status}" href="#/room/${encodeURIComponent(r.id)}">
    <div class="rc-top"><span class="rc-code mono">${r.code}</span><span class="rc-mode">${r.status === 'offline' ? icon('cards') : r.status === 'lobby' ? icon('table') : icon('wifi')}${ROOM_STATUS[r.status] || r.status}</span></div>
    <div class="rc-teams">${[0, 1].map((t) => html`<div class="rc-team">${teamDots(teams[t], t)}<span>${teams[t].map((u) => (u ? nick(u) : '—')).join(' & ')}</span>${c ? html`<b class="num">${fmtNum(c.scores[t])}</b>` : ''}</div>`)}</div>
    <div class="rc-go">Wejdź do stołu ${icon('chevronRight')}</div>
  </a>`;
}

function joinForm() {
  return html`<form class="join-inline" data-form="join">
    <input name="code" required minlength="6" maxlength="7" autocapitalize="characters" autocomplete="off" spellcheck="false" class="mono code-in" placeholder="KOD STOŁU" aria-label="Kod stołu (6 znaków)">
    <button class="btn gold" type="submit">Dołącz</button></form>`;
}

async function onJoinSubmit(e, go) {
  const f = e.target.closest('form[data-form="join"]');
  if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const { room } = await post('/api/rooms/join', { code: f.code.value });
    go('/room/' + encodeURIComponent(room.id));
  } catch (ex) { toast(ex.network ? 'Dołączenie wymaga internetu' : ex.message, { kind: 'bad' }); } finally { btn.disabled = false; }
}

export function home({ el, go }) {
  const draw = () => {
    const rooms = (state.rooms || []).slice().sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const inRoom = new Set(rooms.map((r) => r.matchId).filter(Boolean));
    const active = state.matches.filter((m) => m.status === 'active' && !inRoom.has(m.id)).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const stats = computeStats(state.matches);
    const me = stats.players[state.me.id];
    const top = ranking(stats, 'wins').slice(0, 4);
    mount(el, html`
      <section class="hero">
        <div><div class="eyebrow">Witaj przy stole</div><h1 class="title-xl">${state.me.nick}</h1>
        <p class="muted">${me && me.matches ? html`${me.matches} meczów · ${me.wins} wygranych · ${pct(me.winRate)} skuteczności` : 'Jeszcze nie masz rozegranych meczów.'}</p></div>
      </section>
      ${rooms.length ? html`<div class="section-head"><span class="eyebrow">Twoje stoły</span></div><div class="room-cards">${rooms.map(roomCard)}</div>` : ''}
      <div class="tiles-2">
        <a class="big-tile online" href="#/play?new=1"><div class="bt-ic">${icon('table')}</div><div class="bt-t">Nowy stół</div><div class="bt-d">zaproś graczy kodem, potem wybierzcie: prawdziwe karty albo gra w aplikacji</div></a>
        <div class="big-tile join"><div class="bt-ic">${icon('users')}</div><div class="bt-t">Dołącz do stołu</div>${joinForm()}</div>
      </div>
      ${active.length ? html`<div class="section-head"><span class="eyebrow">Kontynuuj mecz</span></div>${active.slice(0, 6).map((m) => matchCard(m))}` : ''}
      <div class="grid-2">
        <section class="card">
          <div class="card-h"><h3>Ranking</h3><a class="link" href="#/stats/ranking">pełny ${icon('chevronRight')}</a></div>
          ${top.length ? html`<ol class="mini-rank">${top.map((p, i) => html`<li><span class="rank ${i === 0 ? 'r1' : ''}">${i + 1}</span><i class="dot" style="--pc:${colorOf(p.id)}"></i><a href="#/stats/player/${encodeURIComponent(p.id)}">${nick(p.id)}</a><span class="muted small">${p.wins} / ${p.matches}</span></li>`)}</ol>` : html`<p class="muted small">Brak danych.</p>`}
        </section>
        <section class="card">
          <div class="card-h"><h3>Na skróty</h3></div>
          <div class="quick">
            <a href="#/offline/new">${icon('cards')}Sam licznik</a><a href="#/stats/groups">${icon('users')}Grupy</a>
            <a href="#/history">${icon('history')}Historia</a><a href="#/profile">${icon('user')}Profil</a>
            ${state.me.role === 'admin' ? html`<a href="#/admin">${icon('shield')}Administracja</a>` : ''}
          </div>
        </section>
      </div>`);
  };
  draw();
  const onSubmit = (e) => onJoinSubmit(e, go);
  el.addEventListener('submit', onSubmit);
  return subscribe((w) => { if (w === 'data' || w === 'sync' || String(w).startsWith('match:')) draw(); });
}

// Zakładka „Graj”: stoły. Stół = jedno miejsce dla meczu – w środku wybieracie grę online albo prawdziwymi kartami.
export function play({ el, go }) {
  const s = { ...DEFAULT_SETTINGS, ...(state.defaults || {}) };
  const openNew = /[?&]new=1/.test(location.hash);
  const draw = () => {
    const rooms = (state.rooms || []).slice().sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const inRoom = new Set(rooms.map((r) => r.matchId).filter(Boolean));
    const active = state.matches.filter((m) => m.status === 'active' && !inRoom.has(m.id) && (m.seats.includes(state.me.id) || m.createdBy === state.me.id));
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Graj</div><h1 class="title-xl">Stoły</h1></div></div>
      ${rooms.length ? html`<div class="room-cards">${rooms.map(roomCard)}</div>` : ''}
      <div class="grid-2">
        <section class="card">
          <h3>Dołącz do stołu</h3>
          <p class="muted small">Wpisz kod od gracza, który założył stół (albo zeskanuj jego kod QR).</p>
          ${joinForm()}
        </section>
        <section class="card">
          <h3>Nowy stół</h3>
          <form data-form="create">
            <div class="form-grid">
              <label class="field"><span>Gra do</span><input type="number" name="target" value="${s.target}" step="10" min="100"></label>
              <label class="field"><span>Zaokrąglanie</span><select name="rounding"><option value="nearest10" ${s.rounding === 'nearest10' ? raw('selected') : ''}>do najbliższej 10</option><option value="down10" ${s.rounding === 'down10' ? raw('selected') : ''}>w dół do 10</option><option value="exact" ${s.rounding === 'exact' ? raw('selected') : ''}>bez zaokrąglania</option></select></label>
            </div>
            <details class="rules"><summary>Więcej zasad</summary>
              <div class="form-grid">
                <label class="field"><span>Bez licytacji max do</span><input type="number" name="passiveCap" value="${s.passiveCap}" step="10"></label>
                <label class="field"><span>Kontrakt sprawdzany</span><select name="contractCheck"><option value="raw" ${s.contractCheck === 'raw' ? raw('selected') : ''}>przed zaokrągleniem</option><option value="rounded" ${s.contractCheck === 'rounded' ? raw('selected') : ''}>po zaokrągleniu</option></select></label>
              </div>
              <p class="muted small">Tylko w grze online:</p>
              <label class="check"><input type="checkbox" name="mustBeat" ${s.mustBeat ? raw('checked') : ''}> Obowiązek przebicia (do koloru i tromfem)</label>
              <label class="check"><input type="checkbox" name="mustTrump" ${s.mustTrump ? raw('checked') : ''}> Brak koloru → obowiązek dania tromfu</label>
              <label class="check"><input type="checkbox" name="meldOnFirstTrick" ${s.meldOnFirstTrick ? raw('checked') : ''}> Meldunek dozwolony już w pierwszej lewie</label>
              <label class="check"><input type="checkbox" name="meldOnPlayed" ${s.meldOnPlayed !== false ? raw('checked') : ''}> Meldunek na kimś (król dołożony na damę zagraną tuż przed nim)</label>
            </details>
            <button class="btn gold wide" type="submit">${icon('plus')}Załóż stół</button>
            <p class="muted small">Po założeniu dostaniesz kod dla graczy. W stole wybierzecie: prawdziwe karty (liczenie punktów) albo grę w aplikacji – i możecie to zmieniać między rozdaniami.</p>
          </form>
        </section>
      </div>
      ${active.length ? html`<div class="section-head"><span class="eyebrow">Mecze bez stołu</span></div>${active.map((m) => matchCard(m))}
        <p class="muted small">Opcje meczu (⋯): otwórz dla niego stół, przerwij albo usuń.</p>` : ''}
      <p class="muted small center"><a class="link" href="#/offline/new">${icon('cards')} Sam licznik punktów bez stołu</a> – działa też bez internetu.</p>`);
    if (openNew) { const f = el.querySelector('[data-form="create"] input'); if (f) f.focus(); }
  };
  draw();
  const onSubmit = async (e) => {
    if (e.target.dataset.form === 'join') return onJoinSubmit(e, go);
    if (e.target.dataset.form !== 'create') return;
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const fd = new FormData(f);
      const settings = { ...s, target: Number(fd.get('target')), rounding: fd.get('rounding'), passiveCap: Number(fd.get('passiveCap')), contractCheck: fd.get('contractCheck'),
        mustBeat: !!fd.get('mustBeat'), mustTrump: !!fd.get('mustTrump'), meldOnFirstTrick: !!fd.get('meldOnFirstTrick'), meldOnPlayed: !!fd.get('meldOnPlayed') };
      const { room } = await post('/api/rooms', { settings });
      go('/room/' + encodeURIComponent(room.id));
    } catch (ex) { toast(ex.network ? 'Założenie stołu wymaga internetu' : ex.message, { kind: 'bad' }); } finally { btn.disabled = false; }
  };
  el.addEventListener('submit', onSubmit);
  return subscribe((w) => { if (w === 'data') draw(); });
}

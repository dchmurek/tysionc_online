// Historia meczów i sesji (spotkań).
import { html, mount, fmtDate, fmtDateTime, toast, confirmBox, raw } from '../dom.js';
import { state, nick, subscribe, post, loadData } from '../state.js';
import { computeStats, pairKey } from '/shared/stats.js';
import { icon, dot, teamDots } from '../ui.js';
import { matchCard } from './home.js';

let mode = 'matches';
let statusF = 'all';

export function history({ el }) {
  const draw = () => {
    const ms = state.matches.filter((m) => statusF === 'all' || m.status === statusF).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const meets = state.meets.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const counts = Object.fromEntries(state.matches.map((m) => m.meetId).filter(Boolean).reduce((mp, id) => mp.set(id, (mp.get(id) || 0) + 1), new Map()));
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Archiwum</div><h1 class="title-xl">Historia</h1></div>
        <div class="seg" role="group">${[['matches', 'Mecze'], ['meets', 'Sesje']].map(([v, l]) => html`<button type="button" data-mode="${v}" class="${mode === v ? 'on' : ''}" aria-pressed="${mode === v}">${l}</button>`)}</div></div>
      ${mode === 'matches' ? html`
        <div class="seg small" role="group">${[['all', 'Wszystkie'], ['active', 'W toku'], ['finished', 'Zakończone'], ['abandoned', 'Przerwane'], ...(state.me.role === 'admin' ? [['deleted', 'Usunięte']] : [])].map(([v, l]) => html`<button type="button" data-status="${v}" class="${statusF === v ? 'on' : ''}">${l}</button>`)}</div>
        ${ms.length ? ms.map((m) => matchCard(m)) : html`<div class="card empty">Brak meczów.</div>`}`
      : html`
        ${meets.length ? meets.map((s) => html`<a class="game-card" href="#/session/${encodeURIComponent(s.id)}"><div class="gc-main">
          <div class="gc-sides"><span>${fmtDate(s.startedAt)} ${s.status === 'open' ? html`<span class="badge live">trwa</span>` : ''}</span></div>
          <div class="gc-meta">${s.players.map((p) => html`${dot(p)}${nick(p)} `)} · ${counts[s.id] || 0} meczów</div></div><span class="chev">${icon('chevronRight')}</span></a>`) : html`<div class="card empty">Brak sesji.</div>`}
        <p class="muted small">Sesja to jedno spotkanie tej samej czwórki. Nowy mecz tej samej czwórki trafia do otwartej sesji, jeśli od ostatniej gry minęło mniej niż 12 godzin – albo do nowej, jeśli rozpoczniesz ją ręcznie.</p>`}`);
  };
  el.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; draw(); }
    const s = e.target.closest('[data-status]');
    if (s) { statusF = s.dataset.status; draw(); }
  });
  draw();
  return subscribe((w) => { if (w === 'data' || String(w).startsWith('match:')) draw(); });
}

export function session({ el, params, go }) {
  const id = params.id;
  const draw = () => {
    const s = state.meets.find((x) => x.id === id);
    if (!s) { mount(el, html`<div class="card empty">Nie ma takiej sesji.</div>`); return; }
    const ms = state.matches.filter((m) => m.meetId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const st = computeStats(state.matches, { meetId: id });
    const sm = st.meets[id] || { wins: {}, pairWins: {}, finished: 0, rounds: 0 };
    const mine = s.players.includes(state.me.id) || state.me.role === 'admin';
    const pairRows = Object.entries(sm.pairWins).sort((a, b) => b[1] - a[1]);
    mount(el, html`
      <a class="back" href="#/history">${icon('chevronLeft')}Historia</a>
      <div class="page-head"><div><div class="eyebrow">Sesja ${s.status === 'open' ? '· trwa' : ''}</div><h1 class="title-xl">${fmtDate(s.startedAt)}</h1>
        <p class="muted">${fmtDateTime(s.startedAt)}${s.endedAt ? html` – ${fmtDateTime(s.endedAt)}` : ''} · ${s.players.map(nick).join(', ')}</p></div></div>
      <div class="kpis">
        <div class="kpi"><div class="v">${ms.length}</div><div class="l">meczów</div></div>
        <div class="kpi"><div class="v">${sm.finished}</div><div class="l">ukończonych</div></div>
        <div class="kpi"><div class="v">${sm.rounds}</div><div class="l">rozdań</div></div>
      </div>
      <div class="grid-2">
        <section class="card"><h3>Wygrane graczy</h3><div class="table-wrap"><table class="tbl"><tbody>${s.players.slice().sort((a, b) => (sm.wins[b] || 0) - (sm.wins[a] || 0)).map((p) => html`<tr><td class="l">${dot(p)}${nick(p)}</td><td><b>${sm.wins[p] || 0}</b></td></tr>`)}</tbody></table></div></section>
        <section class="card"><h3>Wygrane par</h3>${pairRows.length ? html`<div class="table-wrap"><table class="tbl"><tbody>${pairRows.map(([k, v]) => html`<tr><td class="l">${teamDots(k.split('~'))} ${k.split('~').map(nick).join(' & ')}</td><td><b>${v}</b></td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Brak ukończonych meczów.</p>`}</section>
      </div>
      <section class="card"><h3>Mecze tej sesji</h3>${ms.length ? ms.map((m) => matchCard(m)) : html`<p class="muted small">Brak meczów.</p>`}</section>
      ${mine ? html`<div class="row wrap">
        ${s.status === 'open' ? html`<button type="button" class="btn sm" data-act="close">Zakończ sesję</button>` : ''}
        <button type="button" class="btn sm gold" data-act="new">Rozpocznij nową sesję tej czwórki</button></div>` : ''}`);
  };
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const s = state.meets.find((x) => x.id === id);
    try {
      if (a.dataset.act === 'close' && (await confirmBox('Zakończyć sesję?', 'Kolejne mecze tej czwórki trafią do nowej sesji.', 'Zakończ'))) { await post(`/api/meets/${encodeURIComponent(id)}/close`); await loadData(); }
      if (a.dataset.act === 'new') { const { meet } = await post('/api/meets', { players: s.players }); await loadData(); toast('Nowa sesja rozpoczęta'); go('/session/' + encodeURIComponent(meet.id)); }
    } catch (ex) { toast(ex.network ? 'Wymaga połączenia z internetem' : ex.message, { kind: 'bad' }); }
  });
  draw();
  return subscribe((w) => { if (w === 'data') draw(); });
}

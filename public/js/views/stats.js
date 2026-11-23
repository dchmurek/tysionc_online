// Statystyki: przegląd, ranking, grupy czteroosobowe, pary, gracz (współpraca i rywalizacja).
import { html, mount, fmtNum, pct, fmtDate, raw, toast } from '../dom.js';
import { state, nick, subscribe } from '../state.js';
import { computeStats, ranking, rivalryFor, groupKey } from '/shared/stats.js';
import { SUIT_INFO } from '/shared/rules.js';
import { icon, dot, colorOf, suitSym, teamDots } from '../ui.js';
import { matchCard } from './home.js';
import { lineChart, barChart, stackedBars, destroyCharts } from './charts.js';
import { download } from '../api.js';

const LS = 'tys2:statsFilter';
const filter = Object.assign({ period: 'all', min: 1 }, JSON.parse(localStorage.getItem(LS) || '{}'));
const saveFilter = () => localStorage.setItem(LS, JSON.stringify(filter));
const since = () => (filter.period === 'all' ? null : new Date(Date.now() - Number(filter.period) * 864e5).toISOString());

const tabs = (active) => html`<nav class="tabs" aria-label="Statystyki">
  ${[['/stats', 'Przegląd'], ['/stats/ranking', 'Ranking'], ['/stats/groups', 'Grupy'], ['/stats/pairs', 'Pary'], ['/stats/player/' + encodeURIComponent(state.me.id), 'Ja']].map(([h, l]) => html`<a href="#${h}" class="${active === h ? 'on' : ''}">${l}</a>`)}
</nav>`;
const periodSeg = () => html`<div class="seg" role="group" aria-label="Okres">${[['30', '30 dni'], ['90', '3 mies.'], ['365', 'Rok'], ['all', 'Całość']].map(([v, l]) => html`<button type="button" data-period="${v}" class="${filter.period === v ? 'on' : ''}" aria-pressed="${filter.period === v}">${l}</button>`)}</div>`;
const minSeg = () => html`<label class="inline">min. meczów <select data-min>${[1, 3, 5, 10, 20].map((n) => html`<option value="${n}" ${filter.min === n ? raw('selected') : ''}>${n}</option>`)}</select></label>`;
const linkP = (id) => html`<a href="#/stats/player/${encodeURIComponent(id)}">${nick(id)}</a>`;

function wire(el, draw) {
  const onClick = (e) => {
    const p = e.target.closest('[data-period]');
    if (p) { filter.period = p.dataset.period; saveFilter(); draw(); }
    const x = e.target.closest('[data-csv]');
    if (x) download('/api/export/csv/' + x.dataset.csv, null, x.dataset.csv + '.csv').catch((er) => toast(er.message, { kind: 'bad' }));
  };
  const onChange = (e) => { if (e.target.matches('[data-min]')) { filter.min = Number(e.target.value); saveFilter(); draw(); } if (e.target.matches('[data-sort]')) draw(e.target.value); };
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  draw();
  const unsub = subscribe((w) => { if (w === 'data' || String(w).startsWith('match:')) draw(); });
  return () => { unsub(); destroyCharts(el); };
}

export function overview({ el }) {
  const draw = () => {
    destroyCharts(el);
    const s = computeStats(state.matches, { from: since() });
    const players = ranking(s, 'wins');
    const totalRounds = Object.values(s.groups).reduce((a, g) => a + g.rounds, 0);
    const allBids = players.reduce((a, p) => a + p.bids, 0);
    const allMade = players.reduce((a, p) => a + p.made, 0);
    const r = s.records;
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Analiza</div><h1 class="title-xl">Statystyki</h1></div>${periodSeg()}</div>
      ${tabs('/stats')}
      ${!players.length ? html`<div class="card empty">Brak rozegranych rozdań w wybranym okresie.</div>` : html`
      <div class="kpis">
        <div class="kpi"><div class="v">${s.finishedCount}</div><div class="l">ukończonych meczów</div></div>
        <div class="kpi"><div class="v">${fmtNum(totalRounds)}</div><div class="l">rozdań</div></div>
        <div class="kpi"><div class="v">${pct(allBids ? allMade / allBids : null)}</div><div class="l">kontraktów ugranych</div></div>
        <div class="kpi"><div class="v">${Object.keys(s.groups).length}</div><div class="l">${Object.keys(s.groups).length === 1 ? 'grupa graczy' : 'grup graczy'}</div></div>
      </div>
      <div class="grid-2">
        <section class="card"><h3>Wygrane mecze</h3><div class="chart-box"><canvas id="chWins" role="img" aria-label="Wygrane mecze graczy"></canvas></div></section>
        <section class="card"><h3>Skuteczność kontraktów</h3><div class="chart-box"><canvas id="chSucc" role="img" aria-label="Skuteczność kontraktów"></canvas></div></section>
      </div>
      <section class="card"><h3>Wygrane w czasie</h3><div class="legend">${players.map((p) => html`<span>${dot(p.id)}${nick(p.id)}</span>`)}</div><div class="chart-box tall"><canvas id="chTime" role="img" aria-label="Wygrane w czasie"></canvas></div></section>
      <section class="card"><h3>Rozkład kontraktów</h3><div class="legend"><span><i class="dot" style="--pc:var(--chart-good)"></i>ugrane</span><span><i class="dot" style="--pc:var(--chart-bad)"></i>nieugrane</span></div><div class="chart-box"><canvas id="chBids" role="img" aria-label="Rozkład kontraktów"></canvas></div></section>
      <div class="grid-2">
        <section class="card"><h3>Meldunki</h3><div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Gracz</th>${Object.keys(SUIT_INFO).map((k) => html`<th>${suitSym(k)} ${SUIT_INFO[k].meld}</th>`)}<th>Razem</th></tr></thead>
          <tbody>${players.map((p) => html`<tr><td class="l">${dot(p.id)}${linkP(p.id)}</td>${Object.keys(SUIT_INFO).map((k) => html`<td>${p.melds[k] || 0}</td>`)}<td><b>${fmtNum(p.meldPts)}</b></td></tr>`)}</tbody></table></div></section>
        <section class="card"><h3>Rekordy</h3><dl class="info">
          ${r.maxMadeBid ? html`<dt>Najwyższy ugrany kontrakt</dt><dd><b class="gold">${r.maxMadeBid.bid}</b> – ${linkP(r.maxMadeBid.userId)} <span class="muted small">${fmtDate(r.maxMadeBid.date)}</span></dd>` : ''}
          ${r.maxFailedBid ? html`<dt>Najwyższy nieugrany</dt><dd><b>${r.maxFailedBid.bid}</b> – ${linkP(r.maxFailedBid.userId)}</dd>` : ''}
          ${r.maxRound ? html`<dt>Najwięcej w rozdaniu</dt><dd><b>+${r.maxRound.points}</b> – ${r.maxRound.team.map(nick).join(' & ')}</dd>` : ''}
          ${r.longest ? html`<dt>Najdłuższy mecz</dt><dd>${r.longest.n} rozdań</dd>` : ''}
          ${r.shortest ? html`<dt>Najkrótszy mecz</dt><dd>${r.shortest.n} rozdań</dd>` : ''}
        </dl></section>
      </div>
      <section class="card"><h3>Eksport CSV</h3><div class="row wrap">${[['matches', 'Mecze'], ['rounds', 'Rozdania'], ['players', 'Gracze'], ['groups', 'Grupy'], ['pairs', 'Pary']].map(([k, l]) => html`<button type="button" class="btn sm" data-csv="${k}">${icon('download')}${l}</button>`)}</div></section>`}`);
    if (!players.length) return;
    const byWins = players.slice().sort((a, b) => b.wins - a.wins);
    barChart(el.querySelector('#chWins'), { labels: byWins.map((p) => nick(p.id)), data: byWins.map((p) => p.wins), colors: byWins.map((p) => colorOf(p.id)) });
    const bySucc = players.filter((p) => p.bids).sort((a, b) => b.contractRate - a.contractRate);
    barChart(el.querySelector('#chSucc'), { labels: bySucc.map((p) => nick(p.id)), data: bySucc.map((p) => Math.round(p.contractRate * 100)), colors: bySucc.map((p) => colorOf(p.id)), max: 100, suffix: '%', tooltip: (ctx) => ` ${ctx.raw}% (${bySucc[ctx.dataIndex].made}/${bySucc[ctx.dataIndex].bids})` });
    // wygrane narastająco
    const done = state.matches.filter((m) => m.status === 'finished' && m.winner != null && (!since() || m.createdAt >= since())).sort((a, b) => (a.finishedAt || a.createdAt).localeCompare(b.finishedAt || b.createdAt));
    const acc = Object.fromEntries(players.map((p) => [p.id, 0]));
    const series = Object.fromEntries(players.map((p) => [p.id, [0]]));
    const labels = ['start'];
    for (const m of done) {
      const team = m.winner === 0 ? [m.seats[0], m.seats[2]] : [m.seats[1], m.seats[3]];
      for (const id of team) if (id in acc) acc[id]++;
      for (const p of players) series[p.id].push(acc[p.id]);
      labels.push(fmtDate(m.finishedAt || m.createdAt));
    }
    lineChart(el.querySelector('#chTime'), { labels, series: players.map((p) => ({ label: nick(p.id), color: colorOf(p.id), data: series[p.id] })), stepped: true });
    const all = {};
    for (const p of players) for (const [k, v] of Object.entries(p.byBid)) { all[k] = all[k] || { n: 0, made: 0 }; all[k].n += v.n; all[k].made += v.made; }
    const keys = Object.keys(all).map(Number).sort((a, b) => a - b);
    stackedBars(el.querySelector('#chBids'), { labels: keys.map(String), sets: [{ label: 'ugrane', color: getComputedStyle(document.documentElement).getPropertyValue('--chart-good'), data: keys.map((k) => all[k].made) }, { label: 'nieugrane', color: getComputedStyle(document.documentElement).getPropertyValue('--chart-bad'), data: keys.map((k) => all[k].n - all[k].made) }] });
  };
  return wire(el, draw);
}

const SORTS = [['wins', 'zwycięstwa'], ['winRate', 'skuteczność (z uwzgl. liczby meczów)'], ['matches', 'liczba meczów'], ['points', 'zdobyte punkty'], ['contracts', 'skuteczność kontraktów']];
let sortBy = 'wins';
export function rankingView({ el }) {
  const draw = (sort) => {
    if (sort) sortBy = sort;
    const s = computeStats(state.matches, { from: since() });
    const list = ranking(s, sortBy, sortBy === 'winRate' ? filter.min : 0);
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Wszyscy gracze</div><h1 class="title-xl">Ranking</h1></div>${periodSeg()}</div>
      ${tabs('/stats/ranking')}
      <div class="row wrap"><label class="inline">sortuj <select data-sort>${SORTS.map(([k, l]) => html`<option value="${k}" ${sortBy === k ? raw('selected') : ''}>${l}</option>`)}</select></label>${sortBy === 'winRate' ? minSeg() : ''}</div>
      <section class="card"><div class="table-wrap"><table class="tbl rank-tbl">
        <thead><tr><th class="l">Gracz</th><th>Mecze</th><th>Wygr.</th><th>Przegr.</th><th>% wygr.</th><th>Rozdania</th><th>Kontrakty</th><th>% kontr.</th><th>Punkty</th><th>Seria</th></tr></thead>
        <tbody>${list.map((p, i) => html`<tr><td class="l"><span class="rank ${i === 0 ? 'r1' : ''}">${i + 1}</span>${dot(p.id)}<b>${linkP(p.id)}</b></td><td>${p.matches}</td><td><b>${p.wins}</b></td><td>${p.losses}</td><td title="przedział ufności uwzględnia liczbę meczów">${pct(p.winRate)}</td><td>${p.rounds}</td><td>${p.made}/${p.bids}</td><td>${pct(p.contractRate)}</td><td>${fmtNum(p.points)}</td><td>${p.bestStreak}</td></tr>`)}</tbody>
      </table></div>
      <p class="muted small">Zwycięstwa = wygrane mecze (nie rozdania); mecze nieukończone się nie liczą. Sortowanie po skuteczności uwzględnia liczbę meczów (dolna granica przedziału Wilsona) – 100% z jednego meczu nie wyprzedza 75% z czterdziestu.</p></section>`);
  };
  return wire(el, draw);
}

export function groupsView({ el }) {
  const draw = () => {
    const s = computeStats(state.matches, { from: since() });
    const groups = Object.values(s.groups).sort((a, b) => b.allMatches - a.allMatches);
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Automatycznie rozpoznane czwórki</div><h1 class="title-xl">Grupy</h1></div>${periodSeg()}</div>
      ${tabs('/stats/groups')}
      ${groups.length ? groups.map((g) => html`<a class="game-card" href="#/stats/group/${encodeURIComponent(g.key)}"><div class="gc-main">
        <div class="gc-sides"><span>${g.players.map((p) => html`${dot(p)}${nick(p)} `)}</span></div>
        <div class="gc-meta">${g.matches} ukończonych meczów · ${g.rounds} rozdań · ${g.meetCount} ${g.meetCount === 1 ? 'sesja' : 'sesji'} · ostatnio ${fmtDate(g.last)}</div></div><span class="chev">${icon('chevronRight')}</span></a>`) : html`<div class="card empty">Brak grup w wybranym okresie.</div>`}
      <p class="muted small">Grupa to konkretna czwórka graczy (po ich trwałych ID). Zmiana drużyn w tej samej czwórce ani zmiana nicku nie tworzy nowej grupy.</p>`);
  };
  return wire(el, draw);
}

export function groupView({ el, params }) {
  const key = params.key;
  const draw = () => {
    destroyCharts(el);
    const s = computeStats(state.matches, { groupKey: key, from: since() });
    const g = s.groups[key];
    if (!g) { mount(el, html`<a class="back" href="#/stats/groups">${icon('chevronLeft')}Grupy</a><div class="card empty">Brak meczów tej grupy w wybranym okresie.</div>`); return; }
    const matches = state.matches.filter((m) => (m.groupKey || groupKey(m.seats)) === key && m.status !== 'deleted' && (!since() || m.createdAt >= since())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const meets = state.meets.filter((x) => x.groupKey === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    mount(el, html`
      <a class="back" href="#/stats/groups">${icon('chevronLeft')}Grupy</a>
      <div class="page-head"><div><div class="eyebrow">Grupa</div><h1 class="title-xl">${g.players.map(nick).join(', ')}</h1></div>${periodSeg()}</div>
      <div class="kpis">
        <div class="kpi"><div class="v">${g.matches}</div><div class="l">ukończonych meczów (${g.allMatches} wszystkich)</div></div>
        <div class="kpi"><div class="v">${g.rounds}</div><div class="l">rozdań</div></div>
        <div class="kpi"><div class="v">${g.meetCount}</div><div class="l">sesji</div></div>
        <div class="kpi"><div class="v small">${fmtDate(g.first)}</div><div class="l">pierwsza gra · ostatnia ${fmtDate(g.last)}</div></div>
      </div>
      <div class="grid-2">
        <section class="card"><h3>Ranking w grupie</h3><div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Gracz</th><th>Wygrane</th><th>Przegrane</th><th>%</th><th>Kontrakty</th></tr></thead>
          <tbody>${g.ranking.map((r, i) => { const p = s.players[r.id]; return html`<tr><td class="l"><span class="rank ${i === 0 && r.wins ? 'r1' : ''}">${i + 1}</span>${dot(r.id)}${linkP(r.id)}</td><td><b>${r.wins}</b></td><td>${g.matches - r.wins}</td><td>${pct(r.winRate)}</td><td>${p.made}/${p.bids}</td></tr>`; })}</tbody></table></div>
          ${g.bestPlayer ? html`<p class="small">Najlepszy gracz: <b>${nick(g.bestPlayer)}</b></p>` : ''}</section>
        <section class="card"><h3>Pary w tej grupie</h3><div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Para</th><th>Mecze</th><th>Wygrane</th><th>%</th></tr></thead>
          <tbody>${g.pairs.map((p) => html`<tr><td class="l">${teamDots(p.ids)} ${p.ids.map(nick).join(' & ')}</td><td>${p.matches}</td><td><b>${p.wins}</b></td><td>${pct(p.winRate)}</td></tr>`)}</tbody></table></div>
          ${g.bestPair ? html`<p class="small">Najskuteczniejsza para: <b>${g.bestPair.ids.map(nick).join(' & ')}</b></p>` : ''}</section>
      </div>
      <div class="grid-2">
        <section class="card"><h3>Licytacje</h3><p>Kontrakty: <b>${g.made}/${g.bids}</b> ugranych (${pct(g.contractRate)}), średnio ${g.bids ? Math.round(g.bidSum / g.bids) : '–'}</p></section>
        <section class="card"><h3>Meldunki</h3><p>${Object.keys(SUIT_INFO).map((k) => html`${suitSym(k)} ${g.melds[k] || 0} &nbsp; `)} · razem <b>${fmtNum(g.meldPts)}</b> pkt</p></section>
      </div>
      <section class="card"><h3>Sesje (spotkania)</h3>${meets.length ? html`<div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Data</th><th>Mecze</th><th>Wyniki</th></tr></thead><tbody>${meets.map((x) => { const ms = s.meets[x.id]; return html`<tr><td class="l"><a href="#/session/${encodeURIComponent(x.id)}">${fmtDate(x.startedAt)}</a>${x.status === 'open' ? html` <span class="badge live">trwa</span>` : ''}</td><td>${ms ? ms.matchIds.length : 0}</td><td class="small">${ms ? Object.entries(ms.pairWins).map(([k, v]) => `${k.split('~').map(nick).join('&')}: ${v}`).join(' · ') : ''}</td></tr>`; })}</tbody></table></div>` : html`<p class="muted small">Brak sesji.</p>`}</section>
      <section class="card"><h3>Mecze</h3>${matches.map((m) => matchCard(m))}</section>`);
  };
  return wire(el, draw);
}

export function pairsView({ el }) {
  let gk = '';
  const draw = () => {
    const s = computeStats(state.matches, { from: since(), groupKey: gk || null });
    const all = computeStats(state.matches, { from: since() });
    const pairs = Object.values(s.pairs).filter((p) => p.matches >= filter.min).sort((a, b) => b.wilson - a.wilson || b.matches - a.matches);
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Gracze w jednej drużynie</div><h1 class="title-xl">Pary</h1></div>${periodSeg()}</div>
      ${tabs('/stats/pairs')}
      <div class="row wrap"><label class="inline">grupa <select data-gk><option value="">wszystkie</option>${Object.values(all.groups).map((g) => html`<option value="${g.key}" ${gk === g.key ? raw('selected') : ''}>${g.players.map(nick).join(', ')}</option>`)}</select></label>${minSeg()}</div>
      <section class="card"><div class="table-wrap"><table class="tbl"><thead><tr><th class="l">#</th><th class="l">Para</th><th>Mecze</th><th>Wygr.</th><th>Przegr.</th><th>%</th><th>Punkty</th><th>Kontrakty</th><th>Meldunki</th></tr></thead>
        <tbody>${pairs.map((p, i) => html`<tr><td class="l">${i + 1}</td><td class="l">${teamDots(p.ids)} ${p.ids.map(nick).join(' & ')}</td><td>${p.matches}</td><td><b>${p.wins}</b></td><td>${p.losses}</td><td>${pct(p.winRate)}</td><td>${fmtNum(p.points)}</td><td>${p.made}/${p.bids}</td><td>${fmtNum(p.meldPts)}</td></tr>`)}</tbody></table></div>
        <p class="muted small">Statystyki pary sumują się niezależnie od przeciwników. Kolejność uwzględnia liczbę meczów.</p></section>`);
  };
  el.addEventListener('change', (e) => { if (e.target.matches('[data-gk]')) { gk = e.target.value; draw(); } });
  return wire(el, draw);
}

export function playerView({ el, params }) {
  const id = params.id;
  const draw = () => {
    destroyCharts(el);
    const s = computeStats(state.matches, { from: since() });
    const p = s.players[id];
    const r = rivalryFor(s, id, filter.min);
    const isMe = id === state.me.id;
    const line = (label, x, fmt) => (x ? html`<dt>${label}</dt><dd>${dot(x.id)}${linkP(x.id)} <span class="muted small">${fmt(x)}</span></dd>` : '');
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">${isMe ? 'Twoje statystyki' : 'Gracz'}</div><h1 class="title-xl">${dot(id)}${nick(id)}</h1></div>${periodSeg()}</div>
      ${tabs(isMe ? '/stats/player/' + encodeURIComponent(state.me.id) : '')}
      ${!p ? html`<div class="card empty">Brak rozegranych meczów w wybranym okresie.</div>` : html`
      <div class="kpis">
        <div class="kpi"><div class="v">${p.matches}</div><div class="l">mecze (${p.wins} W / ${p.losses} P)</div></div>
        <div class="kpi"><div class="v">${pct(p.winRate)}</div><div class="l">wygranych meczów</div></div>
        <div class="kpi"><div class="v">${pct(p.contractRate)}</div><div class="l">kontraktów (${p.made}/${p.bids})</div></div>
        <div class="kpi"><div class="v">${p.bestStreak}</div><div class="l">najdłuższa seria (teraz ${p.streak})</div></div>
      </div>
      <div class="grid-2">
        <section class="card"><h3>Liczby</h3><dl class="info">
          <dt>Rozdania</dt><dd>${p.rounds}</dd><dt>Wygrane licytacje</dt><dd>${p.bids}</dd><dt>Przegrane kontrakty</dt><dd>${p.failed}</dd>
          <dt>Zdobyte punkty (drużynowo)</dt><dd>${fmtNum(p.points)} (śr. ${p.avgPoints ?? '–'} / rozdanie)</dd>
          <dt>Najwyższy kontrakt</dt><dd>${p.maxBid || '–'} (ugrany: ${p.maxMadeBid || '–'})</dd>
          <dt>Najwyższy wynik w meczu</dt><dd>${p.highestScore ?? '–'}</dd>
          <dt>Meldunki</dt><dd>${Object.keys(SUIT_INFO).map((k) => html`${suitSym(k)}${p.melds[k] || 0} `)} = ${fmtNum(p.meldPts)} pkt</dd>
          <dt>Lewy (gra online)</dt><dd>${p.trickRounds ? html`${p.tricks} w ${p.trickRounds} rozdaniach` : html`<span class="muted">brak danych</span>`}</dd>
          ${p.abandoned ? html`<dt>Przerwane mecze</dt><dd>${p.abandoned}</dd>` : ''}
        </dl></section>
        <section class="card"><h3>Współpraca i rywalizacja</h3>${minSeg()}<dl class="info">
          ${line('Najlepszy partner', r.bestPartner, (x) => `${x.wins}/${x.matches}`)}
          ${line('Najgorszy partner', r.worstPartner, (x) => `${x.wins}/${x.matches}`)}
          ${line('Najczęstszy partner', r.mostFrequentPartner, (x) => `${x.matches} meczów`)}
          ${line('Najczęstszy przeciwnik', r.mostFrequentOpponent, (x) => `${x.matches} meczów`)}
          ${line('Najczęściej pokonywany', r.mostBeatenOpponent, (x) => `${x.wins}/${x.matches}`)}
          ${line('Najtrudniejszy przeciwnik', r.toughestOpponent, (x) => `${x.losses} porażek w ${x.matches}`)}
        </dl></section>
      </div>
      <section class="card"><h3>Bilans bezpośrednich spotkań</h3><div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Przeciwnik</th><th>Mecze</th><th>Wygrane</th><th>Porażki</th><th>%</th></tr></thead>
        <tbody>${r.opponents.map((o) => html`<tr><td class="l">${dot(o.id)}${linkP(o.id)}</td><td>${o.matches}</td><td>${o.wins}</td><td>${o.losses}</td><td>${pct(o.winRate)}</td></tr>`)}</tbody></table></div>
        <h3>Z partnerami</h3><div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Partner</th><th>Mecze</th><th>Wygrane</th><th>%</th></tr></thead>
        <tbody>${r.partners.map((o) => html`<tr><td class="l">${dot(o.id)}${linkP(o.id)}</td><td>${o.matches}</td><td>${o.wins}</td><td>${pct(o.winRate)}</td></tr>`)}</tbody></table></div></section>
      ${p.history.length ? html`<section class="card"><h3>Historia wyników</h3><div class="chart-box"><canvas id="chHist" role="img" aria-label="Historia wyników"></canvas></div></section>` : ''}
      <section class="card"><h3>Ostatnie mecze</h3>${p.recent.map((h) => html`<a class="game-card" href="#/match/${encodeURIComponent(h.matchId)}/details"><div class="gc-main"><div class="gc-sides"><span class="${h.won ? 'w' : ''}">${h.won ? icon('crown', 'win-ic') : ''}${h.won ? 'wygrana' : 'porażka'} <b class="num">${h.score} : ${h.opp}</b></span></div><div class="gc-meta">${fmtDate(h.date)} · z ${nick(h.partner)} przeciw ${h.opponents.map(nick).join(' & ')}</div></div><span class="chev">${icon('chevronRight')}</span></a>`)}</section>`}`);
    if (p && p.history.length) {
      let acc = 0;
      lineChart(el.querySelector('#chHist'), { labels: p.history.map((h) => fmtDate(h.date)), series: [{ label: 'bilans wygranych', color: colorOf(id), data: p.history.map((h) => (acc += h.won ? 1 : -1)) }] });
    }
  };
  return wire(el, draw);
}

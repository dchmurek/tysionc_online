// Szczegóły meczu: przebieg (wykres), wszystkie rozdania, licytacje, tryby rozgrywki.
import { html, mount, fmtNum, signed, fmtDateTime, pct } from '../dom.js';
import { state, nick, matchById, subscribe } from '../state.js';
import { computeMatch } from '/shared/scoring.js';
import { computeStats } from '/shared/stats.js';
import { icon, dot, colorOf, suitSym, teamDots } from '../ui.js';
import { lineChart, destroyCharts } from './charts.js';

export function details({ el, params }) {
  const id = params.id;
  const draw = () => {
    destroyCharts(el);
    const m = matchById(id);
    if (!m) { mount(el, html`<div class="card empty">Nie ma takiego meczu.</div>`); return; }
    const c = computeMatch(m);
    const st = computeStats([m]);
    const meet = state.meets.find((s) => s.id === m.meetId);
    const statusTxt = c.winner !== null ? html`wygrali <b class="gold">${c.teams[c.winner].map(nick).join(' & ')}</b>` : m.status === 'abandoned' ? 'przerwany' : m.status === 'deleted' ? 'usunięty' : 'w trakcie';
    mount(el, html`
      <a class="back" href="${m.status === 'active' ? `#/match/${encodeURIComponent(id)}` : '#/history'}">${icon('chevronLeft')}${m.status === 'active' ? 'Stół' : 'Historia'}</a>
      <div class="page-head"><div><div class="eyebrow">Mecz</div><h1 class="title-xl">${c.teams.map((t) => t.map(nick).join(' & ')).join(' vs ')}</h1>
        <p class="muted">${fmtDateTime(m.createdAt)}${m.finishedAt ? html` – ${fmtDateTime(m.finishedAt)}` : ''} · ${c.rows.length} rozdań · ${statusTxt}</p></div></div>
      <div class="kpis">
        ${c.teams.map((t, i) => html`<div class="kpi" style="--pc:${colorOf(t[0])}"><div class="v ${c.scores[i] < 0 ? 'bad' : ''}">${fmtNum(c.scores[i])}</div><div class="l">${teamDots(t)} ${t.map(nick).join(' & ')}</div></div>`)}
      </div>
      ${c.rows.length ? html`<section class="card"><h3>Przebieg meczu</h3>
        <div class="legend">${c.teams.map((t) => html`<span><i class="dot" style="--pc:${colorOf(t[0])}"></i>${t.map(nick).join(' & ')}</span>`)}<span><i class="dash"></i>limit ${c.cap}</span></div>
        <div class="chart-box"><canvas id="chMatch" aria-label="Wykres przebiegu meczu" role="img"></canvas></div></section>` : ''}
      <section class="card"><h3>Wszystkie rozdania</h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>#</th><th class="l">Licytacja</th><th>Tryb</th>${c.teams.map((t) => html`<th>${t.map((p) => nick(p)).join(' & ')}</th>`)}</tr></thead>
          <tbody>${c.rows.slice().reverse().map((row) => {
            const r = row.round;
            return html`<tr><td class="muted">${row.index + 1}</td>
              <td class="l">${dot(r.bidder)}${nick(r.bidder)} <b>${r.bid}</b> ${row.made ? html`<span class="res ok">${icon('check')}</span>` : html`<span class="res ko">${icon('x')}</span>`} ${Object.values(r.melds || {}).flat().map(suitSym)}
                ${r.got != null ? html`<span class="muted small">ugrane ${r.got}</span>` : ''}${r.history ? html` <span class="badge" title="poprawiane">poprawiane</span>` : ''}</td>
              <td>${r.mode === 'online' ? 'online' : 'offline'}</td>
              ${[0, 1].map((t) => html`<td><b>${fmtNum(row.after[t])}</b><span class="d ${row.deltas[t] > 0 ? 'pos' : row.deltas[t] < 0 ? 'neg' : 'zero'}">${signed(row.deltas[t])}${row.notes[t].length ? ' · ' + row.notes[t].join(', ') : ''}</span></td>`)}</tr>`;
          })}</tbody></table></div>
        ${m.status === 'active' ? html`<p class="muted small">Poprawki rozdań wprowadzasz na stole – dotknij rozdania.</p>` : ''}
      </section>
      <section class="card"><h3>Licytacje w tym meczu</h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Gracz</th><th>Kontrakty</th><th>Ugrane</th><th>Skuteczność</th><th>Najwyższy</th><th>Meldunki</th><th>Lewy</th></tr></thead>
        <tbody>${m.seats.map((pid) => { const p = st.players[pid]; return html`<tr><td class="l">${dot(pid)}${nick(pid)}</td><td>${p.bids}</td><td>${p.made}</td><td>${pct(p.contractRate)}</td><td>${p.maxBid || '–'}</td><td>${p.meldPts}</td><td>${p.trickRounds ? p.tricks : '–'}</td></tr>`; })}</tbody></table></div>
      </section>
      <section class="card"><h3>Informacje</h3>
        <dl class="info">
          <dt>Zasady</dt><dd>do ${m.settings.target} · bez licytacji max ${c.cap} · zaokrąglanie ${m.settings.rounding === 'nearest10' ? 'do 10' : m.settings.rounding === 'down10' ? 'w dół do 10' : 'brak'} · kontrakt ${m.settings.contractCheck === 'raw' ? 'przed zaokrągleniem' : 'po zaokrągleniu'}</dd>
          <dt>Tryby</dt><dd>${(m.modeHistory || []).map((h) => html`<span class="badge">${h.mode} od rozdania ${h.afterRound + 1}</span> `)}</dd>
          <dt>Sesja</dt><dd>${meet ? html`<a href="#/session/${encodeURIComponent(meet.id)}">${fmtDateTime(meet.startedAt)}</a>` : '–'}</dd>
          ${m.migratedFrom ? html`<dt>Pochodzenie</dt><dd>przeniesiony ze starej aplikacji (wynik zweryfikowany co do punktu)</dd>` : ''}
        </dl>
      </section>`);
    if (c.rows.length) {
      lineChart(el.querySelector('#chMatch'), {
        labels: ['0', ...c.rows.map((r) => String(r.index + 1))],
        series: c.teams.map((t, i) => ({ label: t.map(nick).join(' & '), color: colorOf(t[0]), data: [0, ...c.rows.map((r) => r.after[i])] })),
        refs: [{ value: c.cap, label: 'limit' }, { value: c.settings.target, label: 'cel' }],
        xTitle: 'rozdanie',
      });
    }
  };
  draw();
  const unsub = subscribe((w) => { if (w === 'match:' + id || w === 'data') draw(); });
  return () => { unsub(); destroyCharts(el); };
}

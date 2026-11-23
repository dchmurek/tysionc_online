// Tryb offline: nowy mecz i stół z licznikiem punktów (prawdziwe karty).
import { html, mount, $, toast, confirmBox, dialog, fmtNum, signed, fmtDateTime, vibrate, raw } from '../dom.js';
import { state, nick, matchById, matchOp, createMatch, subscribe, post, pendingFor, loadData } from '../state.js';
import { computeMatch, validateRoundInput, teamOfUser, meldPointsOf } from '/shared/scoring.js';
import { SUIT_INFO, DEFAULT_SETTINGS, CARD_POINTS_TOTAL } from '/shared/rules.js';
import { icon, dot, colorOf, suitSym, teamDots } from '../ui.js';

const ROUNDING_LABEL = { nearest10: 'do najbliższej dziesiątki (5 w górę)', down10: 'w dół do dziesiątki', exact: 'bez zaokrąglania' };
const CHECK_LABEL = { raw: 'przed zaokrągleniem', rounded: 'po zaokrągleniu' };

// ---------------- Nowy mecz ----------------
export function newMatch({ el, go, setCta }) {
  const players = state.users.filter((u) => u.status !== 'disabled').sort((a, b) => a.nick.localeCompare(b.nick, 'pl'));
  const last = state.matches.filter((m) => m.seats.every((s) => players.some((p) => p.id === s))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const ng = { seats: last ? last.seats.slice() : [state.me.id, '', '', ''], settings: { ...DEFAULT_SETTINGS, ...(state.defaults || {}) }, firstDealerSeat: 0 };
  if (last) ng.firstDealerSeat = (last.seats.indexOf(last.rounds.at(-1)?.dealer ?? last.seats[3]) + 1) % 4;

  const seatSel = (i, label) => html`<label class="field"><span>${label}</span>
    <select data-seat="${i}"><option value="">— wybierz —</option>${players.map((p) => html`<option value="${p.id}" ${ng.seats[i] === p.id ? raw('selected') : ''}>${p.nick}${p.status === 'pending' ? ' (nieaktywne konto)' : ''}</option>`)}</select></label>`;
  const draw = () => {
    const S = ng.settings;
    mount(el, html`
      <a class="back" href="#/play">${icon('chevronLeft')}Wróć</a>
      <div class="page-head"><div><div class="eyebrow">Mecz offline · prawdziwe karty</div><h1 class="title-xl">Kto siada do stołu?</h1></div></div>
      <div class="teams">
        <div class="team"><div class="team-h">Drużyna A</div>${seatSel(0, 'Miejsce 1')}${seatSel(2, 'Miejsce 3 · naprzeciwko')}</div>
        <div class="team"><div class="team-h">Drużyna B</div>${seatSel(1, 'Miejsce 2')}${seatSel(3, 'Miejsce 4 · naprzeciwko')}</div>
      </div>
      <p class="hint">Miejsca w kolejności siedzenia przy stole (zgodnie z ruchem wskazówek zegara) – tak idzie rozdawanie. Partnerzy siedzą naprzeciwko.</p>
      <div class="row wrap">
        <button type="button" class="btn sm" data-act="swap">${icon('swap')}Zamień partnerów w drużynie B</button>
        <button type="button" class="btn sm" data-act="add-profile">${icon('plus')}Gracz bez konta</button>
      </div>
      <label class="field"><span>Pierwszy rozdaje</span><select data-act="dealer">${[0, 1, 2, 3].map((i) => html`<option value="${i}" ${ng.firstDealerSeat === i ? raw('selected') : ''}>Miejsce ${i + 1}${ng.seats[i] ? ' – ' + nick(ng.seats[i]) : ''}</option>`)}</select></label>
      <details class="rules">
        <summary>Zasady meczu (zapisywane w meczu, nie zmieniają się w trakcie)</summary>
        <div class="form-grid">
          <label class="field"><span>Gra do</span><input type="number" data-set="target" value="${S.target}" step="10" min="100"></label>
          <label class="field"><span>Bez licytacji max do</span><input type="number" data-set="passiveCap" value="${S.passiveCap}" step="10"></label>
          <label class="field"><span>Min. kontrakt</span><input type="number" data-set="minBid" value="${S.minBid}" step="10"></label>
          <label class="field"><span>Zaokrąglanie</span><select data-set="rounding">${Object.entries(ROUNDING_LABEL).map(([k, v]) => html`<option value="${k}" ${S.rounding === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
          <label class="field"><span>Kontrakt sprawdzany</span><select data-set="contractCheck">${Object.entries(CHECK_LABEL).map(([k, v]) => html`<option value="${k}" ${S.contractCheck === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
        </div>
        <p class="hint">Ugrany kontrakt = drużyna dostaje faktycznie zdobyte punkty (karty + meldunki). Nieugrany = minus kontrakt. Bez wygranej licytacji wynik rośnie najwyżej do ${S.passiveCap}; wygrywa się tylko ugranym kontraktem.</p>
      </details>`);
  };
  draw();
  setCta(html`<button class="btn-gold" data-act="start">Rozpocznij mecz <span>♠</span></button>`);
  const onInput = (e) => {
    const t = e.target;
    if (t.dataset.seat !== undefined) { ng.seats[Number(t.dataset.seat)] = t.value; draw(); }
    else if (t.dataset.act === 'dealer') ng.firstDealerSeat = Number(t.value);
    else if (t.dataset.set) {
      const k = t.dataset.set;
      ng.settings[k] = t.type === 'number' ? Number(t.value) : t.value;
    }
  };
  const onClick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'swap') { [ng.seats[1], ng.seats[3]] = [ng.seats[3], ng.seats[1]]; draw(); }
    if (a.dataset.act === 'add-profile') {
      const r = await dialog({ title: 'Gracz bez konta', body: html`<p class="muted small">Powstanie profil z trwałym ID. Gracz może później aktywować go kodem od administratora i przejąć swoje statystyki.</p>`, fields: [{ name: 'nick', label: 'Nick', required: true }], buttons: [{ label: 'Anuluj', value: false }, { label: 'Dodaj', value: true, kind: 'gold' }] });
      if (!r || !r.value) return;
      try {
        const { user } = await post('/api/users/profile', { nick: r.fields.nick });
        state.users.push(user);
        players.push(user);
        const free = ng.seats.indexOf('');
        if (free >= 0) ng.seats[free] = user.id;
        draw();
      } catch (ex) { toast(ex.message, { kind: 'bad' }); }
    }
    if (a.dataset.act === 'start') {
      if (ng.seats.some((s) => !s)) return toast('Wybierz czterech graczy');
      if (new Set(ng.seats).size !== 4) return toast('Każdy gracz może siedzieć tylko na jednym miejscu');
      try {
        const id = await createMatch({ seats: ng.seats, settings: ng.settings, firstDealerSeat: ng.firstDealerSeat });
        go('/match/' + encodeURIComponent(id), { replace: true });
      } catch (ex) { toast(ex.message, { kind: 'bad' }); }
    }
  };
  el.addEventListener('change', onInput);
  el.addEventListener('input', onInput);
  document.getElementById('cta').addEventListener('click', onClick);
  el.addEventListener('click', onClick);
  return () => document.getElementById('cta').removeEventListener('click', onClick);
}

// ---------------- Stół ----------------
const shown = {};

export function table({ el, params, go, setCta, setBar }) {
  const id = params.id;
  const ui = { logAll: false, sheet: null, draft: null, editId: null };
  const sheetRoot = document.createElement('div');
  document.body.appendChild(sheetRoot);

  const draw = () => {
    const m = matchById(id);
    if (!m) { mount(el, html`<div class="card empty">Nie ma takiego meczu w telefonie. <a href="#/">Wróć</a></div>`); setCta(''); return; }
    const c = computeMatch(m);
    const finished = m.status !== 'active';
    const lead = Math.max(...c.scores);
    const prev = shown[id] || c.scores;
    const dealer = c.nextDealer;
    const pend = pendingFor(id).length;
    setBar(html`<button class="icon-btn" data-act="menu" aria-label="Opcje meczu">${icon('more')}</button>`);
    const tiles = c.teams.map((team, t) => {
      const sc = c.scores[t];
      const pills = [];
      if (c.winner === t) pills.push(html`<span class="pill win">${icon('crown')}wygrana</span>`);
      if (c.atCap[t] && c.winner === null) pills.push(html`<span class="pill barrel">${c.cap} · tylko licytacja</span>`);
      if (!finished && team.includes(dealer)) pills.push(html`<span class="pill deal">rozdaje ${nick(dealer)}</span>`);
      const w = Math.max(0, Math.min(100, (sc / c.settings.target) * 100));
      const isLead = c.winner === null && sc === lead && sc > 0 && c.scores[1 - t] !== lead;
      return html`<div class="tile ${c.winner === t ? 'win' : ''} ${isLead ? 'lead' : ''}" style="--pc:${colorOf(team[0])}">
        <div class="tname">${teamDots(team)}<span>${team.map((p) => nick(p)).join(' & ')}</span></div>
        <div class="tscore ${sc < 0 ? 'neg' : ''}" data-from="${prev[t]}" data-to="${sc}">${fmtNum(prev[t])}</div>
        <div class="tmeta">${pills}</div>
        <div class="tbar"><i style="width:${w}%"></i><span class="mark" style="left:${(c.cap / c.settings.target) * 100}%"></span></div>
      </div>`;
    });
    const rows = c.rows.slice().reverse();
    const visible = ui.logAll ? rows : rows.slice(0, 6);
    const live = (state.rooms || []).find((r) => r.matchId === id);
    mount(el, html`
      <section class="felt">
        <div class="felt-meta"><span>4 na krzyż · ${m.mode === 'online' ? 'online' : 'offline'}</span>${finished
          ? html`<span>${m.status === 'abandoned' ? 'przerwany' : `${c.rows.length} rozdań`}</span>`
          : html`<span class="dealer">rozdanie ${c.rows.length + 1} · rozdaje <b>${nick(dealer)}</b></span>`}</div>
        <div class="scores n2">${tiles}</div>
      </section>
      ${live ? html`<a class="notice" href="#/room/${encodeURIComponent(live.id)}">${icon('wifi')} Ten mecz ma otwarty pokój online (kod ${live.code}) – przejdź do gry online</a>` : ''}
      ${pend ? html`<p class="notice warn">${icon('upload')} ${pend} ${pend === 1 ? 'zmiana czeka' : 'zmian czeka'} na wysłanie na serwer</p>` : ''}
      <section class="log">
        <div class="section-head"><span class="eyebrow">Rozdania</span>
          ${m.rounds.length && !finished && m.rounds.at(-1).mode !== 'online' ? html`<button class="btn sm" data-act="undo">${icon('undo')}Cofnij ostatnie</button>` : ''}</div>
        ${c.rows.length ? html`<div class="log-list" role="table">
          <div class="lrow head" role="row"><div>Kto · kontrakt</div>${c.teams.map((t) => html`<div class="num-col">${t.map((p) => nick(p).slice(0, 6)).join('/')}</div>`)}</div>
          ${visible.map((row) => roundRow(m, row))}
          ${rows.length > 6 ? html`<button class="log-more" data-act="log-all">${ui.logAll ? 'Pokaż mniej' : `Pokaż wszystkie (${rows.length})`}</button>` : ''}
        </div>` : html`<div class="log-list"><div class="empty"><div class="suits">♠ <span class="red">♥</span> ♣ <span class="red">♦</span></div>Jeszcze nic nie zagrano.<br>Dodaj pierwsze rozdanie przyciskiem poniżej.</div></div>`}
      </section>`);
    if (finished) setCta(html`<button class="btn-ghost" data-act="details">Szczegóły</button><button class="btn-gold" data-act="rematch">Rewanż <span>♠</span></button>`);
    else setCta(html`<button class="btn-gold" data-act="add">${icon('plus', 'lg')}Dodaj rozdanie</button>`);
    animate();
    shown[id] = c.scores.slice();
  };

  const roundRow = (m, row) => {
    const r = row.round;
    const melds = Object.values(r.melds || {}).flat();
    return html`<button type="button" class="lrow ${r.pending ? 'pending' : ''}" role="row" data-act="edit" data-id="${r.id}">
      <div class="who"><span class="n">${row.index + 1}</span>${dot(r.bidder)}<span class="pn">${nick(r.bidder)}</span><span class="bid">${r.bid}</span>
        ${row.made ? html`<span class="res ok" title="ugrany">${icon('check')}</span>` : html`<span class="res ko" title="nieugrany">${icon('x')}</span>`}
        ${melds.length ? html`<span class="melds-mini">${melds.map(suitSym)}</span>` : ''}${r.mode === 'online' ? html`<span class="tag-on" title="rozegrane online">${icon('wifi')}</span>` : ''}</div>
      ${[0, 1].map((t) => html`<div class="cell ${row.deltas[t] > 0 ? 'pos' : row.deltas[t] < 0 ? 'neg' : 'zero'}">${row.deltas[t] === 0 ? '0' : signed(row.deltas[t])}${row.notes[t].length ? html`<span class="note gold" title="${row.notes[t].join(', ')}">${icon('lock')}</span>` : ''}</div>`)}
    </button>`;
  };

  const animate = () => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.querySelectorAll('.tscore[data-to]').forEach((n) => {
      const from = Number(n.dataset.from), to = Number(n.dataset.to);
      if (from === to || reduce) { n.textContent = fmtNum(to); return; }
      const t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / 650); n.textContent = fmtNum(Math.round(from + (to - from) * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  };

  // ---------- arkusz rozdania ----------
  const newDraft = (m) => ({ bidder: null, bid: m.settings.minBid, opp: '', melds: {}, top: true });
  const draftToInput = (m, d) => {
    const bs = teamOfUser(m, d.bidder);
    return { bidder: d.bidder, bid: d.bid, cards: d.opp === '' ? {} : { [1 - bs]: Number(d.opp) }, melds: d.melds };
  };

  function openSheet(editId) {
    const m = matchById(id);
    if (editId) {
      const r = m.rounds.find((x) => x.id === editId);
      if (!r) return;
      if (r.mode === 'online') { toast('Rozdanie rozegrane online – wynik ustalił serwer z zagranych kart, nie można go poprawić ręcznie.'); return; }
      const bs = teamOfUser(m, r.bidder);
      const opp = r.cards[1 - bs] ?? r.cards[String(1 - bs)];
      ui.editId = editId;
      ui.draft = { bidder: r.bidder, bid: r.bid, opp: opp == null ? '' : String(opp), melds: JSON.parse(JSON.stringify(r.melds || {})), top: false, legacy: r.scoring === 'legacy' };
    } else {
      if (m.status !== 'active') return;
      ui.editId = null;
      if (!ui.draft || ui.draftFor !== m.rounds.length) ui.draft = newDraft(m);
      ui.draftFor = m.rounds.length;
    }
    ui.sheet = true;
    drawSheet(true);
  }

  function closeSheet() {
    ui.sheet = null;
    if (ui.editId) { ui.editId = null; ui.draft = null; }
    mount(sheetRoot, '');
    document.body.classList.remove('locked');
  }

  function drawSheet(first) {
    const m = matchById(id);
    const d = ui.draft;
    const S = computeMatch(m).settings;
    const body = $('.sheet-body', sheetRoot);
    const scroll = body ? body.scrollTop : 0;
    const editing = !!ui.editId;
    const editIdx = editing ? m.rounds.findIndex((r) => r.id === ui.editId) : m.rounds.length;
    let err = null;
    let preview = null;
    let ev = null;
    if (d.bidder) {
      try {
        const v = validateRoundInput(m, draftToInput(m, d));
        ev = v;
        const rounds = m.rounds.slice();
        rounds[editIdx] = { ...(editing ? m.rounds[editIdx] : {}), ...v, id: 'preview', mode: 'offline', dealer: editing ? m.rounds[editIdx].dealer : computeMatch(m).nextDealer, scoring: undefined };
        const pc = computeMatch({ ...m, rounds });
        preview = pc.rows[editIdx] ? { row: pc.rows[editIdx], winner: pc.winner, truncates: pc.winner !== null && pc.rows.length < rounds.length } : null;
      } catch (e) { err = e.message; }
    }
    const bs = d.bidder ? teamOfUser(m, d.bidder) : -1;
    const teams = computeMatch(m).teams;
    const oppTeam = bs >= 0 ? teams[1 - bs] : null;
    const taken = {};
    for (const [pid, l] of Object.entries(d.melds)) for (const s of l) taken[s] = pid;
    const chips = [];
    for (let b = S.minBid; b <= Math.max(S.minBid + 150, d.bid + 30) && b <= S.maxBid; b += S.bidStep) chips.push(b);
    const bidderMelds = bs >= 0 ? meldPointsOf(d.melds, teams[bs]) : 0;
    const oppMelds = bs >= 0 ? meldPointsOf(d.melds, teams[1 - bs]) : 0;
    const bidderCards = d.opp === '' ? null : CARD_POINTS_TOTAL - Number(d.opp);

    mount(sheetRoot, html`<div class="sheet-backdrop ${first ? '' : 'static'}" data-act="close-sheet"></div>
      <section class="sheet ${first ? '' : 'static'}" tabindex="-1" role="dialog" aria-modal="true" aria-label="${editing ? 'Poprawka rozdania' : 'Nowe rozdanie'}">
      <div class="sheet-grip"></div>
      <div class="sheet-head"><div><h2>${editing ? `Poprawka #${editIdx + 1}` : `Rozdanie ${m.rounds.length + 1}`}</h2>
        <div class="sub">rozdaje ${nick(editing ? m.rounds[editIdx].dealer : computeMatch(m).nextDealer)}</div></div>
        <button class="icon-btn" data-act="close-sheet" aria-label="Zamknij">${icon('x')}</button></div>
      <div class="sheet-body">
        ${d.legacy ? html`<p class="notice warn small">To rozdanie pochodzi ze starej aplikacji. Zapis poprawki przeliczy je według obecnych zasad (faktycznie ugrane punkty).</p>` : ''}
        ${d.bidder && !d.top ? html`<button class="summary" data-act="expand">${dot(d.bidder)}<b>${nick(d.bidder)}</b><span class="sb">${d.bid}</span><span class="chg">zmień</span></button>` : html`
          <div class="lbl">Kto wygrał licytację</div>
          <div class="pgrid">${m.seats.map((pid, i) => html`<button type="button" class="pbtn ${d.bidder === pid ? 'on' : ''}" data-act="bidder" data-pid="${pid}">${dot(pid)}<span>${nick(pid)}</span><small>${i % 2 === 0 ? 'A' : 'B'}</small></button>`)}</div>
          <div class="lbl">Kontrakt</div>
          <div class="bidrow"><button type="button" class="round-btn" data-act="bid-step" data-v="${-S.bidStep}" aria-label="Mniej">−</button><div class="bidval" aria-live="polite">${d.bid}</div><button type="button" class="round-btn" data-act="bid-step" data-v="${S.bidStep}" aria-label="Więcej">+</button></div>
          <div class="chips">${chips.map((b) => html`<button type="button" class="chip ${d.bid === b ? 'on' : ''}" data-act="bid" data-v="${b}">${b}</button>`)}</div>
          ${d.bidder ? html`<button type="button" class="btn sm wide" data-act="collapse">Dalej – punkty ${icon('chevronRight')}</button>` : ''}`}
        ${d.bidder ? html`
          <div class="lbl">Punkty przeciwników z kart</div>
          <div class="opps">
            <div class="ofield on"><div class="on-name">${teamDots(oppTeam)}${oppTeam.map((p) => nick(p)).join(' & ')}</div><div class="ov ${d.opp === '' ? 'ph' : ''}">${d.opp === '' ? '—' : d.opp}${oppMelds ? html`<span class="mb">+${oppMelds}</span>` : ''}</div></div>
            <div class="ofield got"><div class="on-name">${teamDots(teams[bs])}grający · razem</div><div class="ov ${bidderCards == null ? 'ph' : ''}">${bidderCards == null ? '—' : bidderCards + bidderMelds}</div>
              <div class="calc">${bidderCards == null ? 'wpisz punkty przeciwników' : `120 − ${d.opp}${bidderMelds ? ` + ${bidderMelds}` : ''}`}</div></div>
          </div>
          <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'].map((k) => html`<button type="button" class="key ${k.length > 1 ? 'fn' : ''}" data-act="key" data-k="${k}" aria-label="${k === 'del' ? 'Usuń cyfrę' : k === 'clr' ? 'Wyczyść' : k}">${k === 'del' ? icon('backspace') : k === 'clr' ? 'C' : k}</button>`)}</div>
          <div class="lbl">Meldunki <span class="muted">(król + dama w kolorze)</span></div>
          <div class="melds">${m.seats.map((pid) => html`<div class="meld-row"><div class="mn">${dot(pid)}${nick(pid)}${teamOfUser(m, pid) === bs ? html` <small>grający</small>` : ''}</div>
            ${Object.entries(SUIT_INFO).map(([s, info]) => html`<button type="button" class="mbtn ${info.red ? 'red' : ''} ${(d.melds[pid] || []).includes(s) ? 'on' : ''}" data-act="meld" data-pid="${pid}" data-s="${s}" ${taken[s] && taken[s] !== pid ? raw('disabled') : ''} aria-pressed="${(d.melds[pid] || []).includes(s)}"><span class="s">${info.symbol}︎</span><span class="v">${info.meld}</span></button>`)}</div>`)}</div>` : ''}
      </div>
      <div class="sheet-foot">
        <div class="preview" aria-live="polite">${!d.bidder ? html`<span class="muted">Wybierz, kto licytował.</span>` : err ? html`<span class="warnline">${err}</span>` : preview ? html`
          <span class="res-txt ${ev.made ? 'good' : 'bad'}">${ev.made ? html`${icon('check')}kontrakt ugrany (${ev.got})` : html`${icon('x')}nieugrany (${ev.got} < ${d.bid})`}</span>
          ${[0, 1].map((t) => html`<span class="pv">${teams[t].map((p) => nick(p).slice(0, 5)).join('/')} <b class="${preview.row.deltas[t] < 0 ? 'bad' : preview.row.deltas[t] > 0 ? 'good' : ''}">${signed(preview.row.deltas[t])}</b> → <b>${fmtNum(preview.row.after[t])}</b>${preview.row.notes[t].length ? html` <span class="note">${preview.row.notes[t].join(', ')}</span>` : ''}</span>`)}
          ${preview.winner !== null ? html`<span class="good">${icon('crown')} wygrywa ${teams[preview.winner].map(nick).join(' & ')}</span>` : ''}` : ''}</div>
        <button type="button" class="btn-gold wide" data-act="save" ${!d.bidder || err ? raw('disabled') : ''}>${editing ? 'Zapisz poprawkę' : 'Zapisz rozdanie'}</button>
      </div></section>`);
    document.body.classList.add('locked');
    const nb = $('.sheet-body', sheetRoot);
    if (!first && nb) nb.scrollTop = scroll;
    const on = $('.chip.on', sheetRoot);
    if (on && first) on.parentElement.scrollLeft = on.offsetLeft - on.parentElement.clientWidth / 2;
    if (first) $('.sheet', sheetRoot).focus?.();
  }

  async function save() {
    const m = matchById(id);
    const d = ui.draft;
    const input = draftToInput(m, d);
    try {
      if (ui.editId) {
        const idx = m.rounds.findIndex((r) => r.id === ui.editId);
        const v = validateRoundInput(m, input);
        const rounds = m.rounds.slice();
        rounds[idx] = { ...rounds[idx], ...v, scoring: undefined };
        const pc = computeMatch({ ...m, rounds });
        let truncate = false;
        if (pc.winner !== null && pc.rows.length < rounds.length) {
          if (!(await confirmBox('Mecz kończy się wcześniej', `Po tej poprawce mecz kończy się na rozdaniu ${pc.rows.length}. Usunąć późniejsze rozdania (${rounds.length - pc.rows.length})?`, 'Usuń i zapisz', 'danger'))) return;
          truncate = true;
        }
        await matchOp('editRound', id, { round: input, truncate }, { roundId: ui.editId });
        toast('Poprawka zapisana');
      } else {
        await matchOp('addRound', id, { round: input });
        vibrate(15);
      }
      ui.draft = null;
      closeSheet();
      const after = matchById(id);
      if (after.status === 'finished') {
        const c = computeMatch(after);
        setTimeout(() => toast(`Wygrywa ${c.teams[c.winner].map(nick).join(' & ')}!`), 250);
      }
      draw();
    } catch (e) {
      toast(e.message, { kind: 'bad' });
    }
  }

  async function openMenu() {
    const m = matchById(id);
    const finished = m.status !== 'active';
    const r = await dialog({
      title: 'Mecz',
      body: html`<p class="muted small">${fmtDateTime(m.createdAt)} · zasady: do ${m.settings.target}, zaokrąglanie ${ROUNDING_LABEL[m.settings.rounding]}, kontrakt ${CHECK_LABEL[m.settings.contractCheck]}</p>`,
      buttons: [
        { label: 'Szczegóły i wykres', value: 'details' },
        ...(!finished ? [{ label: 'Kontynuuj online', value: 'online', kind: 'gold' }, { label: 'Przerwij mecz', value: 'abandon' }] : []),
        ...(m.status === 'abandoned' ? [{ label: 'Wznów mecz', value: 'reopen' }] : []),
        ...(m.status === 'finished' ? [{ label: 'Rewanż', value: 'rematch', kind: 'gold' }] : []),
        { label: 'Usuń mecz', value: 'delete', kind: 'danger' },
        { label: 'Zamknij', value: null },
      ],
    });
    if (r) handle(r);
  }

  async function handle(act) {
    const m = matchById(id);
    try {
      if (act === 'details') go(`/match/${encodeURIComponent(id)}/details`);
      if (act === 'abandon' && (await confirmBox('Przerwać mecz?', 'Przerwany mecz nie liczy się do wygranych. Można go później wznowić.', 'Przerwij'))) { await matchOp('status', id, { status: 'abandoned' }); draw(); }
      if (act === 'reopen') { await matchOp('status', id, { status: 'active' }); draw(); }
      if (act === 'delete' && (await confirmBox('Usunąć mecz?', 'Mecz zniknie z historii i statystyk. Administrator może go przywrócić.', 'Usuń', 'danger'))) { await matchOp('status', id, { status: 'deleted' }); go('/history', { replace: true }); }
      if (act === 'online') {
        if (pendingFor(id).length) return toast('Najpierw muszą się wysłać zapisane wyniki (brak internetu?)');
        const { room } = await post('/api/rooms', { fromMatchId: id });
        await loadData();
        go('/room/' + encodeURIComponent(room.id));
      }
      if (act === 'rematch') {
        const lastDealerSeat = m.seats.indexOf(m.rounds.at(-1)?.dealer);
        const nid = await createMatch({ seats: m.seats, settings: m.settings, firstDealerSeat: (lastDealerSeat + 1) % 4 });
        go('/match/' + encodeURIComponent(nid), { replace: true });
      }
    } catch (e) { toast(e.message, { kind: 'bad' }); }
  }

  const onClick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a || a.disabled) return;
    const m = matchById(id);
    const d = ui.draft;
    switch (a.dataset.act) {
      case 'add': openSheet(); break;
      case 'edit': openSheet(a.dataset.id); break;
      case 'close-sheet': closeSheet(); break;
      case 'menu': openMenu(); break;
      case 'details': handle('details'); break;
      case 'rematch': handle('rematch'); break;
      case 'log-all': ui.logAll = !ui.logAll; draw(); break;
      case 'bidder': d.bidder = a.dataset.pid; drawSheet(); break;
      case 'bid': d.bid = Number(a.dataset.v); drawSheet(); break;
      case 'bid-step': d.bid = Math.min(m.settings.maxBid, Math.max(m.settings.minBid, d.bid + Number(a.dataset.v))); drawSheet(); break;
      case 'collapse': d.top = false; drawSheet(); $('.sheet-body', sheetRoot).scrollTop = 0; break;
      case 'expand': d.top = true; drawSheet(); $('.sheet-body', sheetRoot).scrollTop = 0; break;
      case 'key': {
        let v = d.opp;
        const k = a.dataset.k;
        if (k === 'del') v = v.slice(0, -1); else if (k === 'clr') v = ''; else if (v.length < 3) v = (v === '0' ? '' : v) + k;
        if (v !== '' && Number(v) > 120) { toast('Najwyżej 120 punktów z kart'); return; }
        d.opp = v;
        drawSheet();
        break;
      }
      case 'meld': {
        const list = (d.melds[a.dataset.pid] = d.melds[a.dataset.pid] || []);
        const i = list.indexOf(a.dataset.s);
        if (i >= 0) list.splice(i, 1); else list.push(a.dataset.s);
        if (!list.length) delete d.melds[a.dataset.pid];
        drawSheet();
        break;
      }
      case 'save': save(); break;
      case 'undo': {
        const last = m.rounds.at(-1);
        const snapshot = { bidder: last.bidder, bid: last.bid, cards: last.cards, melds: last.melds };
        try {
          await matchOp('undo', id);
          draw();
          vibrate(10);
          const legacy = last.scoring === 'legacy';
          toast(`Cofnięto rozdanie ${m.rounds.length + 1}`, legacy ? {} : { action: 'Przywróć', onAction: async () => { try { await matchOp('addRound', id, { round: snapshot }); draw(); } catch (ex) { toast(ex.message, { kind: 'bad' }); } } });
        } catch (ex) { toast(ex.message, { kind: 'bad' }); }
        break;
      }
      default:
    }
  };
  const onKey = (e) => {
    if (!ui.sheet) return;
    if (e.key === 'Escape') return closeSheet();
    if (!ui.draft || !ui.draft.bidder || e.target.tagName === 'INPUT') return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); sheetRoot.querySelector(`[data-k="${e.key}"]`)?.click(); }
    else if (e.key === 'Backspace') { e.preventDefault(); sheetRoot.querySelector('[data-k="del"]')?.click(); }
    else if (e.key === 'Enter') { e.preventDefault(); sheetRoot.querySelector('[data-act="save"]')?.click(); }
  };
  draw();
  el.addEventListener('click', onClick);
  sheetRoot.addEventListener('click', onClick);
  const cta = document.getElementById('cta');
  const bar = document.getElementById('barAction');
  cta.addEventListener('click', onClick);
  bar.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  const unsub = subscribe((w) => { if ((w === 'match:' + id || w === 'data' || w === 'sync') && !ui.sheet) draw(); });
  return () => {
    unsub();
    cta.removeEventListener('click', onClick);
    bar.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
    sheetRoot.remove();
    document.body.classList.remove('locked');
  };
}

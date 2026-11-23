// Tryb online: poczekalnia (pokoje) i stół gry. Stan gry przychodzi wyłącznie z serwera (WebSocket).
import { html, mount, $, toast, confirmBox, fmtNum, signed, raw, vibrate } from '../dom.js';
import { state, nick, matchById, refreshMatch, subscribe, post, get, loadData } from '../state.js';
import { subscribeRoom, unsubscribeRoom, onWs, act as wsAct, connect, wsState } from '../ws.js';
import { computeMatch } from '/shared/scoring.js';
import { SUIT_INFO, DEFAULT_SETTINGS } from '/shared/rules.js';
import { icon, dot, colorOf, card, suitSym, teamDots } from '../ui.js';

const STATUS = { lobby: 'Poczekalnia', playing: 'Trwa rozdanie', between: 'Przerwa między rozdaniami', finished: 'Mecz zakończony', closed: 'Pokój zamknięty' };

export function lobby({ el, go }) {
  const s = { ...DEFAULT_SETTINGS, ...(state.defaults || {}) };
  const activeMine = state.matches.filter((m) => m.status === 'active' && m.seats.includes(state.me.id));
  mount(el, html`
    <a class="back" href="#/play">${icon('chevronLeft')}Wróć</a>
    <div class="page-head"><div><div class="eyebrow">Gra online</div><h1 class="title-xl">Pokoje</h1></div></div>
    <div class="grid-2">
      <section class="card">
        <h3>Dołącz kodem</h3>
        <form class="join" data-form="join">
          <label class="field"><span>Kod zaproszenia (6 znaków)</span><input name="code" required minlength="6" maxlength="7" autocapitalize="characters" autocomplete="off" spellcheck="false" class="mono code-in" placeholder="ABC123"></label>
          <button class="btn gold wide" type="submit">Dołącz</button>
        </form>
      </section>
      <section class="card">
        <h3>Nowy pokój</h3>
        <form data-form="create">
          <div class="form-grid">
            <label class="field"><span>Gra do</span><input type="number" name="target" value="${s.target}" step="10" min="100"></label>
            <label class="field"><span>Zaokrąglanie</span><select name="rounding"><option value="nearest10" ${s.rounding === 'nearest10' ? raw('selected') : ''}>do najbliższej 10</option><option value="down10" ${s.rounding === 'down10' ? raw('selected') : ''}>w dół do 10</option><option value="exact" ${s.rounding === 'exact' ? raw('selected') : ''}>bez zaokrąglania</option></select></label>
          </div>
          <details class="rules"><summary>Zasady rozgrywki</summary>
            <label class="check"><input type="checkbox" name="mustBeat" ${s.mustBeat ? raw('checked') : ''}> Obowiązek przebicia (do koloru i atutem)</label>
            <label class="check"><input type="checkbox" name="mustTrump" ${s.mustTrump ? raw('checked') : ''}> Brak koloru → obowiązek dania atutu</label>
            <label class="check"><input type="checkbox" name="meldOnFirstTrick" ${s.meldOnFirstTrick ? raw('checked') : ''}> Meldunek dozwolony już w pierwszej lewie</label>
            <p class="hint">Licytację otwiera obowiązkowo gracz po lewej rozdającego (${s.minBid}). Licytuje się co ${s.bidStep}, bez ograniczeń wynikających z meldunków.</p>
          </details>
          <button class="btn gold wide" type="submit">Utwórz pokój</button>
        </form>
      </section>
    </div>
    ${activeMine.length ? html`<section class="card"><h3>Kontynuuj swój mecz online</h3>
      <p class="muted small">Wynik, drużyny i historia zostają – zaczyna się nowe cyfrowe rozdanie.</p>
      ${activeMine.map((m) => { const c = computeMatch(m); return html`<button type="button" class="game-card" data-act="continue" data-id="${m.id}"><div class="gc-main"><div class="gc-sides">${c.teams.map((t, i) => html`<span>${teamDots(t)} ${t.map(nick).join(' & ')} <b class="num">${fmtNum(c.scores[i])}</b></span>`)}</div><div class="gc-meta">${m.rounds.length} rozdań</div></div><span class="chev">${icon('wifi')}</span></button>`; })}
    </section>` : ''}
    ${(state.rooms || []).length ? html`<section class="card"><h3>Twoje pokoje</h3>${state.rooms.map((r) => html`<a class="game-card" href="#/room/${encodeURIComponent(r.id)}"><div class="gc-main"><div class="gc-sides"><span>Kod <b class="mono">${r.code}</b></span></div><div class="gc-meta">${STATUS[r.status]}</div></div><span class="chev">${icon('chevronRight')}</span></a>`)}</section>` : ''}`);
  const onSubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (f.dataset.form === 'join') {
        const { room } = await post('/api/rooms/join', { code: f.code.value });
        go('/room/' + encodeURIComponent(room.id));
      } else {
        const fd = new FormData(f);
        const settings = { target: Number(fd.get('target')), rounding: fd.get('rounding'), mustBeat: !!fd.get('mustBeat'), mustTrump: !!fd.get('mustTrump'), meldOnFirstTrick: !!fd.get('meldOnFirstTrick') };
        const { room } = await post('/api/rooms', { settings });
        go('/room/' + encodeURIComponent(room.id));
      }
    } catch (ex) { toast(ex.network ? 'Gra online wymaga internetu' : ex.message, { kind: 'bad' }); } finally { btn.disabled = false; }
  };
  const onClick = async (e) => {
    const a = e.target.closest('[data-act="continue"]');
    if (!a) return;
    try {
      const { room } = await post('/api/rooms', { fromMatchId: a.dataset.id });
      go('/room/' + encodeURIComponent(room.id));
    } catch (ex) { toast(ex.message, { kind: 'bad' }); }
  };
  el.addEventListener('submit', onSubmit);
  el.addEventListener('click', onClick);
}

export function room({ el, params, go, setCta, setBar }) {
  const roomId = params.id;
  let view = null;
  let online = [];
  let selected = null;
  let lastHandNo = null;
  let busy = false;
  let lastTrickShownFor = null;

  connect();
  subscribeRoom(roomId);
  // pierwszy stan także przez HTTP (szybciej i działa, gdy WebSocket dopiero się łączy)
  get('/api/rooms/' + encodeURIComponent(roomId)).then((r) => { if (!view) { view = r.room; draw(); } }).catch((e) => { mount(el, html`<div class="card empty">${e.message}<br><a class="btn" href="#/online">Pokoje</a></div>`); });

  const send = async (action) => {
    if (busy) return;
    busy = true;
    try {
      await wsAct(roomId, view && ['bid', 'pass', 'play'].includes(action.type) ? { ...action, expectSeq: view.seq } : action);
      vibrate(8);
    } catch (e) {
      toast(e.message, { kind: 'bad' });
    } finally {
      busy = false;
    }
  };

  const rel = (seat) => {
    const me = view.mySeat >= 0 ? view.mySeat : 0;
    return ['bottom', 'left', 'top', 'right'][(seat - me + 4) % 4];
  };

  function draw() {
    if (!view) { mount(el, html`<div class="loading"><span class="spinner"></span>Łączenie ze stołem…</div>`); return; }
    setBar(html`<span class="conn ${wsState.connected ? 'on' : 'off'}" title="${wsState.connected ? 'połączono' : 'łączenie…'}">${icon('wifi')}</span><a class="icon-btn" href="#/" aria-label="Wyjdź do menu (gra trwa dalej)">${icon('home')}</a>`);
    if (view.status === 'lobby') return drawLobby();
    return drawTable();
  }

  function drawLobby() {
    const meSeated = view.mySeat >= 0;
    const allReady = view.seats.every(Boolean) && view.ready.every(Boolean);
    const m = view.matchId ? matchById(view.matchId) : null;
    mount(el, html`
      <a class="back" href="#/online">${icon('chevronLeft')}Pokoje</a>
      <div class="page-head"><div><div class="eyebrow">${m ? 'Kontynuacja meczu' : 'Nowy mecz online'}</div><h1 class="title-xl">Poczekalnia</h1></div></div>
      <section class="card code-card">
        <div class="muted small">Kod zaproszenia</div>
        <div class="room-code mono" aria-label="Kod ${view.code.split('').join(' ')}">${view.code}</div>
        <button type="button" class="btn sm" data-act="copy">${icon('copy')}Kopiuj zaproszenie</button>
      </section>
      ${view.reservedSeats ? html`<p class="hint">Miejsca są przypisane z meczu – każdy gracz siada automatycznie po dołączeniu kodem.</p>` : html`<p class="hint">Partnerzy siedzą naprzeciwko: drużyna A to miejsca 1 i 3, drużyna B – 2 i 4.</p>`}
      <div class="lobby-seats">${[0, 1, 2, 3].map((s) => {
        const u = view.seats[s];
        const reserved = view.reservedSeats ? view.reservedSeats[s] : null;
        return html`<div class="lseat team-${s % 2 ? 'b' : 'a'} ${u === state.me.id ? 'me' : ''}">
          <div class="ls-h">Miejsce ${s + 1} · drużyna ${s % 2 ? 'B' : 'A'}</div>
          ${u ? html`<div class="ls-u">${dot(u)}<b>${nick(u)}</b>${online.includes(u) ? html`<span class="online-dot" title="online"></span>` : html`<span class="muted small">offline</span>`}</div>
              <div class="ls-r ${view.ready[s] ? 'ok' : ''}">${view.ready[s] ? html`${icon('check')}gotowy` : 'czeka'}</div>`
            : reserved ? html`<div class="ls-u muted">${dot(reserved)}${nick(reserved)} – jeszcze nie dołączył</div>`
              : html`<button type="button" class="btn sm" data-act="sit" data-seat="${s}">Usiądź tutaj</button>`}
        </div>`;
      })}</div>
      <section class="card"><h3>W pokoju</h3><div class="members">${view.members.map((u) => html`<span class="member">${dot(u)}${nick(u)}${online.includes(u) ? html`<span class="online-dot"></span>` : ''}</span>`)}</div></section>
      <div class="row wrap">
        ${meSeated && !view.reservedSeats ? html`<button type="button" class="btn sm" data-act="stand">Wstań</button>` : ''}
        <button type="button" class="btn sm" data-act="leave">Opuść pokój</button>
        ${m ? html`<button type="button" class="btn sm" data-act="detach">${icon('cards')}Wróć do trybu offline</button>` : ''}
      </div>`);
    if (meSeated) {
      const myReady = view.ready[view.mySeat];
      setCta(html`<button class="btn-ghost" data-act="ready">${myReady ? 'Jednak nie gotowy' : 'Jestem gotowy'}</button><button class="btn-gold" data-act="start" ${allReady ? '' : raw('disabled')}>Start ♠</button>`);
    } else setCta('');
  }

  function scoresOf() {
    const m = view.matchId ? matchById(view.matchId) : null;
    if (!m) return null;
    return { m, c: computeMatch(m) };
  }

  function seatBox(seat, h) {
    const u = view.seats[seat];
    const pos = rel(seat);
    const turn = h && h.turn === seat && h.phase !== 'finished';
    const bidH = h && h.phase === 'bidding' ? [...h.bidding.history].reverse().find((x) => x.seat === seat) : null;
    const melds = h ? h.melds.filter((x) => x.seat === seat) : [];
    return html`<div class="seat-box ${pos} team-${seat % 2 ? 'b' : 'a'} ${turn ? 'turn' : ''} ${u === state.me.id ? 'me' : ''}">
      <div class="sb-name">${dot(u)}<b>${nick(u)}</b>${h && h.dealerSeat === seat ? html`<span class="chipd" title="rozdaje">R</span>` : ''}${online.includes(u) ? '' : html`<span class="badge warn" title="rozłączony">offline</span>`}</div>
      <div class="sb-meta">${h ? html`${pos !== 'bottom' ? html`<span class="backs">${Array.from({ length: h.handCounts[seat] }, () => card(null, { back: true, small: true }))}</span>` : ''}
        <span class="muted small">lewy: ${h.tricksWon[seat]}</span>` : ''}
        ${bidH ? html`<span class="bubble ${bidH.type}">${bidH.type === 'pass' ? 'pas' : bidH.value}</span>` : ''}
        ${melds.map((x) => html`<span class="meld-badge">${suitSym(x.suit)} ${x.value}</span>`)}</div>
    </div>`;
  }

  function drawTable() {
    const h = view.hand;
    const sc = scoresOf();
    const me = view.mySeat;
    const myTurn = h && h.turn === me && h.phase !== 'finished';
    const contract = h && h.contract;
    const center = h && h.trick && h.trick.cards.length ? h.trick.cards : (h && h.lastTrick ? h.lastTrick.cards : []);
    const showingLast = h && h.trick && !h.trick.cards.length && h.lastTrick;
    const teamsTxt = sc ? sc.c.teams : [[view.seats[0], view.seats[2]], [view.seats[1], view.seats[3]]];
    mount(el, html`
      <div class="game">
        <div class="gbar">
          ${[0, 1].map((t) => html`<div class="gscore team-${t ? 'b' : 'a'} ${sc && sc.c.winner === t ? 'win' : ''}"><span class="gs-n">${teamDots(teamsTxt[t])}${teamsTxt[t].map((p) => nick(p)).join(' & ')}</span><b class="gs-v">${sc ? fmtNum(sc.c.scores[t]) : '–'}</b></div>`)}
          <div class="ginfo">
            ${contract ? html`<span class="gi">kontrakt <b>${contract.value}</b> · ${nick(view.seats[contract.seat])}</span>` : h && h.phase === 'bidding' ? html`<span class="gi">licytacja: <b>${h.bidding.highest}</b> · ${nick(view.seats[h.bidding.highestSeat])}</span>` : ''}
            <span class="gi">atut ${h && h.trump ? suitSym(h.trump) : html`<span class="muted">brak</span>`}</span>
            <span class="gi">rozdanie ${view.handNo}</span>
          </div>
        </div>
        <div class="felt-table" aria-label="Stół">
          ${[0, 1, 2, 3].map((s) => seatBox(s, h))}
          <div class="trick ${showingLast ? 'last' : ''}">
            ${center.map((x) => html`<div class="tc ${rel(x.seat)}">${card(x.card)}</div>`)}
            ${showingLast ? html`<div class="trick-note">lewę bierze ${nick(view.seats[h.lastTrick.winner])} (+${h.lastTrick.points})</div>` : ''}
            ${h && !center.length ? html`<div class="trick-note">${h.phase === 'bidding' ? 'licytacja' : myTurn ? 'wyjdź kartą' : ''}</div>` : ''}
          </div>
        </div>
        <div class="turn-line ${myTurn ? 'mine' : ''}" aria-live="polite">${!h ? '' : h.phase === 'bidding' ? (myTurn ? 'Twoja kolej w licytacji' : `Licytuje: ${nick(view.seats[h.turn])}`) : h.phase === 'playing' ? (myTurn ? 'Twój ruch' : `Ruch: ${nick(view.seats[h.turn])}`) : ''}</div>
        ${view.status === 'playing' && h ? drawControls(h, myTurn) : drawResult()}
        ${me >= 0 && h ? html`<div class="hand" role="group" aria-label="Twoje karty">${h.hand.map((c) => card(c, { act: 'card', playable: myTurn && h.phase === 'playing' && h.legal.includes(c), dim: myTurn && h.phase === 'playing' && !h.legal.includes(c), selected: selected === c, meld: h.meldable.includes(c) }))}</div>` : me < 0 ? html`<p class="muted small center">Oglądasz grę – nie siedzisz przy stole.</p>` : ''}
        ${state.me.role === 'admin' && view.status === 'playing' ? html`<button type="button" class="btn sm danger" data-act="abort">Unieważnij rozdanie (admin)</button>` : ''}
        <details class="glog"><summary>Ostatnie akcje</summary><ol>${(view.log || []).slice().reverse().map((x) => html`<li>${x.type === 'abort' ? 'Rozdanie unieważnione przez administratora' : html`${nick(view.seats[x.seat])}: `}${x.type === 'abort' ? '' : x.type === 'bid' ? `licytuje ${x.value}` : x.type === 'pass' ? 'pas' : html`${x.meld ? 'melduje i ' : ''}zagrywa ${card(x.card, { small: true })}`}</li>`)}</ol></details>
      </div>`);
    setCta('');
  }

  function drawControls(h, myTurn) {
    if (!myTurn) return html`<div class="controls muted small">${h.phase === 'bidding' ? html`Historia licytacji: ${h.bidding.history.map((x) => html`<span class="hb">${nick(view.seats[x.seat])} ${x.type === 'pass' ? 'pas' : x.value}${x.forced ? ' (obowiązkowe)' : ''}</span>`)}` : ''}</div>`;
    if (h.phase === 'bidding') {
      const step = h.settings.bidStep;
      const opts = [];
      for (let v = h.bidding.highest + step; v <= Math.min(h.settings.maxBid, h.bidding.highest + step * 12); v += step) opts.push(v);
      return html`<div class="controls bidding">
        <div class="muted small">Najwyższa: <b>${h.bidding.highest}</b> (${nick(view.seats[h.bidding.highestSeat])})</div>
        <div class="bid-opts">${opts.map((v) => html`<button type="button" class="chip" data-act="bid" data-v="${v}">${v}</button>`)}</div>
        <button type="button" class="btn danger wide" data-act="pass">Pas</button>
      </div>`;
    }
    if (selected && h.legal.includes(selected)) {
      const meld = h.meldable.includes(selected);
      const s = selected[1];
      return html`<div class="controls play">
        <button type="button" class="btn-gold" data-act="play">Zagraj ${card(selected, { small: true })}</button>
        ${meld ? html`<button type="button" class="btn gold" data-act="play-meld">Melduj ${suitSym(s)} ${SUIT_INFO[s].meld} i zagraj</button>` : ''}
      </div>`;
    }
    return html`<div class="controls muted small">${h.meldable.length ? 'Masz meldunek – wybierz króla lub damę, aby zameldować.' : 'Wybierz kartę (podświetlone są dozwolone).'}</div>`;
  }

  function drawResult() {
    const lh = view.lastHand;
    const sc = scoresOf();
    const me = view.mySeat;
    if (!lh) return view.status === 'between' && view.mySeat >= 0 ? (setTimeout(() => setCta(html`<button class="btn-ghost" data-act="detach">Tryb offline</button><button class="btn-gold" data-act="ready" ${view.ready[view.mySeat] ? raw('disabled') : ''}>Następne rozdanie ♠</button>`)), html`<p class="notice warn">Rozdanie zostało unieważnione.</p>`) : '';
    const teams = sc ? sc.c.teams : [[view.seats[0], view.seats[2]], [view.seats[1], view.seats[3]]];
    const meldTeam = [0, 1].map((t) => lh.melds.filter((x) => x.team === t).reduce((a, x) => a + x.value, 0));
    const myReady = me >= 0 && view.ready[me];
    const out = html`<section class="card result">
      <h3>${view.status === 'finished' ? html`${icon('crown')} Wygrywają ${teams[lh.winner].map(nick).join(' & ')}!` : `Rozdanie ${lh.handNo} zakończone`}</h3>
      <p>Kontrakt <b>${lh.contract.value}</b> – ${nick(view.seats[lh.contract.seat])}: ${lh.made ? html`<span class="good">ugrany</span>` : html`<span class="bad">nieugrany</span>`}</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Drużyna</th><th>Karty</th><th>Meldunki</th><th>Zmiana</th><th>Wynik</th></tr></thead>
      <tbody>${[0, 1].map((t) => html`<tr><td class="l">${teamDots(teams[t])} ${teams[t].map(nick).join(' & ')}</td><td>${lh.cardPoints[t]}</td><td>${meldTeam[t]}</td><td class="${lh.deltas[t] > 0 ? 'good' : lh.deltas[t] < 0 ? 'bad' : ''}">${signed(lh.deltas[t])}</td><td><b>${fmtNum(lh.scores[t])}</b></td></tr>`)}</tbody></table></div>
      ${view.status === 'between' ? html`<p class="muted small">Gotowi: ${view.seats.filter((_, i) => view.ready[i]).map(nick).join(', ') || 'nikt'}</p>` : ''}
    </section>`;
    if (view.status === 'between' && me >= 0) setTimeout(() => setCta(html`<button class="btn-ghost" data-act="detach">Tryb offline</button><button class="btn-gold" data-act="ready" ${myReady ? raw('disabled') : ''}>${myReady ? 'Czekam na innych…' : 'Następne rozdanie ♠'}</button>`));
    if (view.status === 'finished') setTimeout(() => setCta(html`<button class="btn-ghost" data-act="match">Szczegóły meczu</button>${me >= 0 ? html`<button class="btn-gold" data-act="rematch">Rewanż ♠</button>` : ''}`));
    return out;
  }

  const onClick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a || a.disabled || !view) return;
    const h = view.hand;
    switch (a.dataset.act) {
      case 'sit': send({ type: 'sit', seat: Number(a.dataset.seat) }); break;
      case 'stand': send({ type: 'stand' }); break;
      case 'ready': send({ type: 'ready', ready: !(view.mySeat >= 0 && view.ready[view.mySeat] && view.status === 'lobby') }); break;
      case 'start': send({ type: 'start' }); break;
      case 'leave': await send({ type: 'leave' }); go('/online'); break;
      case 'detach':
        if (await confirmBox('Przejść do trybu offline?', 'Mecz będzie kontynuowany z prawdziwymi kartami – wynik i historia zostają. Pokój online zostanie zamknięty.', 'Przejdź')) {
          const mid = view.matchId;
          await send({ type: 'detach' });
          await loadData();
          if (mid) go('/match/' + encodeURIComponent(mid), { replace: true });
        }
        break;
      case 'rematch': send({ type: 'rematch' }); break;
      case 'abort':
        if (await confirmBox('Unieważnić rozdanie?', 'Rozdanie zostanie przerwane bez zapisu punktów. Używaj tylko, gdy gra nie może być kontynuowana.', 'Unieważnij', 'danger')) send({ type: 'abort-hand' });
        break;
      case 'match': go('/match/' + encodeURIComponent(view.matchId) + '/details'); break;
      case 'copy': {
        const text = `Zagraj w Tysiąca: ${location.origin}/#/online – kod ${view.code}`;
        try { await navigator.clipboard.writeText(text); toast('Skopiowano zaproszenie'); } catch { toast('Kod: ' + view.code); }
        break;
      }
      case 'bid': send({ type: 'bid', value: Number(a.dataset.v) }); break;
      case 'pass': send({ type: 'pass' }); break;
      case 'card': {
        const c = a.dataset.card;
        if (!h || h.phase !== 'playing' || h.turn !== view.mySeat) return;
        if (!h.legal.includes(c)) { toast('Tej karty nie można teraz zagrać'); return; }
        if (selected === c && !h.meldable.includes(c)) { selected = null; send({ type: 'play', card: c }); return; }
        selected = c;
        draw();
        break;
      }
      case 'play': { const c = selected; selected = null; send({ type: 'play', card: c }); break; }
      case 'play-meld': { const c = selected; selected = null; send({ type: 'play', card: c, meld: true }); break; }
      default:
    }
  };

  const unWs = onWs((m) => {
    if (m.type === 'room' && m.roomId === roomId) {
      if (m.closed || !m.room) {
        toast('Pokój został zamknięty');
        const mid = view && view.matchId;
        loadData().then(() => go(mid && matchById(mid) && matchById(mid).status === 'active' ? '/match/' + encodeURIComponent(mid) : '/online', { replace: true }));
        return;
      }
      const prev = view;
      view = m.room;
      online = m.room.online || online;
      if (view.lastHand && view.lastHand.handNo !== lastHandNo) { lastHandNo = view.lastHand.handNo; if (view.matchId) refreshMatch(view.matchId); }
      if (view.matchId && !matchById(view.matchId)) loadData();
      if (prev && prev.hand && view.hand && view.hand.turn === view.mySeat && prev.hand.turn !== view.mySeat) vibrate([10, 40, 10]);
      if (selected && (!view.hand || !view.hand.hand.includes(selected))) selected = null;
      draw();
    }
    if (m.type === 'status') draw();
  });
  const unSub = subscribe((w) => { if (view && view.matchId && w === 'match:' + view.matchId) draw(); });
  el.addEventListener('click', onClick);
  const cta = document.getElementById('cta');
  cta.addEventListener('click', onClick);
  draw();
  return () => { unWs(); unSub(); unsubscribeRoom(roomId); cta.removeEventListener('click', onClick); };
}

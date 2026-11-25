// Tryb online: poczekalnia (pokoje) i stół gry. Stan gry przychodzi wyłącznie z serwera (WebSocket).
import { html, mount, $, toast, confirmBox, fmtNum, signed, raw, vibrate, copyText } from '../dom.js';
import { state, nick, matchById, refreshMatch, subscribe, post, get, loadData } from '../state.js';
import { subscribeRoom, unsubscribeRoom, onWs, act as wsAct, connect, wsState } from '../ws.js';
import { computeMatch } from '/shared/scoring.js';
import { SUIT_INFO, DEFAULT_SETTINGS } from '/shared/rules.js';
import { icon, dot, colorOf, card, cardName, suitSym, teamDots, teamDot } from '../ui.js';
import qrcode from '/vendor/qrcode.js';

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
            <label class="check"><input type="checkbox" name="mustBeat" ${s.mustBeat ? raw('checked') : ''}> Obowiązek przebicia (do koloru i tromfem)</label>
            <label class="check"><input type="checkbox" name="mustTrump" ${s.mustTrump ? raw('checked') : ''}> Brak koloru → obowiązek dania tromfu</label>
            <label class="check"><input type="checkbox" name="meldOnFirstTrick" ${s.meldOnFirstTrick ? raw('checked') : ''}> Meldunek dozwolony już w pierwszej lewie</label>
            <label class="check"><input type="checkbox" name="meldOnPlayed" ${s.meldOnPlayed !== false ? raw('checked') : ''}> Meldunek na kimś (król dołożony na damę zagraną tuż przed nim – same punkty, tromf bez zmian)</label>
            <p class="hint">Licytację otwiera obowiązkowo gracz po lewej rozdającego (${s.minBid}). Licytuje się zawsze o ${s.bidStep} w górę (bez skakania), bez ograniczeń wynikających z meldunków.</p>
          </details>
          <button class="btn gold wide" type="submit">Utwórz pokój</button>
        </form>
      </section>
    </div>
    ${activeMine.length ? html`<section class="card"><h3>Kontynuuj swój mecz online</h3>
      <p class="muted small">Wynik, drużyny i historia zostają – zaczyna się nowe cyfrowe rozdanie.</p>
      ${activeMine.map((m) => { const c = computeMatch(m); return html`<button type="button" class="game-card" data-act="continue" data-id="${m.id}"><div class="gc-main"><div class="gc-sides">${c.teams.map((t, i) => html`<span>${teamDots(t, i)} ${t.map(nick).join(' & ')} <b class="num">${fmtNum(c.scores[i])}</b></span>`)}</div><div class="gc-meta">${m.rounds.length} rozdań</div></div><span class="chev">${icon('wifi')}</span></button>`; })}
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
        const settings = { target: Number(fd.get('target')), rounding: fd.get('rounding'), mustBeat: !!fd.get('mustBeat'), mustTrump: !!fd.get('mustTrump'), meldOnFirstTrick: !!fd.get('meldOnFirstTrick'), meldOnPlayed: !!fd.get('meldOnPlayed') };
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

// Link zaproszenia (#/join/KOD): zalogowany gracz od razu wchodzi do pokoju.
export async function joinLink({ el, params, go }) {
  mount(el, html`<div class="loading"><span class="spinner"></span>Dołączanie do pokoju ${params.code}…</div>`);
  try {
    const { room } = await post('/api/rooms/join', { code: params.code });
    go('/room/' + encodeURIComponent(room.id), { replace: true });
  } catch (ex) {
    mount(el, html`<div class="card empty">${ex.network ? 'Gra online wymaga internetu' : ex.message}<br><a class="btn" href="#/online">Pokoje</a></div>`);
  }
}

const inviteLink = (code) => `${location.origin}/#/join/${encodeURIComponent(code)}`;
// Kod QR jako SVG (czarne moduły na białym tle – czytelny dla każdego aparatu).
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), m = 4, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return raw(`<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="Kod QR z linkiem do pokoju" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`);
}

export function room({ el, params, go, setCta, setBar }) {
  const roomId = params.id;
  let view = null;
  let online = [];
  let selected = null;
  let lastHandNo = null;
  let busy = false;
  let flashTrick = null;
  let flashTimer = null;
  let cardsHidden = localStorage.getItem('tys2:hideCards') === '1';
  let bidsOpen = false;
  let endFlash = false;
  let endTimer = null;
  let giveDraft = {}; // musik: komu którą kartę (seat → karta), zatwierdzane jednym przyciskiem

  connect();
  subscribeRoom(roomId);
  // pierwszy stan także przez HTTP (szybciej i działa, gdy WebSocket dopiero się łączy)
  get('/api/rooms/' + encodeURIComponent(roomId)).then((r) => { if (!view) { view = r.room; draw(); } }).catch((e) => { mount(el, html`<div class="card empty">${e.message}<br><a class="btn" href="#/online">Pokoje</a></div>`); });

  const send = async (action) => {
    if (busy) return;
    busy = true;
    try {
      await wsAct(roomId, view && ['bid', 'pass', 'play', 'give-all'].includes(action.type) ? { ...action, expectSeq: view.seq } : action);
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
  const POS_TXT = { left: 'po lewej', top: 'naprzeciwko', right: 'po prawej' };
  const isPartner = (seat) => view.mySeat >= 0 && seat !== view.mySeat && seat % 2 === view.mySeat % 2;
  // Król/dama z pary w ręce, ale meldować teraz nie można (np. 1. lewa albo nie wychodzisz) – zagranie wymaga potwierdzenia.
  const pairNoMeld = (h, c) => (c[0] === 'K' || c[0] === 'Q') && h.hand.includes((c[0] === 'K' ? 'Q' : 'K') + c[1]) && !h.meldable.includes(c);
  // Na kogo melduje król (poprzedni gracz zagrał damę tego koloru) – albo -1.
  const meldOnOf = (h, c) => {
    const last = h.trick && h.trick.cards.length ? h.trick.cards[h.trick.cards.length - 1] : null;
    return last && c[0] === 'K' && last.card === 'Q' + c[1] && h.meldable.includes(c) ? last.seat : -1;
  };

  // Panel boczny leży poza widokiem stołu (position: fixed względem całego ekranu).
  const panelHost = document.createElement('div');
  document.body.appendChild(panelHost);
  function draw() {
    const ph = view && view.status !== 'lobby' && view.hand;
    mount(panelHost, bidsOpen && ph ? drawBids(view.hand) : '');
    drawMain();
  }
  function drawMain() {
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
        <div class="row wrap center code-btns">
          <button type="button" class="btn sm" data-act="copy-code">${icon('copy')}Kopiuj kod</button>
          <button type="button" class="btn sm" data-act="copy-link">${icon('copy')}Kopiuj link</button>
          ${navigator.share ? html`<button type="button" class="btn sm" data-act="share">Udostępnij</button>` : ''}
        </div>
        <details class="qr-box"><summary>Pokaż kod QR</summary>${qrSvg(inviteLink(view.code))}<div class="muted small">Zeskanuj aparatem – zalogowany gracz od razu wejdzie do pokoju.</div></details>
      </section>
      ${view.reservedSeats ? html`<p class="hint">Miejsca są przypisane z meczu – każdy gracz siada automatycznie po dołączeniu kodem.</p>` : html`<p class="hint">Partnerzy siedzą naprzeciwko: drużyna A to miejsca 1 i 3, drużyna B – 2 i 4.</p>`}
      <div class="lobby-seats">${[0, 1, 2, 3].map((s) => {
        const u = view.seats[s];
        const reserved = view.reservedSeats ? view.reservedSeats[s] : null;
        return html`<div class="lseat team-${s % 2 ? 'b' : 'a'} ${u === state.me.id ? 'me' : ''}">
          <div class="ls-h">Miejsce ${s + 1} · drużyna ${s % 2 ? 'B' : 'A'}</div>
          ${u ? html`<div class="ls-u">${teamDot(s % 2)}<b>${nick(u)}</b>${online.includes(u) ? html`<span class="online-dot" title="online"></span>` : html`<span class="muted small">offline</span>`}</div>
              <div class="ls-r ${view.ready[s] ? 'ok' : ''}">${view.ready[s] ? html`${icon('check')}gotowy` : 'czeka'}</div>`
            : reserved ? html`<div class="ls-u muted">${teamDot(s % 2)}${nick(reserved)} – jeszcze nie dołączył</div>`
              : html`<button type="button" class="btn sm" data-act="sit" data-seat="${s}">Usiądź tutaj</button>`}
        </div>`;
      })}</div>
      <section class="card"><h3>W pokoju</h3><div class="members">${view.members.map((u) => html`<span class="member">${view.seats.includes(u) ? teamDot(view.seats.indexOf(u) % 2) : dot(u)}${nick(u)}${online.includes(u) ? html`<span class="online-dot"></span>` : ''}</span>`)}</div></section>
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
      <div class="sb-name">${teamDot(seat % 2)}<b>${nick(u)}</b>${h && h.dealerSeat === seat ? html`<span class="chipd" title="rozdaje">R</span>` : ''}${online.includes(u) ? '' : html`<span class="badge warn" title="rozłączony">offline</span>`}</div>
      <div class="sb-meta">${h ? html`${pos !== 'bottom' ? html`<span class="backs">${Array.from({ length: h.handCounts[seat] }, () => card(null, { back: true, small: true }))}</span>` : ''}
        ${pos !== 'bottom' ? html`<span class="cnt" title="kart w ręce">${h.handCounts[seat]} kart</span>` : ''}<span class="muted small">lewy: ${h.tricksWon[seat]}</span>` : ''}
        ${bidH ? html`<span class="bubble ${bidH.type}">${bidH.type === 'pass' ? 'pas' : bidH.value}</span>` : ''}
        ${melds.map((x) => html`<span class="meld-badge" title="${x.on != null ? 'meldunek na ' + nick(view.seats[x.on]) : 'meldunek'}">${suitSym(x.suit)} ${x.value}</span>`)}</div>
    </div>`;
  }

  function drawTable() {
    const h = view.hand;
    const sc = scoresOf();
    const me = view.mySeat;
    const myTurn = h && h.turn === me && h.phase !== 'finished';
    const contract = h && h.contract;
    const flash = h && h.trick && !h.trick.cards.length && h.lastTrick && flashTrick === h.tricksCount;
    // Po ostatniej karcie rozdania ostatnia lewa zostaje chwilę na stole (żeby wszyscy ją zobaczyli).
    const endTrick = !h && endFlash && view.lastHand && view.lastHand.tricks.length ? view.lastHand.tricks[view.lastHand.tricks.length - 1] : null;
    const center = h && h.trick && h.trick.cards.length ? h.trick.cards : (flash ? h.lastTrick.cards : endTrick ? endTrick.cards : []);
    const showingLast = flash || !!endTrick;
    const teamsTxt = sc ? sc.c.teams : [[view.seats[0], view.seats[2]], [view.seats[1], view.seats[3]]];
    mount(el, html`
      <div class="game">
        <div class="gbar">
          ${[0, 1].map((t) => html`<div class="gscore team-${t ? 'b' : 'a'} ${sc && sc.c.winner === t ? 'win' : ''}"><span class="gs-n">${teamDots(teamsTxt[t], t)}${teamsTxt[t].map((p) => nick(p)).join(' & ')}</span><b class="gs-v">${sc ? fmtNum(sc.c.scores[t]) : '–'}</b></div>`)}
          <div class="ginfo">
            ${contract ? html`<span class="gi">kontrakt <b>${contract.value}</b> · ${nick(view.seats[contract.seat])}</span>` : h && h.phase === 'bidding' ? html`<span class="gi">licytacja: <b>${h.bidding.highest}</b> · ${nick(view.seats[h.bidding.highestSeat])}</span>` : ''}
            <span class="gi">tromf ${h && h.trump ? suitSym(h.trump) : html`<span class="muted">brak</span>`}</span>
            <span class="gi">rozdanie ${view.handNo}</span>
            ${h ? html`<button type="button" class="gi gi-btn" data-act="bids" aria-expanded="${bidsOpen}">${icon('list')}licytacja (${h.bidding.history.length})</button>` : ''}
          </div>
        </div>
        <div class="felt-table ${h && h.phase === 'giving' && myTurn ? 'compact' : ''}" aria-label="Stół">
          ${[0, 1, 2, 3].map((s) => seatBox(s, h))}
          <div class="trick ${showingLast ? 'last' : ''}">
            ${center.map((x) => html`<div class="tc ${rel(x.seat)}">${card(x.card)}</div>`)}
            ${showingLast ? html`<div class="trick-note">${endTrick ? 'ostatnia lewa – ' : ''}lewę bierze ${nick(view.seats[(endTrick || h.lastTrick).winner])} (+${(endTrick || h.lastTrick).points})</div>` : ''}
            ${h && h.phase === 'bidding' ? html`<div class="musik" aria-label="Musik – 4 karty">${Array.from({ length: h.musikCount }, () => card(null, { back: true }))}</div>` : ''}
            ${h && !center.length ? html`<div class="trick-note">${h.phase === 'bidding' ? 'musik' : h.phase === 'giving' ? `${nick(view.seats[h.contract.seat])} rozdaje karty z musika` : myTurn ? 'wyjdź kartą' : ''}</div>` : ''}
          </div>
        </div>
        <div class="turn-line ${myTurn ? 'mine' : ''}" aria-live="polite">${!h ? '' : h.phase === 'bidding' ? (myTurn ? 'Twoja kolej w licytacji' : `Licytuje: ${nick(view.seats[h.turn])}`) : h.phase === 'giving' ? (myTurn ? 'Wziąłeś musik – rozdaj po jednej karcie' : `${nick(view.seats[h.turn])} bierze musik i rozdaje karty`) : h.phase === 'playing' ? (myTurn ? 'Twój ruch' : `Ruch: ${nick(view.seats[h.turn])}`) : ''}</div>
        ${view.status === 'playing' && h ? drawControls(h, myTurn) : drawResult()}
        ${me >= 0 && h ? drawHand(h, myTurn) : me < 0 ? html`<p class="muted small center">Oglądasz grę – nie siedzisz przy stole.</p>` : ''}
        ${state.me.role === 'admin' && view.status === 'playing' ? html`<details class="glog"><summary>Opcje administratora</summary><button type="button" class="btn sm danger" data-act="abort">Unieważnij rozdanie</button></details>` : ''}
      </div>`);
    setCta('');
  }

  // Historia licytacji w wysuwanym panelu z boku – nie zabiera miejsca nad kartami.
  function drawBids(h) {
    const hist = h.bidding.history;
    return html`<div class="side-backdrop" data-act="bids"></div><aside class="side-panel" aria-label="Historia licytacji">
      <div class="sp-head"><b>Licytacja</b><button type="button" class="icon-btn sm" data-act="bids" aria-label="Zamknij">${icon('x')}</button></div>
      <ol class="sp-list">${hist.map((x) => html`<li class="${x.type}">${teamDot(x.seat % 2)}<span class="sp-n">${nick(view.seats[x.seat])}</span><b>${x.type === 'pass' ? 'pas' : x.value}</b>${x.forced ? html`<small class="muted">obowiązkowe</small>` : ''}</li>`)}</ol>
      ${h.contract ? html`<div class="sp-foot">Kontrakt: <b>${h.contract.value}</b> · ${nick(view.seats[h.contract.seat])}</div>` : html`<div class="sp-foot muted">Licytuje: ${nick(view.seats[h.turn])}</div>`}
    </aside>`;
  }

  function drawHand(h, myTurn) {
    const giving = h.phase === 'giving' && myTurn;
    const assigned = giving ? Object.values(giveDraft) : [];
    const cards = h.hand.filter((c) => !assigned.includes(c));
    const musik = h.musikCards || [];
    const recv = h.received && h.tricksCount === 0 ? h.received : null;
    // Zakryte karty (gdy ktoś siedzi obok i mógłby podejrzeć) – tylko na tym urządzeniu.
    const toggle = html`<button type="button" class="hide-toggle btn sm" data-act="hide-cards" aria-pressed="${cardsHidden}">${cardsHidden ? 'Pokaż karty' : 'Zakryj karty'}</button>`;
    if (cardsHidden) return html`<div class="hand hidden-hand" role="group" aria-label="Twoje karty – zakryte" style="--n:${cards.length}">${cards.map(() => card(null, { back: true }))}</div>${toggle}${myTurn ? html`<div class="muted small center">Twój ruch – odkryj karty, żeby zagrać.</div>` : ''}`;
    return html`${recv ? html`<div class="recv-note">${nick(view.seats[recv.from])} dał Ci: ${card(recv.card, { small: true, span: true })} <b>${cardName(recv.card)}</b></div>` : ''}
      <div class="hand" role="group" aria-label="Twoje karty" style="--n:${cards.length}">${cards.map((c) => card(c, {
        act: 'card',
        playable: myTurn && ((h.phase === 'playing' && h.legal.includes(c)) || giving),
        dim: myTurn && h.phase === 'playing' && !h.legal.includes(c),
        selected: selected === c,
        meld: h.meldable.includes(c),
        tag: giving && musik.includes(c) ? 'musik' : recv && recv.card === c ? 'nowa' : '',
        tagCls: recv && recv.card === c ? 'new' : '',
      }))}</div>${toggle}`;
  }

  function drawControls(h, myTurn) {
    if (!myTurn) return '';
    if (h.phase === 'bidding') {
      const next = h.bidding.highest + h.settings.bidStep;
      return html`<div class="controls bidding">
        <div class="muted small">Najwyższa: <b>${h.bidding.highest}</b> (${nick(view.seats[h.bidding.highestSeat])})</div>
        ${next <= h.settings.maxBid ? html`<button type="button" class="btn-gold wide" data-act="bid" data-v="${next}">Licytuj ${next} <span class="muted">(+${h.settings.bidStep})</span></button>` : ''}
        <button type="button" class="btn danger wide" data-act="pass">Pas</button>
      </div>`;
    }
    if (h.phase === 'giving') {
      const order = { left: 0, top: 1, right: 2 };
      const left = [0, 1, 2, 3].filter((s) => s !== view.mySeat && !h.given[s]).sort((a, b) => order[rel(a)] - order[rel(b)]);
      const done = left.every((s) => giveDraft[s]);
      return html`<div class="controls giving">
        <div class="give-help">${selected ? html`Komu dać ${card(selected, { small: true, span: true })} <b>${cardName(selected)}</b>? Kliknij gracza.` : done ? 'Sprawdź i zatwierdź. Kliknij kartę gracza, żeby ją cofnąć.' : html`<b>1.</b> Wybierz kartę z ręki &nbsp; <b>2.</b> Kliknij gracza`}</div>
        <div class="give-slots">${left.map((s) => html`<button type="button" class="gslot ${isPartner(s) ? 'partner' : 'opp'} ${selected ? 'target' : ''} ${giveDraft[s] ? 'filled' : ''}" data-act="slot" data-to="${s}">
          <span class="gsl-who">${teamDot(s % 2)}<b>${nick(view.seats[s])}</b></span>
          <span class="gsl-role">${isPartner(s) ? 'partner' : 'przeciwnik'} · ${POS_TXT[rel(s)]}</span>
          <span class="gsl-card">${giveDraft[s] ? card(giveDraft[s], { span: true }) : html`<span class="gsl-empty">?</span>`}</span>
        </button>`)}</div>
        <button type="button" class="btn-gold wide" data-act="give-confirm" ${done ? '' : raw('disabled')}>${done ? 'Zatwierdź rozdanie kart' : `Przydziel jeszcze ${left.filter((s) => !giveDraft[s]).length}`}</button>
      </div>`;
    }
    if (selected && h.legal.includes(selected)) {
      const meld = h.meldable.includes(selected);
      const s = selected[1];
      return html`<div class="controls play">
        <button type="button" class="btn-gold" data-act="play">${meld ? html`Melduj ${suitSym(s)} ${SUIT_INFO[s].meld}${meldOnOf(h, selected) >= 0 ? ` na ${nick(view.seats[meldOnOf(h, selected)])}` : ''} i zagraj` : pairNoMeld(h, selected) ? 'Zagraj bez meldunku' : 'Zagraj'} ${card(selected, { small: true, span: true })}</button>
        ${pairNoMeld(h, selected) ? html`<div class="muted small">${h.trick && h.trick.cards.length ? 'Meldować można tylko wychodząc (albo królem na damę zagraną tuż przed Tobą).' : 'W pierwszej lewie nie można meldować.'}</div>` : ''}
      </div>`;
    }
    const onK = h.meldable.find((c) => meldOnOf(h, c) >= 0);
    return html`<div class="controls muted small">${onK ? html`Możesz zameldować na ${nick(view.seats[meldOnOf(h, onK)])} – dołóż ${card(onK, { small: true, span: true })} (${suitSym(onK[1])} ${SUIT_INFO[onK[1]].meld} pkt, tromf bez zmian).` : h.meldable.length ? 'Masz meldunek – zagranie króla lub damy z pary od razu go zgłasza.' : 'Wybierz kartę (podświetlone są dozwolone).'}</div>`;
  }

  function drawResult() {
    const lh = view.lastHand;
    const sc = scoresOf();
    const me = view.mySeat;
    if (!lh) return view.status === 'between' && view.mySeat >= 0 ? (setTimeout(() => setCta(html`<button class="btn-ghost" data-act="detach">Tryb offline</button><button class="btn-gold" data-act="ready" ${view.ready[view.mySeat] ? raw('disabled') : ''}>Następne rozdanie ♠</button>`)), html`<p class="notice warn">Rozdanie zostało unieważnione.</p>`) : '';
    const teams = sc ? sc.c.teams : [[view.seats[0], view.seats[2]], [view.seats[1], view.seats[3]]];
    const meldTeam = [0, 1].map((t) => lh.melds.filter((x) => x.team === t).reduce((a, x) => a + x.value, 0));
    const meldLost = [0, 1].map((t) => meldTeam[t] > 0 && lh.cardPoints[t] === 0);
    const myReady = me >= 0 && view.ready[me];
    const out = html`<section class="card result">
      <h3>${view.status === 'finished' ? html`${icon('crown')} Wygrywają ${teams[lh.winner].map(nick).join(' & ')}!` : `Rozdanie ${lh.handNo} zakończone`}</h3>
      <p>Kontrakt <b>${lh.contract.value}</b> – ${nick(view.seats[lh.contract.seat])}: ${lh.made ? html`<span class="good">ugrany</span>` : html`<span class="bad">nieugrany</span>`}</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Drużyna</th><th>Karty</th><th>Meldunki</th><th>Zmiana</th><th>Wynik</th></tr></thead>
      <tbody>${[0, 1].map((t) => html`<tr><td class="l">${teamDots(teams[t], t)} ${teams[t].map(nick).join(' & ')}</td><td>${lh.cardPoints[t]}</td><td>${meldLost[t] ? html`<s title="bez punktów z kart meldunek się nie liczy">${meldTeam[t]}</s>` : meldTeam[t]}</td><td class="${lh.deltas[t] > 0 ? 'good' : lh.deltas[t] < 0 ? 'bad' : ''}">${signed(lh.deltas[t])}</td><td><b>${fmtNum(lh.scores[t])}</b></td></tr>`)}</tbody></table></div>
      ${meldLost.some(Boolean) ? html`<p class="muted small">Przekreślony meldunek przepadł – drużyna nie zdobyła żadnych punktów z kart.</p>` : ''}
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
      case 'copy-code': toast((await copyText(view.code)) ? `Skopiowano kod ${view.code}` : `Kod: ${view.code}`); break;
      case 'copy-link': {
        const link = inviteLink(view.code);
        toast((await copyText(link)) ? 'Skopiowano link do pokoju' : `Link: ${link}`);
        break;
      }
      case 'share':
        try { await navigator.share({ title: 'Tysiąc – zaproszenie', text: `Zagraj w Tysiąca – kod ${view.code}`, url: inviteLink(view.code) }); } catch { /* anulowano */ }
        break;
      case 'bid': send({ type: 'bid', value: Number(a.dataset.v) }); break;
      case 'pass': send({ type: 'pass' }); break;
      case 'card': {
        const c = a.dataset.card;
        if (!h || h.turn !== view.mySeat) return;
        if (h.phase === 'giving') { selected = selected === c ? null : c; draw(); return; }
        if (h.phase !== 'playing') return;
        if (!h.legal.includes(c)) { toast('Tej karty nie można teraz zagrać – obowiązek koloru, przebicia lub tromfu'); return; }
        // Drugie kliknięcie tej samej karty zagrywa ją (meldunek zgłasza się sam, jeśli przysługuje).
        // Wyjątek: król/dama z pary, gdy meldować teraz nie można – wtedy tylko przyciskiem „Zagraj bez meldunku”.
        if (selected === c && !pairNoMeld(h, c)) { selected = null; send({ type: 'play', card: c }); return; }
        selected = c;
        draw();
        break;
      }
      case 'bids': bidsOpen = !bidsOpen; draw(); break;
      case 'hide-cards':
        cardsHidden = !cardsHidden;
        localStorage.setItem('tys2:hideCards', cardsHidden ? '1' : '0');
        selected = null;
        draw();
        break;
      case 'play': { const c = selected; selected = null; send({ type: 'play', card: c }); break; }
      case 'slot': {
        const to = Number(a.dataset.to);
        if (selected) {
          for (const k of Object.keys(giveDraft)) if (giveDraft[k] === selected) delete giveDraft[k];
          giveDraft[to] = selected;
          selected = null;
        } else if (giveDraft[to]) {
          selected = giveDraft[to];
          delete giveDraft[to];
        } else { toast('Najpierw wybierz kartę z ręki'); return; }
        draw();
        break;
      }
      case 'give-confirm': {
        const gives = Object.entries(giveDraft).map(([to, c]) => ({ card: c, to: Number(to) }));
        send({ type: 'give-all', gives });
        break;
      }
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
      if (!view.hand || view.hand.phase !== 'giving') giveDraft = {};
      const ph = prev && prev.hand, nh = view.hand;
      if (nh && nh.received && !(ph && ph.received)) toast(`${nick(view.seats[nh.received.from])} dał Ci: ${cardName(nh.received.card)}`);
      if (nh && ph && nh.melds.length > ph.melds.length) {
        const md = nh.melds[nh.melds.length - 1];
        toast(`${nick(view.seats[md.seat])} melduje ${SUIT_INFO[md.suit].symbol} ${md.value}${md.on != null ? ` na ${nick(view.seats[md.on])}` : ''}`);
      }
      // Ukończona lewa zostaje chwilę na stole, żeby każdy zobaczył ostatnią kartę – potem znika.
      if (prev && prev.status === 'playing' && view.status !== 'playing' && view.lastHand) {
        endFlash = true;
        clearTimeout(endTimer);
        endTimer = setTimeout(() => { endFlash = false; draw(); }, 2500);
      }
      if (view.hand && prev && prev.hand && view.hand.tricksCount > prev.hand.tricksCount) {
        flashTrick = view.hand.tricksCount;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { flashTrick = null; draw(); }, 1600);
      }
      draw();
    }
    if (m.type === 'status') draw();
  });
  const unSub = subscribe((w) => { if (view && view.matchId && w === 'match:' + view.matchId) draw(); });
  el.addEventListener('click', onClick);
  const cta = document.getElementById('cta');
  cta.addEventListener('click', onClick);
  panelHost.addEventListener('click', onClick);
  draw();
  return () => { unWs(); unSub(); unsubscribeRoom(roomId); cta.removeEventListener('click', onClick); panelHost.remove(); clearTimeout(endTimer); clearTimeout(flashTimer); };
}

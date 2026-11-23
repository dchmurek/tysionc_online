// Ruletka „na nudę” – przeniesiona ze starej aplikacji. Wirtualne żetony tylko w tym telefonie.
// Wszystkie wstawiane wartości to liczby z kodu – brak danych użytkownika w HTML.
import { toast, vibrate, fmtNum as fmt, raw } from '../dom.js';
import { icon as iconRaw } from '../ui.js';

const icon = (n, c) => String(iconRaw(n, c));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* brak miejsca */ } };
let $app = null;
let setCtaRef = () => {};
const setCta = (h) => setCtaRef(h);
const state = { view: 'roulette' };

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
      <a class="back" href="#/profile">${icon('chevronLeft')}Profil</a>
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

export function roulette({ el, setCta: sc }) {
  $app = el;
  setCtaRef = (h) => sc(h ? raw(h) : '');
  state.view = 'roulette';
  const onClick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    switch (b.dataset.act) {
      case 'rl-chip': rl.chip = Number(b.dataset.v); renderRoulette(); break;
      case 'rl-bet': rlBet(b.dataset.k); break;
      case 'rl-spin': rlSpin(); break;
      case 'rl-clear': rl.bets = {}; renderRoulette(); break;
      case 'rl-repeat': {
        const total = Object.values(rl.lastBets || {}).reduce((a, v) => a + v, 0);
        if (total > rl.data.balance) return toast('Za mało żetonów na powtórkę');
        rl.bets = Object.assign({}, rl.lastBets);
        renderRoulette();
        break;
      }
      case 'rl-double': for (const k in rl.bets) rl.bets[k] *= 2; renderRoulette(); break;
      case 'rl-refill': rl.data.balance = RL_START; rlSave(); toast('Doładowano 1000 żetonów'); renderRoulette(); break;
      default:
    }
  };
  el.addEventListener('click', onClick);
  const cta = document.getElementById('cta');
  cta.addEventListener('click', onClick);
  renderRoulette();
  return () => { state.view = null; cta.removeEventListener('click', onClick); };
}

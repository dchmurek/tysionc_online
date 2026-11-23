// Profil: nick, hasło, kolor, sesje logowania, eksport, wylogowanie.
import { html, mount, toast, confirmBox, fmtDateTime, raw } from '../dom.js';
import { state, post, get, logout, queue, loadData } from '../state.js';
import { download } from '../api.js';
import { icon, colorOf } from '../ui.js';
import { nickProblem } from '/shared/nick.js';

export function profile({ el }) {
  let sessions = [];
  const draw = () => {
    const u = state.me;
    mount(el, html`
      <div class="page-head"><div><div class="eyebrow">Profil</div><h1 class="title-xl"><i class="dot big" style="--pc:${colorOf(u.id)}"></i>${u.nick}</h1>
        <p class="muted">${u.role === 'admin' ? 'administrator' : 'gracz'} · konto od ${fmtDateTime(u.createdAt)}</p></div></div>
      <div class="row wrap">
        <a class="btn sm" href="#/stats/player/${encodeURIComponent(u.id)}">${icon('stats')}Moje statystyki</a>
        ${u.role === 'admin' ? html`<a class="btn sm gold" href="#/admin">${icon('shield')}Administracja</a>` : ''}
      </div>
      <div class="grid-2">
        <section class="card"><h3>Zmiana nicku</h3>
          <form data-form="nick"><label class="field"><span>Nowy nick</span><input name="nick" required minlength="2" maxlength="20" value="${u.nick}" autocapitalize="none"></label>
          <label class="field"><span>Hasło (potwierdzenie)</span><input name="password" type="password" required autocomplete="current-password"></label>
          <p class="hint">Statystyki i historia są przypisane do Twojego stałego ID – zmiana nicku ich nie zmienia.</p>
          <button class="btn gold" type="submit">Zmień nick</button></form></section>
        <section class="card"><h3>Zmiana hasła</h3>
          <form data-form="pw"><input type="text" name="username" value="${u.nick}" autocomplete="username" hidden>
          <label class="field"><span>Obecne hasło</span><input name="old" type="password" required autocomplete="current-password"></label>
          <label class="field"><span>Nowe hasło (min. 10 znaków)</span><input name="new" type="password" required minlength="10" autocomplete="new-password"></label>
          <label class="field"><span>Powtórz nowe hasło</span><input name="new2" type="password" required minlength="10" autocomplete="new-password"></label>
          <p class="hint">Po zmianie hasła pozostałe urządzenia zostaną wylogowane.</p>
          <button class="btn gold" type="submit">Zmień hasło</button></form></section>
      </div>
      <section class="card"><h3>Kolor w statystykach</h3>
        <form data-form="color" class="row"><input type="color" name="color" value="${colorOf(u.id)}" aria-label="Kolor"><button class="btn sm" type="submit">Zapisz kolor</button></form></section>
      <section class="card"><h3>Zalogowane urządzenia</h3>
        ${sessions.length ? html`<ul class="sessions">${sessions.map((s) => html`<li><div><b>${s.current ? 'To urządzenie' : shortUa(s.ua)}</b><div class="muted small">logowanie ${fmtDateTime(s.createdAt)} · ostatnio ${fmtDateTime(s.lastSeen)}</div></div>
          ${s.current ? '' : html`<button type="button" class="btn sm danger" data-act="revoke" data-id="${s.id}">Wyloguj</button>`}</li>`)}</ul>
          ${sessions.length > 1 ? html`<button type="button" class="btn sm" data-act="revoke-all">Wyloguj wszystkie inne urządzenia</button>` : ''}` : html`<p class="muted small">Ładowanie…</p>`}
      </section>
      <section class="card"><h3>Dane</h3>
        <p class="muted small">Eksport zawiera konta (bez haseł), mecze, rozdania, sesje i ustawienia.</p>
        <div class="row wrap"><button type="button" class="btn sm" data-act="export">${icon('download')}Pobierz JSON</button>
        <button type="button" class="btn sm" data-act="reload">${icon('repeat')}Odśwież dane z serwera</button></div></section>
      <button type="button" class="btn danger wide" data-act="logout">${icon('logout')}Wyloguj</button>`);
  };
  const shortUa = (ua) => (/iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Urządzenie');
  const loadSessions = () => get('/api/account/sessions').then((r) => { sessions = r.sessions; draw(); }).catch(() => {});
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = Object.fromEntries(new FormData(f));
    try {
      if (f.dataset.form === 'nick') {
        const p = nickProblem(v.nick);
        if (p) return toast(p, { kind: 'bad' });
        const r = await post('/api/account/nick', { nick: v.nick, password: v.password });
        state.me = r.user;
        await loadData();
        toast('Nick zmieniony');
      } else if (f.dataset.form === 'pw') {
        if (v.new !== v.new2) return toast('Nowe hasła się różnią', { kind: 'bad' });
        await post('/api/account/password', { old: v.old, new: v.new });
        toast('Hasło zmienione – inne urządzenia wylogowane');
        f.reset();
        loadSessions();
      } else if (f.dataset.form === 'color') {
        const r = await post('/api/account/profile', { color: v.color });
        state.me = r.user;
        await loadData();
        toast('Zapisano kolor');
      }
      draw();
    } catch (ex) { toast(ex.network ? 'Wymaga połączenia z internetem' : ex.message, { kind: 'bad' }); }
  });
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    try {
      if (a.dataset.act === 'revoke') { await post('/api/account/sessions/revoke', { id: a.dataset.id }); loadSessions(); }
      if (a.dataset.act === 'revoke-all') { await post('/api/account/sessions/revoke', { all: true }); loadSessions(); }
      if (a.dataset.act === 'export') await download('/api/export/json', null, 'tysiac.json');
      if (a.dataset.act === 'reload') { await loadData(); toast('Dane odświeżone'); }
      if (a.dataset.act === 'logout') {
        const q = queue().length;
        if (q && !(await confirmBox('Niewysłane wyniki', `${q} zmian nie dotarło jeszcze na serwer. Wylogowanie usunie je z telefonu.`, 'Wyloguj mimo to', 'danger'))) return;
        if (!q && !(await confirmBox('Wylogować?', '', 'Wyloguj'))) return;
        await logout();
      }
    } catch (ex) { toast(ex.message, { kind: 'bad' }); }
  });
  draw();
  loadSessions();
}

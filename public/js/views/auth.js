// Logowanie, rejestracja, aktywacja konta kodem.
import { html, mount, $ } from '../dom.js';
import { post } from '../api.js';
import { state } from '../state.js';
import { afterLogin } from '../main.js';
import { nickProblem } from '/shared/nick.js';

const suits = html`<div class="login-suits" aria-hidden="true">♠ <span class="red">♥</span> ♣ <span class="red">♦</span></div>`;

function form(el, { title, sub, fields, submit, links, onSubmit }) {
  mount(el, html`<form class="login" novalidate>
    ${suits}
    <h1 class="title-xl">${title}</h1>
    <p class="muted">${sub}</p>
    ${fields}
    <div class="login-err" role="alert"></div>
    <button class="btn-gold wide" type="submit">${submit}</button>
    <div class="login-links">${links}</div>
  </form>`);
  const f = $('form', el);
  const err = $('.login-err', el);
  f.querySelector('input')?.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!f.reportValidity()) return;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(f)), err);
    } catch (ex) {
      err.textContent = ex.network ? 'Brak połączenia z serwerem.' : ex.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function finish(r, go) {
  state.me = r.user;
  localStorage.setItem('tys2:lastUser', JSON.stringify(r.user));
  await afterLogin();
  // np. link zaproszenia otwarty przed zalogowaniem – po zalogowaniu wracamy do niego
  const next = sessionStorage.getItem('tys2:next');
  sessionStorage.removeItem('tys2:next');
  go(next && next.startsWith('/') ? next : '/', { replace: true });
}

export function login({ el, go }) {
  form(el, {
    title: 'Tysiąc na krzyż',
    sub: 'Zaloguj się, żeby grać online, prowadzić wynik przy stole i oglądać statystyki.',
    fields: html`
      <label class="field"><span>Nick</span><input name="nick" autocomplete="username" required maxlength="20" autocapitalize="none" spellcheck="false"></label>
      <label class="field"><span>Hasło</span><input name="password" type="password" autocomplete="current-password" required></label>`,
    submit: 'Zaloguj się',
    links: html`<a href="#/register">Nie masz konta? Zarejestruj się</a><a href="#/activate">Masz kod aktywacyjny? Aktywuj konto</a>`,
    onSubmit: async (v) => finish(await post('/api/auth/login', v), go),
  });
}

export function register({ el, go }) {
  form(el, {
    title: 'Nowe konto',
    sub: 'Wybierz nick i hasło. Adres e-mail nie jest potrzebny.',
    fields: html`
      <label class="field"><span>Nick (2–20 znaków)</span><input name="nick" autocomplete="username" required minlength="2" maxlength="20" autocapitalize="none" spellcheck="false"></label>
      <label class="field"><span>Hasło (min. 10 znaków)</span><input name="password" type="password" autocomplete="new-password" required minlength="10"></label>
      <label class="field"><span>Powtórz hasło</span><input name="password2" type="password" autocomplete="new-password" required minlength="10"></label>`,
    submit: 'Załóż konto',
    links: html`<a href="#/login">Mam już konto – zaloguj</a><a href="#/activate">Jesteś Kamilem, Danielem, Karolem lub Akuro? Aktywuj konto kodem</a>`,
    onSubmit: async (v, err) => {
      const p = nickProblem(v.nick);
      if (p) { err.textContent = p; return; }
      if (v.password !== v.password2) { err.textContent = 'Hasła się różnią.'; return; }
      await finish(await post('/api/auth/register', { nick: v.nick, password: v.password }), go);
    },
  });
}

export function activate({ el, go }) {
  form(el, {
    title: 'Aktywacja konta',
    sub: 'Kod aktywacyjny dostajesz od administratora. Ustawisz własne hasło – nikt inny go nie zna.',
    fields: html`
      <label class="field"><span>Nick</span><input name="nick" autocomplete="username" required maxlength="20" autocapitalize="none" spellcheck="false"></label>
      <label class="field"><span>Kod (np. ABCD-EFGH-JKLM)</span><input name="code" required autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"></label>
      <label class="field"><span>Nowe hasło (min. 10 znaków)</span><input name="password" type="password" autocomplete="new-password" required minlength="10"></label>
      <label class="field"><span>Powtórz hasło</span><input name="password2" type="password" autocomplete="new-password" required minlength="10"></label>`,
    submit: 'Aktywuj i zaloguj',
    links: html`<a href="#/login">Wróć do logowania</a>`,
    onSubmit: async (v, err) => {
      if (v.password !== v.password2) { err.textContent = 'Hasła się różnią.'; return; }
      await finish(await post('/api/auth/activate', { nick: v.nick, code: v.code, password: v.password }), go);
    },
  });
}

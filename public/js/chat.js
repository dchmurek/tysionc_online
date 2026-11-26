// Czat stołu: wysuwany z prawej strony, wspólny dla wszystkich przy stole (bez czatu drużynowego).
// Schowany czat pokazuje licznik nowych wiadomości i krótki podgląd ostatniej.
import { html, mount, toast, vibrate } from './dom.js';
import { state, nick, get, post } from './state.js';
import { onWs, setChatKnown } from './ws.js';
import { icon } from './ui.js';

const QUICK = ['👍', '😂', '🔥', 'Dobra gra!', 'Szybciej 😴', 'Brawo partner'];
const time = (iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

export function mountChat(roomId) {
  const host = document.createElement('div');
  host.className = 'chat-host';
  document.body.appendChild(host);
  const seenKey = 'tys2:chatSeen:' + roomId;
  let open = localStorage.getItem('tys2:chatOpen') === '1';
  let msgs = [];
  let lastSeen = Number(localStorage.getItem(seenKey) || 0);
  let peekTimer = null;
  let disabled = false;
  let clearedAt = 0; // do którego numeru czat wyczyszczono (koniec gry)

  mount(host, html`
    <button type="button" class="chat-tab" data-chat="toggle" aria-label="Czat stołu">${icon('chat')}<span class="chat-badge" hidden></span></button>
    <div class="chat-peek" hidden></div>
    <div class="chat-backdrop" data-chat="close"></div>
    <aside class="chat-panel" aria-label="Czat stołu">
      <div class="chat-head"><div><b>Czat stołu</b><div class="muted small">widzą wszyscy przy stole</div></div>
        <button type="button" class="icon-btn sm" data-chat="close" aria-label="Schowaj czat">${icon('chevronRight')}</button></div>
      <ol class="chat-list" aria-live="polite"><li class="chat-empty muted small">Jeszcze nikt nic nie napisał.</li></ol>
      <div class="chat-quick">${QUICK.map((q) => html`<button type="button" class="chip" data-chat="quick" data-t="${q}">${q}</button>`)}</div>
      <form class="chat-form" autocomplete="off">
        <input name="t" maxlength="300" placeholder="Napisz do wszystkich…" enterkeyhint="send" aria-label="Wiadomość">
        <button type="submit" class="btn gold sm" aria-label="Wyślij">${icon('send')}</button>
      </form>
    </aside>`);
  const $ = (s) => host.querySelector(s);
  const list = $('.chat-list');
  const input = $('.chat-form input');

  const unreadCount = () => msgs.filter((m) => m.id > lastSeen && m.u !== state.me.id && !m.sys).length;
  const markSeen = () => {
    const max = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (max > lastSeen) { lastSeen = max; localStorage.setItem(seenKey, String(max)); }
  };
  function setOpen(v) {
    open = v;
    localStorage.setItem('tys2:chatOpen', v ? '1' : '0');
    document.body.classList.toggle('chat-open', v);
    host.classList.toggle('open', v);
    if (v) { markSeen(); $('.chat-peek').hidden = true; scrollDown(true); if (matchMedia('(min-width: 700px)').matches) input.focus(); }
    badge();
  }
  function badge() {
    const n = open ? 0 : unreadCount();
    const b = $('.chat-badge');
    b.hidden = !n;
    b.textContent = n > 9 ? '9+' : String(n);
    $('.chat-tab').setAttribute('aria-label', n ? `Czat stołu – ${n} nowych` : 'Czat stołu');
    $('.chat-tab').classList.toggle('has-new', !!n);
  }
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const scrollDown = (force) => { if (force || atBottom()) list.scrollTop = list.scrollHeight; };
  const item = (m) => {
    const mine = m.u === state.me.id;
    return html`<li class="chat-msg ${mine ? 'mine' : ''}">${mine ? '' : html`<b class="chat-who">${nick(m.u)}</b>`}<span class="chat-t">${m.t}</span><time>${time(m.at)}</time></li>`;
  };
  function render() {
    const stick = atBottom();
    mount(list, msgs.length ? msgs.map(item) : html`<li class="chat-empty muted small">Jeszcze nikt nic nie napisał.</li>`);
    scrollDown(stick);
  }
  function add(items, { initial = false } = {}) {
    const known = new Set(msgs.map((m) => m.id));
    const fresh = items.filter((m) => !known.has(m.id) && !m.sys && m.id > clearedAt);
    if (!fresh.length) return;
    msgs = msgs.concat(fresh).sort((a, b) => a.id - b.id).slice(-300);
    render();
    if (open) markSeen();
    else if (!initial) {
      const last = fresh.filter((m) => !m.sys && m.u !== state.me.id).pop();
      if (last) {
        const p = $('.chat-peek');
        mount(p, html`<b>${nick(last.u)}:</b> ${last.t.length > 60 ? last.t.slice(0, 60) + '…' : last.t}`);
        p.hidden = false;
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => { p.hidden = true; }, 3500);
        vibrate(6);
      }
    }
    badge();
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text || disabled) return;
    try {
      const r = await post(`/api/rooms/${encodeURIComponent(roomId)}/chat`, { text });
      add([r.message]);
      scrollDown(true);
    } catch (e) { toast(e.network ? 'Brak internetu – wiadomość nie wysłana' : e.message, { kind: 'bad' }); throw e; }
  }

  const onClick = (e) => {
    const a = e.target.closest('[data-chat]');
    if (!a) return;
    if (a.dataset.chat === 'toggle') setOpen(!open);
    if (a.dataset.chat === 'close') setOpen(false);
    if (a.dataset.chat === 'quick') send(a.dataset.t).catch(() => {});
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    const v = input.value;
    if (!v.trim()) return;
    input.value = '';
    try { await send(v); } catch { input.value = v; }
  };
  const onPeek = () => setOpen(true);
  host.addEventListener('click', onClick);
  host.querySelector('form').addEventListener('submit', onSubmit);
  $('.chat-peek').addEventListener('click', onPeek);
  // Po skończonej (albo usuniętej) grze serwer czyści czat – znikają też wiadomości w telefonie.
  function applyCleared(c) {
    if (!c || c <= clearedAt) return;
    clearedAt = c;
    msgs = msgs.filter((m) => m.id > c);
    render();
    badge();
  }
  const unWs = onWs((m) => {
    if (m.type === 'chat' && m.roomId === roomId) add(m.items);
    if (m.type === 'room' && m.roomId === roomId && m.room) applyCleared(m.room.chatCleared);
  });

  get(`/api/rooms/${encodeURIComponent(roomId)}/chat?since=0`).then((r) => {
    setChatKnown(roomId, r.n);
    clearedAt = r.cleared || 0;
    add(r.items, { initial: true });
    if (lastSeen > r.n) { lastSeen = 0; localStorage.removeItem(seenKey); badge(); }
  }).catch((e) => {
    // Serwer bez czatu (wersja Node.js) – chowamy przycisk.
    if (!e.network) { disabled = true; host.hidden = true; document.body.classList.remove('chat-open'); }
  });
  setOpen(open);

  return () => {
    unWs();
    clearTimeout(peekTimer);
    host.remove();
    document.body.classList.remove('chat-open');
  };
}

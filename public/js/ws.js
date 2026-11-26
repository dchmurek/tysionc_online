// Połączenie WebSocket z automatycznym ponownym łączeniem i odnawianiem subskrypcji.
const handlers = new Set();
const pending = new Map();
const rooms = new Set();
let sock = null;
let retry = 0;
let reqId = 0;
let wanted = false;
let timer = null;
export const wsState = { connected: false };

export function onWs(fn) { handlers.add(fn); return () => handlers.delete(fn); }
const fire = (m) => { for (const h of handlers) h(m); };

export function connect() {
  wanted = true;
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  sock = new WebSocket(url);
  sock.onopen = () => {
    retry = 0;
    wsState.connected = true;
    fire({ type: 'status', connected: true });
    for (const r of rooms) sock.send(JSON.stringify({ type: 'subscribe', roomId: r }));
  };
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.reqId && pending.has(m.reqId)) {
      const p = pending.get(m.reqId);
      pending.delete(m.reqId);
      if (m.type === 'error') { const e = new Error(m.error); e.code = m.code; p.reject(e); } else p.resolve(m);
    }
    fire(m);
  };
  sock.onclose = (ev) => {
    wsState.connected = false;
    fire({ type: 'status', connected: false, code: ev.code });
    for (const [, p] of pending) p.reject(new Error('Połączenie przerwane'));
    pending.clear();
    if (!wanted || ev.code === 4001) return;
    clearTimeout(timer);
    timer = setTimeout(connect, Math.min(15000, 500 * 2 ** retry++) + Math.random() * 300);
  };
  sock.onerror = () => { /* onclose obsłuży ponowne łączenie */ };
}

export function disconnect() {
  wanted = false;
  clearTimeout(timer);
  rooms.clear();
  if (sock) sock.close();
}

export function subscribeRoom(roomId) {
  rooms.add(roomId);
  if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'subscribe', roomId }));
  else connect();
}
export function unsubscribeRoom(roomId) {
  rooms.delete(roomId);
  if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'unsubscribe', roomId }));
}

export function act(roomId, action) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.readyState !== 1) { reject(new Error('Brak połączenia – ponowne łączenie…')); connect(); return; }
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ type: 'act', roomId, action: { ...action, actionId: action.actionId || 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }, reqId: id }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Serwer nie odpowiada')); } }, 10000);
  });
}

// Utrzymanie połączenia po powrocie do aplikacji (telefon w tle).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted && (!sock || sock.readyState > 1)) connect();
});
window.addEventListener('online', () => { if (wanted) connect(); });

// Czat stołu działa w wersji PHP (odpytywanie). Tu tylko zgodne API, żeby moduły się ładowały.
export function setChatKnown() {}
export function chatMessages(roomId, items, n) { if (items && items.length) fire({ type: 'chat', roomId, items, n }); }

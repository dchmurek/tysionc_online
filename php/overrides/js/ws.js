// Synchronizacja w czasie rzeczywistym przez odpytywanie HTTP (wersja na hosting PHP bez WebSocket).
// To samo API co wersja WebSocket: connect, disconnect, onWs, subscribeRoom, unsubscribeRoom, act, wsState.
import { api, ApiError } from './api.js';

const handlers = new Set();
const rooms = new Map(); // roomId → token ostatnio znanego stanu
const chatKnown = new Map(); // roomId → numer ostatniej znanej wiadomości czatu (brak = czat nie pobrany)
const roomStatus = new Map(); // roomId → status (offline odpytujemy rzadziej)
let wanted = false;
let timer = null;
let inflight = false;
let again = false;
let fails = 0;
let changeN = null;
export const wsState = { connected: false };

export function onWs(fn) { handlers.add(fn); return () => handlers.delete(fn); }
const fire = (m) => { for (const h of handlers) h(m); };

function setConnected(v) {
  if (wsState.connected === v) return;
  wsState.connected = v;
  fire({ type: 'status', connected: v });
}

function interval() {
  const hidden = document.visibilityState === 'hidden';
  if (rooms.size) {
    const live = [...rooms.keys()].some((id) => roomStatus.get(id) !== 'offline');
    if (hidden) return live ? 5000 : 10000;
    return live ? 1200 : 2500;
  }
  return hidden ? 60000 : 8000;
}

function schedule(ms) {
  clearTimeout(timer);
  if (!wanted) return;
  timer = setTimeout(poll, ms);
}

function applyRoom(id, r) {
  if (!rooms.has(id)) return;
  if (r.closed) { rooms.delete(id); chatKnown.delete(id); fire({ type: 'room', roomId: id, room: null, closed: true }); return; }
  if (r.error) { fire({ type: 'error', roomId: id, error: r.error }); return; }
  if (r.room) {
    rooms.set(id, r.token || '');
    roomStatus.set(id, r.room.status);
    fire({ type: 'room', roomId: id, room: r.room });
  }
}

function applyChat(id, c) {
  if (!rooms.has(id) || !c) return;
  const known = chatKnown.has(id) ? chatKnown.get(id) : 0;
  const items = (c.items || []).filter((m) => m.id > known);
  if (c.n > known) chatKnown.set(id, c.n);
  if (items.length) fire({ type: 'chat', roomId: id, items, n: c.n });
}
// Czat pobrany przez HTTP – od tej chwili odpytywanie przynosi tylko nowsze wiadomości.
export function setChatKnown(roomId, n) {
  if (!rooms.has(roomId)) return;
  chatKnown.set(roomId, Math.max(n, chatKnown.get(roomId) || 0));
}
export function chatMessages(roomId, items, n) { applyChat(roomId, { items, n }); }

async function poll() {
  if (!wanted) return;
  if (inflight) { again = true; return; }
  inflight = true;
  const qs = new URLSearchParams();
  if (changeN != null) qs.set('n', String(changeN));
  for (const [id, tok] of rooms) qs.append('r[]', id + ':' + (chatKnown.has(id) ? chatKnown.get(id) : '') + ':' + (tok || ''));
  try {
    const d = await api('GET', '/api/poll?' + qs.toString());
    fails = 0;
    setConnected(true);
    if (changeN != null && Array.isArray(d.matches)) for (const id of d.matches) fire({ type: 'match', matchId: id });
    changeN = d.n;
    for (const [id, r] of Object.entries(d.rooms || {})) applyRoom(id, r);
    for (const [id, c] of Object.entries(d.chat || {})) applyChat(id, c);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { wanted = false; setConnected(false); inflight = false; return; }
    fails++;
    setConnected(false);
  }
  inflight = false;
  if (again) { again = false; schedule(0); return; }
  schedule(fails ? Math.min(15000, 1000 * 2 ** Math.min(fails, 4)) : interval());
}

export function connect() {
  if (wanted && (timer || inflight)) return;
  wanted = true;
  schedule(0);
}

export function disconnect() {
  wanted = false;
  clearTimeout(timer);
  timer = null;
  rooms.clear();
  chatKnown.clear();
  changeN = null;
  setConnected(false);
}

export function subscribeRoom(roomId) {
  rooms.set(roomId, '');
  wanted = true;
  schedule(0);
}

export function unsubscribeRoom(roomId) {
  rooms.delete(roomId);
  chatKnown.delete(roomId);
  roomStatus.delete(roomId);
}

export async function act(roomId, action) {
  const actionId = action.actionId || 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const r = await api('POST', `/api/rooms/${encodeURIComponent(roomId)}/act`, { action: { ...action, actionId } });
    setConnected(true);
    if (r.closed) applyRoom(roomId, { closed: true });
    else if (r.room) applyRoom(roomId, r);
    schedule(400);
    return { type: 'ack', duplicate: !!r.duplicate };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.data && e.data.room) applyRoom(roomId, e.data.room);
      const err = new Error(e.message);
      err.code = e.code;
      schedule(200);
      throw err;
    }
    setConnected(false);
    schedule(1000);
    throw new Error('Brak połączenia – spróbuj ponownie');
  }
}

// Powrót do aplikacji (telefon w tle) – od razu odśwież stan.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted) schedule(0);
});
window.addEventListener('online', () => { if (wanted) schedule(0); });

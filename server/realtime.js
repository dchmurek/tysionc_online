// WebSocket: synchronizacja pokoi i meczów w czasie rzeczywistym.
// Uwierzytelnianie ciasteczkiem sesji + kontrola Origin. Każdy klient dostaje WYŁĄCZNIE swój widok.
import { WebSocketServer } from 'ws';
import { COOKIE, originAllowed } from './http/router.js';
import { AppError } from './services/accounts.js';

function cookieValue(header = '', name) {
  for (const p of header.split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return null;
}

export function attachRealtime(server, svc) {
  const { accounts, rooms, config, log } = svc;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set(); // { ws, user, sessionId, rooms:Set, matches:Set }

  server.on('upgrade', async (req, socket, head) => {
    try {
      if (new URL(req.url, 'http://x').pathname !== '/ws') throw new Error('path');
      if (!req.headers.origin || !originAllowed(req, config)) throw new Error('origin');
      const token = cookieValue(req.headers.cookie, COOKIE);
      const auth = token ? await accounts.resolveToken(token) : null;
      if (!auth) throw new Error('auth');
      wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, auth));
    } catch (e) {
      socket.write(`HTTP/1.1 ${e.message === 'auth' ? '401 Unauthorized' : '403 Forbidden'}\r\n\r\n`);
      socket.destroy();
    }
  });

  function sendTo(c, msg) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  function presence(roomId) {
    const online = new Set();
    for (const c of clients) if (c.rooms.has(roomId)) online.add(c.user.id);
    return [...online];
  }

  function pushRoom(c, roomId, roomObj) {
    const room = roomObj || rooms.rooms.get(roomId);
    if (!room || room.status === 'closed') { sendTo(c, { type: 'room', roomId, room: null, closed: true }); return; }
    if (!room.members.includes(c.user.id)) return;
    sendTo(c, { type: 'room', roomId, room: { ...rooms.viewFor(room, c.user.id), online: presence(roomId) } });
  }

  function onConnect(ws, auth) {
    const c = { ws, user: auth.user, sessionId: auth.session.id, rooms: new Set(), alive: true };
    clients.add(c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return sendTo(c, { type: 'error', error: 'Zła wiadomość' }); }
      if (!msg || typeof msg !== 'object') return;
      // Sesja mogła zostać unieważniona (wylogowanie, zmiana hasła).
      const fresh = await accounts.getUser(c.user.id);
      const sess = await accounts.listSessions(c.user.id);
      if (!fresh || fresh.status !== 'active' || !sess.some((s) => s.id === c.sessionId)) { sendTo(c, { type: 'auth', error: 'Sesja wygasła' }); return ws.close(4001, 'auth'); }
      c.user = fresh;
      try {
        if (msg.type === 'subscribe') {
          const room = rooms.rooms.get(String(msg.roomId || ''));
          if (!room) return sendTo(c, { type: 'room', roomId: msg.roomId, room: null, closed: true, reqId: msg.reqId });
          if (!room.members.includes(c.user.id)) throw new AppError(403, 'Najpierw dołącz do pokoju kodem');
          c.rooms.add(room.id);
          pushRoom(c, room.id);
          for (const o of clients) if (o !== c && o.rooms.has(room.id)) pushRoom(o, room.id);
          return;
        }
        if (msg.type === 'unsubscribe') { c.rooms.delete(String(msg.roomId)); return; }
        if (msg.type === 'ping') return sendTo(c, { type: 'pong', t: Date.now() });
        if (msg.type === 'act') {
          const res = await rooms.act(c.user, String(msg.roomId || ''), msg.action || {});
          sendTo(c, { type: 'ack', reqId: msg.reqId, duplicate: !!res.duplicate });
          if (res.duplicate) pushRoom(c, String(msg.roomId));
          return;
        }
        sendTo(c, { type: 'error', error: 'Nieznany typ wiadomości', reqId: msg.reqId });
      } catch (e) {
        const known = e instanceof AppError;
        if (!known) log.error('WS', e.stack || e);
        sendTo(c, { type: 'error', reqId: msg.reqId, code: known ? e.code : 'server', error: known ? e.message : 'Błąd serwera' });
        if (known && (e.code === 'stale' || e.code === 'turn')) pushRoom(c, String(msg.roomId || ''));
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      for (const id of c.rooms) for (const o of clients) if (o.rooms.has(id)) pushRoom(o, id);
    });
    sendTo(c, { type: 'hello', userId: c.user.id });
  }

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* zamknięte */ }
    }
  }, 25000);
  heartbeat.unref();

  return {
    roomChanged(roomId, roomObj) { for (const c of clients) if (c.rooms.has(roomId)) pushRoom(c, roomId, roomObj); },
    matchChanged(matchId) { for (const c of clients) sendTo(c, { type: 'match', matchId }); },
    stats: () => ({ clients: clients.size }),
    close() { clearInterval(heartbeat); for (const c of clients) c.ws.terminate(); wss.close(); },
  };
}

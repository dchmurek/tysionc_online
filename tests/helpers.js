// Wspólne narzędzia testów integracyjnych: serwer na losowym porcie z tymczasowym katalogiem danych.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { getConfig } from '../server/config.js';

export function tmpDir(prefix = 'tysiac-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const quiet = { debug() {}, info() {}, warn() {}, error: (...a) => process.env.TEST_LOG && console.error(...a) };

export async function startServer({ dataDir = tmpDir(), randomInt } = {}) {
  const config = { ...getConfig({ NODE_ENV: 'test' }), dataDir, port: 0, host: '127.0.0.1', noTimers: true, cookieSecure: false, registerPerHour: 1000 };
  const app = await createApp(config, { log: quiet, randomInt });
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, base, dataDir, port: addr.port, close: () => app.close() };
}

// Klient HTTP z ciasteczkami i tokenem CSRF – symuluje jedno urządzenie.
export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; this.user = null; }
  async req(method, url, body, extraHeaders = {}) {
    const headers = { 'X-Tysiac': '1', ...extraHeaders };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extraHeaders);
    const res = await fetch(this.base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (data && data.csrf) this.csrf = data.csrf;
    if (data && data.user !== undefined && typeof data === 'object') this.user = data.user || this.user;
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  async register(nick, password = 'bardzo-tajne-haslo') {
    const r = await this.post('/api/auth/register', { nick, password });
    if (r.status !== 200) throw new Error('register ' + nick + ': ' + JSON.stringify(r.data));
    return r.data.user;
  }
  async login(nick, password = 'bardzo-tajne-haslo') {
    const r = await this.post('/api/auth/login', { nick, password });
    if (r.status !== 200) throw new Error('login ' + nick + ': ' + JSON.stringify(r.data));
    return r.data.user;
  }
  ws() {
    return new WsClient(this.base.replace('http', 'ws') + '/ws', { Cookie: this.cookie, Origin: this.base });
  }
}

export class WsClient {
  constructor(url, headers) {
    this.messages = [];
    this.waiters = [];
    this.rooms = {};
    this.ws = new WebSocket(url, { headers });
    this.ready = new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); this.ws.once('unexpected-response', (_, res) => reject(new Error('HTTP ' + res.statusCode))); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.messages.push(m);
      if (m.type === 'room') this.rooms[m.roomId] = m.room;
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
    });
    this.reqId = 0;
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  wait(pred, ms = 3000) {
    const hit = this.messages.find(pred);
    if (hit) { this.messages.splice(this.messages.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { clearTimeout(t); this.messages.splice(this.messages.indexOf(m), 1); resolve(m); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('timeout ' + pred)); }, ms);
      this.waiters.push(w);
    });
  }
  async act(roomId, action) {
    const reqId = ++this.reqId;
    this.send({ type: 'act', roomId, action, reqId });
    const m = await this.wait((x) => x.reqId === reqId && (x.type === 'ack' || x.type === 'error'));
    if (m.type === 'error') { const e = new Error(m.error); e.code = m.code; throw e; }
    return m;
  }
  close() { this.ws.close(); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

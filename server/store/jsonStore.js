// Magazyn dokumentów JSON: atomowy zapis (tmp + fsync + rename), kolejka operacji per dokument,
// wersje dokumentów (rev), suma kontrolna SHA-256, kopia poprzedniej wersji (.prev) i odzyskiwanie po awarii.
// Przeznaczony dla JEDNEGO procesu zapisującego – blokadę wymusza plik .writer.lock.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class ConflictError extends Error {
  constructor(current) {
    super('Dane zmieniły się na innym urządzeniu – odśwież, aby zobaczyć aktualny stan');
    this.code = 'conflict';
    this.status = 409;
    this.current = current;
  }
}
export class IntegrityError extends Error {
  constructor(msg) { super(msg); this.code = 'integrity'; this.status = 500; }
}
export class ValidationError extends Error {
  constructor(msg) { super(msg); this.code = 'validation'; this.status = 400; }
}

const NAME_RE = /^[a-z0-9_-]+(\/[a-zA-Z0-9_-]+)?$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clone = (x) => (x === undefined ? undefined : structuredClone(x));

export class JsonStore {
  constructor(dir, { validators = {}, log = console, singleWriter = true } = {}) {
    this.dir = path.resolve(dir);
    this.validators = validators; // { prefix: (data) => void | throw }
    this.log = log;
    this.singleWriter = singleWriter;
    this.cache = new Map();   // name → { rev, data, updatedAt }
    this.queues = new Map();  // name → Promise (łańcuch operacji)
    this.gate = Promise.resolve(); // blokada globalna (przywracanie kopii)
    this.lockFile = path.join(this.dir, '.writer.lock');
    this.recovered = [];
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (this.singleWriter) this.#acquireWriterLock();
    await this.#cleanupTmp(this.dir);
    return this;
  }

  close() {
    if (this.singleWriter) {
      try {
        const pid = fs.readFileSync(this.lockFile, 'utf8').trim();
        if (pid === String(process.pid)) fs.unlinkSync(this.lockFile);
      } catch { /* brak blokady */ }
    }
  }

  #acquireWriterLock() {
    try {
      fs.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const pid = Number(fs.readFileSync(this.lockFile, 'utf8').trim());
    let alive = false;
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    }
    if (alive) throw new Error(`Katalog danych jest używany przez inny proces (PID ${pid}). Uruchom tylko jedną instancję serwera.`);
    fs.writeFileSync(this.lockFile, String(process.pid), { mode: 0o600 });
    this.log.warn?.(`Przejęto osieroconą blokadę zapisu (PID ${pid}).`);
  }

  async #cleanupTmp(dir) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'backups') await this.#cleanupTmp(p);
      else if (e.name.includes('.tmp-')) {
        await fsp.unlink(p).catch(() => {});
        this.recovered.push(`usunięto niedokończony zapis ${path.relative(this.dir, p)}`);
      }
    }
  }

  file(name) {
    if (!NAME_RE.test(name)) throw new Error('Niepoprawna nazwa dokumentu: ' + name);
    return path.join(this.dir, name + '.json');
  }

  #validatorFor(name) {
    const prefix = name.includes('/') ? name.split('/')[0] + '/' : name;
    return this.validators[prefix];
  }

  async #readFile(file) {
    const raw = await fsp.readFile(file, 'utf8');
    const env = JSON.parse(raw);
    if (!env || typeof env !== 'object' || !env._meta || !('data' in env)) throw new IntegrityError('Brak koperty dokumentu');
    const body = JSON.stringify(env.data);
    if (env._meta.sha256 !== sha256(body)) throw new IntegrityError('Niezgodna suma kontrolna');
    return { rev: env._meta.rev, updatedAt: env._meta.updatedAt, data: env.data };
  }

  // Odczyt z weryfikacją integralności; przy uszkodzeniu – automatyczny powrót do poprzedniej wersji.
  async #load(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const file = this.file(name);
    let doc = null;
    try {
      doc = await this.#readFile(file);
    } catch (e) {
      if (e.code === 'ENOENT') {
        doc = null;
      } else {
        this.log.error?.(`Dokument ${name} uszkodzony (${e.message}) – próba odtworzenia z .prev`);
        try {
          doc = await this.#readFile(file + '.prev');
          await this.#writeFile(file, doc.rev, doc.data, doc.updatedAt);
          this.recovered.push(`odtworzono ${name} z poprzedniej wersji`);
        } catch (e2) {
          throw new IntegrityError(`Dokument ${name} jest uszkodzony i nie ma poprawnej kopii – przywróć backup`);
        }
      }
    }
    if (doc) this.cache.set(name, doc);
    return doc;
  }

  async #writeFile(file, rev, data, updatedAt = new Date().toISOString()) {
    const body = JSON.stringify(data);
    const env = { _meta: { rev, updatedAt, sha256: sha256(body) }, data };
    const text = JSON.stringify(env, null, 1);
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try { await fsp.copyFile(file, file + '.prev'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.rename(tmp, file);
    try {
      const dh = await fsp.open(path.dirname(file), 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* fsync katalogu nie wszędzie możliwy */ }
    return { rev, updatedAt, data };
  }

  #enqueue(name, task) {
    const prev = this.queues.get(name) || Promise.resolve();
    const gate = this.gate; // operacje zlecone przed exclusive() kończą się przed nim
    const run = prev.then(() => gate).then(task);
    const tail = run.catch(() => {});
    this.queues.set(name, tail);
    tail.then(() => { if (this.queues.get(name) === tail) this.queues.delete(name); });
    return run;
  }

  async get(name) {
    await this.gate;
    const doc = await this.#load(name);
    return doc ? { rev: doc.rev, updatedAt: doc.updatedAt, data: clone(doc.data) } : null;
  }

  async getData(name, fallback = null) {
    const d = await this.get(name);
    return d ? d.data : fallback;
  }

  // Zmiana dokumentu w kolejce. fn(data|null) zwraca nowe dane (albo undefined = bez zapisu).
  // expectRev – kontrola wersji (ochrona przed utratą aktualizacji).
  update(name, fn, { expectRev } = {}) {
    return this.#enqueue(name, async () => {
      const cur = await this.#load(name);
      const curRev = cur ? cur.rev : 0;
      if (expectRev != null && expectRev !== curRev) throw new ConflictError(cur ? clone(cur.data) : null);
      const next = await fn(cur ? clone(cur.data) : null, curRev);
      if (next === undefined) return { rev: curRev, data: cur ? clone(cur.data) : null, changed: false };
      const validate = this.#validatorFor(name);
      if (validate) validate(next, name);
      const doc = await this.#writeFile(this.file(name), curRev + 1, next);
      this.cache.set(name, doc);
      return { rev: doc.rev, data: clone(doc.data), changed: true };
    });
  }

  async list(prefix) {
    const dir = path.join(this.dir, prefix);
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { return []; }
    return entries.filter((f) => f.endsWith('.json')).map((f) => `${prefix}/${f.slice(0, -5)}`).sort();
  }

  // keepPrev: false usuwa też kopię .prev (trwałe sprzątanie, np. starych zamkniętych pokoi).
  async remove(name, { keepPrev = true } = {}) {
    return this.#enqueue(name, async () => {
      const file = this.file(name);
      if (keepPrev) { try { await fsp.copyFile(file, file + '.prev'); } catch { /* brak */ } }
      else await fsp.unlink(file + '.prev').catch(() => {});
      await fsp.unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      this.cache.delete(name);
    });
  }

  // Wszystkie dokumenty (do kopii zapasowej / weryfikacji).
  async allNames() {
    const out = [];
    const walk = async (rel) => {
      const entries = await fsp.readdir(path.join(this.dir, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!rel && ['backups', 'audit', 'logs', 'migrations', 'runtime'].includes(e.name)) continue;
          if (!rel) await walk(e.name);
        } else if (e.name.endsWith('.json')) {
          out.push(rel ? `${rel}/${e.name.slice(0, -5)}` : e.name.slice(0, -5));
        }
      }
    };
    await walk('');
    return out.sort();
  }

  // Weryfikacja integralności wszystkich dokumentów.
  async verifyAll() {
    const problems = [];
    for (const name of await this.allNames()) {
      try {
        const doc = await this.#readFile(this.file(name));
        const v = this.#validatorFor(name);
        if (v) v(doc.data, name);
      } catch (e) {
        problems.push({ name, error: e.message });
      }
    }
    return problems;
  }

  // Wyłączny dostęp do całego magazynu (np. przywracanie kopii). Czeka na zakończenie trwających operacji.
  async exclusive(fn) {
    let release;
    const prevGate = this.gate;
    this.gate = new Promise((r) => { release = r; });
    await prevGate;
    await Promise.all([...this.queues.values()]);
    try {
      return await fn({
        writeRaw: async (name, rev, data, updatedAt) => {
          const doc = await this.#writeFile(this.file(name), rev, data, updatedAt);
          this.cache.set(name, doc);
        },
        removeRaw: async (name) => {
          await fsp.unlink(this.file(name)).catch(() => {});
          await fsp.unlink(this.file(name) + '.prev').catch(() => {});
          this.cache.delete(name);
        },
        readRaw: (name) => this.#readFile(this.file(name)),
      });
    } finally {
      release();
    }
  }

  async appendLine(rel, obj) {
    const file = path.join(this.dir, rel);
    return this.#enqueue('__append__' + rel.replace(/[^a-z0-9]/gi, '_'), async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fsp.appendFile(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
    });
  }
}

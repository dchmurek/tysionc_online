// Kopie zapasowe całego magazynu: paczka JSON (gzip) z kopertami dokumentów i sumami kontrolnymi.
// Kopia administracyjna do pobrania jest szyfrowana AES-256-GCM kluczem z hasła (scrypt).
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const scrypt = promisify(crypto.scrypt);
export const BACKUP_FORMAT = 'tysiac-backup';
export const BACKUP_VERSION = 2;
const NAME_RE = /^backup-[0-9TZ-]+(-[a-z0-9-]{1,40})?\.json\.gz$/;

export function backupDir(store) { return path.join(store.dir, 'backups'); }

export async function buildBundle(store) {
  const files = {};
  await store.exclusive(async ({ readRaw }) => {
    for (const name of await store.allNames()) {
      const doc = await readRaw(name);
      files[name] = { rev: doc.rev, updatedAt: doc.updatedAt, data: doc.data };
    }
  });
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(), files, sha256: sha(JSON.stringify(files)) };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createBackup(store, label = 'manual') {
  const bundle = await buildBundle(store);
  const dir = backupDir(store);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = String(label).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  const name = `backup-${stamp}-${safe}.json.gz`;
  const tmp = path.join(dir, name + '.tmp-' + process.pid);
  const fh = await fsp.open(tmp, 'w', 0o600);
  try { await fh.writeFile(await gzip(JSON.stringify(bundle))); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, path.join(dir, name));
  return { name, files: Object.keys(bundle.files).length, createdAt: bundle.createdAt };
}

export async function listBackups(store) {
  const dir = backupDir(store);
  const entries = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const f of entries) {
    if (!NAME_RE.test(f)) continue;
    const st = await fsp.stat(path.join(dir, f));
    out.push({ name: f, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function readBackup(store, name) {
  if (!NAME_RE.test(name)) throw new Error('Zła nazwa kopii');
  const raw = await fsp.readFile(path.join(backupDir(store), name));
  return parseBundle(JSON.parse((await gunzip(raw)).toString('utf8')));
}

export function parseBundle(bundle) {
  if (!bundle || bundle.format !== BACKUP_FORMAT) throw new Error('To nie jest kopia zapasowa Tysiąca');
  if (bundle.version > BACKUP_VERSION) throw new Error('Kopia pochodzi z nowszej wersji aplikacji');
  if (bundle.sha256 !== sha(JSON.stringify(bundle.files))) throw new Error('Kopia jest uszkodzona (zła suma kontrolna)');
  return bundle;
}

// Usuwa stare kopie automatyczne (zostawia `keep` najnowszych oraz wszystkie oznaczone jako pre-*).
export async function rotateBackups(store, keep = 60) {
  const all = await listBackups(store);
  const auto = all.filter((b) => b.name.includes('-daily'));
  for (const b of auto.slice(keep)) await fsp.unlink(path.join(backupDir(store), b.name)).catch(() => {});
}

// Przywraca paczkę: weryfikacja + kopia bieżącego stanu + podmiana wszystkich dokumentów.
export async function restoreBundle(store, bundle, { validators = {} } = {}) {
  parseBundle(bundle);
  for (const [name, doc] of Object.entries(bundle.files)) {
    const prefix = name.includes('/') ? name.split('/')[0] + '/' : name;
    if (validators[prefix]) validators[prefix](doc.data, name);
  }
  const pre = await createBackup(store, 'pre-restore');
  await store.exclusive(async ({ writeRaw, removeRaw }) => {
    const current = await store.allNames();
    for (const name of current) if (!(name in bundle.files) && name !== 'meta') await removeRaw(name);
    for (const [name, doc] of Object.entries(bundle.files)) await writeRaw(name, (doc.rev || 0) + 1, doc.data);
  });
  return { restored: Object.keys(bundle.files).length, preRestoreBackup: pre.name };
}

export async function encryptBundle(bundle, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Hasło do kopii musi mieć co najmniej 12 znaków');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(await gzip(JSON.stringify(bundle))), c.final()]);
  return Buffer.from(JSON.stringify({ format: 'tysiac-backup-enc', v: 1, kdf: 'scrypt-N32768-r8-p1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') }));
}

export async function decryptBundle(buf, passphrase) {
  const env = JSON.parse(buf.toString('utf8'));
  if (env.format !== 'tysiac-backup-enc') throw new Error('To nie jest zaszyfrowana kopia');
  const key = await scrypt(passphrase, Buffer.from(env.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  let plain;
  try { plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]); } catch { throw new Error('Złe hasło albo uszkodzony plik kopii'); }
  return parseBundle(JSON.parse((await gunzip(plain)).toString('utf8')));
}

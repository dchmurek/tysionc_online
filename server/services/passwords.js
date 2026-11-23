// Hashowanie haseł: Argon2id (wbudowane w Node ≥ 24.7), w razie braku – scrypt.
// Format: $argon2id$v=19$m=19456,t=2,p=1$<salt b64>$<hash b64>  |  $scrypt$N=32768,r=8,p=1$<salt>$<hash>
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 }; // zalecenia OWASP
export const HAS_ARGON2 = typeof crypto.argon2 === 'function';
const b64 = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(s, 'base64');

function argon2(message, nonce, p) {
  return new Promise((resolve, reject) => {
    crypto.argon2('argon2id', { message, nonce, parallelism: p.parallelism, tagLength: p.tagLength, memory: p.memory, passes: p.passes }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  if (HAS_ARGON2) {
    const key = await argon2(password, salt, ARGON);
    return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(salt)}$${b64(key)}`;
  }
  const key = await scryptAsync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `$scrypt$N=32768,r=8,p=1$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const parts = stored.split('$');
  try {
    if (parts[1] === 'argon2id' && HAS_ARGON2) {
      const params = Object.fromEntries(parts[3].split(',').map((kv) => kv.split('=')));
      const salt = unb64(parts[4]);
      const expected = unb64(parts[5]);
      const key = await argon2(password, salt, { memory: +params.m, passes: +params.t, parallelism: +params.p, tagLength: expected.length });
      return crypto.timingSafeEqual(key, expected);
    }
    if (parts[1] === 'scrypt') {
      const params = Object.fromEntries(parts[2].split(',').map((kv) => kv.split('=')));
      const salt = unb64(parts[3]);
      const expected = unb64(parts[4]);
      const key = await scryptAsync(password, salt, expected.length, { N: +params.N, r: +params.r, p: +params.p, maxmem: 64 * 1024 * 1024 });
      return crypto.timingSafeEqual(key, expected);
    }
  } catch {
    return false;
  }
  return false;
}

export function needsRehash(stored) {
  return HAS_ARGON2 ? !String(stored).startsWith(`$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},`) : false;
}

// Atrapa do wyrównania czasu odpowiedzi, gdy użytkownik nie istnieje.
let dummyHash = null;
export async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(String(password || ''), dummyHash);
  return false;
}

const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyui', 'qwerty123', 'haslo123', 'tysiac123', '11111111', 'iloveyou', 'abcdefgh', 'zaq12wsx', 'polska123']);
export function passwordProblem(pw, nick = '') {
  if (typeof pw !== 'string') return 'Podaj hasło';
  if ([...pw].length < 10) return 'Hasło musi mieć co najmniej 10 znaków';
  if (pw.length > 200) return 'Hasło jest za długie';
  if (COMMON.has(pw.toLowerCase())) return 'To hasło jest zbyt popularne';
  if (nick && pw.toLowerCase().includes(nick.toLowerCase()) && nick.length >= 3) return 'Hasło nie może zawierać nicku';
  return null;
}

// Konfiguracja ze zmiennych środowiskowych (opcjonalnie plik .env – bez zewnętrznych bibliotek).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function getConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  return {
    prod,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8080),
    dataDir: path.resolve(ROOT, env.DATA_DIR || 'storage'),
    publicDir: path.join(ROOT, 'public'),
    sharedDir: path.join(ROOT, 'shared'),
    // Za odwrotnym proxy (nginx/Caddy) z HTTPS: ciasteczka Secure i zaufany X-Forwarded-For.
    trustProxy: env.TRUST_PROXY === '1',
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : prod,
    // Dozwolone originy dla WebSocket/POST (np. https://tysiac.example.pl). Pusty = tylko ten sam host.
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    registerPerHour: Number(env.REGISTER_PER_HOUR || 20),
    backupKeep: Number(env.BACKUP_KEEP || 60),
    logLevel: env.LOG_LEVEL || (prod ? 'info' : 'debug'),
  };
}

// Pliki statyczne: public/ oraz wspólne moduły /shared/*.js (silnik używany też w przeglądarce).
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self' ws: wss:", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
].join('; ');
const etags = new Map();

export async function serveStatic(req, res, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  let base = config.publicDir;
  let rel = urlPath;
  if (urlPath.startsWith('/shared/')) { base = config.sharedDir; rel = urlPath.slice('/shared'.length); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // aplikacja jednostronicowa
  const file = path.join(base, path.normalize(rel));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  const type = TYPES[path.extname(file)];
  if (!type) { res.writeHead(404); return res.end(); }
  let body;
  try { body = await fsp.readFile(file); } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nie znaleziono'); }
  const key = file + ':' + body.length;
  let etag = etags.get(key);
  if (!etag || !config.prod) { etag = '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"'; etags.set(key, etag); }
  const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
  if (file.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Kopiuje biblioteki z node_modules do public/vendor (samodzielny hosting – bez CDN).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const FILES = [
  ['node_modules/chart.js/dist/chart.umd.min.js', 'public/vendor/chart.umd.min.js'],
  ['node_modules/qrcode-generator/dist/qrcode.mjs', 'public/vendor/qrcode.js'], // kody QR zaproszeń (ESM)
];
for (const [from, to] of FILES) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('Skopiowano →', path.relative(ROOT, dst));
}

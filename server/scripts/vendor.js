// Kopiuje Chart.js z node_modules do public/vendor (samodzielny hosting – bez CDN).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const src = path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js');
const dst = path.join(ROOT, 'public/vendor/chart.umd.min.js');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('Skopiowano Chart.js →', path.relative(ROOT, dst));

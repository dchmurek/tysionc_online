#!/usr/bin/env bash
# Buduje gotowy folder do wgrania do public_html (hosting PHP, np. CyberFolks) – bez Node.js na serwerze.
# Wynik:
#   dist/public_html/                 – zawartość do skopiowania do public_html (z danymi)
#   dist/tysiac-public_html.zip       – to samo w ZIP (pierwsza instalacja, z danymi z tysiac-baza/)
#   dist/tysiac-aktualizacja.zip      – tylko kod, BEZ danych (aktualizacja bez nadpisywania _dane)
# Użycie: bash deploy/build-public-html.sh [katalog-danych]   (domyślnie: tysiac-baza)
set -euo pipefail
cd "$(dirname "$0")/.."
DATA_SRC="${1:-tysiac-baza}"
OUT=dist/public_html

for f in public/vendor/chart.umd.min.js public/vendor/qrcode.js; do
  [ -f "$f" ] || { echo "Brak $f – uruchom najpierw: npm install"; exit 1; }
done

rm -rf "$OUT" dist/tysiac-public_html.zip dist/tysiac-aktualizacja.zip
mkdir -p "$OUT/shared"

# Frontend (bez zmian) + moduły wspólne używane w przeglądarce
rsync -a --exclude '.DS_Store' public/ "$OUT/"
cp shared/*.js "$OUT/shared/"
# WebSocket → odpytywanie HTTP
cp php/overrides/js/ws.js "$OUT/js/ws.js"
# Nowa wersja cache Service Workera (żeby telefony pobrały nowe pliki)
sed -i.bak "s/^const VERSION = .*/const VERSION = 'tysiac-php-$(date +%Y%m%d%H%M)';/" "$OUT/sw.js" && rm -f "$OUT/sw.js.bak"

# Backend PHP
cp php/api.php php/.htaccess "$OUT/"
rsync -a --exclude '.DS_Store' php/_app/ "$OUT/_app/"

# Dane
mkdir -p "$OUT/_dane"
if [ -d "$DATA_SRC" ]; then
  rsync -a --exclude '.writer.lock' --exclude '*.tmp-*' --exclude '.DS_Store' --exclude 'backups' "$DATA_SRC"/ "$OUT/_dane/"
fi
printf 'Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n' > "$OUT/_dane/.htaccess"
: > "$OUT/_dane/index.html"
find "$OUT" -name '.DS_Store' -delete

# Uprawnienia typowe dla hostingu współdzielonego
find "$OUT" -type d -exec chmod 755 {} +
find "$OUT" -type f -exec chmod 644 {} +
chmod 700 "$OUT/_dane"

(cd "$OUT" && zip -qr -X ../tysiac-public_html.zip . -x '.DS_Store')
(cd "$OUT" && zip -qr -X ../tysiac-aktualizacja.zip . -x '_dane/*' -x '_app/config.php' -x '.DS_Store')
echo "Gotowe:"
echo "  $OUT/                       (folder do wgrania)"
echo "  dist/tysiac-public_html.zip (pierwsza instalacja – z danymi)"
echo "  dist/tysiac-aktualizacja.zip (aktualizacja – bez danych)"

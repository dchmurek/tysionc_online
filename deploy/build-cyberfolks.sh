#!/usr/bin/env bash
# Buduje paczkę do wgrania na CyberFolks (Node.js App / Passenger): dist/tysiac-cyberfolks.zip
# Użycie: bash deploy/build-cyberfolks.sh [katalog-danych]   (domyślnie: tysiac-baza)
set -euo pipefail
cd "$(dirname "$0")/.."
DATA_SRC="${1:-tysiac-baza}"

[ -d node_modules ] || npm install --ignore-scripts >/dev/null
node server/scripts/vendor.js

rm -rf dist && mkdir -p dist/app
cp -R app.cjs package.json package-lock.json server shared public dist/app/
cp .env.example dist/app/.env.example
mkdir -p dist/app/tmp

if [ -d "$DATA_SRC" ]; then
  mkdir -p dist/tysiac-data
  rsync -a --exclude '.writer.lock' --exclude '*.tmp-*' "$DATA_SRC"/ dist/tysiac-data/
fi

(cd dist && zip -qr tysiac-cyberfolks.zip app $( [ -d tysiac-data ] && echo tysiac-data ))
echo "Gotowe: dist/tysiac-cyberfolks.zip"

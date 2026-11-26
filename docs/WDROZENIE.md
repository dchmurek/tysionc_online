# Wdrożenie

## Czy wystarczy obecny hosting (CyberFolks, PHP)?

**Nie dla pełnej wersji.** Gra online wymaga stale działającego procesu Node.js z WebSocketami. Zwykły hosting współdzielony z PHP tego nie zapewnia.
Niektóre plany CyberFolks mają obsługę aplikacji Node.js (instrukcja: [CYBERFOLKS.md](CYBERFOLKS.md)) – **trzeba to sprawdzić w panelu** (stały proces, WebSocket przez proxy, możliwość ustawienia katalogu danych poza `public_html`). Jeśli plan tego nie ma, potrzebny jest VPS (np. najmniejszy VPS w CyberFolks lub innym dostawcy – wystarczy 1 vCPU / 1 GB RAM).

Stara wersja PHP (licznik) nie jest już w repozytorium (jest w historii git, commit sprzed usunięcia `legacy/php/`) i nadal może działać na obecnym hostingu, ale **nie wolno** uruchamiać jej równolegle z nową wersją na tych samych danych – nowa wersja ma własny magazyn (`DATA_DIR`) i jest jedynym zapisującym.

## Wariant zalecany: VPS (Ubuntu/Debian)

```bash
# 1. Node.js 24 i narzędzia
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx rsync

# 2. Użytkownik i katalogi
sudo useradd --system --home /opt/tysiac --shell /usr/sbin/nologin tysiac
sudo mkdir -p /opt/tysiac /var/lib/tysiac
sudo chown tysiac:tysiac /var/lib/tysiac && sudo chmod 700 /var/lib/tysiac

# 3. Kod
sudo git clone https://github.com/dchmurek/tysionc_online.git /opt/tysiac
cd /opt/tysiac && sudo npm ci --omit=dev && sudo node server/scripts/vendor.js
sudo cp .env.example .env && sudo nano .env      # DATA_DIR=/var/lib/tysiac, ALLOWED_ORIGINS=https://twoja-domena
sudo chown -R root:root /opt/tysiac && sudo chown root:tysiac .env && sudo chmod 640 .env

# 4. Migracja danych ze starej wersji (plik data/db.json pobrany z hostingu – np. przez FTP)
sudo -u tysiac env DATA_DIR=/var/lib/tysiac node server/scripts/migrate.js --source /ścieżka/do/db.json --dry-run
sudo -u tysiac env DATA_DIR=/var/lib/tysiac node server/scripts/migrate.js --source /ścieżka/do/db.json

# 5. Administrator
# (Kamil, Daniel, Karol i Akuro są administratorami od migracji – potrzebne są tylko kody aktywacyjne)
for n in Kamil Daniel Karol Akuro; do sudo -u tysiac env DATA_DIR=/var/lib/tysiac node server/scripts/admin.js activation $n; done
# albo od razu tymczasowe hasło (gracz zmienia je w Profilu):
# sudo -u tysiac env DATA_DIR=/var/lib/tysiac node server/scripts/admin.js password Karol <hasło-min-10-znaków>

# 6. Usługa i HTTPS
sudo cp deploy/tysiac.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now tysiac
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tysiac   # podmień tysiac.example.pl na swoją domenę
sudo ln -s /etc/nginx/sites-available/tysiac /etc/nginx/sites-enabled/ && sudo certbot --nginx -d twoja-domena && sudo systemctl reload nginx
```

Zamiast nginx można użyć Caddy (`deploy/Caddyfile`) – sam pobiera certyfikat.

### Dzień przełączenia ze starej strony PHP

1. Uprzedź graczy, że na starej stronie nic już nie wpisujecie.
2. Pobierz z hostingu **najświeższy** `data/db.json` (FTP) – migracja sama przekształca go do nowego formatu, więc zmiany w bazie od ostatniej kopii nie są problemem.
3. Kroki 4–5 powyżej (najpierw `--dry-run`: musi pokazać „wszystkie … mecze identyczne co do punktu”).
4. Jeśli ktoś jednak dopisał coś w PHP po migracji – pobierz db.json jeszcze raz i uruchom migrację ponownie (przy zatrzymanym serwerze): dopisze nowe mecze i rozdania, niczego nie zdubluje.
5. Starą stronę PHP wyłącz albo zostaw tylko do podglądu.

Lokalnego katalogu `storage/` z komputera dewelopera **nie** przenosimy (są w nim konta testowe i skróty haseł).

### WebSocket
Ścieżka `/ws` musi być przekazywana z nagłówkami `Upgrade`/`Connection` (gotowe w `deploy/nginx.conf`). Serwer sprawdza nagłówek `Origin` – ustaw `ALLOWED_ORIGINS` na adres strony, jeśli proxy zmienia `Host`.

### Jedna instancja
Magazyn JSON ma **jednego zapisującego**. Serwer zakłada blokadę `DATA_DIR/.writer.lock` i odmówi startu drugiej instancji na tych samych danych. Nie uruchamiaj kilku procesów (PM2 cluster, kilka kontenerów) na jednym katalogu danych.

## Restart, logi, aktualizacja

```bash
sudo systemctl restart tysiac          # restart (mecze online wznawiają się z rooms/*.json)
sudo journalctl -u tysiac -f           # logi błędów
# aktualizacja:
cd /opt/tysiac && sudo git pull && sudo npm ci --omit=dev && sudo node server/scripts/vendor.js && sudo systemctl restart tysiac
```
Przed aktualizacją warto zrobić kopię: Panel → Administracja → „Utwórz kopię teraz” (albo `admin.js backup` przy zatrzymanym serwerze).

## Kopie zapasowe

- Automatycznie: kopia dzienna (`DATA_DIR/backups/backup-…-daily.json.gz`), trzymane `BACKUP_KEEP` ostatnich, oraz kopie `pre-migration`, `pre-import`, `pre-restore`.
- Ręcznie: Panel → Administracja → **Utwórz kopię teraz** / **Pobierz zaszyfrowaną kopię** (AES-256-GCM, hasło min. 12 znaków – zawiera skróty haseł, dlatego szyfrowana).
- Poza serwerem: `deploy/backup-offsite.sh` w cronie.

## Przywracanie

- Panel → Administracja → wybierz kopię → **Przywróć** (podgląd, potem potwierdzenie; bieżący stan zapisuje się jako `pre-restore`).
- Z pliku zaszyfrowanego: **Przywróć z pliku** + hasło kopii.
- CLI (serwer zatrzymany): `node server/scripts/admin.js backups` → `node server/scripts/admin.js restore <nazwa>`.
- Po awarii zasilania: serwer przy starcie usuwa niedokończone zapisy (`*.tmp-*`), a uszkodzony dokument odtwarza z poprzedniej wersji (`.prev`). Weryfikacja: `admin.js verify` lub Panel → Diagnostyka.

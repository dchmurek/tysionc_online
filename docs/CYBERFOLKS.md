# Wdrożenie na CyberFolks (panel DirectAdmin → „Setup Node.js App”)

Wymaga planu hostingowego z obsługą **Node.js** (CloudLinux Node.js Selector / Phusion Passenger) i wersji **Node 22.12+** (najlepiej 24).

## 1. Zbuduj paczkę (na swoim komputerze)

```bash
npm install
bash deploy/build-cyberfolks.sh          # dane z katalogu tysiac-baza/
```
Powstaje `dist/tysiac-cyberfolks.zip` z dwoma katalogami: `app/` (kod) i `tysiac-data/` (dane: konta, mecze).

## 2. Wgraj pliki (Menedżer plików lub FTP)

Rozpakuj w katalogu domowym (NIE w `public_html`):
```
/home/<login>/tysiac/app/          ← kod
/home/<login>/tysiac-data/         ← dane (uprawnienia 700)
```

## 3. Utwórz aplikację: DirectAdmin → Extra Features → **Setup Node.js App** → Create Application

| Pole | Wartość |
|---|---|
| Node.js version | 24 (albo najwyższa ≥ 22.12) |
| Application mode | Production |
| Application root | `tysiac/app` |
| Application URL | Twoja domena / subdomena |
| Application startup file | `app.cjs` |

Zmienne środowiskowe (Add variable):
```
NODE_ENV=production
DATA_DIR=/home/<login>/tysiac-data
TRUST_PROXY=1
COOKIE_SECURE=1
ALLOWED_ORIGINS=https://twoja-domena.pl
```
Następnie: **Run NPM Install** → **Restart**. Włącz SSL (Let's Encrypt) dla domeny w panelu.

## 4. Sprawdzenie
- Strona otwiera się pod `https://twoja-domena.pl`, logowanie działa.
- Gra online: pokój, 4 graczy – jeśli ruchy nie docierają do innych bez odświeżenia, hosting blokuje WebSocket (`/ws`). Wtedy potrzebny jest VPS (`docs/WDROZENIE.md`).

## Uwagi
- **Jeden proces**: magazyn JSON ma jednego zapisującego (`.writer.lock`). Gdyby panel uruchomił 2 procesy, drugi nie wystartuje – zobacz logi (`stderr.log` w katalogu aplikacji).
- Restart: przycisk Restart w panelu albo `touch ~/tysiac/app/tmp/restart.txt`.
- Polecenia `npm run admin …` (kody aktywacyjne, kopie) wykonuj przez SSH **przy zatrzymanej aplikacji**:
  `source ~/nodevenv/tysiac/app/24/bin/activate && cd ~/tysiac/app && DATA_DIR=~/tysiac-data npm run admin -- verify`
- Aktualizacja: wgraj nowe `app/` (bez nadpisywania `tysiac-data/`), Run NPM Install, Restart.

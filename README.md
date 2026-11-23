# Tysiąc na krzyż – online i offline

Aplikacja do gry w Tysiąca na krzyż (4 graczy, 2 drużyny):

- **Online** – każdy gra na swoim telefonie. Serwer tasuje, rozdaje, pilnuje licytacji, kolejki, legalności ruchów i liczy wynik.
- **Offline** – gracie prawdziwymi kartami, aplikacja prowadzi wynik (licytacja, punkty, meldunki, historia).
- **Jeden mecz może przechodzić między trybami** (między rozdaniami) – ten sam wynik, drużyny, historia i statystyki.
- Konta graczy, statystyki globalne, **automatyczne grupy czwórek**, pary, sesje (spotkania), współpraca i rywalizacja.
- **Brak bazy danych** – wszystkie dane w plikach JSON po stronie serwera (zapis atomowy, wersje, kopie).

## Wymagania

- Node.js **22.12+** (zalecany 24 – ma wbudowany Argon2id; na starszym hasła są hashowane scryptem).
- Brak innych usług. Zależności npm: `ws` (WebSocket), `chart.js` (wykresy, hostowane lokalnie); deweloperskie: `@playwright/test`.

## Uruchomienie lokalne

```bash
npm install                 # instaluje zależności i kopiuje Chart.js do public/vendor
npm run migrate -- --source data/db.json   # (opcjonalnie) przeniesienie danych ze starej wersji PHP
npm start                   # http://127.0.0.1:8080
```

Dane trafiają do `storage/` (zmienna `DATA_DIR`). Katalog jest w `.gitignore`.

### Pierwszy administrator i aktywacja kont Kamil, Daniel, Karol, Akuro

Migracja tworzy cztery konta **bez haseł** (status „czeka na aktywację”); **każdy z czterech graczy ma rolę administratora**. Pierwszy kod generuje się z konsoli:

```bash
# przy zatrzymanym serwerze (magazyn ma jednego zapisującego):
npm run admin -- activation Daniel        # wypisuje jednorazowy kod, ważny 7 dni
npm start
```

Gracz otwiera stronę → **„Aktywuj konto”** → wpisuje nick, kod i własne hasło. Kody dla pozostałych może wygenerować każdy już aktywny administrator w aplikacji: **Profil → Administracja → Kod aktywacyjny** (albo wszystkie od razu z konsoli: `npm run admin -- activation Kamil` itd.). Nikt poza graczem nie zna hasła; administrator nie widzi haseł.

Nowi gracze rejestrują się sami: **„Zarejestruj się”** (nick + hasło, bez e-maila).

## Testy

```bash
npm test             # testy jednostkowe i integracyjne (silnik, punktacja, migracja, magazyn, API, 4 graczy online, bezpieczeństwo, wydajność)
npm run test:e2e     # Playwright (używa zainstalowanego Google Chrome): 5 rozdzielczości, gra online w 4 przeglądarkach, offline/konflikty
```

## Struktura

```
shared/      zasady, punktacja, silnik kart, statystyki, nicki – wspólne dla serwera i przeglądarki
server/      Node.js: HTTP API, WebSocket, magazyn JSON, konta, mecze, pokoje, migracja, CLI
public/      aplikacja (moduły ES bez bundlera), CSS, PWA (manifest, Service Worker), ikony
tests/       unit/, integration/, e2e/ (Playwright), fixtures/ (syntetyczne dane w formacie starej wersji)
deploy/      systemd, nginx, Caddy, kopia poza serwer
docs/        wdrożenie, zasady gry, migracja, bezpieczeństwo, model danych
legacy/php/  poprzednia wersja (PHP) – tylko do wglądu/wycofania, nie jest wdrażana
```

Dokumentacja: [docs/WDROZENIE.md](docs/WDROZENIE.md) · [docs/ZASADY.md](docs/ZASADY.md) · [docs/MIGRACJA.md](docs/MIGRACJA.md) · [docs/BEZPIECZENSTWO.md](docs/BEZPIECZENSTWO.md) · [docs/DANE.md](docs/DANE.md) · [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md)

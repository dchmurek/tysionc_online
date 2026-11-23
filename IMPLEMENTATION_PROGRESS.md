# Postęp implementacji – Tysiąc Online & Offline

Ostatnia aktualizacja: 2026-11-23 · gałąź robocza: `rozbudowa` (bez pusha – czeka na zgodę właściciela)

## Jak wznowić pracę (dla kolejnej sesji)

1. `npm install` → `npm test` (backend) → `npm run test:e2e` (Playwright, wymaga Google Chrome).
2. Architektura: `README.md`, model danych: `docs/DANE.md`, zasady: `docs/ZASADY.md`.
3. Lokalne dane: `storage/` (zmigrowane z `data/db.json`, konta bez haseł). Testowe dane E2E: `tests/.tmp/e2e-data` (tworzone automatycznie).
4. Kopia oryginalnych danych sprzed prac: `backups-local/2026-11-23-przed-rozbudowa/` (z SHA256SUMS, poza repozytorium).

## Decyzje architektoniczne

| Decyzja | Uzasadnienie |
|---|---|
| Jeden serwer **Node.js** (HTTP + WebSocket) jako jedyny zapisujący dane | gra w czasie rzeczywistym wymaga stałego procesu; jeden zapisujący eliminuje konflikty PHP/Node na tych samych plikach |
| PHP przeniesione do `legacy/php/` (niewdrażane) | możliwość wglądu/wycofania; brak równoległego zapisu |
| Magazyn JSON z kopertą (rev + SHA-256), zapis tmp→fsync→rename, kolejka per dokument, `.prev`, blokada `.writer.lock` | atomowość, wykrywanie uszkodzeń, odzyskiwanie, brak utraty aktualizacji |
| Wynik meczu i statystyki zawsze liczone z rozdań (`shared/`) | korekty i migracje nie rozjeżdżają statystyk; „odbudowa” = przeliczenie |
| Kod zasad w `shared/` (ES modules) używany przez serwer i przeglądarkę | jedna implementacja zasad; klient tylko podgląda, serwer decyduje |
| Frontend: moduły ES bez bundlera, szablony z auto-escapowaniem, CSP | brak kroku budowania, ochrona XSS, łatwe wdrożenie |
| Konta: Argon2id, sesje serwerowe (hash tokenu), CSRF token, kody aktywacyjne | wymagania bezpieczeństwa bez zewnętrznych usług |
| Offline: kolejka operacji z `baseRev`/`opId`, konflikt → wybór użytkownika | brak „ostatni zapis wygrywa” |
| Migracja: deterministyczne ID, weryfikacja wyników co do punktu, meldunki wg wartości | powtarzalność i zachowanie historii |

## Etapy

| Etap | Status | Uwagi |
|---|---|---|
| A. Zabezpieczenie projektu | ✅ | gałąź `rozbudowa`, kopia danych z sumami SHA-256, `.gitignore` dla danych i sekretów |
| B. Architektura | ✅ | opis powyżej i w `docs/` |
| C. Fundamenty (bezpieczeństwo, zapis JSON, punktacja, usunięcie bomby, testy) | ✅ | bomba, „3 zera”, tryb 3-osobowy usunięte z nowego silnika |
| D. Migracja i konta | ✅ | Damazy→Daniel, Dollat→Kamil, Karol, Akuro; 10 meczów/142 rozdania identyczne; rejestracja, logowanie, aktywacja, profile, role |
| E. Statystyki | ✅ | globalne, ranking (sortowanie, Wilson + min. meczów), grupy, pary (filtr grupy), sesje, gracz, współpraca/rywalizacja, wykresy, CSV |
| F. Tryb offline | ✅ | kalkulator, korekty z historią, cofanie z przywróceniem, sesje, synchronizacja i konflikty |
| G. Tryb online | ✅ | silnik kart, licytacja, meldunki, atuty, obowiązki koloru/przebicia/atutu, lewy, pokoje, kod, miejsca, gotowość, reconnect, trwałość po restarcie |
| H. Integracja | ✅ | przełączanie offline↔online między rozdaniami (jeden mecz), wspólna historia i statystyki, import/eksport, kopie |
| I. Interfejs | ✅ | ciemny motyw „sukno”, stół 4 graczy, karty CSS, responsywność 320–1920, poziomo, dostępność (zoom, focus, aria), PWA |
| J. Testy końcowe | ✅ | wyniki niżej |

## Wyniki testów (rzeczywiście wykonane 2026-11-23)

- `npm test`: **98 testów – 98 zaliczonych** (unit: silnik kart, punktacja, statystyki; integracyjne: magazyn, kopie i przywracanie, migracja (także na prawdziwych danych lokalnie), konta, mecze i konflikty, pokoje, 4 graczy online przez WebSocket z restartem serwera, administracja/import, bezpieczeństwo, wydajność).
- `npm run test:e2e` (Playwright + Google Chrome): **21 zaliczonych, 29 pominiętych celowo** (scenariusze ograniczone do wybranych rozdzielczości), 0 błędów. Rozdzielczości: 1920×1080, 1366×768, 768×1024, 390×844, 320×568 i telefon poziomo 844×390.
- Wydajność: statystyki 2000 meczów / 30 000 rozdań ≈ 50 ms; 200 równoległych zapisów rozdań ≈ 16 ms/zapis (z fsync), bez utraty danych.

## Niezrealizowane / ograniczenia

- Wdrożenie produkcyjne – **nie wykonane** (wymaga zgody i decyzji o hostingu: obecny hosting PHP nie uruchomi gry online; instrukcja VPS w `docs/WDROZENIE.md`).
- Push na GitHub – **nie wykonany** (wymaga zgody).
- Testy na fizycznych telefonach (iOS Safari/Android) – nie wykonane; testy w Chrome z emulacją urządzeń.
- Limity prób logowania w pamięci (zerują się po restarcie).
- Brak timera tury w grze online (gracz może myśleć dowolnie długo); unieważnienie rozdania – tylko administrator.
- Ruletka przeniesiona bez zmian (dla zabawy, dane tylko w telefonie).

## Znane błędy

- Brak znanych błędów krytycznych.

## Wymagające decyzji właściciela

- Pytania w `docs/ZASADY.md` („Otwarte pytania”): kolory meldunków w historii, zaokrąglanie, zwolnienie z przebijania przy partnerze, obowiązkowe 100.
- Kto ma być administratorem (instrukcja zakłada Daniela – do potwierdzenia).
- Hosting (VPS lub sprawdzenie obsługi Node.js w CyberFolks).

## Kolejne zadania (propozycje)

1. Decyzje z listy powyżej → ewentualne zmiany ustawień domyślnych.
2. Wdrożenie na VPS + migracja produkcyjnego `db.json` + aktywacja 4 kont.
3. Test na prawdziwych telefonach przy stole; zbieranie uwag do UX.
4. Opcjonalnie: timer tury online, czat w pokoju, powiadomienia push o turze.

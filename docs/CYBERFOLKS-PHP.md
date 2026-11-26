# Wdrożenie na CyberFolks – wersja PHP (wrzucasz pliki do `public_html` i gotowe)

Ta wersja **nie wymaga Node.js ani aplikacji w panelu**. Działa na zwykłym hostingu PHP.
Frontend i dane są te same co w wersji Node.js. Różnica: zamiast WebSocketu gra online
odpytuje serwer co ~1,2 s, więc ruchy innych graczy pojawiają się z opóźnieniem do ok. 1–2 s.

## Co nowego (2026-11-26) – tylko w wersji PHP
- **Stoły zamiast „pokoi online”**: zakładasz stół (kod/QR), gracze siadają, a w środku wybieracie
  *Prawdziwe karty* (aplikacja liczy punkty, wystarczy jeden telefon – „Posadź gracza”) albo *Grę online*.
  Między rozdaniami można przełączać się w obie strony bez wychodzenia ze stołu.
- **Czat stołu** wysuwany z prawej (wspólny dla wszystkich, bez czatu drużynowego), licznik nieprzeczytanych,
  podgląd nowej wiadomości, szybkie odpowiedzi. Wiadomości: `_dane/runtime/chat-<stół>.json` (ostatnie 300).
  Czat jest czyszczony, gdy gra się skończy: przy rewanżu, zamknięciu stołu, usunięciu/przerwaniu meczu,
  a nieużywany stół po skończonym meczu zamyka się sam po 24 h.
- **Czas na ruch** w grze online (domyślnie 60 s, do zmiany w poczekalni: 30/60/90/120 s albo bez limitu).
  Po upływie czasu serwer sam wykonuje ruch: pas w licytacji, najsłabsze karty z musika, najsłabsza dozwolona
  karta (bez rozbijania pary K+D; jeśli można zameldować – melduje). Hosting nie ma stałego procesu, więc ruch
  wykonuje się przy najbliższym odpytaniu kogokolwiek przy stole (do ~1–2 s po czasie).
- Lekka wibracja, gdy przychodzi Twoja kolej, i ostrzeżenie 10 s przed końcem czasu (Android; iPhone nie obsługuje wibracji ze stron WWW).
- **Usuwanie / przerywanie meczu z listy** (przycisk ⋯ przy meczu) – stół zamyka się sam.
- Stół gry online mieści się na jednym ekranie; tromf i kontrakt leżą „na stole” w lewym górnym rogu.
- Zagranie króla/damy z pary bez meldunku wymaga potwierdzenia; zbyt szybkie podwójne stuknięcie nie zagrywa karty.

Wersja Node.js (`server/`) **nie ma** tych funkcji – rozwijana jest wersja PHP.

## Wymagania
- PHP **8.1 lub nowszy** (zalecany 8.3). Ustawisz to w panelu: *Wybór wersji PHP*.
- Rozszerzenia (na CyberFolks są domyślnie): `json`, `mbstring`, `openssl`, `zlib`; zalecane `intl`, `sodium`.
- Aplikacja musi działać w **głównym katalogu domeny lub subdomeny** (np. `https://tysiac.twojadomena.pl/`), nie w podkatalogu.

## 1. Zbuduj paczkę (na swoim komputerze)
```bash
npm install                          # tylko raz – pobiera Chart.js i QR do public/vendor
bash deploy/build-public-html.sh     # dane z katalogu tysiac-baza/
```
Powstaje:
- `dist/tysiac-public_html.zip` – **pierwsza instalacja** (kod + dane: konta, mecze),
- `dist/tysiac-aktualizacja.zip` – **aktualizacja** (sam kod, bez danych),
- `dist/public_html/` – to samo co w pierwszym ZIP, rozpakowane.

## 2. Wgraj do `public_html`
1. Panel → Menedżer plików → `domains/<twoja-domena>/public_html`.
2. Usuń domyślne pliki hostingu (np. `index.html`/`index.php` z powitaniem).
3. Wgraj `tysiac-public_html.zip` i **rozpakuj go w `public_html`** (albo wgraj przez FTP zawartość `dist/public_html/`).
   Pliki ukryte `.htaccess` muszą trafić na serwer (w FTP włącz pokazywanie ukrytych plików).
4. Włącz SSL (Let's Encrypt) dla domeny. Potem w `public_html/.htaccess` usuń `#` z trzech linii „Wymuszenie HTTPS”.

Struktura na serwerze:
```
public_html/
  .htaccess        ← przekierowanie /api/* do api.php, blokady, nagłówki bezpieczeństwa
  api.php          ← API (PHP)
  index.html, css/, js/, shared/, vendor/, icons/, sw.js, manifest.webmanifest
  _app/            ← kod PHP (zablokowany dla przeglądarki)
  _dane/           ← dane JSON, kopie zapasowe (zablokowany dla przeglądarki)
```

## 3. Sprawdzenie
- `https://twoja-domena.pl` – strona logowania; Kamil, Daniel, Karol, Akuro logują się **dotychczasowymi hasłami**.
- `https://twoja-domena.pl/_dane/users.json` musi zwrócić **403 Forbidden**. Jeśli plik się pobiera, serwer ignoruje `.htaccess` – wtedy przenieś dane poza `public_html` (punkt „Dane poza public_html”).
- Profil → Administracja → Diagnostyka: `integrityProblems: []`.

## Aktualizacja
Wgraj i rozpakuj `tysiac-aktualizacja.zip` w `public_html` (nadpisz pliki). Katalog `_dane/` i plik `_app/config.php` zostają nietknięte.

## Dane poza public_html (opcjonalnie, bezpieczniej)
1. Utwórz katalog np. `/home/<login>/tysiac-dane` i przenieś do niego zawartość `public_html/_dane/`.
2. W `public_html/_app/config.php` ustaw `'data_dir' => '/home/<login>/tysiac-dane',`.

## Kopie zapasowe
- Automatyczna kopia dzienna powstaje przy pierwszym otwarciu aplikacji danego dnia (`_dane/backups/`, trzymane 60 ostatnich).
- Kopia ręczna i pobranie zaszyfrowanej kopii: Profil → Administracja → Kopie.
- Najprościej: co jakiś czas pobierz cały katalog `_dane/` przez Menedżer plików/FTP.

## Różnice względem wersji Node.js
- Gra online przez odpytywanie HTTP zamiast WebSocket (opóźnienie do ~1–2 s, bez zmian w zasadach).
- Import pliku `db.json` ze starej aplikacji PHP nie jest dostępny (dane są już przeniesione); import eksportu JSON działa.
- Zaszyfrowane kopie `.tysiac.enc` z wersji Node.js nie dają się przywrócić w PHP (inny algorytm klucza) – kopie `.json.gz` działają w obu wersjach.
- Polecenia konsolowe (`npm run admin …`) nie są potrzebne: kody aktywacyjne generuje administrator w aplikacji.

## Rozwiązywanie problemów
- **Błąd 500 / „Brak dostępu do katalogu danych”** – ustaw uprawnienia: katalogi 755 (lub 700 dla `_dane`), pliki 644; właścicielem musi być konto hostingu.
- **404 na `/api/...`** – nie wgrał się `.htaccess` albo `mod_rewrite` jest wyłączony.
- **Biała strona po aktualizacji** – odśwież stronę 2× (Service Worker pobiera nowe pliki).
- Logi błędów PHP: panel → Logi błędów (wpisy zaczynają się od „Tysiąc”).

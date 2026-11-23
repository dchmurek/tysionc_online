# Tysiąc – liczenie punktów

## Wgranie na CyberFolks

1. Zaloguj się do panelu CyberFolks (DirectAdmin) → **Menedżer plików** (albo użyj FTP, np. FileZilla).
2. Wejdź do `domains/TWOJA-DOMENA/public_html/` (albo do podkatalogu, np. `public_html/tysiac/`).
3. Wgraj pliki:
   - `index.html`, `style.css`, `app.js`, `engine.js`
   - `api.php`, `auth.php`, `users.php`, `config.php`
   - `.htaccess` – plik ukryty (na Macu w Finderze: Cmd+Shift+. pokazuje ukryte pliki; FileZilla pokazuje go od razu)
4. Otwórz stronę w przeglądarce. Przy pierwszym zapisie `api.php` sam utworzy katalog `data/`
   z plikiem `db.json` i zablokuje do niego dostęp z zewnątrz (`.htaccess`).
   - Gdyby pojawił się błąd uprawnień: utwórz ręcznie katalog `data` i nadaj mu uprawnienia `755`.
5. Wersja PHP: 7.4 lub nowsza (na CyberFolks domyślnie jest 8.x – nic nie trzeba zmieniać).

## Repozytorium Git

`config.php`, `users.php` i katalog `data/` nie są w repozytorium (skróty haseł, klucz sesji, wyniki).
Na nowym serwerze skopiuj `config.example.php` → `config.php` i `users.example.php` → `users.php`
i wklej w nich skróty haseł wygenerowane poleceniem `php -r "echo password_hash('Haslo', PASSWORD_DEFAULT);"`.

## Hasło do stołu

Bez hasła nie da się ani zobaczyć wyników, ani niczego zmienić. Wszyscy gracze używają jednego wspólnego hasła.

- `users.php` zawiera tylko skrót hasła (bcrypt), nie samo hasło.
- Zmiana hasła: **Historia → Dostęp → Zmień hasło do stołu**. Wymaga **hasła administratora**
  (jego skrót jest w `config.php` jako `ADMIN_HASH`). Po zmianie wszystkie inne telefony
  zostaną wylogowane i trzeba im podać nowe hasło.
- Telefon pamięta logowanie przez 180 dni.
- Po 5 błędnych próbach z jednego adresu IP następuje 15 minut blokady.
- **Włącz SSL** w panelu CyberFolks (SSL/TLS → Let's Encrypt dla domeny). `.htaccess` przekierowuje
  wszystko na `https://`, żeby hasło nie szło otwartym tekstem. Gdyby strona po wgraniu się nie otwierała,
  certyfikat nie jest jeszcze aktywny: włącz go albo tymczasowo usuń pierwszy blok z `.htaccess`.

**Zapomniane hasło?** Wygeneruj nowy skrót (np. lokalnie:
`php -r "echo password_hash('NoweHaslo123', PASSWORD_DEFAULT);"`), wklej go w `users.php`
i usuń plik `data/users.json` (jeśli istnieje).

## Gdzie są dane

- `data/db.json` – wszystkie gry i gracze (jeden plik JSON).
- `data/users.json`, `data/secret.key` – zmienione hasła i klucz podpisu sesji. Nie usuwaj; skasowanie `secret.key` wyloguje wszystkich.
- `data/backups/db-RRRR-MM-DD.json` – automatyczna kopia raz dziennie, trzymana 120 dni.
- W zakładce **Historia** jest przycisk „Pobierz JSON” do zrobienia własnej kopii.

Miejsce: jedna gra to ok. 3–6 KB, więc nawet kilka gier dziennie przez rok to kilka MB.
Na hostingu CyberFolks to nic – dane się nie kasują, zostają na stałe.

Jeśli zgubi się internet przy stole, wynik zapisuje się w telefonie i wysyła na serwer, gdy
połączenie wróci.

## Zasady, które liczy aplikacja (można zmienić przy nowej grze)

- Grający, gdy ugra, dostaje tyle, ile faktycznie ugrał, jeśli to więcej niż licytacja
  (szedł 160, ugrał 200 → +200). Ugrane liczą się same: 120 − punkty przeciwników z kart + meldunki grającego. Gdy nie ugra, dostaje kwotę licytacji na minus.
  Zasadę można wyłączyć przy nowej grze albo w „Szczegółach gry” (wtedy zawsze liczy się kwota licytacji).
- Przeciwnicy dostają punkty z kart zaokrąglone do 10 oraz swoje meldunki
  (kier ♥100, karo ♦80, wino ♠60, żołądź ♣40).
- **Limit 990**: punkty z kart, meldunków i bomby (bez wygranej licytacji) podnoszą wynik
  najwyżej do 990. Kto ma 990, nic już nie dostaje biernie.
- Gra do 1000, ale wygrać można tylko ugraną licytacją: drużyna musi przebić licytację
  i zrealizować zadeklarowane punkty, żeby przekroczyć 990.
- Opcjonalnie: trzy zera z rzędu = −120.
- **4 na krzyż**: gracze wpisani jako 1 i 3 grają przeciwko 2 i 4, punkty liczy się drużynie.

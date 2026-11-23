# Bezpieczeństwo

## Zabezpieczenia w nowej wersji

| Obszar | Rozwiązanie |
|---|---|
| Hasła | Argon2id (m=19 MiB, t=2, p=1; wbudowany w Node ≥ 24.7), w razie braku – scrypt; min. 10 znaków, odrzucane popularne hasła i hasła zawierające nick |
| Sesje | losowy token 256-bit w ciasteczku `HttpOnly; SameSite=Strict; Secure` (przy HTTPS); na serwerze tylko SHA-256 tokenu; wygasanie 30 dni bezczynności / 180 dni maks.; wylogowanie pojedynczego urządzenia i wszystkich innych |
| CSRF | token CSRF sesji w nagłówku `X-CSRF-Token` + nagłówek `X-Tysiac` + kontrola `Origin` + `SameSite=Strict` |
| XSS | wszystkie dane wstawiane przez szablony z automatycznym escapowaniem; nicki ograniczone do liter łacińskich, cyfr i kilku znaków; Content-Security-Policy bez `unsafe-inline` dla skryptów; brak zewnętrznych CDN |
| Przejęcie konta | limit prób logowania per IP i per konto (blokada 15 min), zmiana hasła wymaga starego hasła i wylogowuje inne urządzenia, zmiana nicku wymaga hasła, aktywacja/reset tylko jednorazowym kodem od administratora (przechowywany jako hash, ważny 7 dni / 24 h) |
| Uprawnienia | role `admin`/`player` sprawdzane na serwerze; mecz zmienia tylko jego uczestnik, twórca lub administrator; administrator nie widzi haseł |
| Manipulacja wynikami | serwer waliduje każde rozdanie wg zasad i sam liczy wynik, zwycięzcę, rozdającego; klient nie ustawia statusu ani wyniku |
| Gra online | serwer autorytatywny; klient dostaje wyłącznie własne karty; kontrola kolejki, legalności, numeru stanu (`expectSeq`) i identyfikatora akcji (powtórzenia ignorowane); operacje pokoju wykonywane szeregowo |
| WebSocket | uwierzytelnienie ciasteczkiem sesji, wymagany zgodny `Origin`, limit rozmiaru wiadomości, ponowna kontrola sesji przy każdej wiadomości |
| Dane | poza katalogiem publicznym; pliki `0600`, katalogi `0700`; zapis atomowy z sumą kontrolną; eksport bez hashy i sesji; kopia administracyjna szyfrowana AES-256-GCM |
| Nagłówki | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS (przy HTTPS), `Permissions-Policy` |

## Ujawnione sekrety starej wersji – procedura rotacji

W starej wersji w katalogu projektu (i potencjalnie w repozytorium) leżały: `data/secret.key` (klucz podpisu sesji), `data/users.json`, `users.php` i `config.php` (skróty bcrypt). Obecne repozytorium ich **nie zawiera** (`.gitignore`), ale jeśli starsze kopie projektu były komuś udostępniane:

1. Na hostingu ze starą wersją: usuń `data/secret.key` (zostanie wygenerowany nowy – wszyscy zostaną wylogowani).
2. Zmień hasło do stołu i hasło administratora starej wersji (nowe skróty: `php -r "echo password_hash('NoweHaslo', PASSWORD_DEFAULT);"`).
3. Sprawdź historię repozytorium: `git log --all --stat -- data/ users.php config.php`. Jeśli pliki tam są – historię trzeba wyczyścić (np. `git filter-repo`) i wymusić push (wymaga decyzji właściciela), a i tak potraktować sekrety jako ujawnione (kroki 1–2).
4. Nowa wersja nie używa żadnego z tych sekretów – po przejściu na nią stara wersja powinna zostać wyłączona.

## Znane ograniczenia

- Limity prób logowania są trzymane w pamięci procesu (restart serwera je zeruje).
- Brak 2FA i odzyskiwania hasła e-mailem (zgodnie z założeniem: e-mail nieobowiązkowy) – reset hasła tylko przez administratora.

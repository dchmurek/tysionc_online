# Migracja danych ze starej wersji (PHP)

## Ostateczne mapowanie graczy

| Stara nazwa | Nowe konto |
|---|---|
| Damazy | **Daniel** |
| Dollat | **Kamil** |
| Karol | Karol |
| Akuro | Akuro |

Zakodowane w `server/migrate/legacy.js` (`NAME_MAP`) i sprawdzane testami (`tests/integration/migration.test.js`).

## Co robi migracja

1. Liczy odwołania każdego starego rekordu gracza (miejsca w meczach, licytacje, meldunki, rozdający).
2. Rekordy z historią mapuje na konta kanoniczne wg tabeli. Gracz z historią spoza tabeli → **przerwanie** (bez zgadywania).
3. Dwa rekordy z historią wskazujące na ten sam profil → **przerwanie i prośba o decyzję** (raport zawiera, czy kiedykolwiek grały razem).
4. Rekordy bez żadnej historii trafiają tylko do archiwum migracji. Drugi rekord „Akuro” (usunięty, 0 odwołań) jest dopisany jako alias Akuro; stary pusty rekord „Daniel” (usunięty, 0 odwołań) **nie** jest doklejany do nikogo.
5. Tworzy 4 konta oczekujące na aktywację (bez haseł) z deterministycznymi, stałymi ID; **wszystkie cztery z rolą administratora** (ustalenie właściciela). Mecze dostają zasady: zaokrąglanie do 10, kontrakt sprawdzany po zaokrągleniu (dotyczy nowych rozdań – historyczne zachowują zapisany wynik).
6. Przenosi mecze i rozdania; meldunki 1:1 (stare ♠ 60 → pik 60, stare ♣ 40 → trefl 40 – zgodnie z zasadami właściciela). Dane zmigrowane wcześniejszą wersją (z odwrotnym mapowaniem) serwer jednorazowo konwertuje przy starcie (`server/migrate/meldsV2.js`, kopia `pre-melds-v2`); rozdania dopisane już w nowej aplikacji zostają bez zmian. Oryginalne dane każdego rozdania zostają w `round.legacy`, a ustawienia i ID graczy meczu w `match.migratedFrom`.
7. **Weryfikuje każdy mecz**: wyniki po każdym rozdaniu i zwycięzca muszą być identyczne jak w starym silniku (`server/migrate/legacyEngine.cjs` – kopia silnika z wersji PHP). Jakakolwiek różnica przerywa migrację.
8. Grupuje mecze w sesje (spotkania): skupiska aktywności tej samej czwórki bez przerwy > 12 h.

## Wynik na prawdziwych danych (23.11.2026)

- 4 konta: Kamil (dawniej Dollat), Daniel (dawniej Damazy), Karol, Akuro.
- 10 meczów, 142 rozdania – **wszystkie wyniki identyczne co do punktu**.
- 4 sesje: 28.10 (5 meczów), 4.11 (2), 9.11 (1), 18.11 (2; mecz w toku, sesja otwarta).
- Archiwum: Banderowiec, Kamilek, Daniel (pusty, usunięty), drugi Akuro (alias).
- Ostrzeżenie: jedno rozdanie z ugranymi < kontrakt (zachowane jak w oryginale).

## Dosynchronizowanie 25.11.2026

Nowsza kopia produkcyjna (`data_oryginal`, 11 meczów, 183 rozdania) – wszystkie wyniki identyczne co do punktu. Mecz z 18.11 (`gmwm586ims9y6b`) dograny do końca w PHP (44 rozdania) zastąpił lokalną kopię testową; doszedł mecz z 25.11 (w toku, sesja otwarta).

## Bezpieczeństwo migracji

- Przed zapisem: kopia `pre-migration` całego magazynu; plik źródłowy kopiowany do `DATA_DIR/migrations/`.
- Raport zapisywany do `DATA_DIR/migrations/report-*.json`.
- **Idempotencja**: ponowne uruchomienie z tym samym plikiem niczego nie zmienia (nie resetuje haseł kont, nie nadpisuje meczów zmienionych po migracji).
- **Dosynchronizowanie z nowszą bazą PHP** (np. gdy stara strona działa dalej do dnia wdrożenia): `npm run migrate -- --source data/db.json` dopisuje nowe mecze, nowe rozdania i zmiany statusu w meczach nietkniętych w nowej aplikacji oraz odświeża sesje z migracji. Mecz zmieniony w nowej aplikacji (dopisane rozdanie, usunięty, pokój online) jest pomijany i wypisany w raporcie; `--prefer-source` zastępuje go wersją z pliku (po kopii `pre-migration`).
- Sesje bez żadnego rozpoczętego meczu (dzień, w którym tylko dokończono mecz) nie są tworzone.
- Wycofanie: przywróć kopię `pre-migration` (Panel → Administracja lub `admin.js restore`).
- Tryb próbny: `--dry-run` (wypisuje raport, nic nie zapisuje).

Import starej bazy jest też dostępny w panelu administratora (Import danych → wybierz `db.json` → podgląd → Zaimportuj).

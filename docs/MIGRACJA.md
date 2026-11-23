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
5. Tworzy 4 konta oczekujące na aktywację (bez haseł) z deterministycznymi, stałymi ID.
6. Przenosi mecze i rozdania; meldunki konwertuje według wartości (zob. `docs/ZASADY.md`, pytanie 1). Oryginalne dane każdego rozdania zostają w `round.legacy`, a ustawienia i ID graczy meczu w `match.migratedFrom`.
7. **Weryfikuje każdy mecz**: wyniki po każdym rozdaniu i zwycięzca muszą być identyczne jak w starym silniku (`legacy/php/engine.js`). Jakakolwiek różnica przerywa migrację.
8. Grupuje mecze w sesje (spotkania): skupiska aktywności tej samej czwórki bez przerwy > 12 h.

## Wynik na prawdziwych danych (23.11.2026)

- 4 konta: Kamil (dawniej Dollat), Daniel (dawniej Damazy), Karol, Akuro.
- 10 meczów, 142 rozdania – **wszystkie wyniki identyczne co do punktu**.
- 4 sesje: 28.10 (5 meczów), 4.11 (2), 9.11 (1), 18.11 (2; mecz w toku, sesja otwarta).
- Archiwum: Banderowiec, Kamilek, Daniel (pusty, usunięty), drugi Akuro (alias).
- Ostrzeżenie: jedno rozdanie z ugranymi < kontrakt (zachowane jak w oryginale).

## Bezpieczeństwo migracji

- Przed zapisem: kopia `pre-migration` całego magazynu; plik źródłowy kopiowany do `DATA_DIR/migrations/`.
- Raport zapisywany do `DATA_DIR/migrations/report-*.json`.
- **Idempotencja**: ponowne uruchomienie z tym samym plikiem niczego nie zmienia (nie resetuje haseł kont, nie nadpisuje meczów zmienionych po migracji).
- Wycofanie: przywróć kopię `pre-migration` (Panel → Administracja lub `admin.js restore`).
- Tryb próbny: `--dry-run` (wypisuje raport, nic nie zapisuje).

Import starej bazy jest też dostępny w panelu administratora (Import danych → wybierz `db.json` → podgląd → Zaimportuj).

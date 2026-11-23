# Model danych (pliki JSON)

Katalog `DATA_DIR` (domyślnie `storage/`, produkcyjnie np. `/var/lib/tysiac`):

```
meta.json              wersja schematu, lista wykonanych migracji
config.json            ustawienia aplikacji (rejestracja otwarta, domyślne zasady)
users.json             konta: { users: { <id>: User } }
auth.json              sesje logowania (tylko SHA-256 tokenów)
meets.json             sesje gry (spotkania)
matches/<id>.json      mecz z pełną listą rozdań
rooms/<id>.json        pokój online z ukrytym stanem rozdania (przeżywa restart)
audit/YYYY-MM.jsonl    dziennik zdarzeń (logowania, zmiany, operacje administratora) – tylko dopisywanie
backups/               kopie zapasowe (gzip)
migrations/            raporty i kopie plików źródłowych migracji
.writer.lock           blokada jednego zapisującego
```

## Koperta dokumentu

Każdy plik: `{ "_meta": { "rev": 7, "updatedAt": "...", "sha256": "..." }, "data": { ... } }`.
`rev` – wersja (kontrola konfliktów), `sha256` – suma kontrolna `data` (wykrywanie uszkodzeń). Obok trzymana jest poprzednia wersja `*.prev`.

## Zapis

1. Operacje na jednym dokumencie wykonują się w kolejce (jedna po drugiej).
2. Walidacja schematu przed zapisem (`server/store/schemas.js`).
3. Zapis do pliku tymczasowego → `fsync` → kopia bieżącego jako `.prev` → `rename` (atomowo) → `fsync` katalogu.
4. Zmiany meczów wymagają `baseRev`; niezgodna wersja → HTTP 409 z aktualnym stanem (bez „ostatni zapis wygrywa”).
5. Każda operacja ma `opId` – powtórzone żądanie (np. po zerwanym połączeniu) nie dubluje rozdania.

## Mecz (`matches/<id>.json`)

```json
{
  "id": "m_…", "mode": "offline|online", "seats": ["u…","u…","u…","u…"],
  "settings": { "target": 1000, "passiveCap": 990, "rounding": "nearest10", "contractCheck": "raw", … },
  "firstDealerSeat": 0, "status": "active|finished|abandoned|deleted", "winner": 0|1|null,
  "createdAt": "…", "finishedAt": "…", "meetId": "s_…", "groupKey": "<4 posortowane ID>",
  "modeHistory": [{ "mode": "offline", "afterRound": 0, "at": "…" }, { "mode": "online", "afterRound": 12 }],
  "rounds": [{
    "id": "r_…", "mode": "offline|online", "bidder": "u…", "bid": 120, "made": true, "got": 170,
    "cards": { "0": 50, "1": 70 }, "melds": { "u…": ["H"] }, "dealer": "u…", "createdAt": "…",
    "history": [ /* poprzednie wersje po korektach */ ], "plays": [ /* online: przebieg licytacji i zagrań */ ], "tricksWon": { "u…": 2 }
  }],
  "removedRounds": [ /* cofnięte rozdania (nie giną) */ ], "appliedOps": [ "…" ]
}
```

Drużyna 0 = miejsca 0 i 2, drużyna 1 = miejsca 1 i 3. Wynik meczu **nie jest zapisywany** – zawsze liczony z rozdań (`shared/scoring.js`), więc korekta automatycznie poprawia wynik i statystyki.
Brak danych (np. nieznane punkty z kart w starych rozdaniach) to `null`/brak pola – statystyki nie traktują tego jako zera.

## Statystyki, grupy, pary

Nie są zapisywane – liczone z historii (`shared/stats.js`) w przeglądarce i na serwerze (eksport CSV). Dzięki temu „odbudowa statystyk” to po prostu ponowne przeliczenie; panel administratora ma przycisk sprawdzający, że każdy mecz da się przeliczyć.
Grupa = posortowane 4 ID graczy (zmiana drużyn ani nicku nie tworzy nowej grupy). Para = posortowane 2 ID.

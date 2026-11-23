# Zasady zaimplementowane w aplikacji

## Ustalone przez właściciela (zakodowane na stałe)

- 4 graczy, 2 drużyny; partnerzy naprzeciwko (miejsca 1+3 i 2+4).
- Talia 24 kart (A, 10, K, D, W, 9 w czterech kolorach), wartości 11/10/4/3/2/0 = 120 pkt; każdy dostaje 6 kart; **brak musika**.
- Meldunki: kier 100, karo 80, **trefl 60, pik 40**; wymagają króla i damy tego samego koloru; meldunek ustala atut; liczone drużynowo.
- Licytacja od 100, przebijanie co najmniej o 10. **Brak ograniczeń wynikających z posiadanych meldunków.**
- Ugrany kontrakt → drużyna dostaje **faktycznie zdobyte punkty** (karty + meldunki drużyny), zaokrąglone do 10. Kontrakt sprawdzany **po zaokrągleniu** (grał 160, ma 158 → 160 → ugrany).
- Nieugrany kontrakt → **minus wartość kontraktu**.
- Przeciwnicy dostają swoje punkty z kart + swoje meldunki (zaokrąglone).
- Kontraktu nie można oznaczyć jako ugranego, jeśli punkty na to nie pozwalają (w trybie offline wynik kontraktu wynika z wpisanych punktów).
- **Brak bomby**, brak spadku do 800, brak limitu prób na beczce, brak „trzech zer”.
- Bez wygranej licytacji wynik rośnie najwyżej do **990**. Wygrana = wygrana licytacja + zrealizowany kontrakt + wynik **≥ 1000**.
- Wynik może być ujemny (bez dolnego limitu).

## Ustawienia meczu (zapisywane w meczu, niezmienne w trakcie)

| Ustawienie | Wartości | Domyślnie | Uzasadnienie domyślnej |
|---|---|---|---|
| `rounding` | `nearest10` / `down10` / `exact` | `nearest10` | zachowanie poprzedniej aplikacji (`Math.round` do 10, połówki w górę: 155 → 160) |
| `contractCheck` | `raw` / `rounded` | `rounded` | **ustalenie właściciela**: kontrakt sprawdzany po zaokrągleniu – grał 160, ma 158 → 160 → ugrany, +160 |
| `target` | 100–10000 | 1000 | |
| `passiveCap` | | 990 | |
| `minBid`, `bidStep`, `maxBid` | | 100, 10, 400 | 400 = 120 + wszystkie meldunki (teoretyczne maksimum) – nie jest to limit z meldunków gracza |
| `mustBeat` | tak/nie | tak | obowiązek przebicia: do koloru wyższą kartą, a bez koloru – atutem i nadbicie atutu |
| `mustTrump` | tak/nie | tak | brak koloru → obowiązek dania atutu |
| `meldOnFirstTrick` | tak/nie | nie | meldować można wychodząc, od drugiej lewy (po wzięciu lewy) |

## Rozstrzygnięcia wariantowe w grze online (do potwierdzenia)

- Rozdaje kolejno następny gracz zgodnie z miejscami; licytację **obowiązkowo otwiera 100** gracz po lewej rozdającego; gdy wszyscy spasują – gra on za 100.
- Pas jest ostateczny (nie można wrócić do licytacji).
- Pierwszą lewę wychodzi zwycięzca licytacji; kolejne – zwycięzca poprzedniej lewy.
- Obowiązek przebicia dotyczy karty wygrywającej lewę w danej chwili (jeśli lewę wygrywa atut, dokładający do koloru nie musi przebijać).
- Brak zwolnienia z przebijania, gdy lewę wygrywa partner.
- Remis w wyniku nie jest możliwy (wygrywa tylko drużyna licytująca).

## Otwarte pytania (nie zgadywałem – wymagana decyzja)

1. ~~Meldunki~~ – **potwierdzone**: obowiązuje trefl 60, pik 40 (stara aplikacja miała to odwrotnie). Historia – zob. niżej.
   **Meldunki w starej historii.** Stara aplikacja miała przyciski ♠ = 60 i ♣ = 40 (odwrotnie niż obecna specyfikacja). Historyczne rozdania przeniesiono **według wartości** (stare „♠ 60” → trefl 60, stare „♣ 40” → pik 40), dzięki czemu wszystkie wyniki zgadzają się co do punktu. Jeśli przy stole klikaliście przycisk według **symbolu koloru**, a nie wartości – historyczne statystyki *kolorów* meldunków mogą być zamienione (suma punktów i wyniki są poprawne). Oryginalne kody są zachowane w `round.legacy.melds`.
2. ~~Zaokrąglanie~~ – **ustalone**: do najbliższej 10, kontrakt sprawdzany po zaokrągleniu.
3. Czy obowiązuje zwolnienie z przebijania, gdy lewę wygrywa partner?
4. Czy pierwsze 100 ma być obowiązkowe (obecnie tak), czy dopuszczalne jest „rozdanie na nowo”, gdy wszyscy pasują?
5. Jedno historyczne rozdanie (mecz `gmw1uxazz8uvbw`, rozdanie 16) oznaczono kiedyś jako ugrane przy ugranych 120 < kontrakt 150 i zaliczono +150. Zostawiono bez zmian (zachowanie historii); można je poprawić ręcznie w aplikacji.

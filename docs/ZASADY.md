# Zasady zaimplementowane w aplikacji

## Ustalone przez właściciela (zakodowane na stałe)

- 4 graczy, 2 drużyny; partnerzy naprzeciwko (miejsca 1+3 i 2+4).
- Talia 24 kart (A, 10, K, Q, J, 9 w czterech kolorach), wartości 11/10/4/3/2/0 = 120 pkt.
- **Rozdawanie** (online): talia tasowana losowo (Fisher–Yates, kryptograficzny generator), karty po jednej: rozdający **sobie pierwszą**, potem gracz po lewej, naprzeciwko, po prawej, **do musika** – i od nowa (musik dostaje kartę w czterech pierwszych kolejkach). Licytację otwiera gracz po lewej rozdającego.
- **Musik**: każdy dostaje po 5 kart, 4 karty leżą zakryte na środku. Zwycięzca licytacji zbiera musik i oddaje po jednej **dowolnej** karcie (nie tylko z musika) każdemu z pozostałych graczy – potem każdy ma 6 kart. Oddaną kartę widzi tylko jej odbiorca.
- Meldunki: kier 100, karo 80, **pik 60, trefl 40**; wymagają króla i damy tego samego koloru; meldunek **z ręki** ustala tromf; liczone drużynowo.
- **Meldunek liczy się tylko, gdy drużyna zdobyła jakiekolwiek punkty z kart** w tym rozdaniu (> 0). Bez punktów z kart meldunek przepada – w wyniku online jest przekreślony, w liczniku offline pojawia się ostrzeżenie. Statystyki nadal pokazują, kto meldował. Rozdań ze starej aplikacji to nie zmienia.
- Online meldunek zgłasza się **automatycznie**: kto wychodzi królem lub damą z pary (gdy wolno meldować), melduje od razu – nie da się przypadkiem zagrać bez meldunku. Podwójne kliknięcie karty z pary też melduje i zagrywa. Gdy król/dama z pary nie może teraz meldować (np. pierwsza lewa albo nie wychodzisz), zagranie wymaga przycisku z dopiskiem „bez meldunku”.
- **Meldunek na kimś**: gdy gracz zagra damę, a następny gracz dołoży do niej króla tego samego koloru, ten drugi melduje (wartość koloru, liczona jego drużynie), ale **tromf się nie zmienia** – król nie bije wszystkiego, lewa rozstrzyga się po staremu; są tylko punkty za meldunek (jak każdy meldunek – gdy drużyna ma jakieś punkty z kart). Król musi być dozwolony zwykłymi zasadami (kolor/przebicie/tromf); dama musi być zagrana bezpośrednio przed królem. Ten sam limit co przy zwykłym meldunku: domyślnie od drugiej lewy.
- Musik online: grający najpierw **przydziela** karty (karta → gracz, z oznaczeniem partner/przeciwnik), może je zmieniać, a potem **zatwierdza wszystkie trzy jednym przyciskiem**. Karty z musika są w ręce oznaczone „musik”, a odbiorca widzi, jaką kartę i od kogo dostał.
- Licytacja od 100, podbija się **zawsze dokładnie o 10** (110, 120, …) – bez skakania (np. ze 120 nie można od razu na 240). **Brak ograniczeń wynikających z posiadanych meldunków.**
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
| `mustBeat` | tak/nie | tak | obowiązek przebicia: do koloru wyższą kartą, a bez koloru – tromfem i nadbicie tromfu |
| `mustTrump` | tak/nie | tak | brak koloru → obowiązek dania tromfu |
| `meldOnFirstTrick` | tak/nie | nie | meldować można wychodząc, od drugiej lewy (po wzięciu lewy) |
| `meldOnPlayed` | tak/nie | tak | **ustalenie właściciela**: meldunek na kimś – król dołożony na damę zagraną tuż przed nim |

## Rozstrzygnięcia wariantowe w grze online (do potwierdzenia)

- Rozdaje kolejno następny gracz zgodnie z miejscami; licytację **obowiązkowo otwiera 100** gracz po lewej rozdającego; gdy wszyscy spasują – gra on za 100.
- Pas jest ostateczny (nie można wrócić do licytacji).
- Licytację otwiera obowiązkowo 100 gracz po rozdającym (potwierdzone); po licytacji grający bierze musik i oddaje karty.
- Grający **nie podnosi kontraktu** po zebraniu musika (potwierdzone – i tak liczy się faktycznie ugrane, np. grał 150, ugrał 300 → +300).
- Musik leży **zakryty** i nie jest nikomu pokazywany (potwierdzone).
- Pierwszą lewę wychodzi zwycięzca licytacji; kolejne – zwycięzca poprzedniej lewy.
- Na stole widać tylko bieżącą lewę (ukończona zostaje ok. 1,5 s, żeby było widać ostatnią kartę); brak historii zagranych kart.
- Obowiązek przebicia dotyczy karty wygrywającej lewę w danej chwili (jeśli lewę wygrywa tromf, dokładający do koloru nie musi przebijać).
- **Przebijać trzeba zawsze, gdy się da – także gdy lewę bierze partner** (potwierdzone). Dotyczy też dawania i nadbijania tromfu.
- Remis w wyniku nie jest możliwy (wygrywa tylko drużyna licytująca).

## Otwarte pytania (nie zgadywałem – wymagana decyzja)

1. ~~Meldunki~~ – **ustalone**: pik 60, trefl 40 – tak samo jak w starej aplikacji, więc stara historia przechodzi 1:1 (symbol i wartość się zgadzają, wyniki co do punktu).
2. ~~Zaokrąglanie~~ – **ustalone**: do najbliższej 10, kontrakt sprawdzany po zaokrągleniu.
3. ~~Przebijanie partnera~~ – **ustalone**: zawsze trzeba przebić, jeśli można.
4. ~~Pierwsze 100~~ – **ustalone**: obowiązkowe dla gracza po rozdającym.
5. Jedno historyczne rozdanie (mecz `gmw1uxazz8uvbw`, rozdanie 16) oznaczono kiedyś jako ugrane przy ugranych 120 < kontrakt 150 i zaliczono +150. Zostawiono bez zmian (zachowanie historii); można je poprawić ręcznie w aplikacji.

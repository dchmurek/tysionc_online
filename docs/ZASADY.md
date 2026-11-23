# Zasady zaimplementowane w aplikacji

## Ustalone przez właściciela (zakodowane na stałe)

- 4 graczy, 2 drużyny; partnerzy naprzeciwko (miejsca 1+3 i 2+4).
- Talia 24 kart (A, 10, K, Q, J, 9 w czterech kolorach), wartości 11/10/4/3/2/0 = 120 pkt.
- **Musik**: każdy dostaje po 5 kart, 4 karty leżą zakryte na środku. Zwycięzca licytacji zbiera musik i oddaje po jednej **dowolnej** karcie (nie tylko z musika) każdemu z pozostałych graczy – potem każdy ma 6 kart. Oddaną kartę widzi tylko jej odbiorca.
- Meldunki: kier 100, karo 80, **pik 60, trefl 40**; wymagają króla i damy tego samego koloru; meldunek ustala atut; liczone drużynowo.
- Online meldunek zgłasza się **automatycznie**: kto wychodzi królem lub damą z pary (gdy wolno meldować), melduje od razu – nie da się przypadkiem zagrać bez meldunku.
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
- Licytację otwiera obowiązkowo 100 gracz po rozdającym (potwierdzone); po licytacji grający bierze musik i oddaje karty.
- Grający nie podnosi kontraktu po zobaczeniu musika (do potwierdzenia, jeśli gracie inaczej).
- Musik leży zakryty – pozostali gracze go nie widzą (do potwierdzenia, jeśli ma być odkrywany).
- Pierwszą lewę wychodzi zwycięzca licytacji; kolejne – zwycięzca poprzedniej lewy.
- Na stole widać tylko bieżącą lewę (ukończona zostaje ok. 1,5 s, żeby było widać ostatnią kartę); brak historii zagranych kart.
- Obowiązek przebicia dotyczy karty wygrywającej lewę w danej chwili (jeśli lewę wygrywa atut, dokładający do koloru nie musi przebijać).
- Brak zwolnienia z przebijania, gdy lewę wygrywa partner.
- Remis w wyniku nie jest możliwy (wygrywa tylko drużyna licytująca).

## Otwarte pytania (nie zgadywałem – wymagana decyzja)

1. ~~Meldunki~~ – **ustalone**: pik 60, trefl 40 – tak samo jak w starej aplikacji, więc stara historia przechodzi 1:1 (symbol i wartość się zgadzają, wyniki co do punktu).
2. ~~Zaokrąglanie~~ – **ustalone**: do najbliższej 10, kontrakt sprawdzany po zaokrągleniu.
3. Czy obowiązuje zwolnienie z przebijania, gdy lewę wygrywa partner?
4. ~~Pierwsze 100~~ – **ustalone**: obowiązkowe dla gracza po rozdającym.
5. Jedno historyczne rozdanie (mecz `gmw1uxazz8uvbw`, rozdanie 16) oznaczono kiedyś jako ugrane przy ugranych 120 < kontrakt 150 i zaliczono +150. Zostawiono bez zmian (zachowanie historii); można je poprawić ręcznie w aplikacji.

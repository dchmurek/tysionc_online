<?php
// Silnik rozgrywki kartami (tryb online) – wierne przeniesienie shared/cards.js.
declare(strict_types=1);

final class Cards
{
    public static function fullDeck(): array
    {
        $d = [];
        foreach (R::SUITS as $s) foreach (R::RANKS as $r) $d[] = $r . $s;
        return $d;
    }
    public static function suit(string $c): string { return $c[1]; }
    public static function rank(string $c): string { return $c[0]; }
    public static function points(string $c): int { return R::RANK_POINTS[$c[0]]; }
    public static function rankIndex(string $c): int { return (int)array_search($c[0], R::RANKS, true); }
    public static function isCard($c): bool
    {
        return is_string($c) && strlen($c) === 2 && in_array($c[0], R::RANKS, true) && in_array($c[1], R::SUITS, true);
    }

    public static function shuffle(array $deck): array
    {
        for ($i = count($deck) - 1; $i > 0; $i--) {
            $j = random_int(0, $i);
            [$deck[$i], $deck[$j]] = [$deck[$j], $deck[$i]];
        }
        return $deck;
    }

    public static function sortHand(array $hand, ?string $trump): array
    {
        $order = $trump ? array_merge([$trump], array_values(array_filter(R::SUITS, fn($s) => $s !== $trump))) : R::SUITS;
        usort($hand, fn($a, $b) => (array_search($a[1], $order, true) - array_search($b[1], $order, true)) ?: (self::rankIndex($a) - self::rankIndex($b)));
        return array_values($hand);
    }

    public static function dealSequence(int $dealer): array
    {
        $seq = [];
        for ($r = 0; $r < R::DEAL_SIZE; $r++) {
            for ($k = 0; $k < R::PLAYERS; $k++) $seq[] = ($dealer + $k) % R::PLAYERS;
            if ($r < R::MUSIK_SIZE) $seq[] = 'm';
        }
        return $seq;
    }

    public static function createHand(int $dealerSeat, $settings, ?array $deck = null): array
    {
        $S = R::normalizeSettings($settings);
        if ($dealerSeat < 0 || $dealerSeat >= R::PLAYERS) throw new RuleError('Zły rozdający');
        $cards = $deck ?? self::shuffle(self::fullDeck());
        if (count($cards) !== R::PLAYERS * R::DEAL_SIZE + R::MUSIK_SIZE || count(array_unique($cards)) !== count($cards)) throw new RuleError('Zła talia');
        $hands = [[], [], [], []];
        $musik = [];
        foreach (self::dealSequence($dealerSeat) as $i => $to) {
            if ($to === 'm') $musik[] = $cards[$i]; else $hands[$to][] = $cards[$i];
        }
        $opener = R::nextSeat($dealerSeat);
        return [
            'phase' => 'bidding', 'settings' => $S, 'dealerSeat' => $dealerSeat, 'hands' => $hands, 'musik' => $musik,
            'given' => [false, false, false, false], 'received' => [null, null, null, null], 'musikTaken' => [],
            'bidding' => ['highest' => $S['minBid'], 'highestSeat' => $opener, 'passed' => [false, false, false, false],
                'history' => [['seat' => $opener, 'type' => 'bid', 'value' => $S['minBid'], 'forced' => true]]],
            'contract' => null, 'trump' => null, 'melds' => [], 'trick' => null, 'tricks' => [],
            'cardPoints' => [0, 0], 'tricksWon' => [0, 0, 0, 0], 'turn' => R::nextSeat($opener),
            'log' => [['type' => 'deal', 'dealerSeat' => $dealerSeat], ['type' => 'bid', 'seat' => $opener, 'value' => $S['minBid'], 'forced' => true]],
        ];
    }

    private static function nextActiveBidder(array $st, int $from): int
    {
        $s = R::nextSeat($from);
        for ($i = 0; $i < R::PLAYERS; $i++) {
            if (!$st['bidding']['passed'][$s]) return $s;
            $s = R::nextSeat($s);
        }
        return -1;
    }

    private static function finishBidding(array &$st): void
    {
        $b = $st['bidding'];
        $hs = $b['highestSeat'];
        $st['contract'] = ['seat' => $hs, 'team' => R::teamOfSeat($hs), 'value' => $b['highest']];
        $st['log'][] = ['type' => 'contract', 'seat' => $hs, 'value' => $b['highest']];
        $st['hands'][$hs] = array_merge($st['hands'][$hs], $st['musik']);
        $st['log'][] = ['type' => 'musik', 'seat' => $hs, 'cards' => $st['musik']];
        $st['musikTaken'] = $st['musik'];
        $st['musik'] = [];
        $st['phase'] = 'giving';
        $st['given'] = [false, false, false, false];
        $st['given'][$hs] = true;
        $st['received'] = [null, null, null, null];
        $st['turn'] = $hs;
    }

    public static function beats(string $a, string $b, ?string $trump): bool
    {
        if ($a[1] === $b[1]) return self::rankIndex($a) < self::rankIndex($b);
        return $trump !== null && $a[1] === $trump;
    }

    public static function trickWinnerIndex(array $cards, ?string $trump): int
    {
        $w = 0;
        for ($i = 1; $i < count($cards); $i++) if (self::beats($cards[$i], $cards[$w], $trump)) $w = $i;
        return $w;
    }

    public static function legalCards(array $st, int $seat): array
    {
        if ($st['phase'] !== 'playing' || $st['turn'] !== $seat) return [];
        $hand = $st['hands'][$seat];
        $trick = $st['trick'];
        if (!$trick['cards']) return $hand;
        $S = $st['settings'];
        $led = $trick['cards'][0]['card'][1];
        $trump = $st['trump'];
        $played = array_map(fn($x) => $x['card'], $trick['cards']);
        $best = $played[self::trickWinnerIndex($played, $trump)];
        $ofLed = array_values(array_filter($hand, fn($c) => $c[1] === $led));
        if ($ofLed) {
            if ($S['mustBeat'] && $best[1] === $led) {
                $higher = array_values(array_filter($ofLed, fn($c) => self::beats($c, $best, $trump)));
                if ($higher) return $higher;
            }
            return $ofLed;
        }
        $trumps = $trump ? array_values(array_filter($hand, fn($c) => $c[1] === $trump)) : [];
        if ($S['mustTrump'] && $trumps) {
            if ($S['mustBeat'] && $best[1] === $trump) {
                $higher = array_values(array_filter($trumps, fn($c) => self::beats($c, $best, $trump)));
                if ($higher) return $higher;
            }
            return $trumps;
        }
        return $hand;
    }

    private static function meldTimingOk(array $st): bool { return $st['settings']['meldOnFirstTrick'] || count($st['tricks']) > 0; }

    public static function canMeld(array $st, int $seat, string $card): bool
    {
        if ($st['phase'] !== 'playing' || $st['turn'] !== $seat || $st['trick']['cards']) return false;
        if (!self::meldTimingOk($st)) return false;
        $r = $card[0];
        if ($r !== 'K' && $r !== 'Q') return false;
        $partner = ($r === 'K' ? 'Q' : 'K') . $card[1];
        return in_array($card, $st['hands'][$seat], true) && in_array($partner, $st['hands'][$seat], true);
    }

    public static function meldOnSeat(array $st, int $seat, string $card): int
    {
        if (empty($st['settings']['meldOnPlayed'])) return -1;
        if ($st['phase'] !== 'playing' || $st['turn'] !== $seat || !$st['trick']['cards']) return -1;
        if (!self::meldTimingOk($st)) return -1;
        if ($card[0] !== 'K' || !in_array($card, $st['hands'][$seat], true)) return -1;
        $prev = $st['trick']['cards'][count($st['trick']['cards']) - 1];
        if ($prev['card'] !== 'Q' . $card[1]) return -1;
        if (!in_array($card, self::legalCards($st, $seat), true)) return -1;
        return $prev['seat'];
    }

    public static function meldableCards(array $st, int $seat): array
    {
        return array_values(array_filter($st['hands'][$seat], fn($c) => self::canMeld($st, $seat, $c) || self::meldOnSeat($st, $seat, $c) >= 0));
    }

    private static function applyGive(array &$st, int $seat, $card, $to): void
    {
        if (!is_int($to) || $to < 0 || $to >= R::PLAYERS || $to === $seat) throw new RuleError('Wybierz innego gracza');
        if ($st['given'][$to]) throw new RuleError('Ten gracz dostał już kartę');
        if (!self::isCard($card) || !in_array($card, $st['hands'][$seat], true)) throw new RuleError('Nie masz tej karty');
        $st['hands'][$seat] = array_values(array_filter($st['hands'][$seat], fn($c) => $c !== $card));
        $st['hands'][$to][] = $card;
        $st['given'][$to] = true;
        if (!isset($st['received'])) $st['received'] = [null, null, null, null];
        $st['received'][$to] = ['card' => $card, 'from' => $seat];
        $st['log'][] = ['type' => 'give', 'seat' => $seat, 'to' => $to, 'card' => $card];
    }

    public static function applyAction(array &$st, int $seat, $action): void
    {
        if (!is_array($action)) throw new RuleError('Brak akcji');
        if ($st['phase'] === 'finished') throw new RuleError('Rozdanie jest zakończone');
        if ($seat !== $st['turn']) throw new RuleError('Nie twoja kolej', 'turn');
        $type = $action['type'] ?? null;

        if ($st['phase'] === 'bidding') {
            $S = $st['settings'];
            if ($type === 'bid') {
                $v = $action['value'] ?? null;
                if (!is_int_like($v) || ((int)$v) % $S['bidStep'] !== 0) throw new RuleError('Zła wartość licytacji');
                $v = (int)$v;
                if ($v > $S['maxBid']) throw new RuleError("Maksymalna licytacja to {$S['maxBid']}");
                $nextV = $st['bidding']['highest'] + $S['bidStep'];
                if ($v !== $nextV) throw new RuleError("Licytuje się co {$S['bidStep']} – teraz tylko $nextV");
                $st['bidding']['highest'] = $v;
                $st['bidding']['highestSeat'] = $seat;
                $st['bidding']['history'][] = ['seat' => $seat, 'type' => 'bid', 'value' => $v];
                $st['log'][] = ['type' => 'bid', 'seat' => $seat, 'value' => $v];
            } elseif ($type === 'pass') {
                $st['bidding']['passed'][$seat] = true;
                $st['bidding']['history'][] = ['seat' => $seat, 'type' => 'pass'];
                $st['log'][] = ['type' => 'pass', 'seat' => $seat];
            } else {
                throw new RuleError('Teraz trwa licytacja');
            }
            $active = array_values(array_filter([0, 1, 2, 3], fn($s) => !$st['bidding']['passed'][$s]));
            $hs = $st['bidding']['highestSeat'];
            if (count($active) === 0 || (count($active) === 1 && $active[0] === $hs)) {
                if (count($active) === 0) $st['bidding']['passed'][$hs] = false;
                self::finishBidding($st);
                return;
            }
            $nxt = self::nextActiveBidder($st, $seat);
            if ($nxt === $hs && count($active) === 1) { self::finishBidding($st); return; }
            $st['turn'] = $nxt;
            return;
        }

        if ($st['phase'] === 'giving') {
            if ($type === 'give') {
                self::applyGive($st, $seat, $action['card'] ?? null, $action['to'] ?? null);
            } elseif ($type === 'give-all') {
                $gives = $action['gives'] ?? null;
                $missing = array_values(array_filter([0, 1, 2, 3], fn($s) => !$st['given'][$s]));
                if (!is_array($gives) || count($gives) !== count($missing)) throw new RuleError('Przydziel po jednej karcie każdemu graczowi');
                $tos = [];
                $cards = [];
                foreach ($gives as $g) { $tos[] = is_array($g) ? ($g['to'] ?? null) : null; $cards[] = is_array($g) ? ($g['card'] ?? null) : null; }
                $uniq = fn($a) => count(array_unique(array_map(fn($x) => var_export($x, true), $a)));
                $missOk = true;
                foreach ($missing as $s) if (!in_array($s, $tos, true)) $missOk = false;
                if ($uniq($tos) !== count($gives) || $uniq($cards) !== count($gives) || !$missOk) throw new RuleError('Każdy gracz dostaje dokładnie jedną, inną kartę');
                foreach ($gives as $g) if (!self::isCard($g['card'] ?? null) || !in_array($g['card'], $st['hands'][$seat], true)) throw new RuleError('Nie masz tej karty');
                foreach ($gives as $g) self::applyGive($st, $seat, $g['card'], $g['to']);
            } else {
                throw new RuleError('Najpierw rozdaj karty z musika – po jednej każdemu graczowi');
            }
            if (!in_array(false, $st['given'], true)) {
                $st['phase'] = 'playing';
                $st['trick'] = ['leader' => $seat, 'cards' => []];
                $st['turn'] = $seat;
            }
            return;
        }

        if ($type !== 'play') throw new RuleError('Teraz zagrywa się karty');
        $card = $action['card'] ?? null;
        if (!self::isCard($card) || !in_array($card, $st['hands'][$seat], true)) throw new RuleError('Nie masz tej karty');
        if (!in_array($card, self::legalCards($st, $seat), true)) throw new RuleError('Tej karty nie można teraz zagrać (obowiązek koloru, przebicia lub tromfu)');
        $meld = null;
        $onSeat = self::meldOnSeat($st, $seat, $card);
        if (self::canMeld($st, $seat, $card) || $onSeat >= 0) {
            $suit = $card[1];
            $meld = ['seat' => $seat, 'team' => R::teamOfSeat($seat), 'suit' => $suit, 'value' => R::MELD_VALUES[$suit], 'trick' => count($st['tricks']) + 1];
            if ($onSeat >= 0) $meld['on'] = $onSeat; else $st['trump'] = $suit;
            $st['melds'][] = $meld;
        }
        $st['hands'][$seat] = array_values(array_filter($st['hands'][$seat], fn($c) => $c !== $card));
        $st['trick']['cards'][] = ['seat' => $seat, 'card' => $card];
        $entry = ['type' => 'play', 'seat' => $seat, 'card' => $card];
        if ($meld) $entry['meld'] = $meld['suit'];
        $st['log'][] = $entry;

        if (count($st['trick']['cards']) < R::PLAYERS) { $st['turn'] = R::nextSeat($seat); return; }
        $cards = array_map(fn($x) => $x['card'], $st['trick']['cards']);
        $wi = self::trickWinnerIndex($cards, $st['trump']);
        $winner = $st['trick']['cards'][$wi]['seat'];
        $points = array_sum(array_map(fn($c) => self::points($c), $cards));
        $st['tricks'][] = ['leader' => $st['trick']['leader'], 'cards' => $st['trick']['cards'], 'winner' => $winner, 'points' => $points, 'trump' => $st['trump']];
        $st['cardPoints'][R::teamOfSeat($winner)] += $points;
        $st['tricksWon'][$winner]++;
        $st['log'][] = ['type' => 'trick', 'winner' => $winner, 'points' => $points, 'n' => count($st['tricks'])];
        if (count($st['tricks']) === R::HAND_SIZE) {
            $st['phase'] = 'finished';
            $st['trick'] = null;
            $st['turn'] = -1;
            if ($st['cardPoints'][0] + $st['cardPoints'][1] !== R::CARD_POINTS_TOTAL) throw new RuntimeException('Suma punktów ≠ 120');
            $st['log'][] = ['type' => 'end', 'cardPoints' => $st['cardPoints']];
        } else {
            $st['trick'] = ['leader' => $winner, 'cards' => []];
            $st['turn'] = $winner;
        }
    }

    public static function handToRound(array $st, array $seats): array
    {
        if ($st['phase'] !== 'finished') throw new RuleError('Rozdanie nie jest zakończone');
        $melds = [];
        foreach ($st['melds'] as $m) $melds[$seats[$m['seat']]][] = $m['suit'];
        $tw = [];
        foreach ($seats as $i => $u) $tw[$u] = $st['tricksWon'][$i];
        $plays = array_map(fn($e) => isset($e['seat']) ? $e + ['user' => $seats[$e['seat']]] : $e, $st['log']);
        return ['bidder' => $seats[$st['contract']['seat']], 'bid' => $st['contract']['value'],
            'cards' => [0 => $st['cardPoints'][0], 1 => $st['cardPoints'][1]], 'melds' => $melds, 'tricksWon' => $tw, 'plays' => $plays];
    }

    public static function viewFor(array $st, int $seat): array
    {
        $last = $st['tricks'] ? $st['tricks'][count($st['tricks']) - 1] : null;
        $v = [
            'phase' => $st['phase'], 'dealerSeat' => $st['dealerSeat'], 'turn' => $st['turn'],
            'bidding' => ['highest' => $st['bidding']['highest'], 'highestSeat' => $st['bidding']['highestSeat'],
                'passed' => $st['bidding']['passed'], 'history' => $st['bidding']['history']],
            'contract' => $st['contract'], 'trump' => $st['trump'], 'melds' => $st['melds'],
            'trick' => $st['trick'] ? ['leader' => $st['trick']['leader'], 'cards' => $st['trick']['cards']] : null,
            'lastTrick' => $last, 'tricksCount' => count($st['tricks']), 'tricksWon' => $st['tricksWon'],
            'handCounts' => array_map('count', $st['hands']), 'musikCount' => count($st['musik'] ?? []),
            'given' => $st['given'] ?? [true, true, true, true],
            'hand' => $seat >= 0 ? self::sortHand($st['hands'][$seat], $st['trump']) : [],
            'legal' => $seat >= 0 ? self::legalCards($st, $seat) : [],
            'meldable' => $seat >= 0 ? self::meldableCards($st, $seat) : [],
            'settings' => ['minBid' => $st['settings']['minBid'], 'bidStep' => $st['settings']['bidStep'], 'maxBid' => $st['settings']['maxBid'], 'meldOnFirstTrick' => (bool)$st['settings']['meldOnFirstTrick']],
            'musikCards' => $seat >= 0 && $st['contract'] && $st['contract']['seat'] === $seat && !empty($st['musikTaken'])
                ? array_values(array_filter($st['musikTaken'], fn($c) => in_array($c, $st['hands'][$seat], true))) : [],
            'received' => $seat >= 0 && !empty($st['received'][$seat]) ? $st['received'][$seat] : null,
        ];
        if ($st['phase'] === 'finished') $v['cardPoints'] = $st['cardPoints'];
        return $v;
    }
}

<?php
// Zasady, punktacja i nicki – wierne przeniesienie shared/rules.js, shared/scoring.js, shared/nick.js.
declare(strict_types=1);

final class R
{
    const SUITS = ['H', 'D', 'S', 'C'];
    const MELD_VALUES = ['H' => 100, 'D' => 80, 'S' => 60, 'C' => 40];
    const RANKS = ['A', 'T', 'K', 'Q', 'J', '9'];
    const RANK_POINTS = ['A' => 11, 'T' => 10, 'K' => 4, 'Q' => 3, 'J' => 2, '9' => 0];
    const CARD_POINTS_TOTAL = 120;
    const HAND_SIZE = 6;
    const DEAL_SIZE = 5;
    const MUSIK_SIZE = 4;
    const PLAYERS = 4;
    const DEFAULT_SETTINGS = [
        'target' => 1000, 'passiveCap' => 990, 'minBid' => 100, 'bidStep' => 10, 'maxBid' => 400,
        'rounding' => 'nearest10', 'contractCheck' => 'rounded',
        'mustBeat' => true, 'mustTrump' => true, 'meldOnFirstTrick' => true, 'meldOnPlayed' => true,
    ];

    private static function settingOk(string $k, $v): bool
    {
        $int = is_int_like($v);
        switch ($k) {
            case 'target': return $int && $v >= 100 && $v <= 10000 && ((int)$v) % 10 === 0;
            case 'passiveCap': return $int && $v >= 0 && $v <= 10000;
            case 'minBid': return $int && $v >= 10 && $v <= 400 && ((int)$v) % 10 === 0;
            case 'bidStep': return $int && in_array((int)$v, [5, 10, 20], true);
            case 'maxBid': return $int && $v >= 100 && $v <= 400;
            case 'rounding': return in_array($v, ['nearest10', 'down10', 'exact'], true);
            case 'contractCheck': return in_array($v, ['raw', 'rounded'], true);
            default: return is_bool($v);
        }
    }

    public static function normalizeSettings($input = []): array
    {
        $out = self::DEFAULT_SETTINGS;
        foreach ((is_array($input) ? $input : []) as $k => $v) {
            if (!array_key_exists($k, self::DEFAULT_SETTINGS)) continue;
            if (!self::settingOk((string)$k, $v)) throw new RuleError("Niepoprawne ustawienie: $k");
            $out[$k] = is_float($v) ? (int)$v : $v;
        }
        if ($out['maxBid'] < $out['minBid']) throw new RuleError('Maksymalna licytacja mniejsza od minimalnej');
        return $out;
    }

    public static function roundPoints($x, string $mode)
    {
        $n = is_numeric($x) ? $x + 0 : 0;
        if ($mode === 'exact') return $n;
        if ($mode === 'down10') return (int)(floor($n / 10) * 10);
        return (int)(floor($n / 10 + 0.5) * 10); // jak Math.round w JS (połówki w górę)
    }

    public static function nextSeat(int $s): int { return ($s + 1) % self::PLAYERS; }
    public static function teamOfSeat(int $s): int { return $s % 2; }

    // ---------- punktacja ----------
    public static function teamsOf(array $m): array { $s = $m['seats']; return [[$s[0], $s[2]], [$s[1], $s[3]]]; }

    public static function teamOfUser(array $m, $uid): int
    {
        $i = array_search($uid, $m['seats'], true);
        return $i === false ? -1 : $i % 2;
    }

    public static function meldPointsOf($melds, array $ids): int
    {
        $sum = 0;
        foreach ($ids as $uid) foreach ((is_array($melds) ? ($melds[$uid] ?? []) : []) as $s) $sum += self::MELD_VALUES[$s] ?? 0;
        return $sum;
    }

    public static function meldsCount($cards): bool { return $cards === null || $cards > 0; }

    public static function evaluateRound(array $match, array $round, ?array $S = null): array
    {
        $S = $S ?? self::normalizeSettings($match['settings'] ?? []);
        $teams = self::teamsOf($match);
        $bs = self::teamOfUser($match, $round['bidder'] ?? null);
        if ($bs < 0) throw new RuleError('Licytujący nie gra w tym meczu');
        $os = 1 - $bs;
        $cards = is_array($round['cards'] ?? null) ? $round['cards'] : [];
        $cardsO = $cards[$os] ?? null;
        $cardsB = $cards[$bs] ?? ($cardsO !== null ? self::CARD_POINTS_TOTAL - $cardsO : null);
        $meldsBAll = self::meldPointsOf($round['melds'] ?? [], $teams[$bs]);
        $meldsOAll = self::meldPointsOf($round['melds'] ?? [], $teams[$os]);
        $deltas = [0, 0];

        if (($round['scoring'] ?? null) === 'legacy') {
            $got = isset($round['got']) ? self::roundPoints($round['got'], $S['rounding']) : 0;
            $deltas[$bs] = !empty($round['made']) ? max($round['bid'], $got) : -$round['bid'];
            $deltas[$os] = self::roundPoints($cardsO ?? 0, $S['rounding']) + $meldsOAll;
            return ['bidderTeam' => $bs, 'made' => !empty($round['made']), 'bidderRaw' => $round['got'] ?? null,
                'oppRaw' => $cardsO === null ? null : $cardsO + $meldsOAll, 'deltas' => $deltas];
        }

        $meldsB = self::meldsCount($cardsB) ? $meldsBAll : 0;
        $meldsO = self::meldsCount($cardsO) ? $meldsOAll : 0;
        $bidderRaw = $cardsB === null ? null : $cardsB + $meldsB;
        $oppRaw = $cardsO === null ? null : $cardsO + $meldsO;
        $check = $bidderRaw === null ? null : ($S['contractCheck'] === 'rounded' ? self::roundPoints($bidderRaw, $S['rounding']) : $bidderRaw);
        $made = $check !== null && $check >= $round['bid'];
        $deltas[$bs] = $made ? self::roundPoints($bidderRaw, $S['rounding']) : -$round['bid'];
        $deltas[$os] = $oppRaw === null ? 0 : self::roundPoints($oppRaw, $S['rounding']);
        $lost = [];
        if ($meldsBAll && !$meldsB) $lost[] = $bs;
        if ($meldsOAll && !$meldsO) $lost[] = $os;
        return ['bidderTeam' => $bs, 'made' => $made, 'bidderRaw' => $bidderRaw, 'oppRaw' => $oppRaw, 'deltas' => $deltas, 'meldsLost' => $lost];
    }

    public static function computeMatch(array $match): array
    {
        $S = self::normalizeSettings($match['settings'] ?? []);
        $scores = [0, 0];
        $rows = [];
        $winner = null;
        $cap = min($S['passiveCap'], $S['target'] - 10);
        $rounds = $match['rounds'] ?? [];
        foreach ($rounds as $i => $round) {
            $ev = self::evaluateRound($match, $round, $S);
            $before = $scores;
            $deltas = $ev['deltas'];
            $notes = [[], []];
            $os = 1 - $ev['bidderTeam'];
            if ($deltas[$os] > 0 && $before[$os] + $deltas[$os] > $cap) {
                $deltas[$os] = max(0, $cap - $before[$os]);
                $notes[$os][] = 'limit ' . $cap;
            }
            $scores[0] += $deltas[0];
            $scores[1] += $deltas[1];
            if ($ev['made'] && $scores[$ev['bidderTeam']] >= $S['target']) $winner = $ev['bidderTeam'];
            $rows[] = ['index' => $i, 'round' => $round, 'before' => $before, 'after' => $scores, 'deltas' => $deltas, 'notes' => $notes,
                'bidderTeam' => $ev['bidderTeam'], 'made' => $ev['made'], 'bidderRaw' => $ev['bidderRaw'], 'oppRaw' => $ev['oppRaw']];
            if ($winner !== null) break;
        }
        $first = (int)($match['firstDealerSeat'] ?? 0);
        $next = $first;
        $n = count($rounds);
        if ($n) {
            $ds = array_search($rounds[$n - 1]['dealer'] ?? null, $match['seats'], true);
            $next = $ds !== false ? self::nextSeat($ds) : ($n + $first) % self::PLAYERS;
        }
        return [
            'settings' => $S, 'teams' => self::teamsOf($match), 'scores' => $scores, 'rows' => $rows, 'winner' => $winner, 'cap' => $cap,
            'roundsAfterWin' => $winner !== null ? $n - count($rows) : 0,
            'nextDealerSeat' => $next, 'nextDealer' => $match['seats'][$next], 'lastRow' => $rows ? $rows[count($rows) - 1] : null,
        ];
    }

    public static function validateRoundInput(array $match, $input): array
    {
        $S = self::normalizeSettings($match['settings'] ?? []);
        if (!is_array($input)) throw new RuleError('Brak danych rozdania');
        $bidder = $input['bidder'] ?? null;
        if (!in_array($bidder, $match['seats'], true)) throw new RuleError('Wybierz licytującego z tego meczu');
        $bid = $input['bid'] ?? null;
        if (!is_int_like($bid) || $bid < $S['minBid'] || $bid > $S['maxBid'] || ((int)$bid) % $S['bidStep'] !== 0) {
            throw new RuleError("Kontrakt musi być liczbą od {$S['minBid']} do {$S['maxBid']} (co {$S['bidStep']})");
        }
        $bid = (int)$bid;
        $bs = self::teamOfUser($match, $bidder);
        $os = 1 - $bs;
        $cards = [];
        foreach ([0, 1] as $t) {
            $v = is_array($input['cards'] ?? null) ? ($input['cards'][$t] ?? null) : null;
            if ($v === null || $v === '') continue;
            if (!is_int_like($v) || $v < 0 || $v > self::CARD_POINTS_TOTAL) throw new RuleError('Punkty z kart muszą być liczbą 0–120');
            $cards[$t] = (int)$v;
        }
        if (!isset($cards[$os])) throw new RuleError('Wpisz punkty drużyny przeciwnej (może być 0)');
        if (isset($cards[$bs]) && $cards[$bs] + $cards[$os] !== self::CARD_POINTS_TOTAL) throw new RuleError('Punkty z kart obu drużyn muszą dawać razem 120');
        $melds = [];
        $used = [];
        foreach ((is_array($input['melds'] ?? null) ? $input['melds'] : []) as $uid => $list) {
            if (!in_array((string)$uid, $match['seats'], true)) throw new RuleError('Meldunek gracza spoza meczu');
            if (!is_array($list)) throw new RuleError('Niepoprawne meldunki');
            $clean = [];
            foreach ($list as $s) {
                if (!is_string($s) || !isset(self::MELD_VALUES[$s])) throw new RuleError('Nieznany meldunek');
                if (isset($used[$s])) throw new RuleError('Ten sam meldunek może wystąpić tylko raz w rozdaniu');
                $used[$s] = true;
                $clean[] = $s;
            }
            if ($clean) $melds[(string)$uid] = $clean;
        }
        $rc = [$os => $cards[$os]];
        if (isset($cards[$bs])) $rc[$bs] = $cards[$bs];
        ksort($rc);
        $round = ['bidder' => $bidder, 'bid' => $bid, 'cards' => $rc, 'melds' => $melds];
        $ev = self::evaluateRound($match, $round, $S);
        if (isset($input['made']) && is_bool($input['made']) && $input['made'] !== $ev['made']) {
            throw new RuleError($ev['made']
                ? "Drużyna licytującego ma {$ev['bidderRaw']} pkt – kontrakt $bid jest zrealizowany"
                : "Drużyna licytującego ma {$ev['bidderRaw']} pkt – za mało na kontrakt $bid");
        }
        $round['made'] = $ev['made'];
        $round['got'] = $ev['bidderRaw'];
        return $round;
    }

    // ---------- nicki ----------
    public static function cleanNick($input): string
    {
        $s = (string)($input ?? '');
        if (class_exists('Normalizer')) $s = Normalizer::normalize($s, Normalizer::FORM_KC) ?: $s;
        return trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
    }

    public static function nickKey($input): string
    {
        $s = self::cleanNick($input);
        if (class_exists('Normalizer')) {
            $s = Normalizer::normalize($s, Normalizer::FORM_KD) ?: $s;
            $s = preg_replace('/\p{M}/u', '', $s) ?? $s;
        } else {
            $s = strtr($s, ['ą' => 'a', 'ć' => 'c', 'ę' => 'e', 'ń' => 'n', 'ó' => 'o', 'ś' => 's', 'ź' => 'z', 'ż' => 'z',
                'Ą' => 'A', 'Ć' => 'C', 'Ę' => 'E', 'Ń' => 'N', 'Ó' => 'O', 'Ś' => 'S', 'Ź' => 'Z', 'Ż' => 'Z']);
        }
        $s = str_replace(['ł', 'Ł'], ['l', 'L'], $s);
        $s = mb_strtolower($s, 'UTF-8');
        return preg_replace('/[ _.\-]/u', '', $s) ?? $s;
    }

    public static function nickProblem($input): ?string
    {
        $n = self::cleanNick($input);
        $len = mb_strlen($n, 'UTF-8');
        if ($len < 2) return 'Nick musi mieć co najmniej 2 znaki';
        if ($len > 20) return 'Nick może mieć najwyżej 20 znaków';
        if (!preg_match('/^[\p{Latin}0-9 _.\-]+$/u', $n)) return 'Nick może zawierać litery łacińskie (także polskie), cyfry, spację, kropkę, _ i -';
        if (mb_strlen(self::nickKey($n), 'UTF-8') < 2) return 'Nick musi zawierać co najmniej 2 litery lub cyfry';
        return null;
    }
}

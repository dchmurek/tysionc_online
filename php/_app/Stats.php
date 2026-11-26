<?php
// Statystyki potrzebne do eksportu CSV (gracze, pary, grupy) – część shared/stats.js.
// W aplikacji statystyki liczy przeglądarka (shared/stats.js), tu tylko eksport.
declare(strict_types=1);

final class Stats
{
    public static function wilson(int $wins, int $n, float $z = 1.96): float
    {
        if (!$n) return 0.0;
        $p = $wins / $n;
        $d = 1 + ($z * $z) / $n;
        $c = $p + ($z * $z) / (2 * $n);
        $m = $z * sqrt(($p * (1 - $p)) / $n + ($z * $z) / (4 * $n * $n));
        return ($c - $m) / $d;
    }
    public static function rate($a, $b): ?float { return $b ? $a / $b : null; }

    public static function compute(array $matches): array
    {
        $list = [];
        foreach ($matches as $m) {
            if (($m['status'] ?? '') === 'deleted') continue;
            $list[] = ['m' => $m, 'c' => R::computeMatch($m), 'gk' => $m['groupKey'] ?? group_key_of($m['seats'])];
        }
        usort($list, fn($a, $b) => strcmp($a['m']['createdAt'], $b['m']['createdAt']));
        $P = [];
        $pairs = [];
        $groups = [];
        $ensure = function ($id) use (&$P) {
            if (!isset($P[$id])) $P[$id] = ['id' => $id, 'matches' => 0, 'wins' => 0, 'losses' => 0, 'rounds' => 0, 'bids' => 0, 'made' => 0, 'failed' => 0,
                'maxBid' => 0, 'points' => 0, 'meldPts' => 0, 'highestScore' => null, 'bestStreak' => 0, 'streak' => 0];
        };
        foreach ($list as $item) {
            $m = $item['m']; $c = $item['c']; $gk = $item['gk'];
            $done = $m['status'] === 'finished' && $c['winner'] !== null;
            $teams = $c['teams'];
            foreach ($m['seats'] as $s) $ensure($s);
            if (!isset($groups[$gk])) { $pl = $m['seats']; sort($pl, SORT_STRING); $groups[$gk] = ['key' => $gk, 'players' => $pl, 'matches' => 0, 'allMatches' => 0, 'rounds' => 0, 'meets' => [], 'first' => $m['createdAt'], 'last' => $m['createdAt'], 'wins' => [], 'pairKeys' => []]; }
            $g = &$groups[$gk];
            $g['allMatches']++;
            $g['rounds'] += count($c['rows']);
            if (!empty($m['meetId'])) $g['meets'][$m['meetId']] = true;
            $upd = $m['updatedAt'] ?? null;
            $g['last'] = $upd && $upd > $g['last'] ? $upd : ($m['createdAt'] > $g['last'] ? $m['createdAt'] : $g['last']);
            foreach ($teams as $t => $team) {
                $pk = pair_key($team[0], $team[1]);
                if (!isset($pairs[$pk])) { $ids = $team; sort($ids, SORT_STRING); $pairs[$pk] = ['key' => $pk, 'ids' => $ids, 'matches' => 0, 'wins' => 0, 'losses' => 0, 'rounds' => 0, 'points' => 0, 'bids' => 0, 'made' => 0, 'meldPts' => 0]; }
                $g['pairKeys'][$pk] = true;
                foreach ($c['rows'] as $row) { $pairs[$pk]['rounds']++; $pairs[$pk]['points'] += $row['deltas'][$t]; }
                if ($done) { $pairs[$pk]['matches']++; if ($c['winner'] === $t) $pairs[$pk]['wins']++; else $pairs[$pk]['losses']++; }
            }
            if ($done) {
                $g['matches']++;
                foreach ($teams as $t => $team) {
                    $won = $c['winner'] === $t;
                    foreach ($team as $pid) {
                        $p = &$P[$pid];
                        $p['matches']++;
                        if ($won) { $p['wins']++; $p['streak']++; $p['bestStreak'] = max($p['bestStreak'], $p['streak']); $g['wins'][$pid] = ($g['wins'][$pid] ?? 0) + 1; }
                        else { $p['losses']++; $p['streak'] = 0; }
                        $p['highestScore'] = $p['highestScore'] === null ? $c['scores'][$t] : max($p['highestScore'], $c['scores'][$t]);
                        unset($p);
                    }
                }
            }
            foreach ($c['rows'] as $row) {
                $r = $row['round'];
                foreach ($teams as $t => $team) foreach ($team as $pid) { $P[$pid]['rounds']++; $P[$pid]['points'] += $row['deltas'][$t]; }
                $ensure($r['bidder']);
                $b = &$P[$r['bidder']];
                $b['bids']++;
                $b['maxBid'] = max($b['maxBid'], $r['bid']);
                $pk = pair_key(...$teams[$row['bidderTeam']]);
                $pairs[$pk]['bids']++;
                if ($row['made']) { $b['made']++; $pairs[$pk]['made']++; } else $b['failed']++;
                unset($b);
                foreach (($r['melds'] ?? []) as $pid => $ms) {
                    $ensure((string)$pid);
                    foreach ($ms as $s) {
                        $v = R::MELD_VALUES[$s] ?? 0;
                        $P[$pid]['meldPts'] += $v;
                        foreach ($teams as $tm) if (in_array((string)$pid, $tm, true)) $pairs[pair_key(...$tm)]['meldPts'] += $v;
                    }
                }
            }
            unset($g);
        }
        foreach ($P as &$p) { $p['winRate'] = self::rate($p['wins'], $p['matches']); $p['contractRate'] = self::rate($p['made'], $p['bids']); $p['wilson'] = self::wilson($p['wins'], $p['matches']); }
        unset($p);
        foreach ($pairs as &$pr) { $pr['winRate'] = self::rate($pr['wins'], $pr['matches']); $pr['wilson'] = self::wilson($pr['wins'], $pr['matches']); }
        unset($pr);
        foreach ($groups as &$g) {
            $g['meetCount'] = count($g['meets']);
            $rank = array_map(fn($id) => ['id' => $id, 'wins' => $g['wins'][$id] ?? 0], $g['players']);
            usort($rank, fn($a, $b) => $b['wins'] - $a['wins']);
            $g['bestPlayer'] = $g['matches'] ? $rank[0]['id'] : null;
            $best = null;
            foreach (array_keys($g['pairKeys']) as $pk) {
                $w = 0; $n = 0;
                foreach ($list as $item) {
                    if ($item['gk'] !== $g['key'] || $item['m']['status'] !== 'finished' || $item['c']['winner'] === null) continue;
                    foreach ($item['c']['teams'] as $t => $tm) if (pair_key($tm[0], $tm[1]) === $pk) { $n++; if ($item['c']['winner'] === $t) $w++; }
                }
                if (!$n) continue;
                $cand = ['ids' => explode('~', $pk), 'wins' => $w, 'matches' => $n, 'wilson' => self::wilson($w, $n)];
                if (!$best || $cand['wilson'] > $best['wilson'] || ($cand['wilson'] == $best['wilson'] && $cand['wins'] > $best['wins'])) $best = $cand;
            }
            $g['bestPair'] = $best;
        }
        unset($g);
        return ['players' => $P, 'pairs' => $pairs, 'groups' => $groups];
    }

    public static function ranking(array $stats): array
    {
        $list = array_values(array_filter($stats['players'], fn($p) => $p['matches'] > 0 || $p['rounds'] > 0));
        usort($list, fn($a, $b) => ($b['wins'] - $a['wins']) ?: (($b['winRate'] ?? 0) <=> ($a['winRate'] ?? 0)));
        return $list;
    }
}

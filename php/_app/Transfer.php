<?php
// Eksport (JSON, CSV) i import z podglądem (odpowiednik server/services/transfer.js).
declare(strict_types=1);

final class Transfer
{
    const FORMAT = 'tysiac-export';
    const VERSION = 2;

    public static function exportData(Accounts $accounts, Matches $matches, Store $store): array
    {
        $users = array_map(function ($u) {
            $x = Accounts::publicUser($u) + ['nickHistory' => $u['nickHistory'] ?? []];
            if (!empty($u['legacy'])) $x['legacy'] = $u['legacy'];
            return $x;
        }, $accounts->allUsers());
        $list = array_map(fn($m) => Store::shape('matches/x', without($m, 'rev', 'appliedOps')), $matches->list());
        return ['format' => self::FORMAT, 'version' => self::VERSION, 'exportedAt' => now_iso(), 'users' => $users,
            'matches' => $list, 'meets' => $matches->meets(), 'settings' => as_obj($store->getData('config') ?: [])];
    }

    private static function cell($v): string
    {
        if ($v === null) return '';
        if (is_bool($v)) $v = $v ? 'true' : 'false';
        $s = (string)$v;
        if (preg_match('/^[=+\-@\t\r]/', $s)) $s = "'" . $s;
        return preg_match('/[",;\n]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
    }
    private static function csv(array $rows): string
    {
        return "\u{FEFF}" . implode("\r\n", array_map(fn($r) => implode(';', array_map([self::class, 'cell'], $r)), $rows)) . "\r\n";
    }
    private static function pct($x) { return $x === null ? '' : round($x * 1000) / 10; }

    public static function exportCsv(string $kind, Accounts $accounts, Matches $matches): string
    {
        $users = [];
        foreach ($accounts->allUsers() as $u) $users[$u['id']] = $u['nick'];
        $nick = fn($id) => $users[$id] ?? $id;
        $list = $matches->list();
        if ($kind === 'matches') {
            $rows = [['id', 'rozpoczęty', 'zakończony', 'status', 'drużyna A', 'drużyna B', 'wynik A', 'wynik B', 'zwycięzca', 'rozdań', 'tryby', 'sesja']];
            foreach ($list as $m) {
                $c = R::computeMatch($m);
                $modes = implode('/', array_values(array_unique(array_map(fn($r) => $r['mode'], $m['rounds']))));
                $rows[] = [$m['id'], $m['createdAt'], $m['finishedAt'] ?? '', $m['status'], implode(' + ', array_map($nick, $c['teams'][0])), implode(' + ', array_map($nick, $c['teams'][1])),
                    $c['scores'][0], $c['scores'][1], $c['winner'] === null ? '' : ($c['winner'] === 0 ? 'A' : 'B'), count($c['rows']), $modes, $m['meetId'] ?? ''];
            }
            return self::csv($rows);
        }
        if ($kind === 'rounds') {
            $rows = [['mecz', 'nr', 'id', 'tryb', 'data', 'rozdający', 'licytujący', 'kontrakt', 'ugrany', 'ugrane pkt', 'karty A', 'karty B', 'meldunki', 'zmiana A', 'zmiana B', 'wynik A przed', 'wynik B przed', 'wynik A po', 'wynik B po']];
            foreach ($list as $m) {
                $c = R::computeMatch($m);
                foreach ($c['rows'] as $row) {
                    $r = $row['round'];
                    $melds = [];
                    foreach (($r['melds'] ?? []) as $u => $l) $melds[] = $nick((string)$u) . ':' . implode('', $l);
                    $rows[] = [$m['id'], $row['index'] + 1, $r['id'], $r['mode'], $r['createdAt'], isset($r['dealer']) ? $nick($r['dealer']) : '', $nick($r['bidder']), $r['bid'],
                        $r['made'] ? 'tak' : 'nie', $r['got'] ?? '', $r['cards'][0] ?? '', $r['cards'][1] ?? '', implode(' ', $melds),
                        $row['deltas'][0], $row['deltas'][1], $row['before'][0], $row['before'][1], $row['after'][0], $row['after'][1]];
                }
            }
            return self::csv($rows);
        }
        if (!in_array($kind, ['players', 'groups', 'pairs'], true)) throw new AppError(400, 'Nieznany typ eksportu');
        $st = Stats::compute($list);
        if ($kind === 'players') {
            $rows = [['gracz', 'mecze', 'wygrane', 'przegrane', '% wygranych', 'rozdania', 'wygrane licytacje', 'kontrakty ugrane', 'kontrakty przegrane', '% kontraktów', 'punkty', 'meldunki pkt', 'najwyższy kontrakt', 'najwyższy wynik', 'najdłuższa seria']];
            foreach (Stats::ranking($st) as $p) $rows[] = [$nick($p['id']), $p['matches'], $p['wins'], $p['losses'], self::pct($p['winRate']), $p['rounds'], $p['bids'], $p['made'], $p['failed'],
                self::pct($p['contractRate']), $p['points'], $p['meldPts'], $p['maxBid'] ?: '', $p['highestScore'] ?? '', $p['bestStreak']];
            return self::csv($rows);
        }
        if ($kind === 'groups') {
            $rows = [['grupa', 'mecze ukończone', 'mecze wszystkie', 'rozdania', 'sesje', 'pierwsza gra', 'ostatnia gra', 'najlepszy gracz', 'najlepsza para']];
            foreach ($st['groups'] as $g) $rows[] = [implode(', ', array_map($nick, $g['players'])), $g['matches'], $g['allMatches'], $g['rounds'], $g['meetCount'], $g['first'], $g['last'],
                $g['bestPlayer'] ? $nick($g['bestPlayer']) : '', $g['bestPair'] ? implode(' + ', array_map($nick, $g['bestPair']['ids'])) : ''];
            return self::csv($rows);
        }
        $rows = [['para', 'mecze', 'wygrane', 'przegrane', '% wygranych', 'rozdania', 'punkty', 'kontrakty', 'ugrane kontrakty', 'meldunki pkt']];
        $pairs = array_values($st['pairs']);
        usort($pairs, fn($a, $b) => $b['matches'] - $a['matches']);
        foreach ($pairs as $p) $rows[] = [implode(' + ', array_map($nick, $p['ids'])), $p['matches'], $p['wins'], $p['losses'], self::pct($p['winRate']), $p['rounds'], $p['points'], $p['bids'], $p['made'], $p['meldPts']];
        return self::csv($rows);
    }

    // ---------- import z podglądem (plan zapisany w runtime na 15 min) ----------
    public static function preview($data, Accounts $accounts, Matches $matches, Store $store): array
    {
        if (!is_array($data)) throw new AppError(400, 'Plik nie zawiera danych JSON');
        if (isset($data['players'], $data['games']) && !isset($data['format'])) {
            throw new AppError(400, 'Import ze starej aplikacji PHP (db.json) nie jest dostępny w tej wersji – dane zostały już przeniesione. W razie potrzeby użyj wersji Node.js (npm run migrate).');
        }
        if (($data['format'] ?? null) !== self::FORMAT) throw new AppError(400, 'Nieznany format pliku');
        if (!is_int($data['version'] ?? null) || $data['version'] > self::VERSION) throw new AppError(400, 'Plik pochodzi z nowszej wersji aplikacji');
        if (!is_array($data['matches'] ?? null) || !is_array($data['users'] ?? null)) throw new AppError(400, 'Brak meczów lub graczy');
        $current = $accounts->allUsers();
        $byId = [];
        foreach ($current as $u) $byId[$u['id']] = $u;
        $newUsers = [];
        $userConflicts = [];
        foreach ($data['users'] as $u) {
            if (!is_array($u) || !isset($u['id'], $u['nick'])) continue;
            if (isset($byId[$u['id']])) continue;
            $clash = null;
            foreach ($current as $x) if ($x['nickKey'] === R::nickKey($u['nick'])) { $clash = $x; break; }
            if ($clash) { $userConflicts[] = ['id' => $u['id'], 'nick' => $u['nick'], 'clashWith' => $clash['id']]; continue; }
            $nu = ['id' => $u['id'], 'nick' => $u['nick'], 'nickKey' => R::nickKey($u['nick']), 'role' => 'player', 'status' => 'pending', 'guest' => true, 'passwordHash' => null,
                'createdAt' => $u['createdAt'] ?? now_iso(), 'updatedAt' => now_iso(), 'activation' => null, 'profile' => $u['profile'] ?? [], 'nickHistory' => $u['nickHistory'] ?? [], 'importedAt' => now_iso()];
            try { Schemas::user($nu, 'import.user'); } catch (ValidationError $e) { throw new AppError(400, $e->getMessage()); }
            $newUsers[] = $nu;
        }
        $existing = [];
        foreach ($matches->list(true) as $m) $existing[$m['id']] = $m;
        $known = array_flip(array_merge(array_column($current, 'id'), array_column($newUsers, 'id')));
        $add = []; $same = []; $conflicts = []; $invalid = [];
        foreach ($data['matches'] as $m) {
            try {
                if (!is_array($m)) throw new RuntimeException('zły mecz');
                $clean = array_merge($m, ['groupKey' => group_key_of($m['seats'] ?? []), 'appliedOps' => []]);
                Schemas::match($clean, 'import.' . ($m['id'] ?? '?'));
                foreach ($clean['seats'] as $s) if (!isset($known[$s])) throw new RuntimeException('nieznany gracz');
                R::computeMatch($clean);
                $ex = $existing[$m['id']] ?? null;
                if (!$ex) $add[] = $clean;
                elseif (jenc($ex['rounds']) === jenc($m['rounds'])) $same[] = $m['id'];
                else $conflicts[] = ['id' => $m['id'], 'local' => count($ex['rounds']), 'incoming' => count($m['rounds'])];
            } catch (Throwable $e) {
                $invalid[] = ['id' => is_array($m) ? ($m['id'] ?? null) : null, 'error' => $e->getMessage()];
            }
        }
        $meets = array_values(array_filter(is_array($data['meets'] ?? null) ? $data['meets'] : [], fn($s) => is_array($s) && !empty($s['id'])));
        $summary = ['newUsers' => count($newUsers), 'userConflicts' => $userConflicts, 'matchesToAdd' => count($add), 'duplicates' => count($same), 'conflicts' => $conflicts, 'invalid' => $invalid];
        $token = bin2hex(random_bytes(16));
        $store->runtimeWrite('import-' . $token, ['expires' => ms_now() + 900000, 'plan' => ['newUsers' => $newUsers, 'add' => $add, 'meets' => $meets]]);
        foreach (glob($store->dir . '/runtime/import-*.json') ?: [] as $f) if (filemtime($f) < time() - 3600) @unlink($f);
        return ['token' => $token, 'summary' => $summary, 'kind' => 'export'];
    }

    private static function tokenFile(Store $store, string $token): ?string
    {
        if (!preg_match('/^[a-f0-9]{32}$/', $token)) return null;
        return $store->dir . '/runtime/import-' . $token . '.json';
    }

    public static function cancel(Store $store, string $token): bool
    {
        $f = self::tokenFile($store, $token);
        return $f && is_file($f) && @unlink($f);
    }

    public static function apply(Store $store, string $token, string $adminId, callable $audit): array
    {
        $f = self::tokenFile($store, $token);
        $p = $f && is_file($f) ? json_decode((string)file_get_contents($f), true) : null;
        if (!$p || $p['expires'] < ms_now()) throw new AppError(400, 'Podgląd importu wygasł – wczytaj plik ponownie');
        @unlink($f);
        $b = Backup::create($store, 'pre-import');
        $plan = $p['plan'];
        if ($plan['newUsers']) {
            $store->update('users', function ($doc) use ($plan) {
                foreach ($plan['newUsers'] as $u) {
                    if (isset($doc['users'][$u['id']])) continue;
                    foreach ($doc['users'] as $x) if ($x['nickKey'] === $u['nickKey']) continue 2;
                    $doc['users'][$u['id']] = $u;
                }
                return $doc;
            });
        }
        $created = [];
        foreach ($plan['add'] as $m) {
            $store->update('matches/' . $m['id'], fn($cur) => $cur ? null : $m);
            $created[] = $m['id'];
        }
        $store->update('meets', function ($doc) use ($plan) {
            $doc = is_array($doc) ? $doc : ['meets' => []];
            $ch = false;
            foreach ($plan['meets'] as $s) {
                if (!isset($doc['meets'][$s['id']]) && is_array($s['players'] ?? null) && count($s['players']) === 4) {
                    $doc['meets'][$s['id']] = array_merge($s, ['groupKey' => group_key_of($s['players'])]);
                    $ch = true;
                }
            }
            return $ch ? $doc : null;
        });
        $audit('admin.import', ['adminId' => $adminId, 'created' => count($created)]);
        return ['backup' => $b['name'], 'createdMatches' => $created, 'createdUsers' => array_column($plan['newUsers'], 'nick')];
    }
}

<?php
// Mecze, rozdania i sesje gry (odpowiednik server/services/matches.js).
declare(strict_types=1);

final class Matches
{
    const MEET_GAP_MS = 12 * 3600000;
    const MAX_OPS = 300;
    private Store $store;
    private Accounts $accounts;
    private $audit;
    public ?Rooms $rooms = null;

    public function __construct(Store $store, Accounts $accounts, callable $audit)
    {
        $this->store = $store;
        $this->accounts = $accounts;
        $this->audit = $audit;
    }

    private function audit(string $t, array $d = []): void { ($this->audit)($t, $d); }

    // Dziennik zmian meczów – klienci odpytują go zamiast WebSocketu.
    public function onChange(string $id): void
    {
        $this->store->runtimeUpdate('changes', function ($c) use ($id) {
            $n = (int)($c['n'] ?? 0) + 1;
            $items = array_slice(array_merge($c['items'] ?? [], [[$n, $id]]), -300);
            return ['n' => $n, 'items' => $items];
        });
    }

    public function list(bool $includeDeleted = false): array
    {
        $out = [];
        foreach ($this->store->list('matches') as $n) {
            $d = $this->store->get($n);
            if ($d && ($includeDeleted || ($d['data']['status'] ?? '') !== 'deleted')) $out[] = $d['data'] + ['rev' => $d['rev']];
        }
        usort($out, fn($a, $b) => strcmp($a['createdAt'], $b['createdAt']));
        return $out;
    }

    public function get($id): array
    {
        if (!Schemas::isId($id)) throw new AppError(400, 'Zły identyfikator meczu');
        $d = $this->store->get('matches/' . $id);
        if (!$d) throw new AppError(404, 'Nie ma takiego meczu', 'not_found');
        return $d['data'] + ['rev' => $d['rev']];
    }

    public function canEdit(array $user, array $m): bool
    {
        return $user['role'] === 'admin' || in_array($user['id'], $m['seats'], true) || ($m['createdBy'] ?? null) === $user['id'];
    }

    public static function applyResult(array &$m): array
    {
        $c = R::computeMatch($m);
        if ($c['winner'] !== null) {
            $m['winner'] = $c['winner'];
            if ($m['status'] !== 'deleted') $m['status'] = 'finished';
            $m['finishedAt'] = $m['finishedAt'] ?? now_iso();
        } else {
            $m['winner'] = null;
            if ($m['status'] === 'finished') $m['status'] = 'active';
            unset($m['finishedAt']);
        }
        return $c;
    }

    private function checkSeats($seats): void
    {
        if (!is_array($seats) || count($seats) !== 4 || count(array_unique(array_map('strval', $seats))) !== 4) throw new AppError(400, 'Wybierz czterech różnych graczy');
        foreach ($seats as $id) {
            $u = $this->accounts->getUser($id);
            if (!$u) throw new AppError(400, 'Nieznany gracz');
            if ($u['status'] === 'disabled') throw new AppError(400, "Konto {$u['nick']} jest zablokowane");
        }
    }

    // Gracz, którego można posadzić przy stole (istnieje i nie jest zablokowany).
    public function seatUser($id): array
    {
        $u = $this->accounts->getUser($id);
        if (!$u) throw new AppError(400, 'Nieznany gracz');
        if ($u['status'] === 'disabled') throw new AppError(400, "Konto {$u['nick']} jest zablokowane");
        return $u;
    }

    public function create(array $user, array $b): array
    {
        $seats = $b['seats'] ?? null;
        $this->checkSeats($seats);
        $seats = array_values($seats);
        try { $S = R::normalizeSettings($b['settings'] ?? []); } catch (RuleError $e) { throw new AppError(400, $e->getMessage(), 'validation'); }
        $fds = $b['firstDealerSeat'] ?? 0;
        if (!is_int($fds) || $fds < 0 || $fds > 3) throw new AppError(400, 'Zły pierwszy rozdający');
        $matchId = ($b['id'] ?? null) ?: rid('m_');
        if (!Schemas::isId($matchId)) throw new AppError(400, 'Zły identyfikator meczu');
        $opId = $b['opId'] ?? null;
        $mode = ($b['mode'] ?? 'offline') === 'online' ? 'online' : 'offline';
        $meet = $this->resolveMeet($user, $seats, $b['meetId'] ?? null);
        $created = false;
        $res = $this->store->update('matches/' . $matchId, function ($cur) use (&$created, $matchId, $mode, $seats, $S, $fds, $user, $opId, $meet) {
            if ($cur) {
                if ($opId && ($cur['createdOp'] ?? null) === $opId) return null;
                throw new AppError(409, 'Mecz o tym identyfikatorze już istnieje', 'exists');
            }
            $created = true;
            $t = now_iso();
            return ['id' => $matchId, 'schema' => 2, 'mode' => $mode, 'seats' => $seats, 'settings' => $S, 'firstDealerSeat' => $fds,
                'rounds' => [], 'status' => 'active', 'winner' => null, 'createdAt' => $t, 'createdBy' => $user['id'],
                'createdOp' => $opId ?: null, 'meetId' => $meet['id'], 'groupKey' => group_key_of($seats), 'roomId' => null,
                'modeHistory' => [['mode' => $mode, 'at' => $t, 'by' => $user['id'], 'afterRound' => 0]], 'appliedOps' => $opId ? [$opId] : []];
        });
        if ($created) {
            $this->audit('match.create', ['userId' => $user['id'], 'matchId' => $matchId, 'seats' => $seats]);
            $this->onChange($matchId);
        }
        return $res['data'] + ['rev' => $res['rev']];
    }

    // ---------- sesje gry (spotkania) ----------
    public function meets(): array { return array_values(($this->store->getData('meets') ?: ['meets' => []])['meets']); }

    public function resolveMeet(array $user, array $players, $meetId): array
    {
        $gk = group_key_of($players);
        $result = null;
        $this->store->update('meets', function ($doc) use ($gk, $meetId, $players, $user, &$result) {
            $doc = is_array($doc) ? $doc : ['meets' => []];
            $t = ms_now();
            if ($meetId) {
                $m = $doc['meets'][$meetId] ?? null;
                if (!$m) throw new AppError(404, 'Nie ma takiej sesji');
                if ($m['status'] !== 'open') throw new AppError(400, 'Ta sesja jest zakończona');
                if ($m['groupKey'] !== $gk) throw new AppError(400, 'Sesja dotyczy innej czwórki graczy');
                $doc['meets'][$meetId]['lastActivityAt'] = iso_from_ms($t);
                $result = $doc['meets'][$meetId];
                return $doc;
            }
            foreach ($doc['meets'] as $id => $m) {
                if ($m['groupKey'] === $gk && $m['status'] === 'open') {
                    if ($t - (iso_ms($m['lastActivityAt']) ?? 0) <= self::MEET_GAP_MS) {
                        $doc['meets'][$id]['lastActivityAt'] = iso_from_ms($t);
                        $result = $doc['meets'][$id];
                        return $doc;
                    }
                    $doc['meets'][$id]['status'] = 'closed';
                    $doc['meets'][$id]['endedAt'] = $m['lastActivityAt'];
                    $doc['meets'][$id]['closedReason'] = 'auto';
                }
            }
            $m = ['id' => rid('s_'), 'groupKey' => $gk, 'players' => array_values($players), 'status' => 'open', 'startedAt' => iso_from_ms($t),
                'endedAt' => null, 'lastActivityAt' => iso_from_ms($t), 'createdBy' => $user['id']];
            $doc['meets'][$m['id']] = $m;
            $result = $m;
            return $doc;
        });
        return $result;
    }

    public function startMeet(array $user, $players): array
    {
        $this->checkSeats($players);
        $players = array_values($players);
        $gk = group_key_of($players);
        $created = null;
        $this->store->update('meets', function ($doc) use ($gk, $players, $user, &$created) {
            $doc = is_array($doc) ? $doc : ['meets' => []];
            foreach ($doc['meets'] as $id => $m) {
                if ($m['groupKey'] === $gk && $m['status'] === 'open') {
                    $doc['meets'][$id]['status'] = 'closed'; $doc['meets'][$id]['endedAt'] = now_iso(); $doc['meets'][$id]['closedReason'] = 'new';
                }
            }
            $created = ['id' => rid('s_'), 'groupKey' => $gk, 'players' => $players, 'status' => 'open', 'startedAt' => now_iso(), 'endedAt' => null, 'lastActivityAt' => now_iso(), 'createdBy' => $user['id']];
            $doc['meets'][$created['id']] = $created;
            return $doc;
        });
        $this->audit('meet.start', ['userId' => $user['id'], 'meetId' => $created['id']]);
        return $created;
    }

    public function closeMeet(array $user, string $meetId): array
    {
        $out = null;
        $this->store->update('meets', function ($doc) use ($user, $meetId, &$out) {
            $m = $doc['meets'][$meetId] ?? null;
            if (!$m) throw new AppError(404, 'Nie ma takiej sesji');
            if ($user['role'] !== 'admin' && !in_array($user['id'], $m['players'], true)) throw new AppError(403, 'To nie twoja sesja');
            if ($m['status'] === 'closed') { $out = $m; return null; }
            $m['status'] = 'closed'; $m['endedAt'] = now_iso(); $m['closedReason'] = 'manual';
            $doc['meets'][$meetId] = $m;
            $out = $m;
            return $doc;
        });
        return $out;
    }

    private function touchMeet($meetId): void
    {
        if (!$meetId) return;
        try {
            $this->store->update('meets', function ($doc) use ($meetId) {
                if (!isset($doc['meets'][$meetId])) return null;
                $doc['meets'][$meetId]['lastActivityAt'] = now_iso();
                return $doc;
            });
        } catch (Throwable $e) { /* nieistotne */ }
    }

    private function mutate(?array $user, string $id, array $b, callable $fn, bool $allowLive = false): array
    {
        $opId = $b['opId'] ?? null;
        $baseRev = $b['baseRev'] ?? null;
        if ($opId !== null && (!is_string($opId) || strlen($opId) > 64)) throw new AppError(400, 'Zły identyfikator operacji');
        if (!is_int($baseRev)) throw new AppError(400, 'Brak wersji bazowej (baseRev)');
        if (!Schemas::isId($id)) throw new AppError(400, 'Zły identyfikator meczu');
        $replay = false;
        try {
            $res = $this->store->update('matches/' . $id, function ($m, $rev) use ($user, $id, $opId, $baseRev, $fn, $allowLive, &$replay) {
                if (!$m) throw new AppError(404, 'Nie ma takiego meczu', 'not_found');
                if ($opId && in_array($opId, $m['appliedOps'] ?? [], true)) { $replay = true; return null; }
                if ($rev !== $baseRev) throw new ConflictError($m + ['rev' => $rev]);
                if ($user && !$this->canEdit($user, $m)) throw new AppError(403, 'Nie możesz zmieniać tego meczu');
                if (!$allowLive && $this->rooms && $this->rooms->isLive($id)) throw new AppError(409, 'Trwa rozdanie online w tym meczu – dokończ je przed zmianą wyników', 'live');
                $fn($m);
                self::applyResult($m);
                if ($opId) $m['appliedOps'] = array_slice(array_merge($m['appliedOps'] ?? [], [$opId]), -self::MAX_OPS);
                $m['updatedAt'] = now_iso();
                if ($user) $m['updatedBy'] = $user['id'];
                return $m;
            });
        } catch (RuleError $e) {
            throw new AppError(400, $e->getMessage(), 'rule');
        }
        if (!$replay) $this->onChange($id);
        $m = $res['data'] + ['rev' => $res['rev']];
        if (!$replay) $this->touchMeet($m['meetId'] ?? null);
        return ['match' => $m, 'replay' => $replay];
    }

    public function addRound(array $user, string $id, array $b): array
    {
        $added = null;
        $out = $this->mutate($user, $id, $b, function (&$m) use ($user, $b, &$added) {
            if ($m['status'] !== 'active') throw new AppError(400, 'Mecz nie jest w toku', 'not_active');
            $valid = R::validateRoundInput($m, $b['round'] ?? null);
            $c = R::computeMatch($m);
            $added = ['id' => rid('r_'), 'mode' => 'offline'] + $valid + ['dealer' => $c['nextDealer'], 'createdAt' => now_iso(), 'createdBy' => $user['id']];
            $m['rounds'][] = $added;
        });
        if (!$out['replay']) $this->audit('round.add', ['userId' => $user['id'], 'matchId' => $id, 'roundId' => $added['id']]);
        return $out;
    }

    public function editRound(array $user, string $id, string $roundId, array $b): array
    {
        $out = $this->mutate($user, $id, $b, function (&$m) use ($user, $roundId, $b) {
            if ($m['status'] === 'abandoned' || $m['status'] === 'deleted') throw new AppError(400, 'Najpierw wznów mecz');
            $i = null;
            foreach ($m['rounds'] as $k => $r) if ($r['id'] === $roundId) { $i = $k; break; }
            if ($i === null) throw new AppError(404, 'Nie ma takiego rozdania');
            $old = $m['rounds'][$i];
            if ($old['mode'] === 'online') throw new AppError(400, 'Rozdania rozegranego online nie można poprawiać ręcznie – wynik ustalił serwer z zagranych kart');
            $valid = R::validateRoundInput($m, $b['round'] ?? null);
            $next = array_merge($old, $valid, ['id' => $old['id'], 'mode' => $old['mode'], 'dealer' => $old['dealer'] ?? null, 'createdAt' => $old['createdAt'],
                'createdBy' => $old['createdBy'] ?? null, 'updatedAt' => now_iso(), 'updatedBy' => $user['id']]);
            unset($next['scoring'], $next['legacy']);
            $before = ['bid' => $old['bid'], 'bidder' => $old['bidder'], 'made' => $old['made'], 'cards' => $old['cards'], 'melds' => $old['melds'], 'got' => $old['got'] ?? null];
            if (!empty($old['scoring'])) $before['scoring'] = $old['scoring'];
            $next['history'] = array_slice(array_merge($old['history'] ?? [], [['at' => now_iso(), 'by' => $user['id'], 'before' => $before]]), -20);
            if (!empty($old['legacy'])) $next['legacy'] = $old['legacy'];
            $m['rounds'][$i] = $next;
            $c = R::computeMatch($m);
            $nRows = count($c['rows']);
            if ($c['winner'] !== null && $nRows < count($m['rounds'])) {
                if (empty($b['truncate'])) throw new AppError(409, "Po tej poprawce mecz kończy się na rozdaniu $nRows. Potwierdź usunięcie późniejszych rozdań.", 'would_truncate', ['endsAt' => $nRows]);
                $removed = array_map(fn($r) => $r + ['removedAt' => now_iso(), 'removedBy' => $user['id']], array_slice($m['rounds'], $nRows));
                $m['removedRounds'] = array_merge($m['removedRounds'] ?? [], $removed);
                $m['rounds'] = array_slice($m['rounds'], 0, $nRows);
            }
        });
        if (!$out['replay']) $this->audit('round.edit', ['userId' => $user['id'], 'matchId' => $id, 'roundId' => $roundId]);
        return $out;
    }

    public function undoLast(array $user, string $id, array $b): array
    {
        $roundId = $b['roundId'] ?? null;
        $out = $this->mutate($user, $id, $b, function (&$m) use ($user, $roundId) {
            if ($m['status'] !== 'active') throw new AppError(400, 'Cofać można tylko w trwającym meczu');
            $last = $m['rounds'] ? $m['rounds'][count($m['rounds']) - 1] : null;
            if (!$last || $last['id'] !== $roundId) throw new AppError(409, 'Ostatnie rozdanie zmieniło się – odśwież', 'conflict');
            if ($last['mode'] === 'online') throw new AppError(400, 'Rozdania online nie można cofnąć');
            $m['removedRounds'] = array_merge($m['removedRounds'] ?? [], [$last + ['removedAt' => now_iso(), 'removedBy' => $user['id']]]);
            array_pop($m['rounds']);
        });
        if (!$out['replay']) $this->audit('round.undo', ['userId' => $user['id'], 'matchId' => $id, 'roundId' => $roundId]);
        return $out;
    }

    public function setStatus(array $user, string $id, array $b): array
    {
        $status = $b['status'] ?? null;
        // Usunięcie/przerwanie meczu zamyka jego stół (wcześniej trzeba było najpierw przejść na offline).
        if (($status === 'deleted' || $status === 'abandoned') && $this->rooms && $this->rooms->isLive($id)) {
            throw new AppError(409, 'Trwa rozdanie online w tym meczu – dokończ je przed usunięciem', 'live');
        }
        $out = $this->mutate($user, $id, $b, function (&$m) use ($user, $status) {
            if ($status === 'abandoned') {
                if ($m['status'] !== 'active') throw new AppError(400, 'Przerwać można tylko trwający mecz');
                $m['status'] = 'abandoned';
            } elseif ($status === 'active') {
                if ($m['status'] === 'deleted' && $user['role'] !== 'admin') throw new AppError(403, 'Przywrócić usunięty mecz może administrator');
                $m['status'] = 'active';
            } elseif ($status === 'deleted') {
                $m['statusBeforeDelete'] = $m['status'];
                $m['status'] = 'deleted';
            } else {
                throw new AppError(400, 'Zły status');
            }
        });
        if (($status === 'deleted' || $status === 'abandoned') && $this->rooms) $this->rooms->closeForMatch($id, $user['id']);
        $this->audit('match.status', ['userId' => $user['id'], 'matchId' => $id, 'status' => $status]);
        return $out;
    }

    public function setMode(?array $user, string $id, string $mode, ?string $roomId = null): array
    {
        $r = $this->store->update('matches/' . $id, function ($m) use ($user, $mode, $roomId) {
            if (!$m) throw new AppError(404, 'Nie ma takiego meczu');
            if ($m['status'] !== 'active') throw new AppError(400, 'Mecz nie jest w toku');
            if ($m['mode'] === $mode && ($m['roomId'] ?? null) === $roomId) return null;
            if ($m['mode'] !== $mode) $m['modeHistory'] = array_merge($m['modeHistory'] ?? [], [['mode' => $mode, 'at' => now_iso(), 'by' => $user ? $user['id'] : null, 'afterRound' => count($m['rounds'])]]);
            $m['mode'] = $mode;
            $m['roomId'] = $roomId;
            $m['updatedAt'] = now_iso();
            return $m;
        });
        $this->onChange($id);
        return $r['data'] + ['rev' => $r['rev']];
    }

    public function appendOnlineRound(string $id, array $roundData, array $handInfo): array
    {
        $added = null;
        $res = $this->store->update('matches/' . $id, function ($m) use ($roundData, $handInfo, &$added) {
            if (!$m) throw new AppError(404, 'Nie ma meczu');
            if ($m['status'] !== 'active') throw new AppError(400, 'Mecz nie jest w toku');
            if (in_array($handInfo['opId'], $m['appliedOps'] ?? [], true)) return null;
            $c = R::computeMatch($m);
            $valid = R::validateRoundInput($m, ['bidder' => $roundData['bidder'], 'bid' => $roundData['bid'], 'cards' => $roundData['cards'], 'melds' => $roundData['melds']]);
            $added = ['id' => rid('r_'), 'mode' => 'online'] + $valid + [
                'dealer' => $m['seats'][$handInfo['dealerSeat']] ?? $c['nextDealer'], 'createdAt' => now_iso(), 'createdBy' => null,
                'roomId' => $handInfo['roomId'], 'tricksWon' => $roundData['tricksWon'], 'plays' => $roundData['plays']];
            $m['rounds'][] = $added;
            self::applyResult($m);
            $m['appliedOps'] = array_slice(array_merge($m['appliedOps'] ?? [], [$handInfo['opId']]), -self::MAX_OPS);
            $m['updatedAt'] = now_iso();
            return $m;
        });
        $this->onChange($id);
        $this->touchMeet($res['data']['meetId'] ?? null);
        return ['match' => $res['data'] + ['rev' => $res['rev']], 'round' => $added];
    }
}

<?php
// Pokoje i rozgrywka online (odpowiednik server/services/rooms.js). Serwer autorytatywny:
// talia, ręce, kolejność, legalność ruchów, wynik. Stan pokoju w rooms/<id>.json.
// Zamiast WebSocketu klienci odpytują serwer (/api/poll) – działa na zwykłym hostingu PHP.
declare(strict_types=1);

final class Rooms
{
    const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const IDLE_LOBBY_MS = 24 * 3600000;
    const CLOSED_KEEP_MS = 7 * 86400000;
    const PRESENCE_MS = 12000;
    const IDLE_OFFLINE_MS = 14 * 86400000;
    const CHAT_KEEP = 300;
    const CHAT_MAX_LEN = 300;
    const IDLE_FINISHED_MS = 24 * 3600000;
    const TURN_SECONDS = [0, 30, 60, 90, 120];
    const DEFAULT_TURN_SECONDS = 60;
    private Store $store;
    private Matches $matches;
    private $audit;
    private ?array $openCache = null;

    public function __construct(Store $store, Matches $matches, callable $audit)
    {
        $this->store = $store;
        $this->matches = $matches;
        $this->audit = $audit;
    }

    private function audit(string $t, array $d = []): void { ($this->audit)($t, $d); }

    // Otwarte (niezamknięte) pokoje: id → pokój.
    public function open(): array
    {
        if ($this->openCache !== null) return $this->openCache;
        $out = [];
        foreach ($this->store->list('rooms') as $name) {
            try { $d = $this->store->getData($name); } catch (Throwable $e) { continue; }
            if ($d && $d['status'] !== 'closed') $out[$d['id']] = $d;
        }
        return $this->openCache = $out;
    }

    public function count(): int { return count($this->open()); }

    public function purgeClosed(): int
    {
        $t = ms_now();
        $n = 0;
        foreach ($this->store->list('rooms') as $name) {
            try { $d = $this->store->getData($name); } catch (Throwable $e) { continue; }
            if ($d && $d['status'] === 'closed' && $t - (iso_ms($d['updatedAt'] ?? $d['createdAt']) ?? 0) > self::CLOSED_KEEP_MS) {
                $this->store->remove($name, false);
                $this->removeChat($d['id']);
                $n++;
            }
        }
        return $n;
    }

    public function sweep(): void
    {
        $t = ms_now();
        foreach ($this->open() as $r) {
            $idle = $t - (iso_ms($r['updatedAt'] ?? $r['createdAt']) ?? 0);
            $finished = $r['status'] === 'finished';
            if (!$finished && $r['status'] === 'offline' && $r['matchId']) {
                try { $finished = $this->matches->get($r['matchId'])['status'] !== 'active'; } catch (Throwable $e) { $finished = true; }
            }
            if (($r['status'] === 'lobby' && $idle > self::IDLE_LOBBY_MS) || ($r['status'] === 'offline' && $idle > self::IDLE_OFFLINE_MS) || ($finished && $idle > self::IDLE_FINISHED_MS)) {
                $r['status'] = 'closed';
                $this->save($r);
                $this->clearChat($r['id']);
            }
        }
        $this->purgeClosed();
    }

    private function newCode(): string
    {
        $codes = array_map(fn($r) => $r['code'], $this->open());
        for (;;) {
            $c = '';
            for ($i = 0; $i < 6; $i++) $c .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
            if (!in_array($c, $codes, true)) return $c;
        }
    }

    private function save(array $room): void
    {
        $room['updatedAt'] = now_iso();
        $this->store->update('rooms/' . $room['id'], fn() => $room);
        if ($this->openCache !== null) {
            if ($room['status'] === 'closed') unset($this->openCache[$room['id']]);
            else $this->openCache[$room['id']] = $room;
        }
    }

    public function get($roomId): array
    {
        $r = is_string($roomId) ? ($this->open()[$roomId] ?? null) : null;
        if (!$r) throw new AppError(404, 'Nie ma takiego pokoju', 'not_found');
        return $r;
    }

    public function find($roomId): ?array { return is_string($roomId) ? ($this->open()[$roomId] ?? null) : null; }

    public function isLive(string $matchId): bool
    {
        foreach ($this->open() as $r) if (($r['matchId'] ?? null) === $matchId && $r['status'] === 'playing') return true;
        return false;
    }

    public function roomForMatch(string $matchId): ?array
    {
        foreach ($this->open() as $r) if (($r['matchId'] ?? null) === $matchId) return $r;
        return null;
    }

    // Do stołu ma dostęp: kto dołączył kodem, kto siedzi na miejscu i komu miejsce zarezerwowano (mecz).
    public function canAccess(array $room, string $userId): bool
    {
        return in_array($userId, $room['members'], true) || in_array($userId, $room['seats'], true)
            || (is_array($room['reservedSeats'] ?? null) && in_array($userId, $room['reservedSeats'], true));
    }

    public function listForUser(string $userId): array
    {
        $out = [];
        foreach ($this->open() as $r) if ($this->canAccess($r, $userId)) $out[] = $this->summary($r);
        return $out;
    }

    public function summary(array $r): array
    {
        return ['id' => $r['id'], 'code' => $r['code'], 'status' => $r['status'], 'seats' => $r['seats'], 'reservedSeats' => $r['reservedSeats'] ?? null,
            'matchId' => $r['matchId'] ?? null, 'createdAt' => $r['createdAt'], 'updatedAt' => $r['updatedAt'] ?? $r['createdAt'], 'chatN' => $this->chatN($r['id'])];
    }

    // Zamknięcie stołu po usunięciu/przerwaniu meczu (mecz nie jest wtedy już w toku).
    public function closeForMatch(string $matchId, string $userId): void
    {
        $r = $this->roomForMatch($matchId);
        if (!$r) return;
        if ($r['status'] === 'playing') throw new AppError(409, 'Trwa rozdanie online w tym meczu – dokończ je najpierw', 'live');
        $r['status'] = 'closed';
        $this->save($r);
        $this->clearChat($r['id']);
        $this->audit('room.close', ['roomId' => $r['id'], 'matchId' => $matchId, 'userId' => $userId, 'reason' => 'match-status']);
    }

    public function create(array $user, array $b): array
    {
        $fromMatchId = $b['fromMatchId'] ?? null;
        $reserved = null;
        if ($fromMatchId) {
            $m = $this->matches->get($fromMatchId);
            if ($m['status'] !== 'active') throw new AppError(400, 'Ten mecz nie jest w toku');
            if (!in_array($user['id'], $m['seats'], true) && $user['role'] !== 'admin') throw new AppError(403, 'Nie grasz w tym meczu');
            $existing = $this->roomForMatch($fromMatchId);
            if ($existing) return $this->summary($existing);
            $reserved = $m['seats'];
            $S = $m['settings'];
            $offline = ($b['mode'] ?? 'online') === 'offline';
        } else {
            try { $S = R::normalizeSettings($b['settings'] ?? []); } catch (RuleError $e) { throw new AppError(400, $e->getMessage()); }
        }
        $room = ['id' => 'room_' . bin2hex(random_bytes(8)), 'code' => $this->newCode(), 'createdBy' => $user['id'], 'createdAt' => now_iso(),
            'status' => 'lobby', 'seats' => [null, null, null, null], 'ready' => [false, false, false, false], 'members' => [$user['id']],
            'reservedSeats' => $reserved, 'matchId' => $fromMatchId, 'settings' => $S, 'hand' => null, 'handNo' => 0, 'lastHand' => null, 'seq' => 0,
            'recentActions' => [], 'log' => []];
        if ($reserved && in_array($user['id'], $reserved, true)) $room['seats'][array_search($user['id'], $reserved, true)] = $user['id'];
        if ($fromMatchId && !empty($offline)) {
            // Stół dla trwającego meczu offline – wszyscy od razu na swoich miejscach, tryb offline.
            $room['seats'] = $reserved;
            $room['status'] = 'offline';
            $this->matches->setMode($user, $fromMatchId, 'offline', $room['id']);
        }
        $this->save($room);
        $this->audit('room.create', ['userId' => $user['id'], 'roomId' => $room['id'], 'fromMatchId' => $fromMatchId]);
        return $this->summary($room);
    }

    public function joinByCode(array $user, $code): array
    {
        $c = preg_replace('/[^A-Z0-9]/', '', strtoupper((string)($code ?? '')));
        $room = null;
        foreach ($this->open() as $r) if ($r['code'] === $c) { $room = $r; break; }
        if (!$room) throw new AppError(404, 'Nie ma pokoju z takim kodem', 'not_found');
        if (!in_array($user['id'], $room['members'], true)) {
            if (count($room['members']) >= 12) throw new AppError(400, 'Pokój jest pełny');
            $room['members'][] = $user['id'];
        }
        if ($room['reservedSeats'] && in_array($user['id'], $room['reservedSeats'], true) && $room['status'] === 'lobby') {
            $room['seats'][array_search($user['id'], $room['reservedSeats'], true)] = $user['id'];
        }
        $this->save($room);
        return $this->summary($room);
    }

    public function act(array $user, string $roomId, $msg): array
    {
        if (!is_array($msg)) throw new AppError(400, 'Brak akcji');
        $room = $this->get($roomId);
        if (!$this->canAccess($room, $user['id'])) throw new AppError(403, 'Najpierw dołącz do stołu kodem');
        $aid = $msg['actionId'] ?? null;
        if ($aid !== null) {
            if (!is_string($aid) || strlen($aid) > 64) throw new AppError(400, 'Zły identyfikator akcji');
            if (in_array($aid, $room['recentActions'], true)) return ['duplicate' => true];
        }
        $type = $msg['type'] ?? null;
        if (isset($msg['expectSeq']) && $msg['expectSeq'] !== $room['seq'] && in_array($type, ['bid', 'pass', 'play', 'give', 'give-all'], true)) {
            throw new AppError(409, 'Stan gry się zmienił – odświeżam', 'stale');
        }
        // Gracz z zarezerwowanym miejscem, który jeszcze nie wchodził kodem – staje się członkiem stołu.
        if (!in_array($user['id'], $room['members'], true) && ($msg['type'] ?? null) !== 'leave') $room['members'][] = $user['id'];
        try {
            $this->dispatch($user, $room, $msg);
        } catch (RuleError $e) {
            throw new AppError(400, $e->getMessage(), $e->ruleCode === 'turn' ? 'turn' : 'illegal');
        }
        if ($aid !== null) $room['recentActions'] = array_slice(array_merge($room['recentActions'], [$aid]), -100);
        $room['seq']++;
        $this->save($room);
        return ['ok' => true];
    }

    private function seatOf(array $room, string $uid): int
    {
        $i = array_search($uid, $room['seats'], true);
        return $i === false ? -1 : $i;
    }

    private function dispatch(array $user, array &$room, array $msg): void
    {
        $seat = $this->seatOf($room, $user['id']);
        $type = $msg['type'] ?? null;
        switch ($type) {
            case 'sit':
                if ($room['status'] !== 'lobby') throw new AppError(400, 'Miejsca wybiera się przed startem gry');
                $s = $msg['seat'] ?? null;
                if (!is_int($s) || $s < 0 || $s > 3) throw new AppError(400, 'Złe miejsce');
                if ($room['reservedSeats'] && $room['reservedSeats'][$s] !== $user['id']) throw new AppError(400, 'To miejsce należy do innego gracza tego meczu');
                if ($room['seats'][$s] && $room['seats'][$s] !== $user['id']) throw new AppError(400, 'Miejsce zajęte');
                if ($seat >= 0) { $room['seats'][$seat] = null; $room['ready'][$seat] = false; }
                $room['seats'][$s] = $user['id'];
                $room['ready'][$s] = false;
                break;
            case 'stand':
                if ($room['status'] !== 'lobby') throw new AppError(400, 'Nie można wstać w trakcie meczu');
                if ($seat >= 0) { $room['seats'][$seat] = null; $room['ready'][$seat] = false; }
                break;
            case 'seat-other':
                // Posadzenie innego gracza (np. bez telefonu przy grze offline) albo zwolnienie miejsca po nim.
                if ($room['status'] !== 'lobby') throw new AppError(400, 'Miejsca wybiera się przed startem gry');
                if ($room['reservedSeats']) throw new AppError(400, 'Miejsca są przypisane z meczu');
                $s = $msg['seat'] ?? null;
                if (!is_int($s) || $s < 0 || $s > 3) throw new AppError(400, 'Złe miejsce');
                $uid = $msg['userId'] ?? null;
                $cur = $room['seats'][$s];
                if ($cur && $cur !== $uid && in_array($cur, $room['members'], true) && $cur !== $user['id']) throw new AppError(400, 'To miejsce zajął gracz przy stole – może zwolnić je tylko on');
                if ($uid === null) { $room['seats'][$s] = null; $room['ready'][$s] = false; break; }
                $this->matches->seatUser($uid);
                $old = array_search($uid, $room['seats'], true);
                if ($old !== false && $uid !== $user['id'] && in_array($uid, $room['members'], true)) throw new AppError(400, 'Ten gracz już siedzi przy stole');
                if ($old !== false) { $room['seats'][$old] = null; $room['ready'][$old] = false; }
                $room['seats'][$s] = $uid;
                $room['ready'][$s] = false;
                break;
            case 'ready':
                if ($seat < 0) throw new AppError(400, 'Najpierw zajmij miejsce');
                if (!in_array($room['status'], ['lobby', 'between'], true)) throw new AppError(400, 'Teraz nie można zgłosić gotowości');
                $room['ready'][$seat] = ($msg['ready'] ?? true) !== false;
                if ($room['status'] === 'between' && !in_array(false, $room['ready'], true)) $this->deal($room);
                break;
            case 'set-timer':
                if (!in_array($room['status'], ['lobby', 'between', 'offline', 'finished'], true)) throw new AppError(400, 'Czas na ruch zmienia się między rozdaniami');
                $sec = $msg['seconds'] ?? null;
                if (!in_array($sec, self::TURN_SECONDS, true)) throw new AppError(400, 'Zły czas na ruch');
                $room['turnSeconds'] = $sec;
                break;
            case 'start':
                if ($room['status'] !== 'lobby') throw new AppError(400, 'Gra już trwa');
                if (in_array(null, $room['seats'], true)) throw new AppError(400, 'Potrzeba czterech graczy');
                foreach ($room['seats'] as $su) if (!in_array($su, $room['members'], true)) throw new AppError(400, 'Do gry online każdy musi wejść do stołu na swoim telefonie (kod zaproszenia)');
                if (in_array(false, $room['ready'], true)) throw new AppError(400, 'Wszyscy muszą być gotowi');
                if ($seat < 0) throw new AppError(403, 'Start może wykonać tylko gracz przy stole');
                if (!$room['matchId']) {
                    $m = $this->matches->create($user, ['seats' => $room['seats'], 'settings' => $room['settings'], 'mode' => 'online', 'firstDealerSeat' => self::dealerArg($msg)]);
                    $room['matchId'] = $m['id'];
                } else {
                    $m = $this->matches->get($room['matchId']);
                    if (implode(',', $m['seats']) !== implode(',', $room['seats'])) throw new AppError(400, 'Gracze muszą siedzieć na swoich miejscach z meczu');
                    if ($m['status'] !== 'active') throw new AppError(400, 'Mecz jest zakończony');
                }
                $this->matches->setMode($user, $room['matchId'], 'online', $room['id']);
                $this->deal($room);
                $this->audit('room.start', ['roomId' => $room['id'], 'matchId' => $room['matchId']]);
                break;
            case 'start-offline':
                // Gra prawdziwymi kartami – aplikacja tylko liczy punkty. Nie trzeba telefonów wszystkich graczy.
                if ($room['status'] !== 'lobby') throw new AppError(400, 'Gra już trwa');
                if (in_array(null, $room['seats'], true)) throw new AppError(400, 'Posadź czterech graczy');
                if (!$room['matchId']) {
                    $m = $this->matches->create($user, ['seats' => $room['seats'], 'settings' => $room['settings'], 'mode' => 'offline', 'firstDealerSeat' => self::dealerArg($msg)]);
                    $room['matchId'] = $m['id'];
                } else {
                    $m = $this->matches->get($room['matchId']);
                    if (implode(',', $m['seats']) !== implode(',', $room['seats'])) throw new AppError(400, 'Gracze muszą siedzieć na swoich miejscach z meczu');
                    if ($m['status'] !== 'active') throw new AppError(400, 'Mecz jest zakończony');
                }
                $this->matches->setMode($user, $room['matchId'], 'offline', $room['id']);
                $room['reservedSeats'] = $room['seats'];
                $room['status'] = 'offline';
                $room['ready'] = [false, false, false, false];
                $room['hand'] = null;
                $room['lastHand'] = null;
                $this->audit('room.start-offline', ['roomId' => $room['id'], 'matchId' => $room['matchId']]);
                break;
            case 'go-online':
                // Z gry offline do online (między rozdaniami): poczekalnia z miejscami z meczu, każdy zgłasza gotowość.
                if ($room['status'] !== 'offline') throw new AppError(400, 'Stół nie jest w trybie offline');
                $m = $this->matches->get($room['matchId']);
                if ($m['status'] !== 'active') throw new AppError(400, 'Mecz jest zakończony – zacznij rewanż');
                $room['seats'] = $m['seats'];
                $room['reservedSeats'] = $m['seats'];
                $room['ready'] = [false, false, false, false];
                $room['status'] = 'lobby';
                $room['lastHand'] = null;
                break;
            case 'bid':
            case 'pass':
            case 'give':
            case 'give-all':
            case 'play':
                if ($room['status'] !== 'playing' || !$room['hand']) throw new AppError(400, 'Rozdanie nie trwa');
                if ($seat < 0) throw new AppError(403, 'Nie siedzisz przy stole');
                $this->applyHandAction($room, $seat, $msg);
                break;
            case 'detach':
                // Z gry online do offline – stół zostaje otwarty (czat, kod), mecz liczony dalej ręcznie.
                if ($room['status'] === 'playing') throw new AppError(400, 'Dokończ rozdanie przed przejściem do trybu offline');
                if ($room['status'] === 'offline') break;
                if ($seat < 0 && $user['role'] !== 'admin') throw new AppError(403, 'Tylko gracz przy stole');
                if (!$room['matchId']) throw new AppError(400, 'Najpierw rozpocznij grę');
                $m = $this->matches->get($room['matchId']);
                if ($m['status'] !== 'active') throw new AppError(400, 'Mecz jest zakończony – zacznij rewanż');
                $this->matches->setMode($user, $room['matchId'], 'offline', $room['id']);
                $room['seats'] = $m['seats'];
                $room['reservedSeats'] = $m['seats'];
                $room['status'] = 'offline';
                $room['ready'] = [false, false, false, false];
                $room['hand'] = null;
                $this->audit('room.detach', ['roomId' => $room['id'], 'matchId' => $room['matchId'], 'userId' => $user['id']]);
                break;
            case 'close':
                // Zamknięcie stołu. Mecz zostaje (w toku – do kontynuacji z ekranu głównego, albo w historii).
                if ($room['status'] === 'playing') throw new AppError(400, 'Dokończ rozdanie przed zamknięciem stołu');
                if ($room['matchId']) {
                    $m = $this->matches->get($room['matchId']);
                    if ($m['status'] === 'active') $this->matches->setMode($user, $room['matchId'], 'offline', null);
                }
                $room['status'] = 'closed';
                $this->clearChat($room['id']);
                $this->audit('room.close', ['roomId' => $room['id'], 'matchId' => $room['matchId'], 'userId' => $user['id']]);
                break;
            case 'leave':
                if (in_array($room['status'], ['playing', 'between', 'offline'], true)) throw new AppError(400, 'Mecz trwa – możesz wyjść do menu i wrócić później (albo zamknąć stół)');
                if ($seat >= 0) { $room['seats'][$seat] = null; $room['ready'][$seat] = false; }
                $room['members'] = array_values(array_filter($room['members'], fn($m) => $m !== $user['id']));
                if (!$room['members']) $room['status'] = 'closed';
                break;
            case 'abort-hand':
                if ($user['role'] !== 'admin') throw new AppError(403, 'Unieważnić rozdanie może tylko administrator');
                if ($room['status'] !== 'playing') throw new AppError(400, 'Rozdanie nie trwa');
                $room['hand'] = null;
                $room['status'] = 'between';
                $room['ready'] = [false, false, false, false];
                $room['log'] = array_slice(array_merge($room['log'], [['at' => now_iso(), 'seat' => -1, 'type' => 'abort', 'by' => $user['id']]]), -60);
                $this->audit('room.abort-hand', ['roomId' => $room['id'], 'matchId' => $room['matchId'], 'adminId' => $user['id']]);
                break;
            case 'rematch':
                $old = $room['matchId'] ? $this->matches->get($room['matchId']) : null;
                $offlineRoom = $room['status'] === 'offline';
                if (!$old || !($room['status'] === 'finished' || ($offlineRoom && $old['status'] === 'finished'))) throw new AppError(400, 'Rewanż po zakończeniu meczu');
                if ($seat < 0 && !in_array($user['id'], $old['seats'], true)) throw new AppError(403, 'Tylko gracz przy stole');
                $n = count($old['rounds']);
                $lastDealer = $n ? array_search($old['rounds'][$n - 1]['dealer'] ?? null, $old['seats'], true) : -1;
                if ($lastDealer === false) $lastDealer = -1;
                $meetOpen = false;
                if (!empty($old['meetId'])) foreach ($this->matches->meets() as $mt) if ($mt['id'] === $old['meetId'] && $mt['status'] === 'open') $meetOpen = true;
                $m = $this->matches->create($user, ['seats' => $old['seats'], 'settings' => $old['settings'], 'mode' => $offlineRoom ? 'offline' : 'online',
                    'firstDealerSeat' => ($lastDealer + 1 + 4) % 4, 'meetId' => $meetOpen ? $old['meetId'] : null]);
                $room['matchId'] = $m['id'];
                $room['reservedSeats'] = $m['seats'];
                $room['seats'] = $offlineRoom ? $m['seats'] : $room['seats'];
                if ($offlineRoom) $this->matches->setMode($user, $m['id'], 'offline', $room['id']);
                $this->clearChat($room['id']); // nowa gra – czat od zera
                $room['status'] = $offlineRoom ? 'offline' : 'lobby';
                $room['ready'] = [false, false, false, false];
                $room['lastHand'] = null;
                $room['handNo'] = 0;
                break;
            default:
                throw new AppError(400, 'Nieznana akcja');
        }
    }

    // Ruch w rozdaniu (licytacja, musik, zagranie) – od gracza albo automatycznie po upływie czasu.
    private function applyHandAction(array &$room, int $seat, array $msg, bool $auto = false): void
    {
        $type = $msg['type'] ?? null;
        $tricksBefore = count($room['hand']['tricks']);
        if ($type === 'play') $action = ['type' => 'play', 'card' => $msg['card'] ?? null];
        elseif ($type === 'bid') $action = ['type' => 'bid', 'value' => $msg['value'] ?? null];
        elseif ($type === 'give') $action = ['type' => 'give', 'card' => $msg['card'] ?? null, 'to' => $msg['to'] ?? null];
        elseif ($type === 'give-all') $action = ['type' => 'give-all', 'gives' => is_array($msg['gives'] ?? null)
            ? array_map(fn($g) => ['card' => is_array($g) ? ($g['card'] ?? null) : null, 'to' => is_array($g) ? ($g['to'] ?? null) : null], array_slice(array_values($msg['gives']), 0, 3)) : null];
        else $action = ['type' => 'pass'];
        $meldsBefore = count($room['hand']['melds']);
        $before = $room['hand'];
        $logBefore = $room['log'];
        Cards::applyAction($room['hand'], $seat, $action);
        if ($action['type'] === 'give') $entry = ['type' => 'give', 'to' => $action['to']];
        elseif ($action['type'] === 'give-all') $entry = ['type' => 'give-all', 'to' => array_map(fn($g) => $g['to'], $action['gives'])];
        else $entry = $action;
        if (count($room['hand']['melds']) > $meldsBefore) $entry['meld'] = $room['hand']['melds'][count($room['hand']['melds']) - 1]['suit'];
        if ($auto) $entry['auto'] = true;
        $room['log'] = array_slice(array_merge($room['log'], [['at' => now_iso(), 'seat' => $seat] + $entry]), -60);
        if ($room['hand']['phase'] === 'finished') {
            try {
                $this->finishHand($room);
            } catch (Throwable $e) {
                $room['hand'] = $before;
                $room['log'] = $logBefore;
                throw $e;
            }
        }
        // Zegar ruchu: następny gracz ma pełny czas (po skończonej lewie chwila na obejrzenie kart).
        if ($room['hand']) $room['turnAt'] = ms_now() + (count($room['hand']['tricks']) > $tricksBefore ? 2500 : 0);
    }

    private function deal(array &$room): void
    {
        $m = $this->matches->get($room['matchId']);
        if ($m['status'] !== 'active') throw new AppError(400, 'Mecz nie jest w toku (usunięty, przerwany albo zakończony) – nie można rozdać kart');
        $c = R::computeMatch($m);
        $room['handNo']++;
        $room['hand'] = Cards::createHand($c['nextDealerSeat'], $m['settings']);
        $room['handId'] = $room['id'] . '-h' . $room['handNo'] . '-' . bin2hex(random_bytes(4));
        $room['status'] = 'playing';
        $room['ready'] = [false, false, false, false];
        $room['lastHand'] = null;
        $room['turnAt'] = ms_now() + 4000; // chwila na animację rozdawania
    }

    private function finishHand(array &$room): void
    {
        $h = $room['hand'];
        $round = Cards::handToRound($h, $room['seats']);
        $res = $this->matches->appendOnlineRound($room['matchId'], $round, ['roomId' => $room['id'], 'dealerSeat' => $h['dealerSeat'], 'opId' => $room['handId']]);
        $match = $res['match'];
        $saved = $res['round'];
        $c = R::computeMatch($match);
        $row = $c['lastRow'];
        if ($saved) foreach ($c['rows'] as $r) if ($r['round']['id'] === $saved['id']) { $row = $r; break; }
        $room['lastHand'] = [
            'handNo' => $room['handNo'], 'contract' => $h['contract'], 'cardPoints' => $h['cardPoints'], 'melds' => $h['melds'],
            'tricks' => array_map(fn($t) => ['winner' => $t['winner'], 'points' => $t['points'], 'cards' => $t['cards']], $h['tricks']),
            'made' => $row ? $row['made'] : null, 'deltas' => $row ? $row['deltas'] : null, 'scores' => $c['scores'], 'winner' => $c['winner'],
            'bidderTeam' => R::teamOfSeat($h['contract']['seat']),
        ];
        $room['hand'] = null;
        $room['status'] = $match['status'] === 'finished' ? 'finished' : 'between';
        $room['ready'] = [false, false, false, false];
    }

    public function viewFor(array $room, string $userId): array
    {
        $seat = $this->seatOf($room, $userId);
        return [
            'id' => $room['id'], 'code' => $room['code'], 'status' => $room['status'], 'seats' => $room['seats'], 'ready' => $room['ready'],
            'members' => $room['members'], 'reservedSeats' => $room['reservedSeats'], 'matchId' => $room['matchId'], 'createdBy' => $room['createdBy'],
            'handNo' => $room['handNo'], 'seq' => $room['seq'], 'mySeat' => $seat,
            'hand' => $room['hand'] ? Cards::viewFor($room['hand'], $seat) : null,
            'lastHand' => $room['lastHand'], 'log' => array_slice($room['log'], -15),
            'settings' => $room['settings'], 'chatN' => $this->chatN($room['id']), 'chatCleared' => $this->chatCleared($room['id']),
            'turnSeconds' => self::turnSecondsOf($room), 'turnLeftMs' => $this->turnLeft($room),
        ];
    }

    // ---------- czas na ruch (gra online) ----------
    private static function turnSecondsOf(array $room): int
    {
        $s = $room['turnSeconds'] ?? self::DEFAULT_TURN_SECONDS;
        return in_array($s, self::TURN_SECONDS, true) ? $s : self::DEFAULT_TURN_SECONDS;
    }

    // Ile ms zostało graczowi na ruch (null = bez limitu albo nie trwa rozdanie).
    private function turnLeft(array $room): ?int
    {
        $sec = self::turnSecondsOf($room);
        if ($room['status'] !== 'playing' || !$room['hand'] || !$sec) return null;
        $at = (int)($room['turnAt'] ?? ms_now());
        return max(0, $at + $sec * 1000 - ms_now());
    }

    // Hosting PHP nie ma stałego procesu: przy każdym odpytaniu sprawdzamy, czy minął czas gracza – wtedy ruch automatyczny.
    public function autoMoveIfDue(string $roomId): bool
    {
        $r = $this->find($roomId);
        if (!$r || $this->turnLeft($r) !== 0) return false;
        $this->store->lock(LOCK_EX);
        $this->openCache = null; // po zmianie blokady czytamy stan od nowa
        $room = $this->find($roomId);
        if (!$room || $this->turnLeft($room) !== 0) return false;
        $h = $room['hand'];
        $seat = $h['turn'];
        try {
            $this->applyHandAction($room, $seat, self::autoAction($h, $seat), true);
        } catch (Throwable $e) {
            error_log('Tysiąc: ruch automatyczny: ' . $e->getMessage());
            $room['turnAt'] = ms_now(); // spróbujemy ponownie po kolejnym okresie
            $this->save($room);
            return false;
        }
        $room['seq']++;
        $this->save($room);
        $this->audit('room.auto-move', ['roomId' => $roomId, 'seat' => $seat]);
        return true;
    }

    // Ruch za gracza, który nie zdążył: pas; z musika najsłabsze karty; zagranie najsłabszej dozwolonej karty
    // (bez rozbijania pary król+dama, a jeśli można zameldować – meldunek damą).
    private static function autoAction(array $h, int $seat): array
    {
        if ($h['phase'] === 'bidding') return ['type' => 'pass'];
        $hand = $h['hands'][$seat];
        $inPair = fn($c) => ($c[0] === 'K' || $c[0] === 'Q') && in_array(($c[0] === 'K' ? 'Q' : 'K') . $c[1], $hand, true);
        $weak = function (array $cards) use ($inPair) {
            usort($cards, fn($a, $b) => [(int)$inPair($a), Cards::points($a), -Cards::rankIndex($a)] <=> [(int)$inPair($b), Cards::points($b), -Cards::rankIndex($b)]);
            return $cards;
        };
        if ($h['phase'] === 'giving') {
            $missing = array_values(array_filter([0, 1, 2, 3], fn($s) => !$h['given'][$s]));
            $cards = array_slice($weak($hand), 0, count($missing));
            return ['type' => 'give-all', 'gives' => array_map(fn($to, $c) => ['card' => $c, 'to' => $to], $missing, $cards)];
        }
        $legal = Cards::legalCards($h, $seat);
        foreach ($legal as $c) if ($c[0] === 'Q' && Cards::canMeld($h, $seat, $c)) return ['type' => 'play', 'card' => $c];
        return ['type' => 'play', 'card' => $weak($legal)[0]];
    }

    private static function dealerArg(array $msg): int
    {
        $d = $msg['firstDealerSeat'] ?? 0;
        return is_int($d) && $d >= 0 && $d <= 3 ? $d : 0;
    }

    // ---------- czat stołu (wspólny dla wszystkich przy stole – bez wiadomości tylko dla drużyny) ----------
    private function chatKey(string $roomId): string { return 'chat-' . preg_replace('/[^a-zA-Z0-9_-]/', '', $roomId); }

    public function chatN(string $roomId): int
    {
        return (int)($this->store->runtimeRead($this->chatKey($roomId), [])['n'] ?? 0);
    }

    public function chatSince(string $roomId, int $since, int $limit = 100): array
    {
        $d = $this->store->runtimeRead($this->chatKey($roomId), []);
        $items = array_values(array_filter($d['items'] ?? [], fn($m) => (int)$m['id'] > $since && empty($m['sys'])));
        return ['n' => (int)($d['n'] ?? 0), 'cleared' => (int)($d['cleared'] ?? 0), 'items' => array_map(fn($m) => without($m, 'ms'), array_slice($items, -$limit))];
    }

    public function chatPost(array $user, string $roomId, $text): array
    {
        $room = $this->get($roomId);
        if (!$this->canAccess($room, $user['id'])) throw new AppError(403, 'Najpierw dołącz do stołu kodem');
        if (!is_string($text)) throw new AppError(400, 'Pusta wiadomość');
        $text = trim((string)preg_replace('/\s+/u', ' ', $text));
        if ($text === '') throw new AppError(400, 'Pusta wiadomość');
        if (mb_strlen($text) > self::CHAT_MAX_LEN) throw new AppError(400, 'Za długa wiadomość (najwyżej ' . self::CHAT_MAX_LEN . ' znaków)');
        $uid = $user['id'];
        $t = ms_now();
        $msg = null;
        $this->store->runtimeUpdate($this->chatKey($roomId), function ($d) use ($uid, $t, $text, &$msg) {
            $items = $d['items'] ?? [];
            $recent = 0;
            foreach ($items as $m) if (($m['u'] ?? null) === $uid && empty($m['sys']) && $t - (int)($m['ms'] ?? 0) < 10000) $recent++;
            if ($recent >= 6) throw new AppError(429, 'Za dużo wiadomości naraz – chwilę poczekaj', 'rate');
            $n = (int)($d['n'] ?? 0) + 1;
            $msg = ['id' => $n, 'at' => now_iso(), 'ms' => $t, 'u' => $uid, 't' => $text];
            $items[] = $msg;
            return ['n' => $n, 'items' => array_slice($items, -self::CHAT_KEEP)];
        });
        return without($msg, 'ms');
    }

    public function chatCleared(string $roomId): int
    {
        return (int)($this->store->runtimeRead($this->chatKey($roomId), [])['cleared'] ?? 0);
    }

    // Czyszczenie czatu po skończonej / usuniętej grze. Numeracja zostaje (przeglądarki nie gubią nowych wiadomości).
    public function clearChat(string $roomId): void
    {
        try {
            $this->store->runtimeUpdate($this->chatKey($roomId), function ($d) {
                $n = (int)($d['n'] ?? 0);
                if (!$n || empty($d['items'])) return null;
                return ['n' => $n, 'cleared' => $n, 'items' => []];
            });
        } catch (Throwable $e) { error_log('Tysiąc: czyszczenie czatu: ' . $e->getMessage()); }
    }

    public function removeChat(string $roomId): void
    {
        $f = $this->store->dir . '/runtime/' . $this->chatKey($roomId);
        @unlink($f . '.json');
        @unlink($f . '.lock');
    }

    // ---------- obecność przy stole (zamiast połączeń WebSocket) ----------
    public function touchPresence(string $roomId, string $userId): void
    {
        $key = 'presence-' . preg_replace('/[^a-zA-Z0-9_-]/', '', $roomId);
        $cur = $this->store->runtimeRead($key);
        $t = ms_now();
        if (isset($cur[$userId]) && $t - $cur[$userId] < 3000) return; // rzadziej zapisujemy
        $this->store->runtimeUpdate($key, function ($p) use ($userId, $t) {
            $p[$userId] = $t;
            foreach ($p as $u => $at) if ($t - $at > 3600000) unset($p[$u]);
            return $p;
        });
    }

    public function presence(string $roomId): array
    {
        $p = $this->store->runtimeRead('presence-' . preg_replace('/[^a-zA-Z0-9_-]/', '', $roomId));
        $t = ms_now();
        $out = [];
        foreach ($p as $u => $at) if ($t - $at <= self::PRESENCE_MS) $out[] = (string)$u;
        sort($out, SORT_STRING);
        return $out;
    }
}

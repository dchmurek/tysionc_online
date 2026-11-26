<?php
// Walidacja dokumentów przed zapisem (odpowiednik server/store/schemas.js).
declare(strict_types=1);

final class Schemas
{
    const ID_RE = '/^[a-zA-Z0-9_-]{3,64}$/';

    private static function req($cond, string $where, string $msg): void
    {
        if (!$cond) throw new ValidationError("$where: $msg");
    }
    public static function isId($x): bool { return is_string($x) && preg_match(self::ID_RE, $x) === 1; }
    private static function isIso($x): bool { return is_string($x) && iso_ms($x) !== null; }

    public static function user($u, string $w = 'user'): void
    {
        self::req(is_array($u), $w, 'nie jest obiektem');
        self::req(self::isId($u['id'] ?? null), $w, 'zły identyfikator');
        $n = $u['nick'] ?? null;
        self::req(is_string($n) && mb_strlen($n) >= 2 && mb_strlen($n) <= 20, $w, 'zły nick');
        self::req(is_string($u['nickKey'] ?? null) && mb_strlen($u['nickKey']) >= 2, $w, 'brak klucza nicku');
        self::req(in_array($u['role'] ?? null, ['admin', 'player'], true), $w, 'zła rola');
        self::req(in_array($u['status'] ?? null, ['active', 'pending', 'disabled'], true), $w, 'zły status');
        $ph = $u['passwordHash'] ?? null;
        self::req($ph === null || is_string($ph), $w, 'zły hash hasła');
        self::req($u['status'] !== 'active' || is_string($ph), $w, 'aktywne konto bez hasła');
        self::req(self::isIso($u['createdAt'] ?? null), $w, 'zła data utworzenia');
        if (isset($u['activation'])) self::req(is_array($u['activation']) && is_string($u['activation']['codeHash'] ?? null) && self::isIso($u['activation']['expiresAt'] ?? null), $w, 'zły kod aktywacji');
    }

    public static function usersDoc($d): void
    {
        self::req(is_array($d) && is_array($d['users'] ?? null), 'users', 'brak mapy users');
        $keys = [];
        foreach ($d['users'] as $id => $u) {
            self::user($u, "users.$id");
            self::req(($u['id'] ?? null) === (string)$id, "users.$id", 'id niezgodne z kluczem');
            self::req(!isset($keys[$u['nickKey']]), "users.$id", 'zduplikowany nick');
            $keys[$u['nickKey']] = true;
        }
    }

    public static function authDoc($d): void
    {
        self::req(is_array($d) && is_array($d['sessions'] ?? null), 'auth', 'brak sesji');
        foreach ($d['sessions'] as $id => $s) {
            self::req(is_array($s) && ($s['id'] ?? null) === (string)$id && is_string($s['tokenHash'] ?? null) && strlen($s['tokenHash']) === 64, "auth.$id", 'zła sesja');
            self::req(self::isId($s['userId'] ?? null), "auth.$id", 'zły użytkownik sesji');
        }
    }

    public static function round($r, array $seats, string $w): void
    {
        self::req(is_array($r), $w, 'rozdanie nie jest obiektem');
        self::req(self::isId($r['id'] ?? null), $w, 'zły identyfikator rozdania');
        self::req(in_array($r['mode'] ?? null, ['offline', 'online'], true), $w, 'zły tryb rozdania');
        self::req(in_array($r['bidder'] ?? null, $seats, true), $w, 'licytujący spoza meczu');
        self::req(is_int($r['bid'] ?? null) && $r['bid'] > 0, $w, 'zły kontrakt');
        self::req(is_bool($r['made'] ?? null), $w, 'brak wyniku kontraktu');
        $got = $r['got'] ?? null;
        self::req($got === null || is_int($got) || is_float($got), $w, 'złe ugrane punkty');
        self::req(is_array($r['cards'] ?? null), $w, 'brak punktów z kart');
        foreach ($r['cards'] as $k => $v) self::req(in_array((string)$k, ['0', '1'], true) && ($v === null || (is_int($v) && $v >= 0 && $v <= 120)), $w, 'złe punkty z kart');
        self::req(is_array($r['melds'] ?? null), $w, 'złe meldunki');
        foreach ($r['melds'] as $uid => $list) {
            $ok = in_array((string)$uid, $seats, true) && is_array($list);
            if ($ok) foreach ($list as $s) if (!is_string($s) || !isset(R::MELD_VALUES[$s])) $ok = false;
            self::req($ok, $w, 'złe meldunki');
        }
        self::req(!isset($r['dealer']) || in_array($r['dealer'], $seats, true), $w, 'zły rozdający');
        self::req(self::isIso($r['createdAt'] ?? null), $w, 'zła data rozdania');
        self::req(!array_key_exists('scoring', $r) || $r['scoring'] === 'legacy', $w, 'zły sposób liczenia');
    }

    public static function match($m, string $name = 'match'): void
    {
        self::req(is_array($m), $name, 'nie jest obiektem');
        self::req(self::isId($m['id'] ?? null), $name, 'zły identyfikator');
        $seats = $m['seats'] ?? null;
        $ok = is_array($seats) && count($seats) === 4 && count(array_unique($seats)) === 4;
        if ($ok) foreach ($seats as $s) if (!self::isId($s)) $ok = false;
        self::req($ok, $name, 'potrzeba 4 różnych graczy');
        self::req(in_array($m['mode'] ?? null, ['offline', 'online'], true), $name, 'zły tryb');
        self::req(in_array($m['status'] ?? null, ['active', 'finished', 'abandoned', 'deleted'], true), $name, 'zły status');
        self::req(array_key_exists('winner', $m) && ($m['winner'] === null || $m['winner'] === 0 || $m['winner'] === 1), $name, 'zły zwycięzca');
        self::req(is_array($m['rounds'] ?? null), $name, 'brak rozdań');
        try { R::normalizeSettings($m['settings'] ?? []); } catch (RuleError $e) { throw new ValidationError("$name: " . $e->getMessage()); }
        $ids = [];
        foreach ($m['rounds'] as $i => $r) {
            self::round($r, $seats, "$name.rounds[$i]");
            self::req(!isset($ids[$r['id']]), $name, 'zduplikowane id rozdania');
            $ids[$r['id']] = true;
        }
        self::req(($m['groupKey'] ?? null) === group_key_of($seats), $name, 'zły klucz grupy');
        self::req(self::isIso($m['createdAt'] ?? null), $name, 'zła data');
        self::req(is_array($m['appliedOps'] ?? []), $name, 'złe appliedOps');
    }

    public static function meetsDoc($d): void
    {
        self::req(is_array($d) && is_array($d['meets'] ?? null), 'meets', 'brak mapy');
        foreach ($d['meets'] as $id => $s) {
            self::req(is_array($s) && ($s['id'] ?? null) === (string)$id && is_array($s['players'] ?? null) && count($s['players']) === 4, "meets.$id", 'zła sesja');
            self::req(($s['groupKey'] ?? null) === group_key_of($s['players']), "meets.$id", 'zły klucz grupy');
            self::req(in_array($s['status'] ?? null, ['open', 'closed'], true), "meets.$id", 'zły status');
        }
    }

    public static function room($r, string $name = 'room'): void
    {
        self::req(is_array($r) && self::isId($r['id'] ?? null), $name, 'zły pokój');
        self::req(is_string($r['code'] ?? null) && preg_match('/^[A-Z0-9]{6}$/', $r['code']), $name, 'zły kod');
        self::req(is_array($r['seats'] ?? null) && count($r['seats']) === 4, $name, 'złe miejsca');
        self::req(in_array($r['status'] ?? null, ['lobby', 'playing', 'between', 'finished', 'offline', 'closed'], true), $name, 'zły status');
    }

    public static function config($c): void
    {
        self::req(is_array($c), 'config', 'nie jest obiektem');
        self::req(is_bool($c['registrationOpen'] ?? null), 'config', 'registrationOpen');
        try { R::normalizeSettings($c['defaultSettings'] ?? []); } catch (RuleError $e) { throw new ValidationError('config: ' . $e->getMessage()); }
    }

    public static function validators(): array
    {
        return [
            'users' => [self::class, 'usersDoc'],
            'auth' => [self::class, 'authDoc'],
            'meets' => [self::class, 'meetsDoc'],
            'config' => [self::class, 'config'],
            'matches/' => fn($d, $name) => self::match($d, $name),
            'rooms/' => fn($d, $name) => self::room($d, $name),
        ];
    }
}

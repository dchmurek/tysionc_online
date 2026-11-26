<?php
// Konta, sesje logowania, aktywacja, limity prób (odpowiednik server/services/accounts.js + passwords.js).
declare(strict_types=1);

final class Passwords
{
    const ARGON = ['memory_cost' => 19456, 'time_cost' => 2, 'threads' => 1];
    const COMMON = ['12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyui', 'qwerty123', 'haslo123', 'tysiac123', '11111111', 'iloveyou', 'abcdefgh', 'zaq12wsx', 'polska123'];

    public static function hasArgon(): bool { return defined('PASSWORD_ARGON2ID'); }

    public static function hash(string $pw): string
    {
        if (self::hasArgon()) {
            try { return password_hash($pw, PASSWORD_ARGON2ID, self::ARGON); } catch (Throwable $e) { /* niżej bcrypt */ }
        }
        return password_hash($pw, PASSWORD_BCRYPT, ['cost' => 11]);
    }

    public static function verify($pw, $stored): bool
    {
        if (!is_string($pw) || !is_string($stored) || $stored === '') return false;
        if (str_starts_with($stored, '$argon2id$') && !self::hasArgon()) {
            // Hosting bez Argon2 w password_hash – weryfikacja przez libsodium (ten sam algorytm, p=1).
            if (!function_exists('sodium_crypto_pwhash')) return false;
            $p = explode('$', $stored);
            if (count($p) !== 6) return false;
            parse_str(str_replace(',', '&', $p[3]), $par);
            if ((int)($par['p'] ?? 1) !== 1) return false;
            $salt = base64_decode($p[4]);
            $exp = base64_decode($p[5]);
            if (strlen($salt) !== SODIUM_CRYPTO_PWHASH_SALTBYTES) return false;
            try {
                $k = sodium_crypto_pwhash(strlen($exp), $pw, $salt, (int)$par['t'], (int)$par['m'] * 1024, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
                return hash_equals($exp, $k);
            } catch (Throwable $e) { return false; }
        }
        return password_verify($pw, $stored);
    }

    public static function needsRehash(string $stored): bool
    {
        if (self::hasArgon()) return !str_starts_with($stored, '$argon2id$v=19$m=19456,t=2,');
        return !str_starts_with($stored, '$2y$') && !str_starts_with($stored, '$argon2id$');
    }

    public static function dummyVerify($pw): void
    {
        static $h = null;
        if ($h === null) $h = self::hash(bin2hex(random_bytes(16)));
        self::verify((string)($pw ?? ''), $h);
    }

    public static function problem($pw, string $nick = ''): ?string
    {
        if (!is_string($pw)) return 'Podaj hasło';
        if (mb_strlen($pw, 'UTF-8') < 10) return 'Hasło musi mieć co najmniej 10 znaków';
        if (strlen($pw) > 200) return 'Hasło jest za długie';
        if (in_array(mb_strtolower($pw), self::COMMON, true)) return 'To hasło jest zbyt popularne';
        if ($nick !== '' && mb_strlen($nick) >= 3 && str_contains(mb_strtolower($pw), mb_strtolower($nick))) return 'Hasło nie może zawierać nicku';
        return null;
    }
}

// Limiter prób (okno + blokada), zapisany w pliku – PHP nie ma pamięci między żądaniami.
final class Limiter
{
    private Store $store;
    private string $name;
    private int $max, $windowMs, $lockMs;
    public function __construct(Store $store, string $name, int $max, int $windowMs, int $lockMs)
    {
        $this->store = $store; $this->name = $name; $this->max = $max; $this->windowMs = $windowMs; $this->lockMs = $lockMs;
    }
    private function key(string $k): string { return substr(sha256($k), 0, 24); }
    public function check(string $key): int
    {
        $all = $this->store->runtimeRead('limits-' . $this->name);
        $e = $all[$this->key($key)] ?? null;
        $t = ms_now();
        if ($e && $e['until'] > $t) return (int)ceil(($e['until'] - $t) / 1000);
        return 0;
    }
    public function fail(string $key): void
    {
        $this->store->runtimeUpdate('limits-' . $this->name, function ($all) use ($key) {
            $t = ms_now();
            $k = $this->key($key);
            $e = $all[$k] ?? null;
            if (!$e || $e['first'] + $this->windowMs < $t) $e = ['n' => 0, 'first' => $t, 'until' => 0];
            $e['n']++;
            if ($e['n'] >= $this->max) { $e['until'] = $t + $this->lockMs; $e['n'] = 0; $e['first'] = $t; }
            $all[$k] = $e;
            if (count($all) > 2000) foreach ($all as $kk => $v) if ($v['until'] < $t && $v['first'] + $this->windowMs < $t) unset($all[$kk]);
            return $all;
        });
    }
    public function reset(string $key): void
    {
        $this->store->runtimeUpdate('limits-' . $this->name, function ($all) use ($key) {
            $k = $this->key($key);
            if (!isset($all[$k])) return null;
            unset($all[$k]);
            return $all;
        });
    }
}

final class Accounts
{
    const SESSION_IDLE_MS = 30 * 86400000;
    const SESSION_MAX_MS = 180 * 86400000;
    const TOUCH_MS = 600000;
    private Store $store;
    private $audit;
    private $getConfig;
    public Limiter $ipLimiter, $accountLimiter, $registerLimiter;

    public function __construct(Store $store, callable $audit, callable $getConfig, int $registerPerHour = 20)
    {
        $this->store = $store;
        $this->audit = $audit;
        $this->getConfig = $getConfig;
        $this->ipLimiter = new Limiter($store, 'ip', 10, 900000, 900000);
        $this->accountLimiter = new Limiter($store, 'account', 5, 900000, 900000);
        $this->registerLimiter = new Limiter($store, 'register', $registerPerHour, 3600000, 3600000);
    }

    private function audit(string $type, array $data = []): void { ($this->audit)($type, $data); }
    public function usersDoc(): array { $d = $this->store->getData('users'); return is_array($d) ? $d : ['users' => []]; }
    public function allUsers(): array { return array_values($this->usersDoc()['users'] ?? []); }
    public function getUser($id): ?array { return is_string($id) ? ($this->usersDoc()['users'][$id] ?? null) : null; }
    public function findByNick($nick): ?array
    {
        $key = R::nickKey($nick);
        foreach ($this->allUsers() as $u) if ($u['nickKey'] === $key) return $u;
        return null;
    }

    public static function publicUser(?array $u): ?array
    {
        if (!$u) return null;
        return ['id' => $u['id'], 'nick' => $u['nick'], 'role' => $u['role'], 'status' => $u['status'], 'createdAt' => $u['createdAt'],
            'profile' => as_obj($u['profile'] ?? []), 'guest' => !empty($u['guest'])];
    }

    private function updateUsers(callable $fn): array
    {
        return $this->store->update('users', fn($doc) => $fn(is_array($doc) ? $doc : ['users' => []]));
    }

    private static function nickTaken(array $doc, string $key, ?string $exceptId = null): bool
    {
        foreach ($doc['users'] as $u) if ($u['nickKey'] === $key && $u['id'] !== $exceptId) return true;
        return false;
    }

    public function register(array $body, string $ip): array
    {
        $cfg = ($this->getConfig)();
        if (empty($cfg['registrationOpen'])) throw new AppError(403, 'Rejestracja jest wyłączona przez administratora', 'registration_closed');
        if ($this->registerLimiter->check($ip)) throw new AppError(429, 'Za dużo rejestracji z tego adresu – spróbuj później', 'rate');
        $nick = $body['nick'] ?? null;
        $pw = $body['password'] ?? null;
        $problem = R::nickProblem($nick) ?? Passwords::problem($pw, R::cleanNick($nick));
        if ($problem) throw new AppError(400, $problem, 'validation');
        $hash = Passwords::hash($pw);
        $id = rand_id('u');
        $clean = R::cleanNick($nick);
        $this->updateUsers(function ($doc) use ($id, $clean, $hash) {
            if (self::nickTaken($doc, R::nickKey($clean))) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
            $t = now_iso();
            $doc['users'][$id] = ['id' => $id, 'nick' => $clean, 'nickKey' => R::nickKey($clean), 'role' => 'player', 'status' => 'active', 'passwordHash' => $hash,
                'createdAt' => $t, 'updatedAt' => $t, 'passwordChangedAt' => $t, 'activation' => null, 'profile' => [], 'nickHistory' => []];
            return $doc;
        });
        $this->registerLimiter->fail($ip);
        $this->audit('user.register', ['userId' => $id, 'nick' => $clean]);
        return $this->getUser($id);
    }

    public function login(array $body, array $meta): array
    {
        $ip = $meta['ip'] ?? 'unknown';
        $nick = $body['nick'] ?? '';
        $pw = $body['password'] ?? '';
        $key = R::nickKey($nick);
        $wait = $this->ipLimiter->check($ip) ?: $this->accountLimiter->check($key);
        if ($wait) throw new AppError(429, 'Za dużo nieudanych prób. Spróbuj za ' . (int)ceil($wait / 60) . ' min.', 'rate', ['retryAfter' => $wait]);
        $user = $this->findByNick($nick);
        $ok = false;
        if ($user && $user['status'] === 'active' && $user['passwordHash']) $ok = Passwords::verify((string)$pw, $user['passwordHash']);
        else Passwords::dummyVerify($pw);
        if (!$ok) {
            $this->ipLimiter->fail($ip);
            $this->accountLimiter->fail($key);
            $this->audit('auth.fail', ['nickKey' => $key, 'ip' => $ip]);
            if ($user && $user['status'] === 'pending') throw new AppError(401, 'To konto nie jest jeszcze aktywne – użyj kodu aktywacyjnego', 'pending');
            throw new AppError(401, 'Zły nick lub hasło', 'bad_credentials');
        }
        $this->ipLimiter->reset($ip);
        $this->accountLimiter->reset($key);
        if (Passwords::needsRehash($user['passwordHash'])) {
            $h = Passwords::hash((string)$pw);
            $uid = $user['id'];
            $this->updateUsers(function ($doc) use ($uid, $h) { $doc['users'][$uid]['passwordHash'] = $h; return $doc; });
        }
        $s = $this->createSession($user['id'], $meta);
        $this->audit('auth.login', ['userId' => $user['id']]);
        return ['user' => $this->getUser($user['id'])] + $s;
    }

    public function createSession(string $userId, array $meta = []): array
    {
        $token = b64url(random_bytes(32));
        $t = ms_now();
        $s = ['id' => rand_id('s'), 'userId' => $userId, 'tokenHash' => sha256($token), 'csrf' => b64url(random_bytes(24)),
            'createdAt' => iso_from_ms($t), 'lastSeen' => iso_from_ms($t), 'expiresAt' => iso_from_ms($t + self::SESSION_IDLE_MS),
            'ua' => mb_substr((string)($meta['ua'] ?? ''), 0, 160)];
        $this->store->update('auth', function ($doc) use ($s, $t) {
            $doc = is_array($doc) ? $doc : ['sessions' => []];
            foreach ($doc['sessions'] as $id => $x) if ((iso_ms($x['expiresAt']) ?? 0) < $t) unset($doc['sessions'][$id]);
            $doc['sessions'][$s['id']] = $s;
            return $doc;
        });
        return ['token' => $token, 'session' => $s];
    }

    public function resolveToken($token): ?array
    {
        if (!is_string($token) || strlen($token) < 20 || strlen($token) > 100) return null;
        $th = sha256($token);
        $doc = $this->store->getData('auth');
        $s = null;
        foreach (($doc['sessions'] ?? []) as $x) if (hash_equals($x['tokenHash'], $th)) { $s = $x; break; }
        if (!$s) return null;
        $t = ms_now();
        if ((iso_ms($s['expiresAt']) ?? 0) < $t || (iso_ms($s['createdAt']) ?? 0) + self::SESSION_MAX_MS < $t) {
            $this->revokeSession($s['userId'], $s['id']);
            return null;
        }
        $user = $this->getUser($s['userId']);
        if (!$user || $user['status'] !== 'active') return null;
        if ($t - (iso_ms($s['lastSeen']) ?? 0) > self::TOUCH_MS) {
            $sid = $s['id'];
            try {
                $this->store->update('auth', function ($d) use ($sid) {
                    if (!isset($d['sessions'][$sid])) return null;
                    $x = &$d['sessions'][$sid];
                    $x['lastSeen'] = now_iso();
                    $x['expiresAt'] = iso_from_ms(min(ms_now() + self::SESSION_IDLE_MS, (iso_ms($x['createdAt']) ?? 0) + self::SESSION_MAX_MS));
                    unset($x);
                    return $d;
                });
            } catch (Throwable $e) { /* nieistotne */ }
        }
        return ['session' => $s, 'user' => $user];
    }

    public function listSessions(string $userId): array
    {
        $doc = $this->store->getData('auth') ?: ['sessions' => []];
        $out = [];
        foreach ($doc['sessions'] as $s) if ($s['userId'] === $userId) $out[] = ['id' => $s['id'], 'createdAt' => $s['createdAt'], 'lastSeen' => $s['lastSeen'], 'ua' => $s['ua'] ?? ''];
        return $out;
    }

    public function revokeSession(string $userId, string $sessionId): void
    {
        $this->store->update('auth', function ($doc) use ($userId, $sessionId) {
            if (!$doc || !isset($doc['sessions'][$sessionId]) || $doc['sessions'][$sessionId]['userId'] !== $userId) return null;
            unset($doc['sessions'][$sessionId]);
            return $doc;
        });
    }

    public function revokeAll(string $userId, ?string $except = null): void
    {
        $this->store->update('auth', function ($doc) use ($userId, $except) {
            if (!$doc) return null;
            $changed = false;
            foreach ($doc['sessions'] as $id => $s) if ($s['userId'] === $userId && $id !== $except) { unset($doc['sessions'][$id]); $changed = true; }
            return $changed ? $doc : null;
        });
    }

    public function changePassword(string $userId, $old, $new, string $currentSid): void
    {
        $user = $this->getUser($userId);
        if (!$user) throw new AppError(404, 'Brak konta');
        $key = 'pw:' . $userId;
        if ($this->accountLimiter->check($key)) throw new AppError(429, 'Za dużo prób – spróbuj później', 'rate');
        if (!Passwords::verify((string)($old ?? ''), $user['passwordHash'])) {
            $this->accountLimiter->fail($key);
            throw new AppError(403, 'Obecne hasło jest niepoprawne', 'bad_password');
        }
        $problem = Passwords::problem($new, $user['nick']);
        if ($problem) throw new AppError(400, $problem, 'validation');
        $h = Passwords::hash($new);
        $this->updateUsers(function ($doc) use ($userId, $h) {
            $doc['users'][$userId]['passwordHash'] = $h;
            $doc['users'][$userId]['passwordChangedAt'] = now_iso();
            $doc['users'][$userId]['updatedAt'] = now_iso();
            return $doc;
        });
        $this->revokeAll($userId, $currentSid);
        $this->audit('user.password', ['userId' => $userId]);
    }

    public function changeNick(string $userId, $nick, $password): array
    {
        $user = $this->getUser($userId);
        if (!$user) throw new AppError(404, 'Brak konta');
        if (!Passwords::verify((string)($password ?? ''), $user['passwordHash'])) throw new AppError(403, 'Hasło jest niepoprawne', 'bad_password');
        $problem = R::nickProblem($nick);
        if ($problem) throw new AppError(400, $problem, 'validation');
        $clean = R::cleanNick($nick);
        $taken = $this->findByNick($clean);
        if ($taken && $taken['id'] !== $userId) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
        $hist = $user['nickHistory'] ?? [];
        $last = $hist ? $hist[count($hist) - 1] : null;
        if ($last && ms_now() - (iso_ms($last['to']) ?? 0) < 24 * 3600000 && $user['role'] !== 'admin') {
            throw new AppError(429, 'Nick można zmieniać najwyżej raz na 24 godziny', 'rate');
        }
        $this->updateUsers(function ($doc) use ($userId, $clean) {
            $key = R::nickKey($clean);
            if (self::nickTaken($doc, $key, $userId)) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
            $u = &$doc['users'][$userId];
            if ($u['nick'] === $clean) return null;
            $u['nickHistory'] = array_slice(array_merge($u['nickHistory'] ?? [], [['nick' => $u['nick'], 'to' => now_iso()]]), -20);
            $u['nick'] = $clean;
            $u['nickKey'] = $key;
            $u['updatedAt'] = now_iso();
            unset($u);
            return $doc;
        });
        $this->audit('user.nick', ['userId' => $userId, 'nick' => $clean]);
        return $this->getUser($userId);
    }

    public function updateProfile(string $userId, array $profile): array
    {
        $color = $profile['color'] ?? null;
        if ($color !== null && (!is_string($color) || !preg_match('/^#[0-9a-fA-F]{6}$/', $color))) throw new AppError(400, 'Zły kolor');
        $this->updateUsers(function ($doc) use ($userId, $color) {
            $p = $doc['users'][$userId]['profile'] ?? [];
            if ($color !== null) $p['color'] = $color;
            $doc['users'][$userId]['profile'] = $p;
            $doc['users'][$userId]['updatedAt'] = now_iso();
            return $doc;
        });
        return $this->getUser($userId);
    }

    private static function normCode($c): string { return preg_replace('/[^A-Z0-9]/', '', strtoupper((string)($c ?? ''))); }

    public static function newActivationCode(): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $s = '';
        for ($i = 0; $i < 12; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        return substr($s, 0, 4) . '-' . substr($s, 4, 4) . '-' . substr($s, 8);
    }

    public function activate(array $body, array $meta): array
    {
        $ip = $meta['ip'] ?? 'unknown';
        if ($this->ipLimiter->check($ip)) throw new AppError(429, 'Za dużo prób – spróbuj później', 'rate');
        $user = $this->findByNick($body['nick'] ?? '');
        $valid = $user && !empty($user['activation']) && (iso_ms($user['activation']['expiresAt']) ?? 0) > ms_now()
            && hash_equals($user['activation']['codeHash'], sha256(self::normCode($body['code'] ?? '')));
        if (!$valid) {
            $this->ipLimiter->fail($ip);
            throw new AppError(400, 'Nieprawidłowy lub wygasły kod aktywacyjny', 'bad_code');
        }
        $pw = $body['password'] ?? null;
        $problem = Passwords::problem($pw, $user['nick']);
        if ($problem) throw new AppError(400, $problem, 'validation');
        $h = Passwords::hash($pw);
        $uid = $user['id'];
        $codeHash = $user['activation']['codeHash'];
        $this->updateUsers(function ($doc) use ($uid, $h, $codeHash) {
            $u = &$doc['users'][$uid];
            if (empty($u['activation']) || $u['activation']['codeHash'] !== $codeHash) throw new AppError(400, 'Kod został już użyty', 'bad_code');
            $u['passwordHash'] = $h; $u['status'] = 'active'; $u['activation'] = null; $u['guest'] = false;
            $u['passwordChangedAt'] = now_iso(); $u['updatedAt'] = now_iso();
            unset($u);
            return $doc;
        });
        $this->revokeAll($uid);
        $this->audit('user.activate', ['userId' => $uid]);
        $s = $this->createSession($uid, $meta);
        return ['user' => $this->getUser($uid)] + $s;
    }

    public function issueActivation(string $adminId, string $userId, string $purpose = 'activate'): array
    {
        $code = self::newActivationCode();
        $hours = $purpose === 'reset' ? 24 : 7 * 24;
        $this->updateUsers(function ($doc) use ($adminId, $userId, $purpose, $code, $hours) {
            if (!isset($doc['users'][$userId])) throw new AppError(404, 'Brak użytkownika');
            $u = &$doc['users'][$userId];
            if ($u['status'] === 'disabled') throw new AppError(400, 'Konto jest zablokowane');
            $u['activation'] = ['codeHash' => sha256(self::normCode($code)), 'expiresAt' => iso_from_ms(ms_now() + $hours * 3600000), 'purpose' => $purpose, 'issuedBy' => $adminId, 'issuedAt' => now_iso()];
            $u['updatedAt'] = now_iso();
            unset($u);
            return $doc;
        });
        $this->audit('admin.activation', ['adminId' => $adminId, 'userId' => $userId, 'purpose' => $purpose]);
        return ['code' => $code, 'expiresInHours' => $hours];
    }

    public function setRole(string $adminId, string $userId, $role): void
    {
        if (!in_array($role, ['admin', 'player'], true)) throw new AppError(400, 'Zła rola');
        $this->updateUsers(function ($doc) use ($userId, $role) {
            if (!isset($doc['users'][$userId])) throw new AppError(404, 'Brak użytkownika');
            $u = $doc['users'][$userId];
            if ($role === 'player' && $u['role'] === 'admin' && count(array_filter($doc['users'], fn($x) => $x['role'] === 'admin' && $x['status'] === 'active')) <= 1) {
                throw new AppError(400, 'Musi zostać co najmniej jeden administrator');
            }
            $doc['users'][$userId]['role'] = $role;
            $doc['users'][$userId]['updatedAt'] = now_iso();
            return $doc;
        });
        $this->audit('admin.role', ['adminId' => $adminId, 'userId' => $userId, 'role' => $role]);
    }

    public function setStatus(string $adminId, string $userId, $status): void
    {
        if (!in_array($status, ['active', 'disabled', 'pending'], true)) throw new AppError(400, 'Zły status');
        $this->updateUsers(function ($doc) use ($adminId, $userId, $status) {
            if (!isset($doc['users'][$userId])) throw new AppError(404, 'Brak użytkownika');
            if ($userId === $adminId) throw new AppError(400, 'Nie możesz zmienić statusu własnego konta');
            if ($status === 'active' && empty($doc['users'][$userId]['passwordHash'])) throw new AppError(400, 'Konto bez hasła aktywuje się kodem aktywacyjnym');
            $doc['users'][$userId]['status'] = $status;
            $doc['users'][$userId]['updatedAt'] = now_iso();
            return $doc;
        });
        if ($status === 'disabled') $this->revokeAll($userId);
        $this->audit('admin.status', ['adminId' => $adminId, 'userId' => $userId, 'status' => $status]);
    }

    public function createProfile(string $byUserId, $nick): array
    {
        $problem = R::nickProblem($nick);
        if ($problem) throw new AppError(400, $problem, 'validation');
        $clean = R::cleanNick($nick);
        $id = rand_id('u');
        $this->updateUsers(function ($doc) use ($id, $clean, $byUserId) {
            if (self::nickTaken($doc, R::nickKey($clean))) throw new AppError(409, 'Ten nick jest już zajęty', 'nick_taken');
            $t = now_iso();
            $doc['users'][$id] = ['id' => $id, 'nick' => $clean, 'nickKey' => R::nickKey($clean), 'role' => 'player', 'status' => 'pending', 'guest' => true,
                'passwordHash' => null, 'createdAt' => $t, 'updatedAt' => $t, 'activation' => null, 'profile' => [], 'nickHistory' => [], 'createdBy' => $byUserId];
            return $doc;
        });
        $this->audit('user.profile', ['byUserId' => $byUserId, 'userId' => $id, 'nick' => $clean]);
        return $this->getUser($id);
    }
}

<?php
// REST API Tysiąca (wersja PHP). Wszystkie żądania /api/* trafiają tu przez .htaccess.
// Każde uprawnienie sprawdzane po stronie serwera.
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
set_error_handler(function ($no, $str, $file, $line) {
    if (!(error_reporting() & $no)) return false;
    throw new ErrorException($str, 0, $no, $file, $line);
});

require __DIR__ . '/_app/bootstrap.php';

const COOKIE = 'tys_s';
const MAX_BODY = 1048576;
const MAX_IMPORT = 20 * 1048576;

function send_json(int $status, array $body, array $headers = []): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    foreach ($headers as $k => $v) header("$k: $v");
    echo jenc($body);
}

function is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
    if (($_SERVER['SERVER_PORT'] ?? '') === '443') return true;
    return strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function client_ip(array $cfg): string
{
    if ($cfg['trust_proxy'] && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) return trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function origin_allowed(array $cfg): bool
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') return true;
    if (in_array($origin, $cfg['allowed_origins'], true)) return true;
    $host = parse_url($origin, PHP_URL_HOST);
    $port = parse_url($origin, PHP_URL_PORT);
    return $host !== null && ($host . ($port ? ":$port" : '')) === ($_SERVER['HTTP_HOST'] ?? '');
}

function set_session_cookie(array $cfg, string $token, int $maxAge): void
{
    $secure = $cfg['cookie_secure'] ?? null;
    if ($secure === null) $secure = is_https();
    setcookie(COOKIE, $token, ['expires' => $maxAge > 0 ? time() + $maxAge : time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict', 'secure' => (bool)$secure]);
}

// ---------- aplikacja ----------
$cfg = app_config();
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');

try {
    $store = new Store($cfg['data_dir'], Schemas::validators());
} catch (Throwable $e) {
    send_json(500, ['ok' => false, 'error' => 'Brak dostępu do katalogu danych (_dane) – sprawdź uprawnienia (755 dla katalogu, właściciel = konto hostingu).']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$mutating = !in_array($method, ['GET', 'HEAD'], true);
$store->lock($mutating ? LOCK_EX : LOCK_SH);

$audit = function (string $type, array $data = []) use ($store) {
    $store->appendLine('audit/' . gmdate('Y-m') . '.jsonl', ['at' => now_iso(), 'type' => $type] + $data);
};
$getConfig = function () use ($store) {
    $c = $store->getData('config') ?: [];
    return array_merge(['registrationOpen' => true, 'defaultSettings' => []], $c);
};
if (!$store->get('config')) $store->update('config', fn() => ['registrationOpen' => true, 'defaultSettings' => R::DEFAULT_SETTINGS]);
if (!$store->get('meta')) $store->update('meta', fn() => ['schemaVersion' => 2, 'createdAt' => now_iso(), 'migrations' => []]);

$accounts = new Accounts($store, $audit, $getConfig, (int)$cfg['register_per_hour']);
$matches = new Matches($store, $accounts, $audit);
$rooms = new Rooms($store, $matches, $audit);
$matches->rooms = $rooms;

// ---------- trasy ----------
$routes = [];
$add = function (string $m, string $pattern, callable $h, array $opts = []) use (&$routes) {
    $keys = [];
    $re = '#^' . preg_replace_callback('/:([a-zA-Z]+)/', function ($x) use (&$keys) { $keys[] = $x[1]; return '([^/]+)'; }, $pattern) . '$#';
    $routes[] = ['method' => $m, 're' => $re, 'keys' => $keys, 'h' => $h, 'opts' => $opts + ['auth' => true, 'admin' => false, 'bodyLimit' => MAX_BODY]];
};
$admin = ['admin' => true];
$me = fn($ctx) => ['user' => Accounts::publicUser($ctx->user), 'csrf' => $ctx->session['csrf']];
$roomView = function (array $room, string $uid) use ($rooms) {
    $online = $rooms->presence($room['id']);
    return ['room' => $rooms->viewFor($room, $uid) + ['online' => $online], 'token' => ($room['updatedAt'] ?? '') . '|' . $room['seq'] . '|' . implode(',', $online)];
};

// --- konto ---
$add('GET', '/api/me', fn($ctx) => $ctx->user ? $me($ctx) : ['user' => null], ['auth' => false]);
$add('POST', '/api/auth/register', function ($ctx) use ($accounts, $cfg) {
    $u = $accounts->register($ctx->body, $ctx->ip);
    $s = $accounts->createSession($u['id'], ['ip' => $ctx->ip, 'ua' => $ctx->ua]);
    set_session_cookie($cfg, $s['token'], 30 * 86400);
    return ['user' => Accounts::publicUser($u), 'csrf' => $s['session']['csrf']];
}, ['auth' => false]);
$add('POST', '/api/auth/login', function ($ctx) use ($accounts, $cfg) {
    $r = $accounts->login($ctx->body, ['ip' => $ctx->ip, 'ua' => $ctx->ua]);
    set_session_cookie($cfg, $r['token'], 30 * 86400);
    return ['user' => Accounts::publicUser($r['user']), 'csrf' => $r['session']['csrf']];
}, ['auth' => false]);
$add('POST', '/api/auth/activate', function ($ctx) use ($accounts, $cfg) {
    $r = $accounts->activate($ctx->body, ['ip' => $ctx->ip, 'ua' => $ctx->ua]);
    set_session_cookie($cfg, $r['token'], 30 * 86400);
    return ['user' => Accounts::publicUser($r['user']), 'csrf' => $r['session']['csrf']];
}, ['auth' => false]);
$add('POST', '/api/auth/logout', function ($ctx) use ($accounts, $cfg) {
    $accounts->revokeSession($ctx->user['id'], $ctx->session['id']);
    set_session_cookie($cfg, '', 0);
    return [];
});
$add('POST', '/api/account/password', function ($ctx) use ($accounts) { $accounts->changePassword($ctx->user['id'], $ctx->body['old'] ?? null, $ctx->body['new'] ?? null, $ctx->session['id']); return []; });
$add('POST', '/api/account/nick', fn($ctx) => ['user' => Accounts::publicUser($accounts->changeNick($ctx->user['id'], $ctx->body['nick'] ?? null, $ctx->body['password'] ?? null))]);
$add('POST', '/api/account/profile', fn($ctx) => ['user' => Accounts::publicUser($accounts->updateProfile($ctx->user['id'], $ctx->body))]);
$add('GET', '/api/account/sessions', fn($ctx) => ['sessions' => array_map(fn($s) => $s + ['current' => $s['id'] === $ctx->session['id']], $accounts->listSessions($ctx->user['id']))]);
$add('POST', '/api/account/sessions/revoke', function ($ctx) use ($accounts) {
    if (!empty($ctx->body['all'])) $accounts->revokeAll($ctx->user['id'], $ctx->session['id']);
    else $accounts->revokeSession($ctx->user['id'], (string)($ctx->body['id'] ?? ''));
    return [];
});

// --- dane wspólne ---
$add('POST', '/api/users/profile', fn($ctx) => ['user' => Accounts::publicUser($accounts->createProfile($ctx->user['id'], $ctx->body['nick'] ?? null))]);
$add('GET', '/api/data', function ($ctx) use ($accounts, $matches, $rooms, $store, $cfg) {
    // Zadania okresowe (hosting nie ma stałego procesu): kopia dzienna, sprzątanie pokoi.
    try {
        Backup::dailyIfNeeded($store, (int)$cfg['backup_keep']);
        $sw = $store->runtimeRead('sweep', []);
        if (ms_now() - (int)($sw['at'] ?? 0) > 3600000) { $store->lock(LOCK_EX); $store->runtimeWrite('sweep', ['at' => ms_now()]); $rooms->sweep(); }
    } catch (Throwable $e) { error_log('Tysiąc: zadania okresowe: ' . $e->getMessage()); }
    $isAdmin = $ctx->user['role'] === 'admin';
    return [
        'users' => array_map([Accounts::class, 'publicUser'], $accounts->allUsers()),
        'matches' => array_map(fn($m) => Store::shape('matches/x', without($m, 'appliedOps')), $matches->list($isAdmin)),
        'meets' => $matches->meets(),
        'rooms' => $rooms->listForUser($ctx->user['id']),
        'settings' => R::normalizeSettings(($store->getData('config') ?: [])['defaultSettings'] ?? []),
        'serverTime' => now_iso(),
    ];
});

// --- mecze ---
$shapeM = fn($m) => Store::shape('matches/x', without($m, 'appliedOps'));
$mres = fn($r) => ['match' => $shapeM($r['match']), 'replay' => $r['replay']];
$add('POST', '/api/matches', fn($ctx) => ['match' => $shapeM($matches->create($ctx->user, $ctx->body))]);
$add('GET', '/api/matches/:id', fn($ctx) => ['match' => $shapeM($matches->get($ctx->params['id']))]);
$add('POST', '/api/matches/:id/rounds', fn($ctx) => $mres($matches->addRound($ctx->user, $ctx->params['id'], $ctx->body)));
$add('PUT', '/api/matches/:id/rounds/:rid', fn($ctx) => $mres($matches->editRound($ctx->user, $ctx->params['id'], $ctx->params['rid'], $ctx->body)));
$add('POST', '/api/matches/:id/undo', fn($ctx) => $mres($matches->undoLast($ctx->user, $ctx->params['id'], $ctx->body)));
$add('POST', '/api/matches/:id/status', function ($ctx) use ($matches, $mres) {
    if (($ctx->body['status'] ?? null) === 'deleted' && $ctx->user['role'] !== 'admin') {
        $m = $matches->get($ctx->params['id']);
        if (!in_array($ctx->user['id'], $m['seats'], true) && ($m['createdBy'] ?? null) !== $ctx->user['id']) throw new AppError(403, 'Brak uprawnień');
    }
    return $mres($matches->setStatus($ctx->user, $ctx->params['id'], $ctx->body));
});
$add('POST', '/api/meets', fn($ctx) => ['meet' => $matches->startMeet($ctx->user, $ctx->body['players'] ?? null)]);
$add('POST', '/api/meets/:id/close', fn($ctx) => ['meet' => $matches->closeMeet($ctx->user, $ctx->params['id'])]);

// --- pokoje i gra online ---
$add('POST', '/api/rooms', fn($ctx) => ['room' => $rooms->create($ctx->user, $ctx->body)]);
$add('POST', '/api/rooms/join', fn($ctx) => ['room' => $rooms->joinByCode($ctx->user, $ctx->body['code'] ?? null)]);
$add('GET', '/api/rooms/:id', function ($ctx) use ($rooms) {
    $r = $rooms->get($ctx->params['id']);
    if (!$rooms->canAccess($r, $ctx->user['id'])) throw new AppError(403, 'Najpierw dołącz do stołu kodem');
    return ['room' => $rooms->viewFor($r, $ctx->user['id']) + ['online' => $rooms->presence($r['id'])]];
});
// Czat stołu: wspólny dla wszystkich graczy przy stole.
$add('GET', '/api/rooms/:id/chat', function ($ctx) use ($rooms) {
    $r = $rooms->get($ctx->params['id']);
    if (!$rooms->canAccess($r, $ctx->user['id'])) throw new AppError(403, 'Najpierw dołącz do stołu kodem');
    return $rooms->chatSince($r['id'], max(0, (int)($_GET['since'] ?? 0)));
});
$add('POST', '/api/rooms/:id/chat', fn($ctx) => ['message' => $rooms->chatPost($ctx->user, $ctx->params['id'], $ctx->body['text'] ?? null), 'n' => $rooms->chatN($ctx->params['id'])]);
// Akcja gracza (zamiast wiadomości WebSocket „act”). Odpowiedź zawiera od razu nowy widok stołu.
$add('POST', '/api/rooms/:id/act', function ($ctx) use ($rooms, $roomView) {
    $id = $ctx->params['id'];
    try {
        $res = $rooms->act($ctx->user, $id, $ctx->body['action'] ?? null);
    } catch (AppError $e) {
        if (in_array($e->errCode, ['stale', 'turn'], true) && ($r = $rooms->find($id)) && $rooms->canAccess($r, $ctx->user['id'])) {
            $e->extra['room'] = $roomView($r, $ctx->user['id']);
        }
        throw $e;
    }
    $r = $rooms->find($id);
    $out = ['duplicate' => !empty($res['duplicate'])];
    if ($r && $rooms->canAccess($r, $ctx->user['id'])) $out += $roomView($r, $ctx->user['id']);
    else $out['closed'] = true;
    return $out;
});
// Odpytywanie: zmiany pokoi (z obecnością graczy) i lista zmienionych meczów.
$add('GET', '/api/poll', function ($ctx) use ($rooms, $store, $roomView) {
    $out = ['rooms' => new stdClass(), 'chat' => new stdClass()];
    $ch = $store->runtimeRead('changes', ['n' => 0, 'items' => []]);
    $n = (int)($ch['n'] ?? 0);
    $since = isset($_GET['n']) && $_GET['n'] !== '' ? (int)$_GET['n'] : null;
    if ($since !== null && $since < $n) {
        $ids = [];
        foreach ($ch['items'] as [$k, $id]) if ($k > $since) $ids[$id] = true;
        $out['matches'] = array_keys($ids);
    }
    $out['n'] = $n;
    $req = $_GET['r'] ?? [];
    if (!is_array($req)) $req = [$req];
    foreach (array_slice($req, 0, 5) as $item) {
        // r[]=<id>:<numer ostatniej znanej wiadomości czatu>:<token stanu>  (token zawiera datę z ':' – dlatego na końcu)
        $parts = explode(':', (string)$item, 3);
        $id = $parts[0];
        $chatKnown = isset($parts[1]) && $parts[1] !== '' ? (int)$parts[1] : null;
        $known = $parts[2] ?? '';
        $room = $rooms->find($id);
        if (!$room) { $out['rooms']->{$id} = ['closed' => true]; continue; }
        if (!$rooms->canAccess($room, $ctx->user['id'])) { $out['rooms']->{$id} = ['error' => 'Najpierw dołącz do stołu kodem']; continue; }
        // Minął czas na ruch – serwer zagrywa za gracza (każdy odpytujący przy stole może to wywołać).
        try { if ($rooms->autoMoveIfDue($id)) $room = $rooms->find($id); } catch (Throwable $e) { error_log('Tysiąc: auto-ruch: ' . $e->getMessage()); }
        if (!$room) { $out['rooms']->{$id} = ['closed' => true]; continue; }
        $rooms->touchPresence($id, $ctx->user['id']);
        $v = $roomView($room, $ctx->user['id']);
        if ($v['token'] !== $known) $out['rooms']->{$id} = $v;
        if ($chatKnown !== null && $chatKnown < $rooms->chatN($id)) $out['chat']->{$id} = $rooms->chatSince($id, $chatKnown);
    }
    return $out;
});

// --- eksport ---
$add('GET', '/api/export/json', function ($ctx) use ($accounts, $matches, $store) {
    $ctx->raw = ['type' => 'application/json; charset=utf-8', 'body' => jenc(Transfer::exportData($accounts, $matches, $store), JSON_PRETTY_PRINT), 'filename' => 'tysiac-eksport-' . gmdate('Y-m-d') . '.json'];
});
$add('GET', '/api/export/csv/:kind', function ($ctx) use ($accounts, $matches) {
    $kind = $ctx->params['kind'];
    $ctx->raw = ['type' => 'text/csv; charset=utf-8', 'body' => Transfer::exportCsv($kind, $accounts, $matches), 'filename' => 'tysiac-' . preg_replace('/[^a-z]/', '', $kind) . '-' . gmdate('Y-m-d') . '.csv'];
});

// --- administracja ---
$add('GET', '/api/admin/users', fn() => ['users' => array_map(fn($u) => Accounts::publicUser($u) + [
    'hasPassword' => !empty($u['passwordHash']),
    'activationPending' => !empty($u['activation']) && (iso_ms($u['activation']['expiresAt']) ?? 0) > ms_now(),
    'activationExpires' => $u['activation']['expiresAt'] ?? null,
    'nickHistory' => $u['nickHistory'] ?? [], 'legacy' => $u['legacy'] ?? null,
], $accounts->allUsers())], $admin);
$add('POST', '/api/admin/users/:id/activation', fn($ctx) => $accounts->issueActivation($ctx->user['id'], $ctx->params['id'], ($ctx->body['purpose'] ?? '') === 'reset' ? 'reset' : 'activate'), $admin);
$add('POST', '/api/admin/users/:id/role', function ($ctx) use ($accounts) { $accounts->setRole($ctx->user['id'], $ctx->params['id'], $ctx->body['role'] ?? null); return []; }, $admin);
$add('POST', '/api/admin/users/:id/status', function ($ctx) use ($accounts) { $accounts->setStatus($ctx->user['id'], $ctx->params['id'], $ctx->body['status'] ?? null); return []; }, $admin);
$add('GET', '/api/admin/config', fn() => ['config' => $getConfig()], $admin);
$add('POST', '/api/admin/config', function ($ctx) use ($store, $audit) {
    $b = $ctx->body;
    $next = $store->update('config', function ($c) use ($b) {
        $c = $c ?: ['registrationOpen' => true, 'defaultSettings' => []];
        if (isset($b['registrationOpen']) && is_bool($b['registrationOpen'])) $c['registrationOpen'] = $b['registrationOpen'];
        if (!empty($b['defaultSettings'])) { try { $c['defaultSettings'] = R::normalizeSettings($b['defaultSettings']); } catch (RuleError $e) { throw new AppError(400, $e->getMessage()); } }
        return $c;
    });
    $audit('admin.config', ['adminId' => $ctx->user['id']]);
    return ['config' => $next['data']];
}, $admin);
$add('GET', '/api/admin/backups', fn() => ['backups' => Backup::list($store)], $admin);
$add('POST', '/api/admin/backups', function ($ctx) use ($store, $audit) { $b = Backup::create($store, 'manual'); $audit('admin.backup', ['adminId' => $ctx->user['id'], 'name' => $b['name']]); return ['backup' => $b]; }, $admin);
$add('POST', '/api/admin/backups/download', function ($ctx) use ($store, $audit) {
    $bundle = !empty($ctx->body['name']) ? Backup::read($store, (string)$ctx->body['name']) : Backup::buildBundle($store);
    $enc = Backup::encrypt($bundle, (string)($ctx->body['passphrase'] ?? ''));
    $audit('admin.backup.download', ['adminId' => $ctx->user['id'], 'name' => $ctx->body['name'] ?? 'current']);
    $ctx->raw = ['type' => 'application/octet-stream', 'body' => $enc, 'filename' => 'tysiac-backup-' . gmdate('Y-m-d') . '.tysiac.enc'];
}, $admin);
$add('POST', '/api/admin/restore/preview', function ($ctx) use ($store) {
    $bundle = !empty($ctx->body['name']) ? Backup::read($store, (string)$ctx->body['name'])
        : Backup::decrypt((string)base64_decode((string)($ctx->body['file'] ?? '')), (string)($ctx->body['passphrase'] ?? ''));
    $files = array_keys((array)$bundle->files);
    $users = isset($bundle->files->users) ? count((array)$bundle->files->users->data->users) : 0;
    $tmp = $store->dir . '/runtime/restore-' . $ctx->user['id'] . '.json';
    if (!is_dir(dirname($tmp))) @mkdir(dirname($tmp), 0700, true);
    file_put_contents($tmp, json_encode(['expires' => ms_now() + 900000, 'bundle' => $bundle], JSON_FLAGS));
    return ['createdAt' => $bundle->createdAt, 'files' => count($files), 'matches' => count(array_filter($files, fn($f) => str_starts_with((string)$f, 'matches/'))), 'users' => $users];
}, ['admin' => true, 'bodyLimit' => MAX_IMPORT]);
$add('POST', '/api/admin/restore/apply', function ($ctx) use ($store, $audit) {
    $tmp = $store->dir . '/runtime/restore-' . $ctx->user['id'] . '.json';
    $p = is_file($tmp) ? json_decode((string)file_get_contents($tmp), false) : null;
    @unlink($tmp);
    if (!$p || $p->expires < ms_now()) throw new AppError(400, 'Podgląd przywracania wygasł');
    $r = Backup::restore($store, Backup::parse(json_encode($p->bundle, JSON_FLAGS)));
    $audit('admin.restore', ['adminId' => $ctx->user['id']] + $r);
    return $r;
}, $admin);
$add('POST', '/api/admin/import/preview', fn($ctx) => Transfer::preview($ctx->body['data'] ?? null, $accounts, $matches, $store), ['admin' => true, 'bodyLimit' => MAX_IMPORT]);
$add('POST', '/api/admin/import/apply', fn($ctx) => Transfer::apply($store, (string)($ctx->body['token'] ?? ''), $ctx->user['id'], $audit), $admin);
$add('POST', '/api/admin/import/cancel', fn($ctx) => ['cancelled' => Transfer::cancel($store, (string)($ctx->body['token'] ?? ''))], $admin);
$add('GET', '/api/admin/diagnostics', fn() => [
    'version' => APP_VERSION, 'php' => PHP_VERSION, 'argon2' => Passwords::hasArgon(), 'sodium' => function_exists('sodium_crypto_pwhash'),
    'memoryMB' => round(memory_get_peak_usage(true) / 1048576, 1), 'dataDir' => '…/' . basename($store->dir),
    'documents' => count($store->allNames()), 'integrityProblems' => $store->verifyAll(), 'recovered' => $store->recovered,
    'rooms' => $rooms->count(), 'realtime' => 'odpytywanie HTTP (bez WebSocket)', 'backups' => array_slice(Backup::list($store), 0, 5),
], $admin);
$add('POST', '/api/admin/rebuild-stats', function () use ($matches) {
    $list = $matches->list(true);
    $errors = [];
    foreach ($list as $m) { try { R::computeMatch($m); } catch (Throwable $e) { $errors[] = ['id' => $m['id'], 'error' => $e->getMessage()]; } }
    return ['matches' => count($list), 'errors' => $errors];
}, $admin);

// ---------- obsługa żądania ----------
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api.php')), '/');
if ($base !== '' && str_starts_with($path, $base . '/')) $path = substr($path, strlen($base));
$route = null;
$m = [];
foreach ($routes as $r) if ($r['method'] === $method && preg_match($r['re'], $path, $m)) { $route = $r; break; }
if (!$route) { send_json(404, ['ok' => false, 'error' => 'Nie ma takiego zasobu']); exit; }

$ctx = new stdClass();
$ctx->params = [];
foreach ($route['keys'] as $i => $k) $ctx->params[$k] = rawurldecode($m[$i + 1]);
$ctx->ip = client_ip($cfg);
$ctx->ua = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
$ctx->user = null;
$ctx->session = null;
$ctx->raw = null;
$ctx->body = [];

try {
    $auth = isset($_COOKIE[COOKIE]) ? $accounts->resolveToken($_COOKIE[COOKIE]) : null;
    if ($auth) { $ctx->user = $auth['user']; $ctx->session = $auth['session']; }
    if ($mutating) {
        if (!origin_allowed($cfg)) throw new AppError(403, 'Niedozwolone źródło żądania', 'origin');
        if (($_SERVER['HTTP_X_TYSIAC'] ?? '') !== '1') throw new AppError(403, 'Niedozwolone żądanie', 'csrf');
        if ($ctx->user && $route['opts']['auth'] && !hash_equals($ctx->session['csrf'], (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) throw new AppError(403, 'Sesja wygasła – odśwież stronę', 'csrf');
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $route['opts']['bodyLimit']) throw new AppError(413, 'Za duże dane', 'too_large');
        $raw = (string)file_get_contents('php://input', false, null, 0, $route['opts']['bodyLimit'] + 1);
        if (strlen($raw) > $route['opts']['bodyLimit']) throw new AppError(413, 'Za duże dane', 'too_large');
        $body = $raw === '' ? [] : json_decode($raw, true);
        if ($raw !== '' && json_last_error() !== JSON_ERROR_NONE) throw new AppError(400, 'Niepoprawny JSON');
        if (!is_array($body) || ($body && array_is_list($body))) throw new AppError(400, 'Niepoprawne dane');
        $ctx->body = $body;
    }
    if ($route['opts']['auth'] && !$ctx->user) throw new AppError(401, 'Zaloguj się', 'auth');
    if ($route['opts']['admin'] && $ctx->user['role'] !== 'admin') throw new AppError(403, 'Tylko dla administratora', 'forbidden');
    $result = ($route['h'])($ctx);
    if ($ctx->raw) {
        http_response_code(200);
        header('Content-Type: ' . $ctx->raw['type']);
        header('Cache-Control: no-store');
        header('Content-Disposition: attachment; filename="' . $ctx->raw['filename'] . '"');
        echo $ctx->raw['body'];
    } else {
        send_json(200, ['ok' => true] + ($result ?: []));
    }
} catch (ConflictError $e) {
    $cur = is_array($e->current) ? Store::shape('matches/x', without($e->current, 'appliedOps')) : null;
    send_json(409, ['ok' => false, 'error' => $e->getMessage(), 'code' => 'conflict', 'current' => $cur]);
} catch (AppError $e) {
    $hdr = isset($e->extra['retryAfter']) ? ['Retry-After' => (string)$e->extra['retryAfter']] : [];
    send_json($e->status, ['ok' => false, 'error' => $e->getMessage(), 'code' => $e->errCode] + without($e->extra, 'retryAfter'), $hdr);
} catch (ValidationError $e) {
    send_json(400, ['ok' => false, 'error' => $e->getMessage(), 'code' => 'validation']);
} catch (RuleError $e) {
    send_json(400, ['ok' => false, 'error' => $e->getMessage(), 'code' => 'rule']);
} catch (Throwable $e) {
    $id = bin2hex(random_bytes(4));
    error_log("Tysiąc [$id] $method $path: " . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    send_json(500, ['ok' => false, 'error' => "Błąd serwera ($id)"]);
} finally {
    $store->unlock();
}

<?php
// Logowanie: konta z users.php (skróty bcrypt), sesja w podpisanym ciasteczku (HMAC-SHA256).
// Zmiany haseł zapisują się w data/users.json; zmiana hasła unieważnia wszystkie stare sesje konta.

const AUTH_COOKIE = 'tys_auth';
const AUTH_DAYS = 180;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW = 900;   // 15 min – okno liczenia błędnych prób
const LOGIN_LOCK = 900;     // 15 min – blokada po przekroczeniu limitu
const MIN_PASSWORD = 8;

function auth_secret() {
    $file = DATA_DIR . '/secret.key';
    if (!file_exists($file)) {
        $tmp = $file . '.' . bin2hex(random_bytes(4));
        file_put_contents($tmp, bin2hex(random_bytes(32)));
        @chmod($tmp, 0600);
        // Jeśli dwa żądania utworzą klucz naraz, wygrywa pierwszy.
        if (!@link($tmp, $file)) { /* klucz już istnieje */ }
        @unlink($tmp);
    }
    return trim(file_get_contents($file));
}

// Konta: lista loginów z users.php, aktualne hasła/wersje z data/users.json (jeśli zmieniono hasło).
function auth_users() {
    $base = require __DIR__ . '/users.php';
    $over = [];
    $file = DATA_DIR . '/users.json';
    if (file_exists($file)) $over = json_decode(file_get_contents($file), true) ?: [];
    $users = [];
    foreach ($base as $login => $hash) {
        $login = strtolower($login);
        $users[$login] = ['hash' => $over[$login]['hash'] ?? $hash, 'ver' => (int)($over[$login]['ver'] ?? 1)];
    }
    return $users;
}

function auth_save_user($login, $hash, $ver) {
    $file = DATA_DIR . '/users.json';
    $fp = fopen($file, 'c+');
    flock($fp, LOCK_EX);
    $data = json_decode(stream_get_contents($fp), true) ?: [];
    $data[$login] = ['hash' => $hash, 'ver' => $ver];
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($data, JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    @chmod($file, 0600);
}

function is_https() {
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (($_SERVER['SERVER_PORT'] ?? '') == 443);
}

function b64url($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64url_dec($s) { return base64_decode(strtr($s, '-_', '+/')); }

function auth_set_cookie($value, $expires) {
    setcookie(AUTH_COOKIE, $value, [
        'expires' => $expires,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function auth_issue($login, $ver) {
    $exp = time() + AUTH_DAYS * 86400;
    $payload = $login . '|' . $ver . '|' . $exp;
    $sig = hash_hmac('sha256', $payload, auth_secret());
    auth_set_cookie(b64url($payload) . '.' . $sig, $exp);
}

// Zwraca login zalogowanego użytkownika albo null.
function auth_user() {
    $raw = $_COOKIE[AUTH_COOKIE] ?? '';
    if (!is_string($raw) || strpos($raw, '.') === false) return null;
    [$p, $sig] = explode('.', $raw, 2);
    $payload = b64url_dec($p);
    if ($payload === false || !hash_equals(hash_hmac('sha256', $payload, auth_secret()), $sig)) return null;
    $parts = explode('|', $payload);
    if (count($parts) !== 3) return null;
    [$login, $ver, $exp] = $parts;
    if ((int)$exp < time()) return null;
    $users = auth_users();
    if (!isset($users[$login]) || $users[$login]['ver'] !== (int)$ver) return null;
    return $login;
}

function require_auth() {
    $u = auth_user();
    if (!$u) fail(401, 'Zaloguj się');
    return $u;
}

// Ochrona przed CSRF: zapytania zmieniające dane muszą mieć własny nagłówek,
// którego inna strona nie może wysłać bez zgody (CORS), a ciasteczko ma SameSite=Strict.
function require_csrf() {
    if (($_SERVER['HTTP_X_TYSIAC'] ?? '') !== '1') fail(403, 'Niedozwolone żądanie');
}

// ---------- Limit prób logowania ----------
function client_ip() {
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function attempts_update(callable $fn) {
    $file = DATA_DIR . '/attempts.json';
    $fp = fopen($file, 'c+');
    flock($fp, LOCK_EX);
    $data = json_decode(stream_get_contents($fp), true) ?: [];
    $now = time();
    foreach ($data as $k => $v) if (($v['until'] ?? 0) < $now && ($v['first'] ?? 0) + LOGIN_WINDOW < $now) unset($data[$k]);
    $result = $fn($data, $now);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($data));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $result;
}

function login_locked_for() {
    $key = hash('sha256', client_ip());
    return attempts_update(function (&$data, $now) use ($key) {
        $u = $data[$key]['until'] ?? 0;
        return $u > $now ? $u - $now : 0;
    });
}

function login_failed() {
    $key = hash('sha256', client_ip());
    attempts_update(function (&$data, $now) use ($key) {
        $e = $data[$key] ?? ['n' => 0, 'first' => $now, 'until' => 0];
        if ($e['first'] + LOGIN_WINDOW < $now) $e = ['n' => 0, 'first' => $now, 'until' => 0];
        $e['n']++;
        if ($e['n'] >= LOGIN_MAX_FAILS) { $e['until'] = $now + LOGIN_LOCK; $e['n'] = 0; $e['first'] = $now; }
        $data[$key] = $e;
    });
}

function login_ok() {
    $key = hash('sha256', client_ip());
    attempts_update(function (&$data) use ($key) { unset($data[$key]); });
}

function auth_login($login, $password) {
    $wait = login_locked_for();
    if ($wait > 0) fail(429, 'Za dużo błędnych prób. Spróbuj za ' . ceil($wait / 60) . ' min.');
    $login = strtolower(trim((string)$login));
    $users = auth_users();
    // Jedno wspólne konto: wystarczy samo hasło.
    if ($login === '' && count($users) === 1) $login = array_key_first($users);
    // Sprawdzenie hasła trwa tyle samo, czy login istnieje, czy nie.
    $hash = $users[$login]['hash'] ?? '$2y$12$dGsJ6j8aPBW1ZC2bu5Vw4OpzGyKSl1FmbTDnXWRug2Y9.DRJvTysm';
    $ok = password_verify((string)$password, $hash) && isset($users[$login]);
    if (!$ok) {
        login_failed();
        usleep(400000);
        fail(401, count($users) === 1 ? 'Złe hasło' : 'Zły login lub hasło');
    }
    login_ok();
    if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
        auth_save_user($login, password_hash((string)$password, PASSWORD_DEFAULT), $users[$login]['ver']);
    }
    auth_issue($login, $users[$login]['ver']);
    return $login;
}

// Zmiana hasła do stołu wymaga hasła administratora (ADMIN_HASH w config.php).
function auth_change_password($login, $admin, $new) {
    $wait = login_locked_for();
    if ($wait > 0) fail(429, 'Za dużo błędnych prób. Spróbuj za ' . ceil($wait / 60) . ' min.');
    $users = auth_users();
    if (!defined('ADMIN_HASH') || !password_verify((string)$admin, ADMIN_HASH)) {
        login_failed();
        usleep(400000);
        fail(403, 'Złe hasło administratora');
    }
    login_ok();
    $new = (string)$new;
    if (mb_strlen($new) < MIN_PASSWORD) fail(400, 'Nowe hasło musi mieć co najmniej ' . MIN_PASSWORD . ' znaków');
    $ver = $users[$login]['ver'] + 1;
    auth_save_user($login, password_hash($new, PASSWORD_DEFAULT), $ver);
    auth_issue($login, $ver);
}

function auth_logout() {
    auth_set_cookie('', time() - 3600);
}

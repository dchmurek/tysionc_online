<?php
// Tysiąc – backend PHP (wersja do wrzucenia do public_html na hostingu współdzielonym, np. CyberFolks).
// Odpowiednik serwera Node.js: te same dane (pliki JSON z kopertą rev + SHA-256), te same API.
declare(strict_types=1);

const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS;
const APP_VERSION = '2.0.0-php';

// ---------- błędy ----------
class AppError extends Exception
{
    public int $status;
    public string $errCode;
    public array $extra;
    public function __construct(int $status, string $message, string $code = 'error', array $extra = [])
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errCode = $code;
        $this->extra = $extra;
    }
}
class ConflictError extends Exception
{
    public $current;
    public function __construct($current)
    {
        parent::__construct('Dane zmieniły się na innym urządzeniu – odśwież, aby zobaczyć aktualny stan');
        $this->current = $current;
    }
}
class ValidationError extends Exception {}
class IntegrityError extends Exception {}
class RuleError extends Exception
{
    public string $ruleCode;
    public function __construct(string $message, string $code = 'rule')
    {
        parent::__construct($message);
        $this->ruleCode = $code;
    }
}

// ---------- pomocnicze ----------
function now_iso(?float $t = null): string
{
    $t = $t ?? microtime(true);
    $s = (int)floor($t);
    $ms = (int)floor(($t - $s) * 1000);
    return gmdate('Y-m-d\TH:i:s', $s) . sprintf('.%03dZ', $ms);
}
function ms_now(): int { return (int)floor(microtime(true) * 1000); }
function iso_from_ms(int $ms): string { return now_iso($ms / 1000); }
function iso_ms($iso): ?int
{
    if (!is_string($iso) || $iso === '') return null;
    try { return (int)(new DateTimeImmutable($iso))->format('Uv'); } catch (Throwable $e) { return null; }
}
function b64url(string $b): string { return rtrim(strtr(base64_encode($b), '+/', '-_'), '='); }
function rand_id(string $p): string { return $p . preg_replace('/[^a-zA-Z0-9]/', 'x', b64url(random_bytes(9))); }
function rid(string $p): string { return $p . bin2hex(random_bytes(8)); }
function is_int_like($v): bool { return is_int($v) || (is_float($v) && is_finite($v) && floor($v) == $v); }
function jenc($v, int $extra = 0): string { return json_encode($v, JSON_FLAGS | JSON_THROW_ON_ERROR | $extra); }
function sha256(string $s): string { return hash('sha256', $s); }
function group_key_of(array $ids): string { $s = array_values($ids); sort($s, SORT_STRING); return implode('~', $s); }
function pair_key(string $a, string $b): string { return group_key_of([$a, $b]); }
// Obiekt JSON zamiast listy (np. {} albo {"0":70}) – zgodność kształtu danych z wersją Node.js.
function as_obj($a) { return is_array($a) ? (object)$a : $a; }
function without(array $a, string ...$keys): array { foreach ($keys as $k) unset($a[$k]); return $a; }

// ---------- konfiguracja ----------
function app_config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $user = [];
    $file = __DIR__ . '/config.php';
    if (is_file($file)) { $x = require $file; if (is_array($x)) $user = $x; }
    $root = dirname(__DIR__);
    $cfg = array_merge([
        'data_dir' => $root . '/_dane',
        'trust_proxy' => false,
        'allowed_origins' => [],
        'register_per_hour' => 20,
        'backup_keep' => 60,
        'cookie_secure' => null, // null = automatycznie (HTTPS)
    ], $user);
    return $cfg;
}

require __DIR__ . '/Store.php';
require __DIR__ . '/Rules.php';
require __DIR__ . '/Cards.php';
require __DIR__ . '/Schemas.php';
require __DIR__ . '/Accounts.php';
require __DIR__ . '/Matches.php';
require __DIR__ . '/Rooms.php';
require __DIR__ . '/Stats.php';
require __DIR__ . '/Backup.php';
require __DIR__ . '/Transfer.php';

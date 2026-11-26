<?php
// Kopie zapasowe całego magazynu: paczka JSON (gzip) z dokumentami i sumą kontrolną.
// Kopia do pobrania jest szyfrowana AES-256-GCM kluczem z hasła (Argon2id z libsodium albo PBKDF2).
declare(strict_types=1);

final class Backup
{
    const FORMAT = 'tysiac-backup';
    const VERSION = 2;
    const NAME_RE = '/^backup-[0-9TZ-]+(-[a-z0-9-]{1,40})?\.json\.gz$/';

    public static function dir(Store $s): string { return $s->dir . '/backups'; }

    // Paczka: dane dokumentów w postaci obiektów (zachowany kształt JSON → zgodna suma kontrolna).
    public static function buildBundle(Store $store): object
    {
        $files = new stdClass();
        foreach ($store->allNames() as $name) {
            $doc = $store->readFile($store->file($name));
            $files->{$name} = (object)['rev' => $doc['rev'], 'updatedAt' => $doc['updatedAt'], 'data' => $doc['raw']];
        }
        return (object)['format' => self::FORMAT, 'version' => self::VERSION, 'createdAt' => now_iso(), 'files' => $files, 'sha256' => sha256(json_encode($files, JSON_FLAGS))];
    }

    public static function create(Store $store, string $label = 'manual'): array
    {
        $bundle = self::buildBundle($store);
        $dir = self::dir($store);
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        $stamp = str_replace([':', '.'], '-', now_iso());
        $safe = substr(preg_replace('/[^a-z0-9-]/', '-', strtolower($label)), 0, 40);
        $name = "backup-$stamp-$safe.json.gz";
        $tmp = $dir . '/' . $name . '.tmp-' . getmypid();
        if (@file_put_contents($tmp, gzencode(json_encode($bundle, JSON_FLAGS), 6)) === false) throw new RuntimeException('Nie można zapisać kopii');
        @chmod($tmp, 0600);
        rename($tmp, $dir . '/' . $name);
        return ['name' => $name, 'files' => count((array)$bundle->files), 'createdAt' => $bundle->createdAt];
    }

    public static function list(Store $store): array
    {
        $out = [];
        foreach (scandir(self::dir($store)) ?: [] as $f) {
            if (!preg_match(self::NAME_RE, $f)) continue;
            $p = self::dir($store) . '/' . $f;
            $out[] = ['name' => $f, 'size' => filesize($p), 'createdAt' => now_iso((float)filemtime($p))];
        }
        usort($out, fn($a, $b) => strcmp($b['name'], $a['name']));
        return $out;
    }

    public static function read(Store $store, string $name): object
    {
        if (!preg_match(self::NAME_RE, $name)) throw new AppError(400, 'Zła nazwa kopii');
        $raw = @file_get_contents(self::dir($store) . '/' . $name);
        if ($raw === false) throw new AppError(404, 'Nie ma takiej kopii');
        return self::parse((string)@gzdecode($raw));
    }

    public static function parse(string $json): object
    {
        $b = json_decode($json, false);
        if (!is_object($b) || ($b->format ?? null) !== self::FORMAT) throw new AppError(400, 'To nie jest kopia zapasowa Tysiąca');
        if (($b->version ?? 0) > self::VERSION) throw new AppError(400, 'Kopia pochodzi z nowszej wersji aplikacji');
        if (($b->sha256 ?? '') !== sha256(json_encode($b->files, JSON_FLAGS))) throw new AppError(400, 'Kopia jest uszkodzona (zła suma kontrolna)');
        return $b;
    }

    public static function rotate(Store $store, int $keep = 60): void
    {
        $auto = array_values(array_filter(self::list($store), fn($b) => str_contains($b['name'], '-daily')));
        foreach (array_slice($auto, $keep) as $b) @unlink(self::dir($store) . '/' . $b['name']);
    }

    // Kopia dzienna – sprawdzana przy zwykłych żądaniach (hosting nie ma stałego procesu).
    public static function dailyIfNeeded(Store $store, int $keep): void
    {
        $today = gmdate('Y-m-d');
        if (($store->runtimeRead('daily', [])['day'] ?? '') === $today) return;
        $store->lock(LOCK_EX);
        if (($store->runtimeRead('daily', [])['day'] ?? '') === $today) return;
        try {
            if ($store->allNames()) self::create($store, 'daily');
            self::rotate($store, $keep);
        } finally {
            $store->runtimeWrite('daily', ['day' => $today]);
        }
    }

    public static function restore(Store $store, object $bundle): array
    {
        $files = [];
        foreach ((array)$bundle->files as $name => $doc) {
            $data = json_decode(json_encode($doc->data, JSON_FLAGS), true);
            $v = Schemas::validators();
            $prefix = str_contains($name, '/') ? explode('/', $name)[0] . '/' : $name;
            if (isset($v[$prefix])) $v[$prefix]($data, $name);
            if (!preg_match(Store::NAME_RE, (string)$name)) throw new AppError(400, 'Zła nazwa dokumentu w kopii');
            $files[$name] = ['rev' => (int)($doc->rev ?? 0), 'data' => $data];
        }
        $pre = self::create($store, 'pre-restore');
        $store->lock(LOCK_EX);
        foreach ($store->allNames() as $name) {
            if (!isset($files[$name]) && $name !== 'meta') { @unlink($store->file($name)); @unlink($store->file($name) . '.prev'); }
        }
        foreach ($files as $name => $d) $store->writeRaw($name, $d['rev'] + 1, $d['data']);
        $store->dropCache();
        return ['restored' => count($files), 'preRestoreBackup' => $pre['name']];
    }

    private static function deriveKey(string $pass, string $salt, string $kdf): string
    {
        if ($kdf === 'argon2id-sodium') {
            return sodium_crypto_pwhash(32, $pass, $salt, SODIUM_CRYPTO_PWHASH_OPSLIMIT_MODERATE, SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE * 2, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
        }
        if ($kdf === 'pbkdf2-sha256-600000') return hash_pbkdf2('sha256', $pass, $salt, 600000, 32, true);
        throw new AppError(400, 'Nieobsługiwany format szyfrowania kopii');
    }

    public static function encrypt(object $bundle, $pass): string
    {
        if (!is_string($pass) || mb_strlen($pass) < 12) throw new AppError(400, 'Hasło do kopii musi mieć co najmniej 12 znaków');
        $kdf = function_exists('sodium_crypto_pwhash') ? 'argon2id-sodium' : 'pbkdf2-sha256-600000';
        $salt = random_bytes(16);
        $iv = random_bytes(12);
        $key = self::deriveKey($pass, $salt, $kdf);
        $tag = '';
        $enc = openssl_encrypt(gzencode(json_encode($bundle, JSON_FLAGS), 6), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($enc === false) throw new RuntimeException('Szyfrowanie nieudane');
        return jenc(['format' => 'tysiac-backup-enc', 'v' => 2, 'kdf' => $kdf, 'salt' => base64_encode($salt), 'iv' => base64_encode($iv), 'tag' => base64_encode($tag), 'data' => base64_encode($enc)]);
    }

    public static function decrypt(string $raw, $pass): object
    {
        $env = json_decode($raw, true);
        if (!is_array($env) || ($env['format'] ?? null) !== 'tysiac-backup-enc') throw new AppError(400, 'To nie jest zaszyfrowana kopia');
        if (($env['v'] ?? 1) < 2) throw new AppError(400, 'Kopia z wersji Node.js (szyfrowanie scrypt) – przywróć ją w wersji Node.js albo użyj kopii .json.gz');
        $key = self::deriveKey((string)$pass, base64_decode($env['salt']), (string)$env['kdf']);
        $plain = openssl_decrypt(base64_decode($env['data']), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, base64_decode($env['iv']), base64_decode($env['tag']));
        if ($plain === false) throw new AppError(400, 'Złe hasło albo uszkodzony plik kopii');
        return self::parse((string)gzdecode($plain));
    }
}

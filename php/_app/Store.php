<?php
// Magazyn dokumentów JSON: atomowy zapis (tmp + fsync + rename), wersje (rev), suma SHA-256,
// kopia poprzedniej wersji (.prev) i odzyskiwanie. PHP działa w wielu procesach naraz,
// dlatego każde żądanie bierze blokadę pliku .lock: odczyt = współdzielona, zapis = wyłączna.
declare(strict_types=1);

final class Store
{
    public string $dir;
    public array $recovered = [];
    private $lockFp = null;
    private int $lockMode = 0;
    private array $cache = [];
    private array $validators;
    const NAME_RE = '/^[a-z0-9_-]+(\/[a-zA-Z0-9_-]+)?$/';
    const SKIP_DIRS = ['backups', 'audit', 'logs', 'migrations', 'runtime'];

    public function __construct(string $dir, array $validators = [])
    {
        $this->dir = rtrim($dir, '/');
        $this->validators = $validators;
        if (!is_dir($this->dir) && !@mkdir($this->dir, 0700, true)) {
            throw new RuntimeException('Nie można utworzyć katalogu danych');
        }
        $this->protectDir($this->dir);
    }

    // Ochrona katalogu danych w public_html (Apache/LiteSpeed): brak dostępu z internetu.
    private function protectDir(string $dir): void
    {
        $ht = $dir . '/.htaccess';
        if (!is_file($ht)) @file_put_contents($ht, "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
        $ix = $dir . '/index.html';
        if (!is_file($ix)) @file_put_contents($ix, '');
    }

    public function lock(int $mode): void
    {
        if ($this->lockMode === LOCK_EX || $this->lockMode === $mode) return;
        if (!$this->lockFp) $this->lockFp = fopen($this->dir . '/.lock', 'c');
        if (!$this->lockFp || !flock($this->lockFp, $mode)) throw new RuntimeException('Nie można zablokować magazynu');
        // Przejście SH → EX nie jest atomowe – ktoś mógł w międzyczasie zapisać: czytamy od nowa.
        if ($mode === LOCK_EX && $this->lockMode === LOCK_SH) $this->cache = [];
        $this->lockMode = $mode;
    }

    public function unlock(): void
    {
        if ($this->lockFp) { flock($this->lockFp, LOCK_UN); fclose($this->lockFp); }
        $this->lockFp = null;
        $this->lockMode = 0;
    }

    public function file(string $name): string
    {
        if (!preg_match(self::NAME_RE, $name)) throw new RuntimeException('Niepoprawna nazwa dokumentu: ' . $name);
        return $this->dir . '/' . $name . '.json';
    }

    private function validatorFor(string $name): ?callable
    {
        $prefix = str_contains($name, '/') ? explode('/', $name)[0] . '/' : $name;
        return $this->validators[$prefix] ?? null;
    }

    // Odczyt koperty z weryfikacją sumy (suma liczona tak jak JSON.stringify w JS).
    public function readFile(string $file): array
    {
        $raw = @file_get_contents($file);
        if ($raw === false) throw new IntegrityError('ENOENT');
        $obj = json_decode($raw, false);
        if (!is_object($obj) || !isset($obj->_meta) || !property_exists($obj, 'data')) throw new IntegrityError('Brak koperty dokumentu');
        if (($obj->_meta->sha256 ?? '') !== sha256(json_encode($obj->data, JSON_FLAGS))) throw new IntegrityError('Niezgodna suma kontrolna');
        $env = json_decode($raw, true);
        return ['rev' => (int)$obj->_meta->rev, 'updatedAt' => $obj->_meta->updatedAt ?? null, 'data' => $env['data'], 'raw' => $obj->data];
    }

    private function load(string $name): ?array
    {
        if (array_key_exists($name, $this->cache)) return $this->cache[$name];
        $file = $this->file($name);
        $doc = null;
        if (is_file($file)) {
            try {
                $doc = $this->readFile($file);
            } catch (IntegrityError $e) {
                try {
                    $doc = $this->readFile($file . '.prev');
                    $this->lock(LOCK_EX);
                    $this->writeFile($name, $doc['rev'], $doc['data'], $doc['updatedAt']);
                    $this->recovered[] = "odtworzono $name z poprzedniej wersji";
                } catch (IntegrityError $e2) {
                    throw new IntegrityError("Dokument $name jest uszkodzony i nie ma poprawnej kopii – przywróć backup");
                }
            }
        }
        if ($doc) unset($doc['raw']);
        $this->cache[$name] = $doc;
        return $doc;
    }

    // Kształt danych identyczny z wersją Node.js (obiekty zamiast pustych list itp.).
    public static function shape(string $name, $data)
    {
        if (!is_array($data)) return $data;
        $fixRound = function ($r) {
            foreach (['cards', 'melds', 'tricksWon'] as $k) if (isset($r[$k]) && is_array($r[$k])) $r[$k] = as_obj($r[$k]);
            if (isset($r['history']) && is_array($r['history'])) {
                foreach ($r['history'] as $i => $h) {
                    if (isset($h['before']['cards']) && is_array($h['before']['cards'])) $r['history'][$i]['before']['cards'] = as_obj($h['before']['cards']);
                    if (isset($h['before']['melds']) && is_array($h['before']['melds'])) $r['history'][$i]['before']['melds'] = as_obj($h['before']['melds']);
                }
            }
            return $r;
        };
        if ($name === 'users') {
            foreach ($data['users'] as $id => $u) if (isset($u['profile']) && is_array($u['profile'])) $data['users'][$id]['profile'] = as_obj($u['profile']);
            $data['users'] = as_obj($data['users']);
        } elseif ($name === 'auth') {
            $data['sessions'] = as_obj($data['sessions'] ?? []);
        } elseif ($name === 'meets') {
            $data['meets'] = as_obj($data['meets'] ?? []);
        } elseif ($name === 'config') {
            $data['defaultSettings'] = as_obj($data['defaultSettings'] ?? []);
        } elseif (str_starts_with($name, 'matches/')) {
            foreach (['rounds', 'removedRounds'] as $k) if (isset($data[$k])) foreach ($data[$k] as $i => $r) $data[$k][$i] = $fixRound($r);
            if (isset($data['settings'])) $data['settings'] = as_obj($data['settings']);
        }
        return $data;
    }

    private function writeFile(string $name, int $rev, $data, ?string $updatedAt = null): array
    {
        $file = $this->file($name);
        $updatedAt = $updatedAt ?: now_iso();
        $shaped = self::shape($name, $data);
        $body = jenc($shaped);
        $text = jenc(['_meta' => ['rev' => $rev, 'updatedAt' => $updatedAt, 'sha256' => sha256($body)], 'data' => $shaped], JSON_PRETTY_PRINT);
        $dir = dirname($file);
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        $tmp = $file . '.tmp-' . getmypid() . '-' . bin2hex(random_bytes(4));
        $fh = fopen($tmp, 'wb');
        if (!$fh) throw new RuntimeException('Nie można zapisać danych (uprawnienia katalogu _dane?)');
        fwrite($fh, $text);
        fflush($fh);
        if (function_exists('fsync')) @fsync($fh);
        fclose($fh);
        @chmod($tmp, 0600);
        if (is_file($file)) @copy($file, $file . '.prev');
        if (!@rename($tmp, $file)) { @unlink($tmp); throw new RuntimeException('Nie można zapisać danych'); }
        // Dane w pamięci podręcznej – postać po dekodowaniu (tak jak przy odczycie z dysku).
        $doc = ['rev' => $rev, 'updatedAt' => $updatedAt, 'data' => json_decode($body, true)];
        $this->cache[$name] = $doc;
        return $doc;
    }

    public function get(string $name): ?array { return $this->load($name); }

    public function getData(string $name, $fallback = null)
    {
        $d = $this->load($name);
        return $d ? $d['data'] : $fallback;
    }

    // fn($data|null, $rev) zwraca nowe dane albo null (= bez zapisu).
    public function update(string $name, callable $fn, ?int $expectRev = null): array
    {
        $this->lock(LOCK_EX);
        $cur = $this->load($name);
        $curRev = $cur ? $cur['rev'] : 0;
        if ($expectRev !== null && $expectRev !== $curRev) throw new ConflictError($cur ? $cur['data'] : null);
        $next = $fn($cur ? $cur['data'] : null, $curRev);
        if ($next === null) return ['rev' => $curRev, 'data' => $cur ? $cur['data'] : null, 'changed' => false];
        $v = $this->validatorFor($name);
        if ($v) $v(json_decode(jenc(self::shape($name, $next)), true), $name);
        $doc = $this->writeFile($name, $curRev + 1, $next);
        return ['rev' => $doc['rev'], 'data' => $doc['data'], 'changed' => true];
    }

    public function writeRaw(string $name, int $rev, $data, ?string $updatedAt = null): void
    {
        $this->lock(LOCK_EX);
        $this->writeFile($name, $rev, $data, $updatedAt);
    }

    public function list(string $prefix): array
    {
        $out = [];
        foreach (glob($this->dir . '/' . $prefix . '/*.json') ?: [] as $f) $out[] = $prefix . '/' . basename($f, '.json');
        sort($out, SORT_STRING);
        return $out;
    }

    public function remove(string $name, bool $keepPrev = true): void
    {
        $this->lock(LOCK_EX);
        $file = $this->file($name);
        if ($keepPrev) { if (is_file($file)) @copy($file, $file . '.prev'); }
        else @unlink($file . '.prev');
        @unlink($file);
        unset($this->cache[$name]);
    }

    public function allNames(): array
    {
        $out = [];
        foreach (scandir($this->dir) ?: [] as $e) {
            if ($e[0] === '.') continue;
            $p = $this->dir . '/' . $e;
            if (is_dir($p)) {
                if (in_array($e, self::SKIP_DIRS, true)) continue;
                foreach (glob($p . '/*.json') ?: [] as $f) $out[] = $e . '/' . basename($f, '.json');
            } elseif (str_ends_with($e, '.json')) {
                $out[] = substr($e, 0, -5);
            }
        }
        sort($out, SORT_STRING);
        return $out;
    }

    public function verifyAll(): array
    {
        $problems = [];
        foreach ($this->allNames() as $name) {
            try {
                $doc = $this->readFile($this->file($name));
                $v = $this->validatorFor($name);
                if ($v) $v($doc['data'], $name);
            } catch (Throwable $e) {
                $problems[] = ['name' => $name, 'error' => $e->getMessage()];
            }
        }
        return $problems;
    }

    public function dropCache(): void { $this->cache = []; }

    public function appendLine(string $rel, $obj): void
    {
        $file = $this->dir . '/' . $rel;
        $dir = dirname($file);
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        @file_put_contents($file, jenc($obj) . "\n", FILE_APPEND | LOCK_EX);
    }

    // Małe pliki pomocnicze (limity prób, obecność przy stole, dziennik zmian) – poza kopiami zapasowymi.
    public function runtimeRead(string $key, $fallback = [])
    {
        $f = $this->dir . '/runtime/' . $key . '.json';
        if (!is_file($f)) return $fallback;
        $d = json_decode((string)@file_get_contents($f), true);
        return is_array($d) ? $d : $fallback;
    }

    public function runtimeWrite(string $key, $data): void
    {
        $dir = $this->dir . '/runtime';
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        $f = $dir . '/' . $key . '.json';
        $tmp = $f . '.tmp-' . getmypid();
        if (@file_put_contents($tmp, jenc($data)) !== false) @rename($tmp, $f);
    }

    // Zmiana pliku runtime pod własną blokadą (np. obecność przy stole przy blokadzie współdzielonej).
    public function runtimeUpdate(string $key, callable $fn)
    {
        $dir = $this->dir . '/runtime';
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        $fp = fopen($dir . '/' . $key . '.lock', 'c');
        flock($fp, LOCK_EX);
        try {
            $cur = $this->runtimeRead($key, []);
            $next = $fn($cur);
            if ($next !== null) $this->runtimeWrite($key, $next);
            return $next ?? $cur;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }
}

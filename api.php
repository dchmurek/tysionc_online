<?php
// Prosty backend: wszystkie dane trzymane w data/db.json (bez bazy danych).
// Każdy zapis robi blokadę pliku, a raz dziennie kopię zapasową w data/backups/.

require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

const DATA_DIR = __DIR__ . '/data';
const DB_FILE = DATA_DIR . '/db.json';
const BACKUP_DIR = DATA_DIR . '/backups';

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

function ensure_dirs() {
    foreach ([DATA_DIR, BACKUP_DIR] as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
            fail(500, 'Nie mogę utworzyć katalogu ' . basename($dir) . ' – sprawdź uprawnienia (755).');
        }
    }
    // Blokada dostępu do plików z danymi z przeglądarki.
    $ht = DATA_DIR . '/.htaccess';
    if (!file_exists($ht)) {
        @file_put_contents($ht, "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
    }
    if (!file_exists(DATA_DIR . '/index.html')) {
        @file_put_contents(DATA_DIR . '/index.html', '');
    }
}

function empty_db() {
    return ['version' => 1, 'players' => [], 'games' => []];
}

function decode_db($raw) {
    if ($raw === '' || $raw === false) return empty_db();
    $db = json_decode($raw, true);
    if (!is_array($db)) fail(500, 'Plik db.json jest uszkodzony – przywróć kopię z data/backups.');
    $db += empty_db();
    return $db;
}

function read_db() {
    if (!file_exists(DB_FILE)) return empty_db();
    $fp = fopen(DB_FILE, 'r');
    if (!$fp) fail(500, 'Nie mogę odczytać db.json');
    flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return decode_db($raw);
}

// Otwiera bazę z wyłączną blokadą, przekazuje ją do $fn i zapisuje wynik.
function modify_db(callable $fn) {
    $fp = fopen(DB_FILE, 'c+');
    if (!$fp) fail(500, 'Nie mogę zapisać db.json – sprawdź uprawnienia katalogu data.');
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $db = decode_db($raw);
    backup_daily($raw);

    $db = $fn($db);

    $json = json_encode($db, JSON_UNESCAPED_UNICODE);
    if ($json === false) fail(500, 'Błąd kodowania JSON');
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, $json);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $db;
}

function backup_daily($raw) {
    if ($raw === '' || $raw === false) return;
    $file = BACKUP_DIR . '/db-' . date('Y-m-d') . '.json';
    if (file_exists($file)) return;
    @file_put_contents($file, $raw);
    $all = glob(BACKUP_DIR . '/db-*.json');
    sort($all);
    while (count($all) > BACKUP_DAYS) @unlink(array_shift($all));
}

function body() {
    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) fail(400, 'Niepoprawne dane');
    return $data;
}

function valid_id($id) {
    return is_string($id) && preg_match('/^[a-zA-Z0-9_-]{1,40}$/', $id);
}

function merge_players(array $db, $players) {
    if (!is_array($players)) return $db;
    $byId = [];
    foreach ($db['players'] as $i => $p) $byId[$p['id']] = $i;
    foreach ($players as $p) {
        if (!is_array($p) || !valid_id($p['id'] ?? null)) continue;
        $name = mb_substr(trim((string)($p['name'] ?? '')), 0, 30);
        if ($name === '') continue;
        $clean = ['id' => $p['id'], 'name' => $name, 'created' => $p['created'] ?? date('c')];
        // Usunięty gracz znika z list i statystyk, ale zostaje w historii rozegranych gier.
        if (!empty($p['deleted'])) $clean['deleted'] = true;
        if (isset($byId[$p['id']])) {
            $i = $byId[$p['id']];
            $db['players'][$i]['name'] = $name;
            if (array_key_exists('deleted', $p)) {
                if (!empty($p['deleted'])) $db['players'][$i]['deleted'] = true;
                else unset($db['players'][$i]['deleted']);
            }
        } else {
            $db['players'][] = $clean;
        }
    }
    return $db;
}

require __DIR__ . '/auth.php';

ensure_dirs();
$action = $_GET['action'] ?? 'load';
if ($_SERVER['REQUEST_METHOD'] === 'POST') require_csrf();

switch ($action) {
    case 'me':
        echo json_encode(['ok' => true, 'user' => auth_user()]);
        break;

    case 'login':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST');
        $in = body();
        $user = auth_login($in['user'] ?? '', $in['password'] ?? '');
        echo json_encode(['ok' => true, 'user' => $user]);
        break;

    case 'logout':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST');
        auth_logout();
        echo json_encode(['ok' => true]);
        break;

    case 'changePassword':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST');
        $user = require_auth();
        $in = body();
        auth_change_password($user, $in['admin'] ?? '', $in['new'] ?? '');
        echo json_encode(['ok' => true]);
        break;

    case 'load':
        $user = require_auth();
        echo json_encode(['ok' => true, 'user' => $user, 'db' => read_db()], JSON_UNESCAPED_UNICODE);
        break;

    case 'saveGame':
        $user = require_auth();
        $in = body();
        $game = $in['game'] ?? null;
        if (!is_array($game) || !valid_id($game['id'] ?? null)) fail(400, 'Brak gry');
        $game['updated'] = date('c');
        $game['updatedBy'] = $user;
        modify_db(function ($db) use ($in, $game) {
            $db = merge_players($db, $in['players'] ?? []);
            $found = false;
            foreach ($db['games'] as $i => $g) {
                if ($g['id'] === $game['id']) { $db['games'][$i] = $game; $found = true; break; }
            }
            if (!$found) $db['games'][] = $game;
            return $db;
        });
        echo json_encode(['ok' => true, 'updated' => $game['updated'] ?? null]);
        break;

    case 'savePlayers':
        require_auth();
        $in = body();
        modify_db(fn($db) => merge_players($db, $in['players'] ?? []));
        echo json_encode(['ok' => true]);
        break;

    case 'deleteGame':
        require_auth();
        $in = body();
        $id = $in['id'] ?? null;
        if (!valid_id($id)) fail(400, 'Brak id');
        modify_db(function ($db) use ($id) {
            $db['games'] = array_values(array_filter($db['games'], fn($g) => $g['id'] !== $id));
            return $db;
        });
        echo json_encode(['ok' => true]);
        break;

    case 'export':
        require_auth();
        header('Content-Disposition: attachment; filename="tysiac-' . date('Y-m-d') . '.json"');
        echo json_encode(read_db(), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        break;

    default:
        fail(404, 'Nieznana akcja');
}

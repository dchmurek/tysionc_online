<?php
// Testy backendu PHP (silnik kart, stoły, czat, czas na ruch). Uruchomienie: php tests/php/run.php
// Działa na tymczasowym katalogu danych – nigdy na prawdziwych danych.
declare(strict_types=1);
error_reporting(E_ALL);
set_error_handler(function ($no, $str, $file, $line) { throw new ErrorException($str, 0, $no, $file, $line); });

require __DIR__ . '/../../php/_app/bootstrap.php';

$tests = [];
function test(string $name, callable $fn): void { global $tests; $tests[] = [$name, $fn]; }
function ok($cond, string $msg = 'warunek niespełniony'): void { if (!$cond) throw new Exception($msg); }
function eq($a, $b, string $msg = ''): void
{
    if ($a !== $b) throw new Exception(($msg ? "$msg: " : '') . 'oczekiwano ' . json_encode($b, JSON_UNESCAPED_UNICODE) . ', jest ' . json_encode($a, JSON_UNESCAPED_UNICODE));
}
function throws(callable $fn, string $contains = ''): void
{
    try { $fn(); } catch (Throwable $e) { if ($contains === '' || str_contains($e->getMessage(), $contains)) return; throw new Exception("zły błąd: {$e->getMessage()}"); }
    throw new Exception('oczekiwano błędu' . ($contains ? " ($contains)" : ''));
}
function priv(object|string $objOrClass, string $method, array $args = [])
{
    $m = new ReflectionMethod($objOrClass, $method);
    $m->setAccessible(true);
    return $m->invokeArgs(is_object($objOrClass) ? $objOrClass : null, $args);
}

// ---------- silnik kart ----------
function deckFor(array $hands, int $dealer = 3): array
{
    $idx = [0, 0, 0, 0];
    $m = 0;
    return array_map(function ($to) use ($hands, &$idx, &$m) { return $to === 'm' ? $hands[$m++][5] : $hands[$to][$idx[$to]++]; }, Cards::dealSequence($dealer));
}
function playing(array $hands, array $settings = []): array
{
    $h = Cards::createHand(3, $settings, deckFor($hands));
    while ($h['phase'] === 'bidding') Cards::applyAction($h, $h['turn'], ['type' => 'pass']);
    foreach ([1, 2, 3] as $s) Cards::applyAction($h, 0, ['type' => 'give', 'card' => $hands[$s][5], 'to' => $s]);
    return $h;
}
const HANDS = [
    ['AH', 'KH', 'QH', '9C', 'JS', 'TD'],
    ['TH', '9H', 'AC', 'KC', '9S', 'QD'],
    ['JH', 'TC', 'QC', 'AS', 'KS', '9D'],
    ['JC', 'QS', 'TS', 'AD', 'KD', 'JD'],
];

test('meldunek już w pierwszej lewie (także przy zapisanym meldOnFirstTrick=false)', function () {
    foreach ([[], ['meldOnFirstTrick' => false], ['meldOnFirstTrick' => true]] as $set) {
        $h = playing(HANDS, $set);
        ok(Cards::canMeld($h, 0, 'KH') && Cards::canMeld($h, 0, 'QH'), 'K/D z pary w 1. lewie');
        ok(!Cards::canMeld($h, 0, 'AH'));
        $v = Cards::viewFor($h, 0);
        $m = $v['meldable']; sort($m);
        eq($m, ['KH', 'QH'], 'meldable w widoku');
        Cards::applyAction($h, 0, ['type' => 'play', 'card' => 'QH']);
        eq($h['trump'], 'H');
        eq($h['melds'][0]['trick'], 1);
        eq($h['melds'][0]['value'], 100);
    }
});

test('meldunek na kimś w pierwszej lewie: król na damę gracza tuż przed, tromf bez zmian', function () {
    $hands = [
        ['AH', '9H', 'TS', 'JS', '9S', 'TD'],
        ['QS', 'AC', 'TC', 'KC', 'QC', 'AD'],
        ['KS', 'AS', 'JC', '9C', 'KD', 'QD'],
        ['KH', 'QH', 'TH', 'JH', 'JD', '9D'],
    ];
    $h = playing($hands, ['meldOnFirstTrick' => false]);
    Cards::applyAction($h, 0, ['type' => 'play', 'card' => 'AH']);
    Cards::applyAction($h, 1, ['type' => 'play', 'card' => 'QS']);
    eq(Cards::meldOnSeat($h, 2, 'KS'), 1);
    ok(in_array('KS', Cards::viewFor($h, 2)['meldable'], true));
    Cards::applyAction($h, 2, ['type' => 'play', 'card' => 'KS']);
    eq($h['melds'][0], ['seat' => 2, 'team' => 0, 'suit' => 'S', 'value' => 60, 'trick' => 1, 'on' => 1]);
    eq($h['trump'], null);
});

test('obowiązek koloru i przebicia nadal działa', function () {
    $h = playing(HANDS);
    Cards::applyAction($h, 0, ['type' => 'play', 'card' => 'QH']); // meldunek, tromf kier
    eq(Cards::legalCards($h, 1), ['TH'], 'musi przebić');
    throws(fn() => Cards::applyAction($h, 1, ['type' => 'play', 'card' => '9H']), 'nie można');
});

test('ruch automatyczny: pas w licytacji', function () {
    $h = Cards::createHand(3, [], deckFor(HANDS));
    eq(priv(Rooms::class, 'autoAction', [$h, $h['turn']]), ['type' => 'pass']);
});

test('ruch automatyczny: musik – najsłabsze karty, bez rozbijania pary K+D, przyjęte przez silnik', function () {
    $h = Cards::createHand(3, [], deckFor(HANDS));
    while ($h['phase'] === 'bidding') Cards::applyAction($h, $h['turn'], ['type' => 'pass']);
    $a = priv(Rooms::class, 'autoAction', [$h, 0]);
    eq($a['type'], 'give-all');
    $cards = array_map(fn($g) => $g['card'], $a['gives']);
    ok(!in_array('KH', $cards, true) && !in_array('QH', $cards, true), 'nie oddaje pary');
    Cards::applyAction($h, 0, $a);
    eq($h['phase'], 'playing');
});

test('ruch automatyczny: wychodząc z parą melduje damą, inaczej najsłabsza dozwolona karta', function () {
    $h = playing(HANDS);
    eq(priv(Rooms::class, 'autoAction', [$h, 0]), ['type' => 'play', 'card' => 'QH']);
    Cards::applyAction($h, 0, ['type' => 'play', 'card' => '9C']);
    $a = priv(Rooms::class, 'autoAction', [$h, 1]);
    ok(in_array($a['card'], Cards::legalCards($h, 1), true), 'dozwolona');
    eq($a['card'], 'KC', 'najsłabsza dozwolona do koloru (K bije 9)');
});

// ---------- stoły na prawdziwym magazynie ----------
function rrmdir(string $d): void
{
    if (!is_dir($d)) return;
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($d, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $f) $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
    rmdir($d);
}
function env(): array
{
    $dir = sys_get_temp_dir() . '/tysiac-php-test-' . bin2hex(random_bytes(4));
    $store = new Store($dir, Schemas::validators());
    $store->lock(LOCK_EX);
    $audit = fn() => null;
    $store->update('config', fn() => ['registrationOpen' => true, 'defaultSettings' => R::DEFAULT_SETTINGS]);
    $store->update('meta', fn() => ['schemaVersion' => 2, 'createdAt' => now_iso(), 'migrations' => []]);
    $accounts = new Accounts($store, $audit, fn() => ['registrationOpen' => true, 'defaultSettings' => []], 1000);
    $matches = new Matches($store, $accounts, $audit);
    $rooms = new Rooms($store, $matches, $audit);
    $matches->rooms = $rooms;
    $u = [];
    foreach (['Kamil', 'Daniel', 'Karol', 'Akuro'] as $n) $u[] = $accounts->register(['nick' => $n, 'password' => 'bardzo-tajne-haslo-' . $n], '127.0.0.1');
    return ['dir' => $dir, 'store' => $store, 'accounts' => $accounts, 'matches' => $matches, 'rooms' => $rooms, 'u' => $u];
}
function view(array $e, string $roomId, int $i): array { return $e['rooms']->viewFor($e['rooms']->get($roomId), $e['u'][$i]['id']); }
function act(array $e, string $roomId, int $i, array $msg): array { return $e['rooms']->act($e['u'][$i], $roomId, $msg); }
// Ustawia pokój tak, jakby czas gracza właśnie minął.
function expireTurn(array $e, string $roomId): void
{
    $e['store']->update('rooms/' . $roomId, function ($r) { $r['turnAt'] = ms_now() - 10 * 60000; return $r; });
    $e['rooms']->dropCache();
}

test('stół: prawdziwe karty z jednym telefonem → online → offline → zamknięcie; czat czyszczony', function () {
    $e = env();
    try {
        [$A] = $e['u'];
        $R = $e['rooms'];
        $room = $R->create($A, ['settings' => []]);
        $id = $room['id'];
        eq($room['status'], 'lobby');
        // jeden telefon: A siada i sadza resztę
        act($e, $id, 0, ['type' => 'sit', 'seat' => 0]);
        foreach ([1, 2, 3] as $i) act($e, $id, 0, ['type' => 'seat-other', 'seat' => $i, 'userId' => $e['u'][$i]['id']]);
        throws(fn() => act($e, $id, 0, ['type' => 'start']), 'telefonie');
        act($e, $id, 0, ['type' => 'start-offline', 'firstDealerSeat' => 2]);
        $v = view($e, $id, 0);
        eq($v['status'], 'offline');
        $m = $e['matches']->get($v['matchId']);
        eq($m['mode'], 'offline');
        eq($m['firstDealerSeat'], 2);
        eq($m['roomId'], $id);
        // posadzeni gracze widzą stół na liście
        eq(count($R->listForUser($e['u'][3]['id'])), 1);
        // czat
        $msg = $R->chatPost($e['u'][2], $id, "  hej   wszystkim \n ");
        eq($msg['t'], 'hej wszystkim');
        $R->chatPost($e['u'][1], $id, 'siema');
        $c = $R->chatSince($id, 0);
        eq(count($c['items']), 2);
        eq($R->chatSince($id, 1)['items'][0]['t'], 'siema');
        throws(fn() => $R->chatPost($e['u'][1], $id, str_repeat('x', 301)), 'długa');
        throws(fn() => $R->chatPost($e['u'][1], $id, '   '), 'Pusta');
        // przejście na online: poczekalnia z miejscami z meczu, gotowość każdego
        act($e, $id, 1, ['type' => 'go-online']);
        eq(view($e, $id, 0)['status'], 'lobby');
        foreach ([0, 1, 2, 3] as $i) act($e, $id, $i, ['type' => 'ready', 'ready' => true]);
        act($e, $id, 0, ['type' => 'start']);
        $v = view($e, $id, 0);
        eq($v['status'], 'playing');
        eq($v['turnSeconds'], 60);
        ok($v['turnLeftMs'] > 60000 && $v['turnLeftMs'] <= 64000, 'pełny czas + zapas na animację rozdawania');
        // brak wiadomości systemowych w czacie
        eq(count($R->chatSince($id, 0)['items']), 2, 'zmiana trybu nie pisze w czacie');
        // przeterminowany ruch → serwer gra za gracza aż do końca rozdania
        $n = 0;
        while (view($e, $id, 0)['status'] === 'playing' && $n < 40) {
            $seq = view($e, $id, 0)['seq'];
            ok(!$R->autoMoveIfDue($id), 'przed czasem nic się nie dzieje');
            expireTurn($e, $id);
            ok($R->autoMoveIfDue($id), 'po czasie ruch automatyczny');
            eq(view($e, $id, 0)['seq'], $seq + 1);
            $n++;
        }
        $v = view($e, $id, 0);
        eq($v['status'], 'between', "koniec rozdania po $n ruchach");
        ok(!empty(array_filter($v['log'], fn($x) => !empty($x['auto']))), 'ruchy oznaczone jako automatyczne');
        $m = $e['matches']->get($v['matchId']);
        eq(count($m['rounds']), 1);
        eq($m['rounds'][0]['mode'], 'online');
        // online → prawdziwe karty: stół zostaje otwarty
        act($e, $id, 2, ['type' => 'detach']);
        eq(view($e, $id, 0)['status'], 'offline');
        eq($e['matches']->get($v['matchId'])['mode'], 'offline');
        // zamknięcie stołu czyści czat, mecz trwa dalej bez stołu
        act($e, $id, 0, ['type' => 'close']);
        eq($R->find($id), null);
        eq($R->chatSince($id, 0)['items'], []);
        ok($R->chatN($id) >= 2, 'numeracja czatu zostaje');
        $m = $e['matches']->get($v['matchId']);
        eq($m['status'], 'active');
        eq($m['roomId'], null);
    } finally { $e['store']->unlock(); rrmdir($e['dir']); }
});

test('usunięcie meczu zamyka stół i czyści czat (bez przechodzenia na offline)', function () {
    $e = env();
    try {
        [$A] = $e['u'];
        $R = $e['rooms'];
        $id = $R->create($A, ['settings' => []])['id'];
        act($e, $id, 0, ['type' => 'sit', 'seat' => 0]);
        foreach ([1, 2, 3] as $i) act($e, $id, 0, ['type' => 'seat-other', 'seat' => $i, 'userId' => $e['u'][$i]['id']]);
        act($e, $id, 0, ['type' => 'start-offline']);
        $mid = view($e, $id, 0)['matchId'];
        $R->chatPost($A, $id, 'gg');
        $e['matches']->setStatus($A, $mid, ['status' => 'deleted', 'baseRev' => $e['matches']->get($mid)['rev'], 'opId' => 'del1']);
        eq($R->find($id), null);
        eq($R->chatSince($id, 0)['items'], []);
        eq($R->chatCleared($id), 1);
    } finally { $e['store']->unlock(); rrmdir($e['dir']); }
});

test('rewanż przy stole offline: nowy mecz, czat od zera', function () {
    $e = env();
    try {
        [$A] = $e['u'];
        $R = $e['rooms'];
        $id = $R->create($A, ['settings' => ['target' => 100]])['id'];
        act($e, $id, 0, ['type' => 'sit', 'seat' => 0]);
        foreach ([1, 2, 3] as $i) act($e, $id, 0, ['type' => 'seat-other', 'seat' => $i, 'userId' => $e['u'][$i]['id']]);
        act($e, $id, 0, ['type' => 'start-offline']);
        $mid = view($e, $id, 0)['matchId'];
        $R->chatPost($A, $id, 'dobra gra');
        throws(fn() => act($e, $id, 0, ['type' => 'rematch']), 'Rewanż');
        $m = $e['matches']->get($mid);
        $e['matches']->addRound($A, $mid, ['baseRev' => $m['rev'], 'opId' => 'op1', 'round' => ['bidder' => $A['id'], 'bid' => 100, 'cards' => [1 => 0], 'melds' => []]]);
        eq($e['matches']->get($mid)['status'], 'finished');
        act($e, $id, 0, ['type' => 'rematch']);
        $v = view($e, $id, 0);
        eq($v['status'], 'offline');
        ok($v['matchId'] !== $mid, 'nowy mecz');
        eq($R->chatSince($id, 0)['items'], []);
        // nowa wiadomość po wyczyszczeniu dostaje kolejny numer – przeglądarki jej nie zgubią
        $msg = $R->chatPost($A, $id, 'rewanż!');
        eq($msg['id'], 2);
    } finally { $e['store']->unlock(); rrmdir($e['dir']); }
});

test('czas na ruch: zmiana w poczekalni, „bez limitu” wyłącza auto-ruch', function () {
    $e = env();
    try {
        $R = $e['rooms'];
        $id = $R->create($e['u'][0], ['settings' => []])['id'];
        foreach ([0, 1, 2, 3] as $i) { $R->joinByCode($e['u'][$i], view($e, $id, 0)['code']); act($e, $id, $i, ['type' => 'sit', 'seat' => $i]); }
        throws(fn() => act($e, $id, 0, ['type' => 'set-timer', 'seconds' => 45]), 'Zły czas');
        act($e, $id, 0, ['type' => 'set-timer', 'seconds' => 0]);
        foreach ([0, 1, 2, 3] as $i) act($e, $id, $i, ['type' => 'ready', 'ready' => true]);
        act($e, $id, 0, ['type' => 'start']);
        $v = view($e, $id, 0);
        eq($v['turnSeconds'], 0);
        eq($v['turnLeftMs'], null);
        expireTurn($e, $id);
        ok(!$R->autoMoveIfDue($id), 'bez limitu nie ma auto-ruchu');
        throws(fn() => act($e, $id, 0, ['type' => 'set-timer', 'seconds' => 30]), 'między rozdaniami');
    } finally { $e['store']->unlock(); rrmdir($e['dir']); }
});

test('czat: limit wiadomości naraz i dostęp tylko dla osób przy stole', function () {
    $e = env();
    try {
        $R = $e['rooms'];
        $id = $R->create($e['u'][0], ['settings' => []])['id'];
        for ($i = 0; $i < 6; $i++) $R->chatPost($e['u'][0], $id, "w$i");
        throws(fn() => $R->chatPost($e['u'][0], $id, 'za dużo'), 'Za dużo');
        throws(fn() => $R->chatPost($e['u'][3], $id, 'obcy'), 'dołącz');
    } finally { $e['store']->unlock(); rrmdir($e['dir']); }
});

// ---------- uruchomienie ----------
$fail = 0;
foreach ($tests as [$name, $fn]) {
    try { $fn(); echo "✔ $name\n"; }
    catch (Throwable $e) {
        $fail++;
        $where = basename($e->getFile()) . ':' . $e->getLine();
        echo "✖ $name\n    " . $e->getMessage() . " @ $where\n";
        // adnotacja GitHub Actions (widoczna w podsumowaniu przebiegu)
        if (getenv('GITHUB_ACTIONS')) echo '::error title=' . str_replace([',', ':', "\n"], ' ', $name) . '::' . str_replace(["\r", "\n"], ' ', $e->getMessage()) . " @ $where\n";
    }
}
echo "\n" . (count($tests) - $fail) . '/' . count($tests) . " zaliczonych\n";
exit($fail ? 1 : 0);

<?php
// Test HTTP zbudowanej paczki (dist/public_html) na wbudowanym serwerze PHP: 4 graczy, stół, gra online,
// czat w odpytywaniu, przejście na offline, usunięcie meczu. Użycie: php tests/php/http_test.php http://127.0.0.1:8090 dist/public_html
declare(strict_types=1);

$base = $argv[1] ?? 'http://127.0.0.1:8090';
$root = $argv[2] ?? 'dist/public_html';

final class Client
{
    public string $cookie = '';
    public string $csrf = '';
    public ?array $user = null;
    public function __construct(private string $base) {}
    public function req(string $method, string $url, ?array $body = null): array
    {
        $h = ["X-Tysiac: 1"];
        if ($this->cookie) $h[] = 'Cookie: ' . $this->cookie;
        if ($this->csrf) $h[] = 'X-CSRF-Token: ' . $this->csrf;
        if ($body !== null) $h[] = 'Content-Type: application/json';
        $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $h), 'content' => $body !== null ? json_encode($body) : '', 'ignore_errors' => true, 'timeout' => 20]]);
        $raw = file_get_contents($this->base . $url, false, $ctx);
        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+ (\d+)#', $line, $m)) $status = (int)$m[1];
            if (stripos($line, 'Set-Cookie:') === 0) { $v = trim(explode(';', substr($line, 11))[0]); $this->cookie = str_ends_with($v, '=') ? '' : $v; }
        }
        $data = json_decode((string)$raw, true);
        if (is_array($data) && !empty($data['csrf'])) $this->csrf = $data['csrf'];
        return [$status, $data, $raw];
    }
    public function ok(string $method, string $url, ?array $body = null): array
    {
        [$s, $d, $raw] = $this->req($method, $url, $body);
        if ($s !== 200 || !is_array($d) || empty($d['ok'])) throw new Exception("$method $url → $s " . substr((string)$raw, 0, 300));
        return $d;
    }
}

function check($cond, string $msg): void { if (!$cond) throw new Exception($msg); echo "✔ $msg\n"; }

try {
    $c = [];
    foreach (['Kamil', 'Daniel', 'Karol', 'Akuro'] as $n) {
        $x = new Client($base);
        $r = $x->ok('POST', '/api/auth/register', ['nick' => $n, 'password' => 'bardzo-tajne-haslo-' . $n]);
        $x->user = $r['user'];
        $c[] = $x;
    }
    check(count($c) === 4, 'rejestracja 4 graczy');

    $room = $c[0]->ok('POST', '/api/rooms', ['settings' => []])['room'];
    $id = $room['id'];
    foreach ([1, 2, 3] as $i) $c[$i]->ok('POST', '/api/rooms/join', ['code' => $room['code']]);
    $aid = 0;
    $act = function (int $i, array $a) use ($c, $id, &$aid) { $a['actionId'] = 't' . (++$aid); return $c[$i]->ok('POST', "/api/rooms/$id/act", ['action' => $a]); };
    foreach ([0, 1, 2, 3] as $i) $act($i, ['type' => 'sit', 'seat' => $i]);
    foreach ([0, 1, 2, 3] as $i) $act($i, ['type' => 'ready', 'ready' => true]);
    $r = $act(0, ['type' => 'start']);
    check($r['room']['status'] === 'playing', 'start gry online przez API');
    check($r['room']['turnSeconds'] === 60 && $r['room']['turnLeftMs'] > 0, 'zegar ruchu w widoku stołu');

    // czat przez odpytywanie
    $c[1]->ok('POST', "/api/rooms/$id/chat", ['text' => 'hej']);
    $p = $c[0]->ok('GET', '/api/poll?' . http_build_query(['r' => ["$id:0:"]]));
    check(($p['chat'][$id]['items'][0]['t'] ?? null) === 'hej', 'nowa wiadomość czatu w odpytywaniu');
    $p2 = $c[0]->ok('GET', '/api/poll?' . http_build_query(['r' => ["$id:1:" . $p['rooms'][$id]['token']]]));
    check(empty((array)$p2['chat']) && empty((array)$p2['rooms']), 'bez zmian – pusta odpowiedź odpytywania');
    [$s] = (new Client($base))->req('GET', "/api/rooms/$id/chat");
    check($s === 401, 'czat wymaga zalogowania');

    // całe rozdanie: każdy gracz robi ruch, gdy jego kolej (pas / musik / pierwsza dozwolona karta)
    $moves = 0;
    while ($moves < 80) {
        $v = $c[0]->ok('GET', "/api/rooms/$id")['room'];
        if ($v['status'] !== 'playing') break;
        $turn = $v['hand']['turn'];
        $me = $c[array_search($v['seats'][$turn], array_map(fn($x) => $x->user['id'], $c), true)];
        $mv = $me->ok('GET', "/api/rooms/$id")['room'];
        $h = $mv['hand'];
        if ($h['phase'] === 'bidding') $a = ['type' => 'pass'];
        elseif ($h['phase'] === 'giving') {
            $to = array_values(array_filter([0, 1, 2, 3], fn($s) => !$h['given'][$s]));
            $a = ['type' => 'give-all', 'gives' => array_map(fn($t, $card) => ['card' => $card, 'to' => $t], $to, array_slice($h['hand'], 0, count($to)))];
        } else $a = ['type' => 'play', 'card' => $h['legal'][0]];
        $a['expectSeq'] = $mv['seq'];
        $a['actionId'] = 't' . (++$aid);
        $me->ok('POST', "/api/rooms/$id/act", ['action' => $a]);
        $moves++;
    }
    $v = $c[0]->ok('GET', "/api/rooms/$id")['room'];
    check($v['status'] === 'between', "rozdanie online rozegrane do końca ($moves ruchów)");
    $d = $c[2]->ok('GET', '/api/data');
    $m = array_values(array_filter($d['matches'], fn($x) => $x['id'] === $v['matchId']))[0];
    check(count($m['rounds']) === 1 && $m['rounds'][0]['mode'] === 'online', 'wynik rozdania zapisany w meczu');

    // online → prawdziwe karty, stół zostaje
    $r = $act(1, ['type' => 'detach']);
    check($r['room']['status'] === 'offline', 'przejście na prawdziwe karty bez zamykania stołu');
    $c[3]->ok('POST', "/api/rooms/$id/chat", ['text' => 'gramy kartami']);

    // usunięcie meczu z listy: stół się zamyka, czat czyszczony
    $fresh = $c[0]->ok('GET', '/api/matches/' . rawurlencode($m['id']))['match'];
    $c[0]->ok('POST', '/api/matches/' . rawurlencode($m['id']) . '/status', ['status' => 'deleted', 'baseRev' => $fresh['rev'], 'opId' => 'del1']);
    [$s] = $c[0]->req('GET', "/api/rooms/$id");
    check($s === 404, 'usunięcie meczu zamyka stół');
    $chat = json_decode((string)file_get_contents("$root/_dane/runtime/chat-$id.json"), true);
    check($chat['items'] === [] && $chat['n'] === 2, 'czat wyczyszczony po usunięciu meczu');
    [$s] = (new Client($base))->req('GET', '/_dane/users.json');
    echo "  (/_dane/users.json na wbudowanym serwerze: $s – na hostingu blokuje to .htaccess)\n";
    echo "\nTEST HTTP: OK\n";
} catch (Throwable $e) {
    echo "✖ " . $e->getMessage() . "\n";
    exit(1);
}

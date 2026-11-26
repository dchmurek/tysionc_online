<?php
// Router dla wbudowanego serwera PHP w testach (zastępuje regułę .htaccess „/api/* → api.php”).
// php -S 127.0.0.1:8090 -t dist/public_html tests/php/router.php
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (str_starts_with($path, '/api/')) {
    $_SERVER['SCRIPT_NAME'] = '/api.php';
    require $_SERVER['DOCUMENT_ROOT'] . '/api.php';
    return true;
}
return false;

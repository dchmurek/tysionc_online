<?php
// Ustawienia (opcjonalne). Domyślne wartości działają od razu po wgraniu do public_html.
return [
    // Katalog danych. Domyślnie public_html/_dane (zablokowany dla przeglądarek przez .htaccess).
    // Bezpieczniej poza public_html, np.: '/home/TWOJ_LOGIN/tysiac-dane' – wtedy przenieś tam zawartość _dane.
    // 'data_dir' => '/home/TWOJ_LOGIN/tysiac-dane',

    // Limit rejestracji z jednego adresu IP na godzinę.
    'register_per_hour' => 20,

    // Ile kopii dziennych trzymać (w _dane/backups).
    'backup_keep' => 60,

    // Za serwerem proxy (Cloudflare itp.) – ufaj nagłówkowi X-Forwarded-For.
    'trust_proxy' => false,

    // Dodatkowe dozwolone adresy strony (np. gdy aplikacja działa pod dwiema domenami).
    'allowed_origins' => [],
];

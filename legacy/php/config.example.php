<?php
// Ustawienia aplikacji Tysiąc.

// Dostęp: logowanie wspólnym hasłem do stołu z users.php (zob. INSTRUKCJA.md).

// Hasło administratora – wymagane do zmiany hasła do stołu. Tu jest tylko jego skrót (bcrypt).
// Nowy skrót: php -r "echo password_hash('NoweHaslo', PASSWORD_DEFAULT);"
define('ADMIN_HASH', 'WKLEJ_TUTAJ_SKROT_BCRYPT');

// Ile dziennych kopii zapasowych trzymać (data/backups).
define('BACKUP_DAYS', 120);

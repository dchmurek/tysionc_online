<?php
// Wspólne konto do wpisywania wyników. Jest tu tylko skrót hasła (bcrypt), nie samo hasło.
// Zmiana hasła: w aplikacji (Historia → Dostęp → Zmień hasło).
// Reset zapomnianego hasła: wygeneruj skrót poleceniem
//   php -r "echo password_hash('NoweHaslo', PASSWORD_DEFAULT);"
// wklej go poniżej i usuń plik data/users.json.
return [
    'stol' => 'WKLEJ_TUTAJ_SKROT_BCRYPT',
];

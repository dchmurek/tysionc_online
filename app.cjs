// Plik startowy dla hostingu z Phusion Passenger (CyberFolks / DirectAdmin „Setup Node.js App”).
// Passenger ładuje plik startowy przez require(), więc to musi być CommonJS – a serwer to moduły ES.
// Passenger sam podmienia port/gniazdo w server.listen(), dlatego HOST/PORT nie mają tu znaczenia.
import('./server/main.js').catch((e) => {
  console.error('Nie można uruchomić serwera:', e && e.stack ? e.stack : e);
  process.exit(1);
});

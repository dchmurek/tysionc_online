// Narzędzia administratora (uruchamiaj przy ZATRZYMANYM serwerze):
//   npm run admin -- users
//   npm run admin -- activation <nick> [--reset]     → jednorazowy kod aktywacji / resetu hasła
//   npm run admin -- password <nick> <hasło>        → ustawia hasło (np. tymczasowe – gracz zmienia je w Profilu)
//   npm run admin -- role <nick> admin|player
//   npm run admin -- backup
//   npm run admin -- backups
//   npm run admin -- restore <nazwa-kopii>
//   npm run admin -- verify
import { loadEnvFile, getConfig } from '../config.js';
import { JsonStore } from '../store/jsonStore.js';
import { validators } from '../store/schemas.js';
import { createBackup, listBackups, readBackup, restoreBundle } from '../store/backup.js';
import { Accounts } from '../services/accounts.js';
import { hashPassword, passwordProblem } from '../services/passwords.js';

loadEnvFile();
const config = getConfig();
const [cmd, ...rest] = process.argv.slice(2);
let store;
try {
  store = await new JsonStore(config.dataDir, { validators }).init();
} catch (e) {
  console.error(e.message, '\nZatrzymaj serwer przed użyciem narzędzi administratora.');
  process.exit(1);
}
const audit = async (type, data) => store.appendLine(`audit/${new Date().toISOString().slice(0, 7)}.jsonl`, { at: new Date().toISOString(), type, via: 'cli', ...data });
const accounts = new Accounts(store, { audit, getConfig: async () => ({ registrationOpen: true }) });
const CLI = 'cli';

async function userByNick(nick) {
  const u = await accounts.findByNick(nick || '');
  if (!u) throw new Error(`Nie ma użytkownika „${nick}”`);
  return u;
}

try {
  switch (cmd) {
    case 'users': {
      for (const u of await accounts.allUsers()) console.log(`${u.nick.padEnd(20)} ${u.role.padEnd(7)} ${u.status.padEnd(9)} ${u.id}`);
      break;
    }
    case 'activation': {
      const u = await userByNick(rest[0]);
      const r = await accounts.issueActivation(CLI, u.id, rest.includes('--reset') ? 'reset' : 'activate');
      console.log(`Kod dla ${u.nick}: ${r.code}  (ważny ${r.expiresInHours} h, jednorazowy)`);
      console.log('Przekaż go osobiście. Gracz wpisuje go na stronie: „Aktywuj konto”.');
      break;
    }
    case 'password': {
      const u = await userByNick(rest[0]);
      const problem = passwordProblem(rest[1], u.nick);
      if (problem) throw new Error(problem);
      const h = await hashPassword(rest[1]);
      const t = new Date().toISOString();
      await store.update('users', (doc) => {
        const x = doc.users[u.id];
        x.passwordHash = h; x.status = 'active'; x.activation = null; x.passwordChangedAt = t; x.updatedAt = t;
        return doc;
      });
      await accounts.revokeAll(u.id);
      await audit('user.password.cli', { userId: u.id });
      console.log(`${u.nick}: hasło ustawione, stare sesje wylogowane.`);
      break;
    }
    case 'role': {
      const u = await userByNick(rest[0]);
      await accounts.setRole(CLI, u.id, rest[1]);
      console.log(`${u.nick}: rola ${rest[1]}`);
      break;
    }
    case 'backup': console.log('Utworzono:', (await createBackup(store, 'manual')).name); break;
    case 'backups': for (const b of await listBackups(store)) console.log(b.name, Math.round(b.size / 1024) + ' KB'); break;
    case 'restore': {
      const bundle = await readBackup(store, rest[0]);
      const r = await restoreBundle(store, bundle, { validators });
      console.log(`Przywrócono ${r.restored} dokumentów. Kopia stanu sprzed przywrócenia: ${r.preRestoreBackup}`);
      break;
    }
    case 'verify': {
      const p = await store.verifyAll();
      console.log(p.length ? p : 'Wszystkie dokumenty poprawne.');
      if (p.length) process.exitCode = 2;
      break;
    }
    default:
      console.log('Polecenia: users | activation <nick> [--reset] | password <nick> <hasło> | role <nick> admin|player | backup | backups | restore <nazwa> | verify');
  }
} catch (e) {
  console.error('Błąd:', e.message);
  process.exitCode = 1;
} finally {
  store.close();
}

// Panel administratora: użytkownicy, kody aktywacyjne, kopie, import, konfiguracja, diagnostyka.
import { html, mount, toast, confirmBox, dialog, fmtDateTime, raw } from '../dom.js';
import { state, get, post, loadData } from '../state.js';
import { download } from '../api.js';
import { icon, dot } from '../ui.js';

export function admin({ el, go }) {
  if (state.me.role !== 'admin') { go('/', { replace: true }); return; }
  const d = { users: [], backups: [], config: null, diag: null, importPrev: null, restorePrev: null };
  const load = async () => {
    try {
      const [u, b, c] = await Promise.all([get('/api/admin/users'), get('/api/admin/backups'), get('/api/admin/config')]);
      d.users = u.users; d.backups = b.backups; d.config = c.config;
    } catch (e) { toast(e.message, { kind: 'bad' }); }
    draw();
  };
  const draw = () => {
    mount(el, html`
      <a class="back" href="#/profile">${icon('chevronLeft')}Profil</a>
      <div class="page-head"><div><div class="eyebrow">Administracja</div><h1 class="title-xl">Panel</h1></div></div>
      <section class="card"><h3>Użytkownicy</h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th class="l">Nick</th><th>Status</th><th>Rola</th><th>Akcje</th></tr></thead><tbody>
        ${d.users.map((u) => html`<tr>
          <td class="l">${dot(u.id)}<b>${u.nick}</b></td>
          <td>${u.status === 'active' ? 'aktywne' : u.status === 'pending' ? html`<span class="badge warn">czeka na aktywację</span>` : html`<span class="badge bad">zablokowane</span>`}${u.activationPending ? html`<div class="muted small">kod ważny do ${fmtDateTime(u.activationExpires)}</div>` : ''}</td>
          <td>${u.role === 'admin' ? 'admin' : 'gracz'}</td>
          <td class="actions-cell">
            ${u.status !== 'disabled' ? html`<button type="button" class="btn sm ${u.status === 'pending' ? 'gold' : ''}" data-act="code" data-id="${u.id}" data-purpose="${u.status === 'pending' ? 'activate' : 'reset'}">${u.status === 'pending' ? 'Kod aktywacyjny' : 'Reset hasła'}</button>` : ''}
            ${u.id !== state.me.id ? html`<button type="button" class="btn sm" data-act="role" data-id="${u.id}" data-role="${u.role === 'admin' ? 'player' : 'admin'}">${u.role === 'admin' ? 'Odbierz admina' : 'Nadaj admina'}</button>
              ${u.status === 'active' ? html`<button type="button" class="btn sm danger" data-act="status" data-id="${u.id}" data-status="disabled">Zablokuj</button>` : u.status === 'disabled' ? html`<button type="button" class="btn sm" data-act="status" data-id="${u.id}" data-status="${u.hasPassword ? 'active' : 'pending'}">Odblokuj</button>` : ''}` : ''}
          </td></tr>`)}
        </tbody></table></div>
        <p class="muted small">Administrator nie widzi haseł. Kod aktywacyjny jest jednorazowy (7 dni, reset hasła 24 h) – przekaż go osobiście. Gracz wpisuje go w „Aktywuj konto”.</p>
      </section>
      ${d.config ? html`<section class="card"><h3>Konfiguracja</h3>
        <label class="check"><input type="checkbox" data-act="reg" ${d.config.registrationOpen ? raw('checked') : ''}> Otwarta rejestracja nowych graczy</label></section>` : ''}
      <section class="card"><h3>Kopie zapasowe</h3>
        <p class="muted small">Serwer robi kopię codziennie oraz przed migracją, importem i przywracaniem.</p>
        <div class="row wrap"><button type="button" class="btn sm gold" data-act="backup">${icon('plus')}Utwórz kopię teraz</button>
          <button type="button" class="btn sm" data-act="download">${icon('download')}Pobierz zaszyfrowaną kopię</button>
          <label class="btn sm">${icon('upload')}Przywróć z pliku<input type="file" accept=".enc,.tysiac.enc" data-act="restore-file" hidden></label></div>
        <div class="table-wrap"><table class="tbl"><tbody>${d.backups.slice(0, 15).map((b) => html`<tr><td class="l mono small">${b.name}</td><td>${Math.round(b.size / 1024)} KB</td><td><button type="button" class="btn sm" data-act="restore" data-name="${b.name}">Przywróć</button></td></tr>`)}</tbody></table></div>
        ${d.restorePrev ? html`<div class="notice warn"><b>Podgląd przywracania:</b> kopia z ${fmtDateTime(d.restorePrev.createdAt)} – ${d.restorePrev.matches} meczów, ${d.restorePrev.users} kont, ${d.restorePrev.files} dokumentów. Bieżący stan zostanie zapisany jako kopia „pre-restore”.
          <div class="row"><button type="button" class="btn sm" data-act="restore-cancel">Anuluj</button><button type="button" class="btn sm danger" data-act="restore-apply">Przywróć</button></div></div>` : ''}
      </section>
      <section class="card"><h3>Import danych</h3>
        <p class="muted small">Plik eksportu tej aplikacji albo <b>db.json ze starej wersji PHP</b> (migracja: Damazy → Daniel, Dollat → Kamil, Karol, Akuro). Przed zapisem zobaczysz podgląd.</p>
        <label class="btn sm">${icon('upload')}Wybierz plik JSON<input type="file" accept=".json,application/json" data-act="import-file" hidden></label>
        ${d.importPrev ? html`<div class="notice">
          <b>Podgląd importu (${d.importPrev.kind === 'legacy' ? 'stara aplikacja' : 'eksport'})</b>
          <pre class="small">${JSON.stringify(d.importPrev.summary, null, 2)}</pre>
          <div class="row"><button type="button" class="btn sm" data-act="import-cancel">Anuluj</button><button type="button" class="btn sm gold" data-act="import-apply">Zaimportuj</button></div></div>` : ''}
      </section>
      <section class="card"><h3>Diagnostyka</h3>
        <div class="row wrap"><button type="button" class="btn sm" data-act="diag">Sprawdź integralność</button><button type="button" class="btn sm" data-act="rebuild">Przelicz wszystkie mecze</button></div>
        ${d.diag ? html`<pre class="small">${JSON.stringify(d.diag, null, 2)}</pre>` : ''}
      </section>`);
  };
  const readFile = (input) => new Promise((resolve, reject) => {
    const f = input.files[0];
    if (!f) return reject(new Error('Brak pliku'));
    if (f.size > 20 * 1024 * 1024) return reject(new Error('Plik jest za duży'));
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Nie można odczytać pliku'));
    r.readAsArrayBuffer(f);
  });
  el.addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.act === 'reg') { await post('/api/admin/config', { registrationOpen: t.checked }); toast('Zapisano'); load(); }
      if (t.dataset.act === 'import-file') {
        const buf = await readFile(t);
        const data = JSON.parse(new TextDecoder().decode(buf));
        d.importPrev = await post('/api/admin/import/preview', { data });
        draw();
      }
      if (t.dataset.act === 'restore-file') {
        const buf = await readFile(t);
        const r = await dialog({ title: 'Hasło kopii', fields: [{ name: 'p', label: 'Hasło użyte przy pobieraniu', type: 'password', required: true }], buttons: [{ label: 'Anuluj', value: false }, { label: 'Dalej', value: true, kind: 'gold' }] });
        if (!r || !r.value) return;
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        d.restorePrev = await post('/api/admin/restore/preview', { file: btoa(bin), passphrase: r.fields.p });
        draw();
      }
    } catch (ex) { toast(ex.message, { kind: 'bad' }); } finally { if (t.type === 'file') t.value = ''; }
  });
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a || a.tagName === 'INPUT') return;
    try {
      switch (a.dataset.act) {
        case 'code': {
          const r = await post(`/api/admin/users/${encodeURIComponent(a.dataset.id)}/activation`, { purpose: a.dataset.purpose });
          const u = d.users.find((x) => x.id === a.dataset.id);
          await dialog({ title: `Kod dla ${u.nick}`, body: html`<p class="room-code mono">${r.code}</p><p class="muted small">Ważny ${r.expiresInHours} h, jednorazowy. Kod nie zostanie pokazany ponownie – przekaż go osobiście. ${u.nick} wpisuje go na stronie w „Aktywuj konto” i ustawia własne hasło.</p>` });
          load();
          break;
        }
        case 'role': if (await confirmBox('Zmiana roli', 'Na pewno?', 'Zmień')) { await post(`/api/admin/users/${encodeURIComponent(a.dataset.id)}/role`, { role: a.dataset.role }); load(); } break;
        case 'status': if (await confirmBox('Zmiana statusu', a.dataset.status === 'disabled' ? 'Zablokowane konto zostanie wylogowane ze wszystkich urządzeń. Historia zostaje.' : 'Odblokować konto?', 'Tak')) { await post(`/api/admin/users/${encodeURIComponent(a.dataset.id)}/status`, { status: a.dataset.status }); load(); } break;
        case 'backup': { const r = await post('/api/admin/backups'); toast('Utworzono ' + r.backup.name); load(); break; }
        case 'download': {
          const r = await dialog({ title: 'Zaszyfrowana kopia', body: html`<p class="muted small">Kopia zawiera także skróty haseł, dlatego jest szyfrowana (AES-256-GCM). Zapamiętaj hasło – bez niego kopii nie da się przywrócić.</p>`, fields: [{ name: 'p', label: 'Hasło kopii (min. 12 znaków)', type: 'password', required: true, minlength: 12 }], buttons: [{ label: 'Anuluj', value: false }, { label: 'Pobierz', value: true, kind: 'gold' }] });
          if (r && r.value) await download('/api/admin/backups/download', { passphrase: r.fields.p }, 'tysiac-backup.tysiac.enc');
          break;
        }
        case 'restore': d.restorePrev = await post('/api/admin/restore/preview', { name: a.dataset.name }); draw(); break;
        case 'restore-cancel': d.restorePrev = null; draw(); break;
        case 'restore-apply': if (await confirmBox('Przywrócić kopię?', 'Wszystkie bieżące dane zostaną zastąpione zawartością kopii (aktualny stan trafi do kopii pre-restore).', 'Przywróć', 'danger')) { const r = await post('/api/admin/restore/apply'); d.restorePrev = null; toast(`Przywrócono ${r.restored} dokumentów`); await loadData(); load(); } break;
        case 'import-cancel': await post('/api/admin/import/cancel', { token: d.importPrev.token }); d.importPrev = null; draw(); break;
        case 'import-apply': { const r = await post('/api/admin/import/apply', { token: d.importPrev.token }); d.importPrev = null; toast(`Zaimportowano: ${(r.createdMatches || []).length} meczów`); await loadData(); load(); break; }
        case 'diag': d.diag = await get('/api/admin/diagnostics'); draw(); break;
        case 'rebuild': d.diag = await post('/api/admin/rebuild-stats'); draw(); break;
        default:
      }
    } catch (ex) { toast(ex.message, { kind: 'bad' }); }
  });
  draw();
  load();
}

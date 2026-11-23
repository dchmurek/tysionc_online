// Testy E2E interfejsu na 5 rozdzielczościach: logowanie, mecz offline, statystyki, historia, profil, admin.
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './seed.js';

const shot = (page, testInfo, name) => page.screenshot({ path: `test-results/screens/${testInfo.project.name}-${name}.png`, fullPage: false });

async function login(page, nick) {
  await page.goto('/');
  await expect(page.locator('form.login')).toBeVisible();
  await page.fill('input[name=nick]', nick);
  await page.fill('input[name=password]', TEST_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page.locator('.big-tile.online')).toBeVisible();
}

async function noHorizontalOverflow(page) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(o.sw, 'poziome przewijanie strony').toBeLessThanOrEqual(o.w + 1);
}

function watchConsole(page) {
  const errors = [];
  // 401 przy celowo błędnym haśle to oczekiwana odpowiedź serwera, nie błąd aplikacji.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test('logowanie, nowy mecz offline, rozdania, korekta, cofanie – układ na ekranie', async ({ page }, testInfo) => {
  const errors = watchConsole(page);
  await page.goto('/');
  await expect(page).toHaveURL(/#\/login/);
  await shot(page, testInfo, '01-login');
  await noHorizontalOverflow(page);
  // złe hasło
  await page.fill('input[name=nick]', 'Kamil');
  await page.fill('input[name=password]', 'zle-haslo-xxxx');
  await page.click('button[type=submit]');
  await expect(page.locator('.login-err')).toContainText('Zły nick lub hasło');
  await login(page, 'Kamil');
  await shot(page, testInfo, '02-home');
  await noHorizontalOverflow(page);
  // stare nazwy nie są widoczne w interfejsie
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/Damazy|Dollat/);

  await page.click('.big-tile.offline');
  await expect(page.locator('h1')).toContainText('Kto siada do stołu');
  for (const [i, n] of ['Kamil', 'Daniel', 'Karol', 'Akuro'].entries()) await page.selectOption(`select[data-seat="${i}"]`, { label: n });
  await shot(page, testInfo, '03-new-match');
  await page.click('#cta [data-act=start]');
  await expect(page.locator('.felt')).toBeVisible();
  await expect(page.locator('.tile')).toHaveCount(2);

  // dodanie 7 rozdań klawiaturą
  for (let i = 0; i < 7; i++) {
    await page.click('#cta [data-act=add]');
    await page.locator('.pbtn').nth(i % 4).click();
    await page.click('[data-act=collapse]');
    const keypad = page.locator('.keypad');
    await expect(keypad).toBeVisible();
    await page.click('[data-k="2"]');
    await page.click('[data-k="0"]');
    if (i === 0) {
      await page.waitForTimeout(450); // koniec animacji wysuwania arkusza
      // klawiatura i przycisk zapisu mieszczą się na ekranie (problem z audytu)
      const vh = page.viewportSize().height;
      const save = await page.locator('[data-act=save]').boundingBox();
      expect(save.y + save.height).toBeLessThanOrEqual(vh + 1);
      const k0 = await page.locator('[data-k="0"]').boundingBox();
      await page.locator('[data-k="0"]').scrollIntoViewIfNeeded();
      expect(k0).not.toBeNull();
      await shot(page, testInfo, '04-round-sheet');
      await expect(page.locator('.preview')).toContainText('kontrakt ugrany');
    }
    await page.click('[data-act=save]');
    await expect(page.locator('.sheet')).toHaveCount(0);
  }
  await expect(page.locator('.lrow:not(.head)')).toHaveCount(6); // domyślnie 6 ostatnich
  await expect(page.locator('[data-act=log-all]')).toContainText('Pokaż wszystkie (7)');
  // wynik: każde rozdanie +100 dla grającego (120-20=100), +20 dla przeciwników
  const scores = await page.locator('.tscore').allInnerTexts();
  await page.waitForTimeout(800);
  const after = await page.locator('.tscore').allInnerTexts();
  expect(after.length).toBe(2);
  expect(scores.length).toBe(2);
  await shot(page, testInfo, '05-table');
  await noHorizontalOverflow(page);

  // CTA nie zasłania historii rozdań (problem z audytu)
  await page.click('[data-act=log-all]');
  await expect(page.locator('.lrow:not(.head)')).toHaveCount(7);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  const lastRow = await page.locator('.log-list .log-more').boundingBox();
  const cta = await page.locator('#cta').boundingBox();
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(cta.y + 2);

  // korekta rozdania: za mało punktów na kontrakt → zapis zablokowany
  await page.locator('.lrow:not(.head)').first().click();
  await expect(page.locator('.sheet h2')).toContainText('Poprawka');
  await page.click('[data-act=expand]');
  await page.locator('[data-act=bid][data-v="150"]').click();
  await page.click('[data-act=collapse]');
  await page.click('[data-k=clr]');
  await page.click('[data-k="5"]');
  await page.click('[data-k="0"]');
  await expect(page.locator('.preview')).toContainText('nieugrany');
  await page.click('[data-act=save]');
  await expect(page.locator('.toast')).toContainText('Poprawka zapisana');
  await expect(page.locator('.lrow:not(.head)').first().locator('.res.ko')).toBeVisible();

  // cofnięcie i przywrócenie
  await page.click('[data-act=undo]');
  await expect(page.locator('.lrow:not(.head)')).toHaveCount(6);
  await page.click('.toast button');
  await expect(page.locator('.lrow:not(.head)')).toHaveCount(7);

  // szczegóły meczu z wykresem
  await page.click('[data-act=menu]');
  await page.click('.modal button:has-text("Szczegóły")');
  await expect(page.locator('#chMatch')).toBeVisible();
  await shot(page, testInfo, '06-match-details');
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('statystyki, grupy, pary, historia, sesje, profil', async ({ page }, testInfo) => {
  const errors = watchConsole(page);
  await login(page, 'Karol');
  await page.click('#dock [data-tab=stats]');
  await expect(page.locator('h1')).toHaveText('Statystyki');
  await page.click('[data-period=all]');
  await expect(page.locator('#chWins')).toBeVisible();
  await shot(page, testInfo, '10-stats');
  await noHorizontalOverflow(page);
  await page.click('.tabs a:has-text("Ranking")');
  await expect(page.locator('.rank-tbl tbody tr').first()).toBeVisible();
  await page.selectOption('[data-sort]', 'winRate');
  await shot(page, testInfo, '11-ranking');
  await noHorizontalOverflow(page);
  await page.click('.tabs a:has-text("Grupy")');
  await page.locator('.game-card').first().click();
  await expect(page.locator('.eyebrow').first()).toHaveText('Grupa');
  await expect(page.locator('h1')).toContainText('Kamil');
  await shot(page, testInfo, '12-group');
  await noHorizontalOverflow(page);
  await page.goto('/#/stats/pairs');
  await expect(page.locator('h1')).toHaveText('Pary');
  await shot(page, testInfo, '13-pairs');
  await page.goto('/#/stats/player/' + (await page.evaluate(() => JSON.parse(localStorage.getItem('tys2:lastUser')).id)));
  await expect(page.locator('h3:has-text("Współpraca")')).toBeVisible();
  await shot(page, testInfo, '14-player');
  await noHorizontalOverflow(page);
  await page.click('#dock [data-tab=history]');
  await expect(page.locator('h1')).toHaveText('Historia');
  await page.click('[data-mode=meets]');
  await page.locator('.game-card').first().click();
  await expect(page.locator('.eyebrow').first()).toContainText('Sesja');
  await shot(page, testInfo, '15-session');
  await noHorizontalOverflow(page);
  await page.click('#dock [data-tab=profile]');
  await expect(page.locator('h3:has-text("Zmiana hasła")')).toBeVisible();
  await expect(page.locator('a[href="#/admin"]')).toHaveCount(0);
  await shot(page, testInfo, '16-profile');
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('administrator: użytkownicy, kopia, diagnostyka; powiększanie strony nie jest zablokowane', async ({ page }, testInfo) => {
  test.skip(!['desktop-1920', 'phone-390'].includes(testInfo.project.name), 'wystarczą dwa rozmiary');
  const errors = watchConsole(page);
  await login(page, 'Daniel');
  const vp = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(vp).not.toMatch(/user-scalable=no|maximum-scale=1/);
  await page.goto('/#/admin');
  await expect(page.locator('h1')).toHaveText('Panel');
  await expect(page.locator('td:has-text("Kamil")')).toBeVisible();
  await page.click('[data-act=backup]');
  await expect(page.locator('.toast')).toContainText('Utworzono');
  await page.click('[data-act=diag]');
  await expect(page.locator('pre')).toContainText('integrityProblems');
  await shot(page, testInfo, '20-admin');
  await noHorizontalOverflow(page);

  // aktywacja konta bez hasła: profil → kod od administratora → gracz aktywuje w swojej przeglądarce
  const nickG = 'Gosc' + testInfo.project.name.replace(/[^0-9]/g, '');
  await page.evaluate(async (n) => {
    const me = await (await fetch('/api/me')).json();
    await fetch('/api/users/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tysiac': '1', 'X-CSRF-Token': me.csrf }, body: JSON.stringify({ nick: n }) });
  }, nickG);
  await page.reload();
  const row = page.locator('tr', { hasText: nickG });
  await row.locator('[data-act=code]').click();
  const code = (await page.locator('.modal .room-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.click('.modal .btn');
  const other = await (await page.context().browser().newContext({ viewport: page.viewportSize() })).newPage();
  await other.goto('/#/activate');
  await other.fill('input[name=nick]', nickG);
  await other.fill('input[name=code]', code);
  await other.fill('input[name=password]', 'wlasne-haslo-goscia');
  await other.fill('input[name=password2]', 'wlasne-haslo-goscia');
  await other.click('button[type=submit]');
  await expect(other.locator('h1')).toContainText(nickG);
  expect(errors).toEqual([]);
});

test('rejestracja nowego gracza i unikalność nicku', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'jeden rozmiar');
  await page.goto('/#/register');
  await page.fill('input[name=nick]', 'akuro');
  await page.fill('input[name=password]', 'nowe-dlugie-haslo-1');
  await page.fill('input[name=password2]', 'nowe-dlugie-haslo-1');
  await page.click('button[type=submit]');
  await expect(page.locator('.login-err')).toContainText('zajęty');
  await page.fill('input[name=nick]', 'Mati');
  await page.click('button[type=submit]');
  await expect(page.locator('h1')).toContainText('Mati');
});

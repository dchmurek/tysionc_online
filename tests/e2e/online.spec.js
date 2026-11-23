// Czterech graczy w osobnych przeglądarkach gra online przez interfejs (pokój, kod, miejsca, licytacja, karty).
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './seed.js';

test.beforeEach(({}, ti) => { test.skip(!['phone-390', 'desktop-1920', 'phone-320'].includes(ti.project.name), 'trzy rozmiary'); });
test.setTimeout(180_000);

async function login(page, nick) {
  await page.goto('/');
  await page.fill('input[name=nick]', nick);
  await page.fill('input[name=password]', TEST_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page.locator('.big-tile.online')).toBeVisible();
}

test('pełne rozdanie online w 4 przeglądarkach + przejście do trybu offline', async ({ browser }, testInfo) => {
  const vp = testInfo.project.use.viewport;
  const nicks = ['Kamil', 'Daniel', 'Karol', 'Akuro'];
  const pages = [];
  const errors = [];
  for (const n of nicks) {
    const ctx = await browser.newContext({ viewport: vp, hasTouch: !!testInfo.project.use.hasTouch, isMobile: !!testInfo.project.use.isMobile });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(n + ': ' + m.text()); });
    p.on('pageerror', (e) => errors.push(n + ': ' + e));
    await login(p, n);
    pages.push(p);
  }
  const [host] = pages;
  await host.click('.big-tile.online');
  await host.click('form[data-form=create] button[type=submit]');
  await expect(host.locator('.room-code')).toBeVisible();
  const code = (await host.locator('.room-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  for (const p of pages.slice(1)) {
    await p.goto('/#/online');
    await p.fill('input[name=code]', code.toLowerCase());
    await p.click('form[data-form=join] button[type=submit]');
    await expect(p.locator('.room-code')).toHaveText(code);
  }
  // miejsca 1–4 po kolei
  for (const [i, p] of pages.entries()) {
    await p.locator(`[data-act=sit][data-seat="${i}"]`).click();
    await expect(p.locator('.lseat.me')).toBeVisible();
  }
  for (const p of pages) await p.click('#cta [data-act=ready]');
  await expect(host.locator('#cta [data-act=start]')).toBeEnabled();
  await testInfo.attach('lobby', { body: await host.screenshot(), contentType: 'image/png' });
  await host.screenshot({ path: `test-results/screens/${testInfo.project.name}-30-lobby.png` });
  await host.click('#cta [data-act=start]');
  for (const p of pages) await expect(p.locator('.felt-table')).toBeVisible();
  // każdy widzi 6 swoich kart i karty przeciwników jako rewersy (lub ukryte)
  for (const p of pages) await expect(p.locator('.hand .pcard')).toHaveCount(6);
  await host.screenshot({ path: `test-results/screens/${testInfo.project.name}-31-bidding.png` });

  let shotPlay = false;
  // Pętla graczy: kto ma ruch, ten pasuje w licytacji albo zagrywa pierwszą dozwoloną kartę.
  // Stan zmienia się asynchronicznie (WebSocket), więc pojedyncza próba może trafić na przerysowanie – wtedy ponawiamy.
  for (let step = 0; step < 200; step++) {
    if (await host.locator('.card.result').count()) break;
    let acted = false;
    for (const p of pages) {
      if (!(await p.locator('.turn-line.mine').count())) continue;
      try {
        if (await p.locator('.controls.bidding').count()) {
          await p.locator('[data-act=pass]').click({ timeout: 1500 });
        } else {
          const playable = p.locator('.hand .pcard.playable').first();
          await playable.click({ timeout: 1500 });
          const play = p.locator('[data-act=play]');
          await play.click({ timeout: 1500 });
          if (!shotPlay && step > 8) { shotPlay = true; await p.waitForTimeout(200); await p.screenshot({ path: `test-results/screens/${testInfo.project.name}-32-playing.png` }); }
        }
        acted = true;
      } catch { /* przerysowanie w trakcie – spróbuj ponownie */ }
      break;
    }
    if (!acted) await host.waitForTimeout(100);
  }
  for (const p of pages) await expect(p.locator('.card.result')).toBeVisible({ timeout: 10000 });
  await expect(host.locator('.card.result')).toContainText('Rozdanie 1 zakończone');
  await host.screenshot({ path: `test-results/screens/${testInfo.project.name}-33-result.png` });

  // wynik zapisany w meczu na serwerze
  const roomMatch = await host.evaluate(async () => {
    const d = await (await fetch('/api/data')).json();
    return d.matches.find((m) => m.rounds.some((r) => r.mode === 'online'));
  });
  expect(roomMatch.rounds.length).toBe(1);
  expect(roomMatch.rounds[0].cards['0'] + roomMatch.rounds[0].cards['1']).toBe(120);

  // przejście do trybu offline między rozdaniami – ten sam mecz, stół kalkulatora
  await host.click('#cta [data-act=detach]');
  await host.click('.modal button:has-text("Przejdź")');
  await expect(host.locator('.felt')).toBeVisible({ timeout: 10000 });
  await expect(host.locator('.lrow:not(.head)')).toHaveCount(1);
  await expect(host.locator('.lrow .tag-on')).toHaveCount(1);
  for (const p of pages.slice(1)) await expect(p.locator('.toast')).toContainText('zamknięty', { timeout: 10000 });
  expect(errors).toEqual([]);
});

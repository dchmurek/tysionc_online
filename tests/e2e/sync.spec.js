// Zapis offline w telefonie, synchronizacja po powrocie sieci i konflikt dwóch urządzeń.
import { test, expect } from '@playwright/test';
import { TEST_PASSWORD } from './seed.js';

test.beforeEach(({}, ti) => { test.skip(ti.project.name !== 'phone-390', 'scenariusz synchronizacji – jeden rozmiar'); });

async function login(page, nick) {
  await page.goto('/');
  await page.fill('input[name=nick]', nick);
  await page.fill('input[name=password]', TEST_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page.locator('.big-tile.online')).toBeVisible();
}
async function newMatch(page) {
  await page.click('.big-tile.offline');
  for (const [i, n] of ['Kamil', 'Daniel', 'Karol', 'Akuro'].entries()) await page.selectOption(`select[data-seat="${i}"]`, { label: n });
  await page.click('#cta [data-act=start]');
  await expect(page.locator('.felt')).toBeVisible();
  return decodeURIComponent(page.url().split('#/match/')[1]);
}
async function addRound(page, seatIndex, opp) {
  await page.click('#cta [data-act=add]');
  await page.locator('.pbtn').nth(seatIndex).click();
  await page.click('[data-act=collapse]');
  for (const d of String(opp)) await page.click(`[data-k="${d}"]`);
  await page.click('[data-act=save]');
  await expect(page.locator('.sheet')).toHaveCount(0);
}
const serverMatch = (page, id) => page.evaluate(async (mid) => (await (await fetch('/api/matches/' + encodeURIComponent(mid))).json()).match, id);
const queueLen = (page) => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('tys2:queue:')).reduce((a, [, v]) => a + JSON.parse(v).length, 0));

test('wyniki zapisane bez internetu trafiają na serwer po powrocie połączenia', async ({ page, context }) => {
  await login(page, 'Kamil');
  const id = await newMatch(page);
  await addRound(page, 0, 20);
  await expect.poll(() => queueLen(page)).toBe(0);
  expect((await serverMatch(page, id)).rounds.length).toBe(1);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await addRound(page, 1, 30);
  await addRound(page, 2, 40);
  await expect(page.locator('#banner')).toContainText('Brak internetu');
  await expect(page.locator('.lrow.pending')).toHaveCount(2);
  expect(await queueLen(page)).toBe(2);
  // odświeżenie strony bez sieci: dane z telefonu, kolejka zachowana
  await context.setOffline(false);
  await context.setOffline(true);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => queueLen(page), { timeout: 10000 }).toBe(0);
  const m = await serverMatch(page, id);
  expect(m.rounds.length).toBe(3);
  expect(m.rounds.map((r) => r.cards[r.bidder === m.seats[0] || r.bidder === m.seats[2] ? '1' : '0'])).toEqual([20, 30, 40]);
  await expect(page.locator('#banner')).toBeHidden();
});

test('konflikt: dwa telefony dodają rozdanie do tego samego meczu – nic nie ginie, użytkownik wybiera', async ({ browser }) => {
  const a = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const b = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(a, 'Kamil');
  const id = await newMatch(a);
  await addRound(a, 0, 10);
  await login(b, 'Daniel');
  await b.goto('/#/match/' + encodeURIComponent(id));
  await expect(b.locator('.lrow:not(.head)')).toHaveCount(1);
  // telefon B traci sieć, telefon A w tym czasie dodaje rozdanie
  await b.context().setOffline(true);
  await b.evaluate(() => window.dispatchEvent(new Event('offline')));
  await addRound(a, 1, 50);
  await expect.poll(() => queueLen(a)).toBe(0);
  await addRound(b, 2, 70);
  await b.context().setOffline(false);
  await b.evaluate(() => window.dispatchEvent(new Event('online')));
  // B dostaje okno konfliktu
  await expect(b.locator('.modal h2')).toHaveText('Konflikt zapisu', { timeout: 10000 });
  await b.click('.modal button:has-text("Dodaj moje rozdania")');
  await expect.poll(() => queueLen(b), { timeout: 10000 }).toBe(0);
  const m = await serverMatch(b, id);
  expect(m.rounds.length).toBe(3); // rozdanie A i rozdanie B – oba zachowane
  await expect(b.locator('.lrow:not(.head)')).toHaveCount(3);
});

test('PWA: manifest, Service Worker i działanie po przeładowaniu bez internetu', async ({ page, context }) => {
  await login(page, 'Akuro');
  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('.big-tile.online')).toBeVisible();
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  // aplikacja startuje z cache, dane z telefonu, komunikat o braku sieci
  await expect(page.locator('.big-tile.offline')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#banner')).toContainText('Brak internetu');
  // dane API nie trafiają do cache Service Workera
  const cachedApi = await page.evaluate(async () => {
    const keys = await caches.keys();
    let n = 0;
    for (const k of keys) n += (await (await caches.open(k)).keys()).filter((r) => r.url.includes('/api/')).length;
    return n;
  });
  expect(cachedApi).toBe(0);
  await context.setOffline(false);
});

test('mecz offline → „Kontynuuj online”: pokój z zarezerwowanymi miejscami, ten sam mecz', async ({ page }) => {
  await login(page, 'Kamil');
  const id = await newMatch(page);
  await addRound(page, 0, 20);
  await expect.poll(() => queueLen(page)).toBe(0);
  await page.click('[data-act=menu]');
  await page.click('.modal button:has-text("Kontynuuj online")');
  await expect(page.locator('.room-code')).toBeVisible();
  await expect(page.locator('.eyebrow').first()).toHaveText('Kontynuacja meczu');
  await expect(page.locator('.lseat.me')).toHaveCount(1); // automatycznie na swoim miejscu
  await expect(page.locator('.lseat').nth(1)).toContainText('jeszcze nie dołączył');
  // powrót do trybu offline z poczekalni
  await page.click('[data-act=detach]');
  await page.click('.modal button:has-text("Przejdź")');
  await expect(page).toHaveURL(new RegExp('#/match/' + id));
  await expect(page.locator('.lrow:not(.head)')).toHaveCount(1);
});

test('orientacja pozioma telefonu: stół offline i dock bez nakładania', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })).newPage();
  await login(page, 'Karol');
  await newMatch(page);
  await addRound(page, 1, 40);
  await page.screenshot({ path: 'test-results/screens/phone-landscape-table.png' });
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  expect(o.sw).toBeLessThanOrEqual(o.w + 1);
  await page.click('#cta [data-act=add]');
  await page.locator('.pbtn').first().click();
  await page.click('[data-act=collapse]');
  await page.waitForTimeout(450);
  const save = await page.locator('[data-act=save]').boundingBox();
  expect(save.y + save.height).toBeLessThanOrEqual(391);
  await page.screenshot({ path: 'test-results/screens/phone-landscape-sheet.png' });
});

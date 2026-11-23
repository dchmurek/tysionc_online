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

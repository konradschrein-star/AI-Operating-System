import pw from '/opt/hermes-workspace/node_modules/playwright/index.js';
const { chromium } = pw;

const shots = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox'] });
for (const mode of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 620 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`file:///tmp/sh/live-${mode}.html`);
  await page.waitForSelector('[data-settings-surface]');

  // depth 0 — the index
  await page.screenshot({ path: `/tmp/sh/shot-${mode}-index.png` });

  // drill into ACCOUNTS via the section list
  await page.getByRole('button', { name: /ACCOUNTS/ }).first().click();
  await page.waitForTimeout(300);
  const drilled = await page.getAttribute('[data-settings-surface]', 'data-settings-section');
  const hasBack = await page.locator('[data-nav-back]').count();
  const drillAnim = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.nav-drill')).animationName);
  await page.screenshot({ path: `/tmp/sh/shot-${mode}-accounts.png` });

  // SECRETS — the embedded page. Verify the chrome override actually bit.
  await page.getByRole('button', { name: /SECRETS/ }).first().click();
  await page.waitForTimeout(300);
  const embed = await page.evaluate(() => {
    const host = document.querySelector('[data-settings-embed="secrets"]');
    if (!host) return { present: false };
    const inner = host.firstElementChild?.nextElementSibling ?? host.firstElementChild;
    const cs = getComputedStyle(inner);
    return {
      present: true,
      minHeight: cs.minHeight,
      padding: cs.padding,
      backLinksVisible: [...host.querySelectorAll('a[href="/settings"]')]
        .filter((a) => getComputedStyle(a).display !== 'none').length,
      h1sVisible: [...host.querySelectorAll('h1')]
        .filter((h) => getComputedStyle(h).display !== 'none').length,
      viewportHeight: window.innerHeight,
      hostHeight: host.getBoundingClientRect().height,
    };
  });
  await page.screenshot({ path: `/tmp/sh/shot-${mode}-secrets.png` });

  // back — same button the worker chats use
  await page.locator('[data-nav-back]').click();
  await page.waitForTimeout(250);
  const backTo = await page.getAttribute('[data-settings-surface]', 'data-settings-section');

  shots.push({ mode, drilled, hasBack, drillAnim, embed, backTo, errs });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(shots, null, 2));

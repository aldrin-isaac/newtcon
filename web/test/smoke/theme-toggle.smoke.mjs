// Browser smoke: dark theme (uplift 3.2, #415).
//   1. Default follows prefers-color-scheme (emulated dark → data-theme=dark).
//   2. The sidebar-footer toggle flips the theme and actually restyles
//      (body background changes).
//   3. The explicit choice persists across reload (localStorage), beating
//      the system preference.
// Lab-independent.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // 1. System preference is the default when nothing is stored.
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 30000 });
  // Gate on the theme stamp: initTheme() sets data-theme and setupThemeToggle
  // wires the button in the same synchronous boot block — once the stamp is
  // there, the toggle is live (under suite load, boot can lag navigation).
  await page.waitForFunction(() => !!document.documentElement.dataset.theme, { timeout: 30000 });
  expect(await theme() === "dark", "emulated dark system preference boots dark");
  const darkBg = await bodyBg();

  // 2. Toggle flips to light and restyles.
  await page.click("#theme-toggle");
  expect(await theme() === "light", "toggle flips data-theme to light");
  const lightBg = await bodyBg();
  expect(darkBg !== lightBg, `background actually changes (${darkBg} → ${lightBg})`);
  const label = await page.evaluate(() => document.getElementById("theme-toggle-label")?.textContent);
  expect(label === "Dark theme", `toggle now advertises the other theme (label: ${JSON.stringify(label)})`);

  // 3. The explicit choice persists across reload, beating the system pref.
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForFunction(() => !!document.documentElement.dataset.theme, { timeout: 30000 });
  expect(await theme() === "light", "explicit light choice survives reload under a dark system preference");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

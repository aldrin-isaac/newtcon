// Browser smoke: keyboard-focus presence (uplift 3.4, #417).
//   1. Tabbing through the app always lands on a visibly-ringed element
//      (universal :focus-visible baseline — nothing interactive is ringless).
//   2. Mouse clicks stay clean (no ring — :focus-visible semantics).
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
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".specs-subnav", { timeout: 30000 });

  // 1. Every Tab stop is visibly focused: ring OR an intentional
  //    background-highlight override (e.g. .spec-row).
  const probe = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const ringed = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const bgHighlight = el.classList.contains("spec-row");
    return { desc: el.id || el.className?.toString().slice(0, 40), visible: ringed || bgHighlight };
  });
  let checked = 0, allVisible = true, firstBad = "";
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const r = await probe();
    if (!r) continue;
    checked++;
    if (!r.visible && !firstBad) { allVisible = false; firstBad = r.desc; }
  }
  expect(checked >= 8, `tab walk reached interactive elements (${checked} stops)`);
  expect(allVisible, firstBad ? `every stop visibly focused (first ringless: ${firstBad})` : "every stop visibly focused");

  // 2. Mouse click never rings.
  await page.click("#tab-topology");
  const afterClick = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(afterClick === "none", `mouse click stays ringless (outline: ${afterClick})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

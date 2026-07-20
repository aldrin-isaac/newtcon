// Browser smoke: drawer pinned mini-header (uplift 6.2, #445).
//   1. Opening a device drawer puts the device name + a substrate status
//      chip into the FIXED drawer header (outside the scroll area).
//   2. It survives a tab switch (Debug) and a deep content scroll.
// Network-agnostic; opens via canvas click (robust under engine flaps).

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await gotoApp(page, `${BASE}/#/${NET}/topology`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".topo-node", { timeout: 60000 });

  const device = await page.evaluate(() => {
    const g = document.querySelector(".topo-node");
    g?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return g?.getAttribute("data-device");
  });
  await page.waitForSelector("#detail-drawer.open", { timeout: 30000 });
  await sleep(500);

  const crumb = await page.evaluate(() => document.querySelector("#drawer-breadcrumb .crumb-main")?.textContent);
  expect(crumb === device, `fixed header carries the device name (${crumb})`);
  let chip = false;
  try {
    await page.waitForSelector(".drawer-mini-status .status-dot", { timeout: 20000 });
    chip = true;
  } catch { /* substrate probe may be slow — chip presence asserted below */ }
  expect(chip, "substrate status chip filled in");

  await page.evaluate(() => [...document.querySelectorAll(".node-tab, .subtab, [role=tab]")].find((t) => t.textContent.trim() === "Debug")?.click());
  await sleep(600);
  await page.evaluate(() => { const c = document.getElementById("drawer-content"); c.scrollTop = c.scrollHeight; });
  await sleep(300);
  const after = await page.evaluate(() => {
    const bc = document.getElementById("drawer-breadcrumb");
    const r = bc.getBoundingClientRect();
    return { text: bc.querySelector(".crumb-main")?.textContent, pinned: r.top >= 0 && r.top < 100, chipStill: !!bc.querySelector(".drawer-mini-status .status-dot") };
  });
  expect(after.text === device && after.pinned, "mini-header pinned through tab switch + deep scroll");
  expect(after.chipStill, "status chip survives too");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

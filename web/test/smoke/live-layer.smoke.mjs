// Browser smoke: live layer (uplift 4.4, #424).
//   1. NO RATES fetches happen while the Live lens is off (the poll gate).
//   2. Enabling Live starts the poll, bounded: per tick, at most one RATES
//      call per online device.
//   3. Disabling Live stops the poll and clears heat classes.
// Uses a page-context fetch counter (interception drops auth cookies).

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
  await page.evaluateOnNewDocument((n) => {
    try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ }
    const orig = window.fetch;
    window.__ratesCalls = 0;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.includes("/db/COUNTERS_DB/RATES")) window.__ratesCalls += 1;
      return orig.call(window, input, init);
    };
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await gotoApp(page, `${BASE}/#/${NET}/topology`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".topo-node", { timeout: 60000 });

  // 1. Gate: six quiet seconds with the lens off → zero RATES calls.
  await sleep(6000);
  const gated = await page.evaluate(() => window.__ratesCalls);
  expect(gated === 0, `no RATES fetches while Live lens is off (${gated})`);

  const click = (label) => page.evaluate((l) => {
    [...document.querySelectorAll(".topology-lens-row .chip")].find((c) => c.textContent.trim() === l)?.click();
  }, label);

  // 2. Live on: two tick-windows; calls bounded by online devices per tick.
  await click("Live");
  await sleep(11000);
  const during = await page.evaluate(() => window.__ratesCalls);
  const online = await page.evaluate(() => document.querySelectorAll(".topo-node.topo-elem--actuated-ok, .topo-node.topo-elem--actuated-down, .topo-node.topo-elem--drift").length);
  // ≤ 3 tick-windows worth (immediate + 2 interval) for the online fleet.
  expect(during <= Math.max(online, 1) * 3, `poll bounded (${during} calls, ${online} online devices, ≤3 ticks)`);
  if (online === 0) expect(during === 0, "no online devices → zero RATES calls even with Live on");
  else expect(during > 0, `Live lens actually polls (${during} calls)`);

  // 3. Off: calls stop, heat classes clear.
  await click("Live");
  const atOff = await page.evaluate(() => window.__ratesCalls);
  await sleep(7000);
  const after = await page.evaluate(() => window.__ratesCalls);
  expect(after === atOff, `poll stops when Live turns off (${atOff} → ${after})`);
  expect(await page.evaluate(() => document.querySelectorAll("[class*='topo-link--heat-']").length) === 0,
    "heat classes cleared on lens off");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

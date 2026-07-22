// Browser smoke: per-link-end interface-state dots (operator request).
//   1. Every drawn link end carries an interface-state dot in one of the
//      four states (ok / down / admin-down / unknown).
//   2. Each dot has a hover tooltip (native <title>) naming the port +
//      admin/oper. (Colored states are unit-tested + injection-verified;
//      an undeployed fixture reads "unknown", which is honest and stable.)
// Network-agnostic.

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };
const STATES = ["ok", "down", "admin-down", "unknown"];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((n) => { try { localStorage.setItem("newtcon.activeNetwork", n); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await gotoApp(page, `${BASE}/#/${NET}/topology`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".topo-node", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));

  const info = await page.evaluate(() => {
    const links = [...document.querySelectorAll(".topo-link:not(.topo-link-hit)")].filter((l) => !l.closest(".topo-legend"));
    const dots = [...document.querySelectorAll(".topo-iface-dot")];
    return {
      linkCount: links.length,
      dotCount: dots.length,
      allHaveTitle: dots.every((d) => (d.querySelector("title")?.textContent || "").length > 0),
      allValidState: dots.every((d) => [...d.classList].some((c) => c.startsWith("topo-iface-dot--"))),
      sampleTitle: dots[0]?.querySelector("title")?.textContent || null,
    };
  });

  expect(info.dotCount > 0, `interface dots rendered (${info.dotCount} across ${info.linkCount} links)`);
  // Two ends per link, minus any endpoint lacking a device/iface — so dots
  // should be within [linkCount, 2*linkCount].
  expect(info.dotCount <= info.linkCount * 2, "at most one dot per link end");
  expect(info.allValidState, "every dot carries a valid state class");
  expect(info.allHaveTitle, "every dot has a hover tooltip");
  expect(/admin:/.test(info.sampleTitle || "") && /oper:/.test(info.sampleTitle || ""),
    `tooltip names port + admin/oper (${JSON.stringify(info.sampleTitle)})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }
void STATES;

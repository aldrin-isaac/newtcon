// Browser smoke: focus mode + fabric-health strip (uplift 4.5, #425).
//   1. The fabric-health strip is visible on a NON-topology tab (Specs).
//   2. Keyboard-focusing a device dims only non-neighbors.
//   3. Arrow keys walk between nodes; Esc restores the full canvas.
// Network-agnostic (neighbor sets derived from whatever topology renders).

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

  // 1. Strip is topology-scoped (re-homed): absent from the Specs tab,
  //    present with all three cells in the topology header bar.
  await gotoApp(page, `${BASE}/#/${NET}/specs`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(1000);
  expect(await page.evaluate(() => !document.querySelector(".app-header .fabric-strip")),
    "no fabric strip in the global header");

  // 2. Focus mode (+ the strip's topology home).
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 60000 });
  let stripCells = 0;
  try {
    await page.waitForFunction(() => document.querySelectorAll(".topology-header-bar .fabric-strip-cell").length === 3, { timeout: 45000 });
    stripCells = 3;
  } catch { stripCells = await page.evaluate(() => document.querySelectorAll(".topology-header-bar .fabric-strip-cell").length); }
  expect(stripCells === 3, `fabric-health strip shows all three cells in the topology header (${stripCells})`);
  await sleep(500);
  const first = await page.evaluate(() => {
    const g = document.querySelector(".topo-node");
    g?.focus();
    return g?.getAttribute("data-device");
  });
  await sleep(300);
  // Shape-independent: compute the EXPECTED dim set from the rendered links
  // (non-neighbors of the focused device) and compare exactly — a hub node
  // in a small fixture legitimately dims nobody.
  const dimCheck = await page.evaluate((f) => {
    const neighbors = new Set([f]);
    for (const l of document.querySelectorAll(".topo-link:not(.topo-link-hit)")) {
      if (l.closest(".topo-legend")) continue;
      const a = l.getAttribute("data-local-device"), z = l.getAttribute("data-remote-device");
      if (a === f && z) neighbors.add(z);
      if (z === f && a) neighbors.add(a);
    }
    const expected = [...document.querySelectorAll(".topo-node")]
      .map((g) => g.getAttribute("data-device"))
      .filter((d) => d && !neighbors.has(d)).sort();
    const actual = [...document.querySelectorAll(".topo-node--focus-dimmed")]
      .map((g) => g.getAttribute("data-device")).sort();
    return { expected: expected.join(","), actual: actual.join(",") };
  }, first);
  expect(dimCheck.expected === dimCheck.actual,
    `dim set is exactly the non-neighbors (expected [${dimCheck.expected}] got [${dimCheck.actual}])`);
  expect(await page.evaluate((f) => !document.querySelector(`.topo-node[data-device="${f}"]`).classList.contains("topo-node--focus-dimmed"), first),
    "the focused device itself is never dimmed");

  // 3. Arrow nav (try all four directions — any move counts; a single-file
  // layout has no candidate in some directions) + Esc.
  let moved = null;
  for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
    await page.keyboard.press(key);
    await sleep(200);
    const now = await page.evaluate(() => document.activeElement?.getAttribute("data-device") ?? null);
    if (now && now !== first) { moved = `${key}: ${first} → ${now}`; break; }
  }
  const nodeCount = await page.evaluate(() => document.querySelectorAll(".topo-node").length);
  expect(nodeCount < 2 || moved !== null, moved ? `arrow nav moves focus (${moved})` : "arrow nav (single node — nothing to walk)");
  await page.keyboard.press("Escape");
  await sleep(300);
  expect(await page.evaluate(() => document.querySelectorAll(".topo-node--focus-dimmed").length) === 0,
    "Esc restores the full canvas");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

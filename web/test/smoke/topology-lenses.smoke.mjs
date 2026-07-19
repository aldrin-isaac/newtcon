// Browser smoke: topology lenses (uplift 4.3, #423).
//   1. The lens chip row renders (VNI / Underlay / Drift).
//   2. Toggling every lens on and off NEVER moves a node — the
//      layout-stability DoD.
//   3. The drift lens actually re-weights (dim/halo counts change vs no-lens)
//      and turning it off restores the calm canvas exactly.
// Network-agnostic: runs on any topology with nodes.

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
  await sleep(500);

  const chips = await page.evaluate(() => [...document.querySelectorAll(".topology-lens-row .chip")].map((c) => c.textContent.trim()));
  expect(chips.includes("VNI") && chips.includes("Underlay") && chips.includes("Drift"),
    `lens chips present (${chips.join(", ")})`);

  const state = () => page.evaluate(() => ({
    layout: [...document.querySelectorAll(".topo-node > rect:not(.topo-node-halo):not(.topo-node-selection-ring)")].map((r) => `${r.getAttribute("x")},${r.getAttribute("y")}`).join("|"),
    dimmed: document.querySelectorAll(".topo-node--dimmed").length,
    halos: document.querySelectorAll(".topo-node-halo").length,
  }));
  const click = (label) => page.evaluate((l) => {
    [...document.querySelectorAll(".topology-lens-row .chip")].find((c) => c.textContent.trim() === l)?.click();
  }, label);

  const before = await state();
  let layoutStable = true;
  for (const lens of ["VNI", "Underlay", "Drift"]) {
    await click(lens); await sleep(300);
    const on = await state();
    if (on.layout !== before.layout) layoutStable = false;
    await click(lens); await sleep(300);
  }
  expect(layoutStable, "layout identical through every lens toggle");

  await click("Drift"); await sleep(300);
  const driftOn = await state();
  expect(driftOn.dimmed + driftOn.halos > 0, `drift lens re-weights the canvas (dim ${driftOn.dimmed}, halo ${driftOn.halos})`);
  await click("Drift"); await sleep(300);
  const after = await state();
  expect(after.dimmed === before.dimmed && after.halos === before.halos && after.layout === before.layout,
    "lens off restores the canvas exactly");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

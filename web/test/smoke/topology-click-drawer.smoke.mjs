// Browser smoke: the docked action panel is retired — in Spec view a single
// left-click on a device opens the device drawer (the single home for inspection
// + per-port/interface config), and link/node creation lives on the toolbar.
// Network-agnostic (DEVICE env override).

import puppeteer from "puppeteer-core";
import { authenticatePage, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 } });
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((net) => {
    try { localStorage.setItem("newtcon.activeNetwork", net); localStorage.setItem("newtcon:topology-view:" + net, "spec"); } catch { /* */ }
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 60000 });
  await sleep(300);

  // The docked action panel is gone.
  expect(await page.evaluate(() => !document.querySelector(".topo-action-panel")),
    "docked action panel is retired (no .topo-action-panel)");

  // Link creation lives on the toolbar; NODE creation moved to Specs → Nodes
  // (#353/#369 — the canvas no longer creates or deletes nodes).
  const toolbar = await page.evaluate(() => Array.from(document.querySelectorAll(".topology-toolbar-btn")).map((b) => b.textContent.trim()));
  expect(!toolbar.some((t) => /Create node/.test(t)), `toolbar has no "+ Create node" — creation lives in Specs (${JSON.stringify(toolbar)})`);
  expect(toolbar.some((t) => /Add link/.test(t)), `toolbar has "+ Add link" — the link-creation home (${JSON.stringify(toolbar)})`);

  // Single LEFT-click a device (Spec view) → the drawer opens.
  await page.evaluate((dev) => document.querySelector(`g.topo-node[data-device='${dev}']`)?.dispatchEvent(new MouseEvent("click", { bubbles: true })), DEVICE);
  await page.waitForFunction(() => {
    const d = document.getElementById("detail-drawer");
    return d && d.getAttribute("aria-hidden") === "false";
  }, { timeout: 20000 }).then(() => expect(true, "left-click a device opens the drawer"))
    .catch(() => expect(false, "left-click a device opens the drawer (drawer did not open)"));

  // The drawer is the device drawer (has the node tab strip).
  expect(await page.evaluate(() => !!document.querySelector(".node-tabs")),
    "drawer is the device drawer (node tab strip present)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error("threw:", e.message); process.exitCode = 1; } finally { await browser.close(); }

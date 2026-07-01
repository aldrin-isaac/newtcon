// Browser smoke: the State tab renders LAGs (curated table + status pills) and
// Neighbors (device health-checks → status table). Self-contained for LAGs
// (creates a port-channel, verifies, deletes); Neighbors is read live.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "2node-vs-service";
const rpc = (sub, body) => fetch(`${BASE}/api/networks/${NET}/nodes/switch1/rpc/${sub}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

async function sectionText(page, title) {
  await page.evaluate((t) => {
    const det = Array.from(document.querySelectorAll(".node-state-section")).find((d) => d.querySelector(".node-state-section-title")?.textContent.trim() === t);
    if (det && !det.open) det.querySelector("summary")?.click();
  }, title);
  await page.waitForFunction((t) => {
    const det = Array.from(document.querySelectorAll(".node-state-section")).find((d) => d.querySelector(".node-state-section-title")?.textContent.trim() === t);
    const b = det?.querySelector(".node-state-section-body");
    return b && !/Loading/.test(b.textContent || "");
  }, { timeout: 6000 }, title);
  await sleep(150);
  return page.evaluate((t) => {
    const det = Array.from(document.querySelectorAll(".node-state-section")).find((d) => d.querySelector(".node-state-section-title")?.textContent.trim() === t);
    return { text: det?.querySelector(".node-state-section-body")?.textContent || "", table: !!det?.querySelector(".resource-table"), pill: !!det?.querySelector(".resource-pill") };
  }, title);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  await rpc("create-portchannel", { name: "PortChannel99", mtu: 9100 });

  const page = await browser.newPage();

  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((net) => { try { localStorage.setItem("newtcon.activeNetwork", net); localStorage.setItem("newtcon:topology-view:" + net, "spec"); } catch { /* */ } }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 10000 });
  await page.evaluate(() => document.querySelector(".topo-node")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })));
  await page.waitForSelector(".topo-menu-header--button", { timeout: 6000 });
  await page.evaluate(() => document.querySelector(".topo-menu-header--button")?.click());
  await page.waitForSelector(".node-tabs", { timeout: 6000 });
  await page.evaluate(() => Array.from(document.querySelectorAll("button.node-tab")).find((b) => b.textContent.trim() === "State")?.click());
  await page.waitForSelector(".node-state-section", { timeout: 6000 });

  const lags = await sectionText(page, "LAGs");
  expect(lags.table && /LAG/.test(lags.text) && /Members/.test(lags.text), `LAGs: curated table (LAG/Members columns)`);
  expect(/PortChannel99/.test(lags.text), `LAGs: shows the created port-channel`);
  expect(lags.pill, `LAGs: admin/oper rendered as status pills`);

  const nbr = await sectionText(page, "Neighbors");
  expect(nbr.table && /Status/.test(nbr.text) && /Check/.test(nbr.text), `Neighbors: health-check status table (Status/Check columns)`);
  expect(nbr.pill, `Neighbors: status rendered as a pill`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error("threw:", e.message);
  process.exitCode = 1;
} finally {
  try { await rpc("delete-portchannel", { name: "PortChannel99" }); } catch { /* */ }
  await browser.close();
}

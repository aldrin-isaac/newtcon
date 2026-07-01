// Browser smoke: the device drawer's State tab leads with the resource lens —
// services provisioned on the device, grouped by service → the interfaces they
// are applied to. Self-contained: injects a declared apply-service step via the
// API, verifies the lens, then reverts.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEV = "switch1";
const api = (p) => `${BASE}/api/networks/${NET}/${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

async function getDevice() {
  const t = await (await fetch(api("topology"))).json();
  return (t.nodes ?? {})[DEV] ?? {};
}
async function putDevice(dev) {
  await fetch(api(`topology/nodes/${DEV}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dev) });
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
let original = null;
try {
  // Setup: add a declared apply-service step (params.service survives the PUT).
  const dev = await getDevice();
  original = JSON.parse(JSON.stringify(dev));
  dev.steps = [...(dev.steps ?? []), { url: "/interfaces/Ethernet0/apply-service", params: { service: "EVPNIRB", vlan: "100", ip_address: "10.50.0.1/24" } }];
  await putDevice(dev);

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
  await page.waitForSelector(".node-state-section--services", { timeout: 6000 });
  await page.waitForFunction(() => /EVPNIRB/.test(document.querySelector(".node-state-section--services")?.textContent || ""), { timeout: 6000 });
  await sleep(200);

  const txt = await page.evaluate(() => document.querySelector(".node-state-section--services")?.textContent || "");
  expect(/Services/.test(txt), "State tab leads with a Services resource-lens section");
  expect(/EVPNIRB/.test(txt), "lens shows the provisioned service (EVPNIRB)");
  // One card per distinct service applied to the device (state-dependent: the
  // node may carry an overlay + an underlay), so assert ≥1 rather than a fixed
  // count.
  const cards = await page.evaluate(() => document.querySelectorAll(".svc-lens-card").length);
  expect(cards >= 1, `a card per applied service (${cards})`);
  const ifaces = await page.evaluate(() => Array.from(document.querySelectorAll(".svc-lens-table td.iface-name")).map((e) => e.textContent.trim()));
  expect(ifaces.includes("Ethernet0"), `lists the interface the service is applied to (${ifaces.join(",")})`);
  const hasIp = await page.evaluate(() => /10\.50\.0\.1\/24/.test(document.querySelector(".svc-lens-table")?.textContent || ""));
  expect(hasIp, "shows per-interface params (IP)");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error("threw:", e.message);
  process.exitCode = 1;
} finally {
  if (original) { try { await putDevice(original); } catch { /* */ } }  // teardown
  await browser.close();
}

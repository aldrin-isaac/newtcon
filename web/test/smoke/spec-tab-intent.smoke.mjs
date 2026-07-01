// Browser smoke: the device drawer's Spec tab shows the topology.json declared
// intent — provisioning steps + per-port config — not just the profile.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "3node-vs-newtcon";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});

try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  // Pin the network + spec view mode (the right-click menu wires Inspect → drawer in spec mode).
  await page.evaluateOnNewDocument((net) => {
    try {
      localStorage.setItem("newtcon.activeNetwork", net);
      localStorage.setItem("newtcon:topology-view:" + net, "spec");
    } catch { /* */ }
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 10000 });

  // Right-click the node → floating menu → Inspect (header button) → drawer.
  await page.evaluate(() => document.querySelector(".topo-node")
    ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })));
  await page.waitForSelector(".topo-menu-header--button", { timeout: 6000 });
  await page.evaluate(() => document.querySelector(".topo-menu-header--button")?.click());
  await page.waitForSelector(".node-tabs", { timeout: 6000 });

  // Open the Spec tab.
  await page.evaluate(() => Array.from(document.querySelectorAll("button.node-tab"))
    .find((b) => b.textContent.trim() === "Spec")?.click());
  await page.waitForFunction(
    () => /Topology intent/.test(document.querySelector(".node-tab-panel--spec")?.textContent || ""),
    { timeout: 6000 });
  await sleep(300);

  const txt = await page.evaluate(() => document.querySelector(".node-tab-panel--spec")?.textContent || "");
  expect(/Device profile/.test(txt), "Spec tab shows the Device profile section");
  expect(/Topology intent/.test(txt), "Spec tab shows the Topology intent section");
  expect(/Provisioning steps/.test(txt) && /Setup device/.test(txt), "shows provisioning steps (Setup device)");
  expect(/bgp_asn/.test(txt) && /65001/.test(txt), "shows step fields from topology.json (bgp_asn 65001)");
  const ports = await page.evaluate(() => document.querySelectorAll(".node-spec-port-table tbody tr").length);
  expect(ports > 0, `shows the port-config table (${ports} ports)`);
  const order = await page.evaluate(() => Array.from(document.querySelectorAll(".node-spec-port-name"))
    .slice(0, 4).map((e) => e.textContent.trim()));
  expect(order.length < 4 || JSON.stringify(order) === JSON.stringify(["Ethernet0", "Ethernet4", "Ethernet8", "Ethernet12"]),
    `ports numerically ordered (${order.join(",")})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error("threw:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

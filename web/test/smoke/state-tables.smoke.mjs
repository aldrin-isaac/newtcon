// Browser smoke: the State tab renders VRFs / VLANs / ACLs as curated tailored
// tables (not the raw auto-table). Self-contained: creates one of each via the
// device RPCs, verifies the columns + values, then deletes them.

import puppeteer from "puppeteer-core";
import { authenticatePage, skipIfNotDeployed } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const rpc = (sub, body) => fetch(`${BASE}/api/networks/${NET}/nodes/switch1/rpc/${sub}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const expect = (c, m) => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.error("  FAIL:", m); } };

async function expandSection(page, title) {
  await page.evaluate((t) => {
    const det = Array.from(document.querySelectorAll(".node-state-section"))
      .find((d) => d.querySelector(".node-state-section-title")?.textContent.trim() === t);
    det?.querySelector("summary")?.click();
  }, title);
}

await skipIfNotDeployed(NET, "switch1");
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 950 } });
try {
  await rpc("create-vrf", { name: "Vrf_SMK" });
  await rpc("create-vlan", { id: 4000, description: "smk" });
  await rpc("create-acl", { name: "ACL_SMK", type: "L3", stage: "ingress", description: "smk" });

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

  for (const [title, header, value] of [["VRFs", "VRF", "Vrf_SMK"], ["VLANs", "VLAN", "4000"], ["ACLs", "Stage", "ACL_SMK"]]) {
    await expandSection(page, title);
    await page.waitForFunction((t) => {
      const det = Array.from(document.querySelectorAll(".node-state-section")).find((d) => d.querySelector(".node-state-section-title")?.textContent.trim() === t);
      return det?.querySelector(".resource-table");
    }, { timeout: 6000 }, title);
    await sleep(150);
    const txt = await page.evaluate((t) => {
      const det = Array.from(document.querySelectorAll(".node-state-section")).find((d) => d.querySelector(".node-state-section-title")?.textContent.trim() === t);
      return det?.querySelector(".resource-table")?.textContent || "";
    }, title);
    expect(txt.includes(header) && txt.includes(value), `${title}: tailored table with "${header}" column + "${value}" (${txt.replace(/\s+/g, " ").slice(0, 80)})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error("threw:", e.message);
  process.exitCode = 1;
} finally {
  try { await rpc("delete-vrf", { name: "Vrf_SMK" }); await rpc("delete-vlan", { id: 4000 }); await rpc("delete-acl", { name: "ACL_SMK" }); } catch { /* */ }
  await browser.close();
}

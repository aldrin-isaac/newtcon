// Browser smoke test for the topology side-panel UI.
// Requires newtcon-server at $NEWTCON_URL (default http://127.0.0.1:8082)
// and a newtron with at least 2 devices in topology.

import puppeteer from "puppeteer-core";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const failed = [];
function expect(cond, msg) {
  if (!cond) { failed.push(msg); console.error("FAIL:", msg); }
  else { console.log("  ok:", msg); }
}
async function shot(page, name) {
  const path = `/tmp/newtcon-smoke-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log("  📸", path);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("  [console.error]", msg.text());
  });

  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await shot(page, "p01-loaded");

  console.log("→ switch to Topology tab");
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 8000 });
  const nodeCount = await page.$$eval(".topo-node", (els) => els.length);
  expect(nodeCount >= 1, `topology has ≥1 node (got ${nodeCount})`);
  await shot(page, "p02-topology");

  // Side panel exists, initially empty
  const panel = await page.$(".topo-action-panel");
  expect(!!panel, "side action panel rendered");
  const emptyText = await page.$eval(".topo-action-panel-empty", (el) => el.textContent).catch(() => "");
  expect(/Click a device/.test(emptyText), `empty panel shows hint (got "${emptyText}")`);

  // ---- Click a device → panel shows actions + Save/Discard --------------
  console.log("→ click first device");
  await page.evaluate(() => {
    document.querySelector(".topo-node").dispatchEvent(
      new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const savebar = await page.$(".topo-action-panel-savebar");
  expect(!!savebar, "Save/Discard bar present on single-select");
  const saveText = await page.$eval(".topo-action-panel-savebar", (el) => el.textContent);
  expect(/Save changes/.test(saveText) && /Discard/.test(saveText),
    `bar has Save + Discard buttons (got "${saveText}")`);
  const ifaceCount = await page.$$eval(".topo-iface-chip", (els) => els.length);
  expect(ifaceCount > 0, `interface chips populated from topology (got ${ifaceCount})`);
  const groupCount = await page.$$eval(".topo-action-group", (els) => els.length);
  expect(groupCount >= 7, `action panel has ≥7 categories (got ${groupCount})`);
  await shot(page, "p03-single-select-panel");

  // ---- Open a group, see actions -------------------------------------
  console.log("→ open VLANs group");
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    const vlanGroup = groups.find((g) => /VLAN/.test(g.querySelector(".topo-action-group-summary")?.textContent ?? ""));
    if (vlanGroup) vlanGroup.setAttribute("open", "");
  });
  await new Promise((r) => setTimeout(r, 100));
  await shot(page, "p04-vlans-open");

  // ---- Click "Create VLAN" → inline form with VLAN ID + Name --------
  console.log("→ click Create VLAN");
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    const createVlan = items.find((it) => it.textContent.trim() === "Create VLAN");
    createVlan?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  const inlineForm = await page.$(".topo-inline-form");
  expect(!!inlineForm, "inline action form opens");
  const inlineLabels = await page.$$eval(".topo-inline-form .form-label", (els) => els.map((e) => e.textContent.trim()));
  expect(inlineLabels.some((l) => /VLAN ID/.test(l)), `inline form has VLAN ID field (got ${JSON.stringify(inlineLabels)})`);
  await shot(page, "p05-inline-form");

  // ---- Click interface chip → panel switches to interface actions ---
  console.log("→ click first interface chip");
  await page.evaluate(() => {
    document.querySelector(".topo-iface-chip")?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const ifKind = await page.$eval(".topo-action-panel-kind", (el) => el.textContent).catch(() => "");
  expect(ifKind === "Interface", `panel kind switches to Interface (got "${ifKind}")`);
  const ifGroups = await page.$$eval(".topo-action-group-summary", (els) => els.map((e) => e.textContent.trim()));
  expect(ifGroups.includes("Service"), "iface panel includes Service group");
  expect(ifGroups.includes("BGP"), "iface panel includes BGP group");
  expect(ifGroups.includes("QoS"), "iface panel includes QoS group");
  await shot(page, "p06-iface-panel");

  // ---- Click "Bind service" → form with service dropdown (autofill) -
  console.log("→ open Bind service form");
  await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    const svc = groups.find((g) => /Service/.test(g.querySelector(".topo-action-group-summary")?.textContent ?? ""));
    svc?.setAttribute("open", "");
  });
  await new Promise((r) => setTimeout(r, 50));
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    const bind = items.find((it) => it.textContent.trim() === "Bind service");
    bind?.closest("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 700)); // wait for autofill hydration
  const serviceField = await page.$(".topo-inline-form select");
  expect(!!serviceField, "service field is a dropdown (autofilled)");
  await shot(page, "p07-bind-service-autofill");

  // ---- Multi-select 2 devices → Link form ---------------------------
  if (nodeCount >= 2) {
    console.log("→ shift-click 2 devices");
    // Reset: click empty area
    await page.evaluate(() => {
      document.querySelector(".topology-graph-slot").click();
    });
    await new Promise((r) => setTimeout(r, 100));
    await page.evaluate(() => {
      const nodes = document.querySelectorAll(".topo-node");
      nodes[0].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      nodes[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await new Promise((r) => setTimeout(r, 300));
    const selectedCount = await page.$$eval(".topo-node--selected", (els) => els.length);
    expect(selectedCount === 2, `2 devices visually selected (got ${selectedCount})`);
    const linkSection = await page.$(".topo-action-panel-section--highlight");
    expect(!!linkSection, "Link section appears");
    const linkSelects = await page.$$eval(".topo-action-panel-section--highlight select",
      (els) => els.length);
    expect(linkSelects === 2, `link form has 2 interface dropdowns (got ${linkSelects})`);
    const linkOptionCounts = await page.$$eval(".topo-action-panel-section--highlight select",
      (els) => els.map((e) => e.querySelectorAll("option").length));
    expect(linkOptionCounts.every((n) => n > 1),
      `both dropdowns populated from topology (got ${JSON.stringify(linkOptionCounts)})`);
    await shot(page, "p08-multi-link");
  }

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else {
    console.log(`❌ ${failed.length} check(s) failed:`);
    for (const f of failed) console.log("  -", f);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

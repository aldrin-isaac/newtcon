// Browser smoke: configure a port's PHYSICAL properties from the device drawer's
// Interfaces tab — the "Properties" per-port action opens the schema-driven
// PortConfig form (admin_status/mtu/speed/…), stages a whole-device update, and
// applies via the workspace pending bar; verify the write-back landed in newtron.
//
// Port config used to live only in the Topology side panel's "Configure a port";
// it now lives in the drawer, the single home for per-port config (mode + service
// + physical properties). Network-agnostic: discovers device/port, restores state.

import puppeteer from "puppeteer-core";
import { authenticatePage, loginCookie, gotoApp } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = process.env.DEVICE || "switch1";
const PORT = process.env.PORT || "Ethernet0";
const _ck = await loginCookie(BASE);
const AUTH = _ck ? { Cookie: `${_ck.name}=${_ck.value}` } : {};

const failed = [], ok = [];
function expect(cond, msg) { if (!cond) { failed.push(msg); console.error("  FAIL:", msg); } else { ok.push(msg); console.log("  ok:", msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTopoPort() {
  const r = await fetch(`${BASE}/api/networks/${NET}/topology`, { headers: AUTH });
  if (!r.ok) return { _error: r.status };
  const body = await r.json();
  const dev = (body.data ?? body).nodes?.[DEVICE] ?? {};
  return dev.ports?.[PORT] ?? null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"], ignoreHTTPSErrors: true, defaultViewport: { width: 1500, height: 950 },
});
let ORIGINAL = null; // pre-smoke port state, restored in finally
try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((net) => {
    try { localStorage.setItem("newtcon.activeNetwork", net); localStorage.setItem("newtcon:topology-view:" + net, "spec"); } catch { /* */ }
    const inst = () => new MutationObserver(() => { const b = document.querySelector(".confirm-modal-btn--confirm"); if (b instanceof HTMLElement) b.click(); }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", inst); else inst();
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  ORIGINAL = await fetchTopoPort();

  console.log(`→ open ${BASE} (network ${NET})`);
  await gotoApp(page, BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 60000 });

  // Open the device drawer (right-click → Inspect) → Interfaces tab.
  console.log(`→ open ${DEVICE} drawer → Interfaces`);
  await page.evaluate((dev) => document.querySelector(`g.topo-node[data-device='${dev}']`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })), DEVICE);
  await page.waitForSelector(".topo-menu-header--button", { timeout: 20000 });
  await page.evaluate(() => document.querySelector(".topo-menu-header--button")?.click());
  await page.waitForSelector(".node-tabs", { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll("button.node-tab")).find((b) => b.textContent.trim() === "Interfaces")?.click());
  await page.waitForSelector(".iface-table tbody .iface-row", { timeout: 20000 });

  // Expand the target port row → click "Properties".
  console.log(`→ ${PORT} → Properties`);
  await page.evaluate((port) => {
    const row = Array.from(document.querySelectorAll(".iface-table tbody .iface-row"))
      .find((tr) => tr.querySelector(".iface-name")?.textContent.trim() === port);
    row?.click();
  }, PORT);
  await page.waitForFunction(() => { const d = document.querySelector(".iface-detail-row"); return d && !d.hidden; }, { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".iface-actions .iface-action-btn")).find((b) => /Properties/.test(b.textContent))?.click());
  await page.waitForSelector(".iface-portprops-form .schema-form", { timeout: 20000 });

  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".iface-portprops-form .schema-form [name]")).map((e) => e.getAttribute("name")));
  expect(
    fields.includes("admin_status") && fields.includes("mtu") && fields.includes("speed") && !fields.includes("port"),
    `Properties renders the PortConfig schema (fields: ${fields.join(",")}; 'port' correctly skipped)`,
  );

  // Fill admin_status=down, mtu=9000, then Queue.
  console.log("→ fill form + Queue");
  await page.evaluate(() => {
    const f = document.querySelector(".iface-portprops-form .schema-form");
    const as = f.querySelector('[name="admin_status"]'); as.value = "down"; as.dispatchEvent(new Event("change", { bubbles: true }));
    const mtu = f.querySelector('[name="mtu"]'); mtu.value = "9000"; mtu.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => Array.from(document.querySelectorAll(".iface-portprops-form .btn-primary")).find((b) => /Queue/.test(b.textContent))?.click());
  await sleep(400);
  expect(await page.evaluate(() => /\d+\s+pending/i.test(document.body.textContent || "")),
    "workspace pending bar reflects the staged port edit");

  // Apply via the workspace pending bar → apply-preview → Apply.
  console.log("→ Apply changes");
  await page.evaluate(() => document.getElementById("pending-bar-save")?.click());
  await page.waitForSelector(".apply-preview-card .btn-primary", { timeout: 20000 });
  await page.evaluate(() => Array.from(document.querySelectorAll(".apply-preview-card .btn-primary")).find((b) => /Apply/.test(b.textContent))?.click());
  await sleep(2500);

  // Verify newtron persisted the config (int mtu, admin down).
  const after = await fetchTopoPort();
  expect(after && after.mtu === 9000 && after.admin_status === "down",
    `newtron persisted ${PORT} config: ${JSON.stringify(after)}`);

  console.log("");
  console.log(`✅ ${ok.length} passed, ❌ ${failed.length} failed`);
  if (failed.length > 0) { for (const f of failed) console.log("  -", f); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  try {
    const topo = await (await fetch(`${BASE}/api/networks/${NET}/topology`, { headers: AUTH })).json();
    const dev = (topo.data ?? topo).nodes[DEVICE];
    if (ORIGINAL) dev.ports[PORT] = ORIGINAL; else delete dev.ports[PORT];
    await fetch(`${BASE}/api/networks/${NET}/topology/nodes/${DEVICE}`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify(dev),
    });
  } catch { /* */ }
  await browser.close();
}

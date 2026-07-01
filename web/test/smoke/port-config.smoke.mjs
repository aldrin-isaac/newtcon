// Browser smoke: drive the Topology "Configure a port" flow end-to-end —
// inventory picker → schema-driven PortConfig form → stage → per-device Apply →
// verify the whole-device write-back landed in newtron with the right shape.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const NET = process.env.NET || "smoke-fixture";
const DEVICE = "switch1";
const PORT = "Ethernet0";

const failed = [];
const ok = [];
function expect(cond, msg) {
  if (!cond) { failed.push(msg); console.error("  FAIL:", msg); }
  else { ok.push(msg); console.log("  ok:", msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTopoPort() {
  const r = await fetch(`${NEWTRON}/newtron/v1/networks/${NET}/topology`);
  if (!r.ok) return { _error: r.status };
  const body = await r.json();
  const dev = (body.data ?? body).nodes?.[DEVICE] ?? {};
  return dev.ports?.[PORT] ?? null;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});

try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  // Pin the active network + auto-accept inline confirm modals.
  await page.evaluateOnNewDocument((net) => {
    try { localStorage.setItem("newtcon.activeNetwork", net); } catch { /* */ }
    const install = () => new MutationObserver(() => {
      const btn = document.querySelector(".confirm-modal-btn--confirm");
      if (btn instanceof HTMLElement) btn.click();
    }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", install);
    else install();
  }, NET);
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`→ open ${BASE} (network ${NET})`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 10000 });

  // Select the device → action panel with the Interfaces tab.
  console.log(`→ select ${DEVICE}`);
  await page.evaluate(() => {
    document.querySelectorAll(".topo-node")[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".topo-portcfg", { timeout: 8000 });
  expect(true, "device panel shows the 'Configure a port' section");

  // Open the port-config section → picker loads from the platform inventory.
  console.log("→ open 'Configure a port' + wait for inventory");
  await page.evaluate(() => document.querySelector(".topo-portcfg-summary")?.click());
  await page.waitForFunction(
    () => (document.querySelector(".topo-portcfg-select")?.options.length ?? 0) > 1,
    { timeout: 8000 },
  );
  const portCount = await page.evaluate(() => document.querySelector(".topo-portcfg-select").options.length - 1);
  expect(portCount === 32, `picker populated from inventory (${portCount} ports; expected 32)`);

  // Pick the port → schema-driven PortConfig form renders.
  console.log(`→ pick ${PORT}`);
  await page.evaluate((port) => {
    const sel = document.querySelector(".topo-portcfg-select");
    sel.value = port;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, PORT);
  await page.waitForSelector(".topo-portcfg-form .schema-form", { timeout: 8000 });
  const fieldNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".topo-portcfg-form .schema-form [name]")).map((e) => e.getAttribute("name")));
  expect(
    fieldNames.includes("admin_status") && fieldNames.includes("mtu") && fieldNames.includes("speed") && !fieldNames.includes("port"),
    `form rendered from PortConfig schema (fields: ${fieldNames.join(",")}; 'port' correctly skipped)`,
  );

  // Fill admin_status=down, mtu=9000, speed=40G, then Queue.
  console.log("→ fill form + Queue");
  await page.evaluate(() => {
    const f = document.querySelector(".topo-portcfg-form .schema-form");
    const as = f.querySelector('[name="admin_status"]'); as.value = "down"; as.dispatchEvent(new Event("change", { bubbles: true }));
    const mtu = f.querySelector('[name="mtu"]'); mtu.value = "9000"; mtu.dispatchEvent(new Event("input", { bubbles: true }));
    const sp = f.querySelector('[name="speed"]'); sp.value = "40G"; sp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector(".topo-portcfg-form button.btn-primary")?.click());
  await sleep(400);

  // The queued op shows in the per-device queued list.
  const queued = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".topo-queued-item-label")).map((e) => e.textContent.trim()));
  expect(queued.some((t) => /ports on switch1/i.test(t)), `port edit staged + shown in queue (${JSON.stringify(queued)})`);

  // Apply via the per-device savebar; capture the whole-device PUT.
  console.log("→ Apply changes (per-device savebar)");
  const put = await page.evaluate(async () => {
    const orig = window.fetch;
    let captured = null;
    window.fetch = async (...args) => {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      const r = await orig(...args);
      if (url && url.includes("topology/nodes/") && (args[1]?.method === "PUT")) captured = { url, status: r.status };
      return r;
    };
    document.querySelector(".topo-action-panel-savebar .btn-primary")?.click();
    await new Promise((r) => setTimeout(r, 1500));
    window.fetch = orig;
    return captured;
  });
  expect(put && put.status >= 200 && put.status < 300, `Apply PUT the whole device (${JSON.stringify(put)})`);

  // Verify newtron persisted the config (int mtu, the values we set).
  const after = await fetchTopoPort();
  expect(after && after.mtu === 9000 && after.admin_status === "down" && after.speed === "40G",
    `newtron persisted ${PORT} config: ${JSON.stringify(after)}`);

  // Cleanup: restore the port to its pre-smoke state.
  console.log("→ cleanup (restore port)");
  const topo = await (await fetch(`${NEWTRON}/newtron/v1/networks/${NET}/topology`)).json();
  const dev = (topo.data ?? topo).nodes[DEVICE];
  dev.ports[PORT] = { admin_status: "up", mtu: 9100 };
  await fetch(`${BASE}/api/networks/${NET}/topology/nodes/${DEVICE}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dev),
  });

  console.log("");
  console.log(`✅ ${ok.length} passed, ❌ ${failed.length} failed`);
  if (failed.length > 0) { for (const f of failed) console.log("  -", f); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

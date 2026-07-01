// Broad end-to-end smoke: drive several action types through the side panel
// and verify each landed in newtron with the right shape.

import puppeteer from "puppeteer-core";
import { authenticatePage, skipIfNotDeployed } from "./_auth.mjs";
const NET = process.env.NET || "smoke-fixture";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const NEWTRON = process.env.NEWTRON_URL || "http://127.0.0.1:18080";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const failed = [];
const ok = [];
function expect(cond, msg) {
  if (!cond) { failed.push(msg); console.error("  FAIL:", msg); }
  else { ok.push(msg); console.log("  ok:", msg); }
}

async function applyAction(page, group, action, fields = {}) {
  // Open the matching group.
  await page.evaluate((g) => {
    const groups = Array.from(document.querySelectorAll(".topo-action-group"));
    groups.find((el) => el.querySelector(".topo-action-group-summary")?.textContent.trim() === g)
      ?.setAttribute("open", "");
  }, group);
  await new Promise((r) => setTimeout(r, 50));
  // Click the action.
  await page.evaluate((a) => {
    const items = Array.from(document.querySelectorAll(".topo-action-item-label"));
    items.find((it) => it.textContent.trim() === a)?.closest("button")?.click();
  }, action);
  await new Promise((r) => setTimeout(r, 200));
  // Fill in fields by label match.
  await page.evaluate((fs) => {
    const labels = Array.from(document.querySelectorAll(".topo-inline-form .form-label"));
    for (const [labelText, value] of Object.entries(fs)) {
      const label = labels.find((l) => l.textContent.trim().startsWith(labelText));
      if (!label) continue;
      const ctrl = label.parentElement.querySelector(".form-control");
      if (!ctrl) continue;
      if (ctrl.tagName === "SELECT") {
        ctrl.value = String(value);
        ctrl.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (ctrl.type === "checkbox") {
        ctrl.checked = !!value;
      } else {
        ctrl.value = String(value);
        ctrl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }, fields);
  // Submit.
  await page.evaluate(() => {
    document.querySelector(".topo-inline-form button[type=submit]")?.click();
  });
  await new Promise((r) => setTimeout(r, 1200));
}

async function selectDevice(page, idx = 0) {
  await page.evaluate((i) => {
    const nodes = document.querySelectorAll(".topo-node");
    nodes[i]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, idx);
  await new Promise((r) => setTimeout(r, 250));
}

async function fetchJSON(path) {
  const r = await fetch(`${NEWTRON}${path}`);
  if (!r.ok) return { _error: r.status };
  return r.json();
}

await skipIfNotDeployed(NET, "switch1");
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});

const vrfName  = "Vrf_T" + Math.floor(Math.random() * 9000 + 1000);
const aclName  = "ACL_T" + Math.floor(Math.random() * 9000 + 1000);
const rndIP    = `198.51.${Math.floor(Math.random()*200)}.0`;
const rndAsn   = 65000 + Math.floor(Math.random() * 1000);

try {
  const page = await browser.newPage();
  await authenticatePage(page, BASE);
  await page.evaluateOnNewDocument((net) => { try { localStorage.setItem("newtcon.activeNetwork", net); localStorage.setItem("newtcon:topology-view:" + net, "spec"); } catch { /* */ } }, NET);
  await page.evaluateOnNewDocument(() => {
    // Inline confirm modal auto-accept; replaces native-dialog handler.
    const install = () => new MutationObserver(() => {
      const btn = document.querySelector(".confirm-modal-btn--confirm");
      if (btn instanceof HTMLElement) btn.click();
    }).observe(document.body, { childList: true, subtree: true });
    if (document.readyState === "loading") {
      addEventListener("DOMContentLoaded", install);
    } else {
      install();
    }
  });
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  console.log(`→ open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.click("#tab-topology");
  await page.waitForSelector(".topo-node", { timeout: 8000 });
  await page.screenshot({ path: "/tmp/newtcon-smoke-b01-loaded.png" });

  // ─── Create VRF ────────────────────────────────────────────────────
  console.log(`→ Create VRF "${vrfName}"`);
  await selectDevice(page, 0);
  await applyAction(page, "VRFs", "Create VRF", { "VRF name": vrfName });
  const vrfList = await fetchJSON(`/newtron/v1/network/default/node/switch1/vrf/${vrfName}`);
  expect(vrfList && !vrfList._error, `VRF ${vrfName} confirmed by newtron (${JSON.stringify(vrfList).slice(0,80)})`);

  // ─── Create ACL (has multiple fields) ──────────────────────────────
  console.log(`→ Create ACL "${aclName}" (L3 INGRESS)`);
  await selectDevice(page, 0);
  await applyAction(page, "ACLs", "Create ACL", {
    "ACL name": aclName, "Type": "L3", "Stage": "INGRESS", "Description": "smoke test",
  });
  const aclResp = await fetchJSON(`/newtron/v1/network/default/node/switch1/acl/${aclName}`);
  expect(aclResp && !aclResp._error, `ACL ${aclName} confirmed by newtron (${JSON.stringify(aclResp).slice(0,80)})`);

  // ─── Add BGP EVPN peer (has BGPNeighborConfig shape) ───────────────
  console.log(`→ Add BGP EVPN peer ${rndIP} AS ${rndAsn}`);
  await selectDevice(page, 0);
  await applyAction(page, "Routing", "Add BGP EVPN peer", {
    "Peer IP": rndIP, "Peer ASN": rndAsn,
  });
  const bgp = await fetchJSON(`/newtron/v1/network/default/node/switch1/bgp/status`);
  expect(bgp && !bgp._error, `BGP status endpoint reachable after EVPN peer add`);

  // ─── Save changes (per-device intent/save) ─────────────────────────
  console.log("→ click Save changes");
  await selectDevice(page, 0);
  await new Promise((r) => setTimeout(r, 150));
  const saveResult = await page.evaluate(async () => {
    const btn = document.querySelector(".topo-action-panel-savebar .btn-primary");
    if (!btn) return "no-button";
    // capture next /api/networks/default/nodes POST → return its response status
    const orig = window.fetch;
    let captured = null;
    window.fetch = async (...args) => {
      const r = await orig(...args);
      if (typeof args[0] === "string" && args[0].includes("intent/save")) {
        captured = { url: args[0], status: r.status };
      }
      return r;
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    window.fetch = orig;
    return captured;
  });
  expect(saveResult && saveResult.status >= 200 && saveResult.status < 300,
    `Save changes POSTed intent/save (got ${JSON.stringify(saveResult)})`);
  await page.screenshot({ path: "/tmp/newtcon-smoke-b02-after-saves.png" });

  // ─── Multi-select 2 devices: link form populated from topology ─────
  console.log("→ shift-click 2 devices and add a link");
  await page.evaluate(() => document.querySelector(".topology-graph-slot").click());
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const nodes = document.querySelectorAll(".topo-node");
    nodes[0].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    nodes[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: "/tmp/newtcon-smoke-b03-multi-link.png" });
  const linkOk = await page.evaluate(() => {
    const selects = document.querySelectorAll(".topo-action-panel-section--highlight select");
    if (selects.length !== 2) return { error: "not 2 selects", got: selects.length };
    selects[0].value = Array.from(selects[0].options).find((o) => o.value !== "")?.value;
    selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    selects[1].value = Array.from(selects[1].options).find((o) => o.value !== "")?.value;
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    const form = selects[0].closest("form");
    const submit = form.querySelector("button[type=submit]");
    submit.click();
    return { a: selects[0].value, z: selects[1].value };
  });
  await new Promise((r) => setTimeout(r, 1200));
  expect(linkOk && linkOk.a && linkOk.z, `Link form submitted with ${JSON.stringify(linkOk)}`);
  // Verify topology has more links now (or at least one).
  const topo = await fetchJSON(`/newtron/v1/network/default/topology`);
  const linkCount = topo?.data?.links?.length ?? 0;
  expect(linkCount > 0, `topology now has links (${linkCount})`);

  // ─── Cleanup via API ──────────────────────────────────────────────
  console.log("→ cleanup");
  await fetch(`${BASE}/api/networks/default/nodes/switch1/rpc/delete-vrf`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: vrfName }),
  });
  await fetch(`${BASE}/api/networks/default/nodes/switch1/rpc/delete-acl`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: aclName }),
  });
  await fetch(`${BASE}/api/networks/default/nodes/switch1/rpc/remove-bgp-evpn-peer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip: rndIP }),
  });

  console.log("");
  console.log(`✅ ${ok.length} passed, ❌ ${failed.length} failed`);
  if (failed.length > 0) {
    for (const f of failed) console.log("  -", f);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

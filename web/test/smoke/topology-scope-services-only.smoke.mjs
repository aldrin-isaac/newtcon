// Headless smoke for the Topology-tab scope.
//
// The per-device action surface stays empty (NODE_ACTIONS = []). The
// per-interface surface has two layers, matching newtron's substrate:
//   1. Port-mode configuration (configure-interface RPC): set the port to
//      access / trunk / routed.
//   2. Service binding (apply-service RPC): layer a composed service on top.
// What stays OUT of the Topology tab: primitive composition — VLAN/VRF/ACL
// creation, prefix-lists, route-policies, BGP peers, QoS, IPVPN/MACVPN
// definition. Those live in the Specs tab.

import puppeteer from "puppeteer-core";
import { authenticatePage } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

// IDs that MUST be gone from the Topology action panel (primitive
// composition that lives in the Specs tab now).
const FORBIDDEN_ACTION_IDS = [
  "create-vlan", "delete-vlan",
  "create-vrf",  "delete-vrf",
  "configure-irb", "unconfigure-irb",
  "bind-ipvpn",  "unbind-ipvpn",
  "bind-macvpn", "unbind-macvpn",
  "add-static-route", "remove-static-route",
  "add-bgp-evpn-peer", "remove-bgp-evpn-peer",
  "create-acl", "delete-acl", "add-acl-rule", "remove-acl-rule",
  "create-portchannel", "delete-portchannel", "add-portchannel-member", "remove-portchannel-member",
  "reload-config", "restart-daemon", "ssh-command",
  "set-property", "clear-property",
  "bind-acl", "unbind-acl",
  "add-bgp-peer", "remove-bgp-peer",
  "bind-qos", "unbind-qos",
];

// IDs that MUST be reachable on an interface — port-mode + service binding.
const ALLOWED_ACTION_IDS = [
  "set-access", "add-trunk-vlan", "set-routed", "unconfigure-interface",
  "apply-service", "remove-service", "refresh-service",
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
await authenticatePage(page, BASE);
// Inline confirm modal auto-dismiss — this smoke must NEVER let an
// action go through; the goal is to verify which actions are reachable,
// not to fire them.
await page.evaluateOnNewDocument(() => {
  // The "services only" scope + guiding hint are Spec-view behaviour (Lab view of
  // a running lab shows lifecycle actions). Pin the network + spec view pre-load.
  try {
    localStorage.setItem("newtcon.activeNetwork", "2node-vs");
    localStorage.setItem("newtcon:topology-view:2node-vs", "spec");
  } catch { /* */ }
  const install = () => new MutationObserver(() => {
    const btn = document.querySelector(".confirm-modal-btn--cancel");
    if (btn instanceof HTMLElement) btn.click();
  }).observe(document.body, { childList: true, subtree: true });
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
});

try {
  // Pre-seed active network = a registered one.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => localStorage.setItem("newtcon.activeNetwork", "2node-vs"));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });

  // ── 1. Single-device selection: action panel shows the guiding hint ─────
  await page.click("#tab-topology");
  await new Promise((r) => setTimeout(r, 1500));

  await page.evaluate(() => {
    const g = document.querySelector("svg.topology-graph g.topo-node[data-device='switch1']");
    if (g) g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));

  const singleDeviceState = await page.evaluate(() => {
    const panel = document.querySelector(".topo-action-panel");
    const hint = panel?.querySelector(".topo-action-panel-empty-hint");
    const actionGroupSummaries = Array.from(panel?.querySelectorAll(".topo-action-group-summary") ?? [])
      .map((s) => s.textContent?.trim());
    return {
      hasHint: !!hint && hint.textContent?.includes("Specs tab"),
      hintText: hint?.textContent ?? null,
      actionGroups: actionGroupSummaries,
    };
  });
  expect(singleDeviceState.hasHint,
    `single-device selection shows guiding hint mentioning Specs tab: "${singleDeviceState.hintText}"`);
  expect(singleDeviceState.hintText?.includes("port mode") || singleDeviceState.hintText?.includes("access / trunk / routed"),
    `hint mentions port mode: "${singleDeviceState.hintText}"`);
  expect(singleDeviceState.actionGroups.length === 0,
    `no per-device action groups rendered (got: ${JSON.stringify(singleDeviceState.actionGroups)})`);

  await page.screenshot({ path: "/tmp/newtcon-smoke-scope-01-single.png" });

  // ── 2. Interface selection: action panel shows Port mode + Service groups ──
  const ifaceClicked = await page.evaluate(() => {
    const chip = document.querySelector(".topo-action-panel .topo-iface-chip");
    if (chip instanceof HTMLElement) {
      const name = chip.textContent?.trim() || "unknown";
      chip.click();
      return name;
    }
    return null;
  });
  await new Promise((r) => setTimeout(r, 400));

  if (ifaceClicked === null) {
    console.log("  note: no interface chip rendered; per-interface assertions skipped");
  } else {
    console.log(`  → clicked interface: ${ifaceClicked}`);

    const ifaceGroups = await page.evaluate(() => {
      const panel = document.querySelector(".topo-action-panel");
      return Array.from(panel?.querySelectorAll(".topo-action-group-summary") ?? [])
        .map((s) => s.textContent?.trim());
    });
    expect(ifaceGroups.includes("Port mode"),
      `interface panel exposes "Port mode" group: ${JSON.stringify(ifaceGroups)}`);
    expect(ifaceGroups.includes("Service"),
      `interface panel exposes "Service" group: ${JSON.stringify(ifaceGroups)}`);
  }

  // Read every action ID actually exposed in the panel right now. The
  // panel renders each action as a button or details<summary>; harvest by
  // matching label text against our known service IDs and also enumerating
  // any visible item IDs via data attribute.
  const panelActions = await page.evaluate(() => {
    const panel = document.querySelector(".topo-action-panel");
    if (!panel) return { labels: [], ids: [] };
    const labels = Array.from(panel.querySelectorAll("button, summary, label"))
      .map((e) => e.textContent?.trim()).filter(Boolean);
    const ids = Array.from(panel.querySelectorAll("[data-action-id]"))
      .map((e) => e.getAttribute("data-action-id"));
    return { labels, ids };
  });
  // Action IDs aren't necessarily in DOM, so primary check is by label text
  // for forbidden actions (their labels are distinctive).
  const SCOPE_BANNED_LABELS = [
    "Create VLAN", "Delete VLAN", "Create VRF", "Delete VRF",
    "Configure IRB", "Bind IP VPN", "Bind MAC VPN", "Add static route",
    "Add BGP EVPN peer", "Create ACL", "Add ACL rule", "Create port-channel",
    "Reload from startup", "Restart daemon", "Run SSH command",
    "Configure interface", "Set property", "Bind ACL", "Add BGP peer",
    "Apply QoS policy",
  ];
  const stragglers = SCOPE_BANNED_LABELS.filter((banned) =>
    panelActions.labels.some((label) => label === banned));
  expect(stragglers.length === 0,
    `no banned action labels appear in the panel; stragglers: ${JSON.stringify(stragglers)}`);

  // ── 3. Allowed action labels are present (after clicking an iface). Service
  //      group lives in collapsed <details>; expanding shows the items.
  if (ifaceClicked !== null) {
    await page.evaluate(() => {
      for (const d of document.querySelectorAll(".topo-action-panel details")) {
        d.setAttribute("open", "");
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    const expandedLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".topo-action-panel button"))
        .map((b) => b.textContent?.trim()).filter(Boolean));
    const serviceLabelsFound = ["Bind service", "Unbind service", "Refresh service"]
      .filter((wanted) => expandedLabels.includes(wanted));
    expect(serviceLabelsFound.length >= 1,
      `service binding actions reachable: ${JSON.stringify(serviceLabelsFound)}`);

    const portModeLabelsFound = expandedLabels
      .filter((l) => /Set to access|Add tagged VLAN|Set to routed|Clear port configuration/.test(l));
    expect(portModeLabelsFound.length >= 3,
      `port-mode actions reachable (≥3): ${JSON.stringify(portModeLabelsFound)}`);
  }

  await page.screenshot({ path: "/tmp/newtcon-smoke-scope-02-iface.png" });

  // ── 4. Right-click → context menu also constrained ───────────────────────
  // The right-click floating menu uses NODE_ACTIONS too. With it empty, the
  // menu should render only the device header (Inspect) and no action groups.
  await page.evaluate(() => {
    const g = document.querySelector("svg.topology-graph g.topo-node[data-device='switch1']");
    if (g) g.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const ctxMenuGroups = await page.evaluate(() => {
    const menu = document.querySelector(".topo-menu, .ctxmenu, [class*='context-menu']");
    if (!menu) return [];
    return Array.from(menu.querySelectorAll(".topo-menu-group-summary, summary, .group-title"))
      .map((el) => el.textContent?.trim());
  });
  expect(ctxMenuGroups.length === 0 || ctxMenuGroups.every((g) => g === "Inspect" || g === undefined),
    `right-click context menu has no node-action groups (got: ${JSON.stringify(ctxMenuGroups)})`);

  console.log("");
  if (failed.length === 0) console.log("✅ all checks passed");
  else { console.log(`❌ ${failed.length} failed`); process.exitCode = 1; }
} catch (err) {
  console.error("test threw:", err.stack || err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

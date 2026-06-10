// Headless smoke for the topology-tab scope contraction.
//
// Verifies that the per-device + per-interface action surface in the Topology
// tab is restricted to "apply a pre-composed service" — no VLAN/VRF/ACL/etc
// primitives. Service composition lives in the Specs tab; the Topology tab
// only binds/unbinds/refreshes services on interfaces.

import puppeteer from "puppeteer-core";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8082";
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";

const ok = [], failed = [];
function expect(c, m) { (c ? ok : failed).push(m); console.log((c ? "  ok:  " : "  FAIL:") + m); }

// IDs that MUST be gone from the Topology action panel.
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
  "configure-interface", "unconfigure-interface",
  "set-property", "clear-property",
  "bind-acl", "unbind-acl",
  "add-bgp-peer", "remove-bgp-peer",
  "apply-qos", "remove-qos",
];

// IDs that MUST remain (the service-application set).
const ALLOWED_ACTION_IDS = ["apply-service", "remove-service", "refresh-service"];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
page.on("dialog", (d) => { void d.dismiss(); });

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
    `single-device selection shows the guiding hint pointing at Specs tab: "${singleDeviceState.hintText}"`);
  expect(singleDeviceState.actionGroups.length === 0,
    `no per-device action groups rendered (got: ${JSON.stringify(singleDeviceState.actionGroups)})`);

  await page.screenshot({ path: "/tmp/newtcon-smoke-scope-01-single.png" });

  // ── 2. Interface selection: action panel shows ONLY the Service group ────
  // Click on an interface pill. The interface list is rendered by
  // renderInterfacesTab inside the panel; find a clickable interface label.
  const ifaceClicked = await page.evaluate(() => {
    // Find first interface link/button in the panel-rendered interfaces list.
    const panel = document.querySelector(".topo-action-panel");
    if (!panel) return null;
    const ifaceItems = panel.querySelectorAll(".topo-iface-item, .topo-iface, [data-iface]");
    const first = ifaceItems[0];
    if (first instanceof HTMLElement) {
      first.click();
      return first.getAttribute("data-iface") || first.textContent?.trim() || "unknown";
    }
    return null;
  });
  await new Promise((r) => setTimeout(r, 400));

  if (ifaceClicked === null) {
    // No clickable interface in the rendered panel — log this so we know,
    // but the surface scope assertion below still runs against whatever the
    // panel did render.
    console.log("  note: no interface item was clickable in the action panel; checking node-level surface only");
  } else {
    console.log(`  → clicked interface: ${ifaceClicked}`);
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

  // ── 3. Allowed service-application labels are present (after clicking an iface) ─
  if (ifaceClicked !== null) {
    const serviceLabelsFound = ["Bind service", "Unbind service", "Refresh service"]
      .filter((wanted) => panelActions.labels.includes(wanted));
    expect(serviceLabelsFound.length >= 1,
      `interface selection exposes service actions: ${JSON.stringify(serviceLabelsFound)} / labels=${JSON.stringify(panelActions.labels)}`);
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

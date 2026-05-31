// app.ts — newtcon workspace entry. Renders a two-tab layout:
//   Tab 1 (Specs)    — multi-panel spec view (unchanged from slice 2)
//   Tab 2 (Topology) — SVG topology graph + node-inspector drawer

import { fetchSpecList, fetchSpecDetail, type SpecKind } from "./api/newtcon/network.js";
import { ApiError } from "./api/newtcon/services.js";
import {
  fetchTopology,
  fetchNodeInfo,
  fetchNodeInterfaces,
  fetchNodeInterface,
  fetchNodeInterfaceBinding,
  fetchNodeVLANs,
  fetchNodeVRFs,
  fetchNodeACLs,
  fetchNodeLAGs,
  fetchNodeNeighbors,
  fetchNodeBGPStatus,
  fetchNodeEVPNStatus,
  fetchNodeConfigDB,
  fetchNodeConfigDBTable,
  fetchNodeConfigDBEntry,
} from "./api/newtcon/nodes.js";

// ---- DOM helper -------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ---- Specs tab (unchanged from slice 2) ------------------------------------

interface Panel {
  kind: SpecKind;
  title: string;
}

const PANELS: Panel[] = [
  { kind: "services", title: "Services" },
  { kind: "ipvpns", title: "IP VPNs" },
  { kind: "macvpns", title: "MAC VPNs" },
  { kind: "qos-policies", title: "QoS policies" },
  { kind: "filters", title: "Filters" },
  { kind: "route-policies", title: "Route policies" },
  { kind: "prefix-lists", title: "Prefix lists" },
  { kind: "profiles", title: "Device profiles" },
  { kind: "zones", title: "Zones" },
  { kind: "platforms", title: "Platforms" },
];

function renderPanel(panel: Panel, result: PromiseSettledResult<string[]>): HTMLElement {
  const container = el("section", { className: "panel" });
  const header = el("div", { className: "panel-header" });
  header.appendChild(el("h2", { className: "panel-title" }, panel.title));

  if (result.status === "fulfilled") {
    const items = result.value;
    header.appendChild(el("span", { className: "panel-count" }, String(items.length)));
    container.appendChild(header);

    if (items.length === 0) {
      container.appendChild(el("p", { className: "panel-empty" }, "none defined"));
    } else {
      const list = el("ul", { className: "panel-list" });
      for (const name of items) {
        const item = el("li", { className: "panel-list-item", tabIndex: 0 }, name);
        item.dataset.kind = panel.kind;
        item.dataset.name = name;
        item.addEventListener("click", () => openDetail(panel.kind, panel.title, name));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(panel.kind, panel.title, name);
          }
        });
        list.appendChild(item);
      }
      container.appendChild(list);
    }
    return container;
  }

  // rejected
  container.appendChild(header);
  const err = result.reason;
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "newtron is unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
  return container;
}

// ---- Shared recursive value renderer ----------------------------------------

export function renderValue(value: unknown): HTMLElement | Text {
  if (value === null || value === undefined) {
    return el("span", { className: "detail-null" }, "—");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return el("span", { className: "detail-null" }, "(empty)");
    const list = el("ol", { className: "detail-array" });
    for (const item of value) {
      const li = el("li");
      li.appendChild(renderValue(item));
      list.appendChild(li);
    }
    return list;
  }
  if (typeof value === "object") {
    const dl = el("dl", { className: "detail-object" });
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      dl.appendChild(el("dt", {}, k));
      const dd = el("dd");
      dd.appendChild(renderValue(v));
      dl.appendChild(dd);
    }
    return dl;
  }
  if (typeof value === "boolean") {
    return el("span", { className: "detail-bool" }, value ? "true" : "false");
  }
  return document.createTextNode(String(value));
}

// ---- Detail drawer (spec) ---------------------------------------------------

async function openDetail(kind: SpecKind, kindTitle: string, name: string): Promise<void> {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, name));
  const loading = el("p", { className: "status-loading" }, "Loading…");
  content.appendChild(loading);

  try {
    const detail = await fetchSpecDetail(kind, name);
    content.removeChild(loading);
    const body = renderValue(detail);
    if (body instanceof HTMLElement) {
      body.classList.add("drawer-detail");
    }
    content.appendChild(body);
  } catch (err) {
    content.removeChild(loading);
    if (err instanceof ApiError && err.status === 404) {
      content.appendChild(el("p", { className: "panel-error" }, `${kindTitle} not found`));
    } else if (err instanceof ApiError) {
      content.appendChild(el("p", { className: "panel-error" }, err.message));
    } else {
      content.appendChild(el("p", { className: "panel-error" }, "request failed"));
      content.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
    }
  }
}

function closeDetail(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;
  drawer.setAttribute("aria-hidden", "true");
  drawer.classList.remove("open");
}

// ---- Topology types ---------------------------------------------------------

interface TopoNode {
  name: string;
  type?: string;
  [k: string]: unknown;
}

interface TopoLink {
  local_device?: string;
  local_interface?: string;
  remote_device?: string;
  remote_interface?: string;
  [k: string]: unknown;
}

interface TopologyData {
  nodes?: TopoNode[];
  links?: TopoLink[];
  [k: string]: unknown;
}

// ---- Topology SVG renderer --------------------------------------------------

const NODE_W = 120;
const NODE_H = 52;
const H_GAP = 80;
const V_GAP = 60;

// layoutNodes assigns (cx, cy) to each node in a deterministic grid.
// Up to 4 nodes per row; rows stacked with V_GAP spacing.
function layoutNodes(nodes: TopoNode[]): Map<string, { cx: number; cy: number }> {
  const cols = Math.min(nodes.length, 4);
  const positions = new Map<string, { cx: number; cy: number }>();
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(n.name, {
      cx: (NODE_W + H_GAP) * col + NODE_W / 2 + H_GAP / 2,
      cy: (NODE_H + V_GAP) * row + NODE_H / 2 + V_GAP / 2,
    });
  });
  return positions;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {}
): SVGElementTagNameMap[K] {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  return node;
}

function renderTopologySVG(data: TopologyData, onNodeClick: (name: string) => void): SVGSVGElement {
  const nodes: TopoNode[] = Array.isArray(data.nodes) ? data.nodes : [];
  const links: TopoLink[] = Array.isArray(data.links) ? data.links : [];

  const cols = Math.min(nodes.length || 1, 4);
  const rows = nodes.length === 0 ? 1 : Math.ceil(nodes.length / cols);
  const svgW = (NODE_W + H_GAP) * cols + H_GAP;
  const svgH = (NODE_H + V_GAP) * rows + V_GAP;

  const svg = svgEl("svg", {
    width: String(svgW),
    height: String(svgH),
    viewBox: `0 0 ${svgW} ${svgH}`,
    "class": "topology-graph",
    role: "img",
    "aria-label": "Network topology diagram",
  });

  const positions = layoutNodes(nodes);

  // Draw links first (under nodes).
  for (const link of links) {
    const from = link.local_device ? positions.get(link.local_device) : undefined;
    const to = link.remote_device ? positions.get(link.remote_device) : undefined;
    if (!from || !to) continue;
    const line = svgEl("line", {
      "class": "topo-link",
      x1: String(from.cx),
      y1: String(from.cy),
      x2: String(to.cx),
      y2: String(to.cy),
    });
    svg.appendChild(line);
  }

  // Draw nodes.
  for (const node of nodes) {
    const pos = positions.get(node.name);
    if (!pos) continue;

    const g = svgEl("g", {
      "class": "topo-node",
      role: "button",
      tabindex: "0",
      "aria-label": `Device ${node.name}`,
    });

    const rect = svgEl("rect", {
      x: String(pos.cx - NODE_W / 2),
      y: String(pos.cy - NODE_H / 2),
      width: String(NODE_W),
      height: String(NODE_H),
      rx: "4",
    });
    g.appendChild(rect);

    const label = svgEl("text", {
      x: String(pos.cx),
      y: String(pos.cy - 8),
    });
    label.textContent = node.name;
    g.appendChild(label);

    if (node.type) {
      const typeLabel = svgEl("text", {
        "class": "topo-node-type",
        x: String(pos.cx),
        y: String(pos.cy + 10),
      });
      typeLabel.textContent = String(node.type);
      g.appendChild(typeLabel);
    }

    g.addEventListener("click", () => onNodeClick(node.name));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onNodeClick(node.name);
      }
    });

    svg.appendChild(g);
  }

  if (nodes.length === 0) {
    const msg = svgEl("text", {
      x: String(svgW / 2),
      y: String(svgH / 2),
      "text-anchor": "middle",
      "dominant-baseline": "central",
      "font-size": "13",
      fill: "#57534e",
    });
    msg.textContent = "No devices in topology";
    svg.appendChild(msg);
  }

  return svg;
}

// ---- Node inspector drawer --------------------------------------------------

// NODE_TABS defines the sub-tabs in operator-domain words (no internal jargon
// vocabulary, per vocabulary discipline in the slice spec).
const NODE_TABS = [
  { id: "overview",  label: "Overview" },
  { id: "interfaces", label: "Interfaces" },
  { id: "vlans",     label: "VLANs" },
  { id: "vrfs",      label: "VRFs" },
  { id: "acls",      label: "ACLs" },
  { id: "bgp",       label: "BGP" },
  { id: "evpn",      label: "EVPN" },
  { id: "lags",      label: "LAGs" },
  { id: "neighbors", label: "Neighbors" },
  { id: "configdb",  label: "Config DB" },
] as const;

type NodeTabId = typeof NODE_TABS[number]["id"];

// renderLoadingInto clears a container and shows a loading indicator.
function renderLoadingInto(container: HTMLElement): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "status-loading" }, "Loading…"));
}

// renderErrorInto clears a container and shows an error message.
function renderErrorInto(container: HTMLElement, err: unknown): void {
  container.textContent = "";
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "Device unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError && err.kind === "internal" && err.status === 404) {
    container.appendChild(el("p", { className: "panel-error" }, "Not found"));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "Request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
}

// renderValueInto places renderValue output into a container, adding .drawer-detail.
function renderValueInto(container: HTMLElement, data: unknown): void {
  container.textContent = "";
  const body = renderValue(data);
  if (body instanceof HTMLElement) {
    body.classList.add("drawer-detail");
  }
  container.appendChild(body);
}

// renderInterfaceTab renders the interfaces sub-tab with click-to-expand detail.
function renderInterfaceTab(container: HTMLElement, device: string, data: unknown): void {
  container.textContent = "";

  let items: unknown[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data !== null && typeof data === "object") {
    // Some newtron endpoints return objects — wrap as single item.
    items = [data];
  }

  if (items.length === 0) {
    container.appendChild(el("p", { className: "topology-empty" }, "No interfaces found"));
    return;
  }

  const list = el("ul", { className: "iface-list" });

  for (const raw of items) {
    const iface = raw as Record<string, unknown>;
    const name = String(iface.name ?? iface.interface_name ?? iface.ifname ?? "—");
    const operStatus = String(iface.oper_status ?? iface.oper_state ?? "");

    const itemRow = el("li", { className: "iface-item", tabIndex: 0 });
    itemRow.appendChild(el("span", { className: "iface-name" }, name));
    if (operStatus) {
      itemRow.appendChild(el("span", {}, operStatus));
    }

    // Expand/collapse detail inline.
    const detailContainer = el("div", { className: "iface-detail" });
    detailContainer.hidden = true;

    let loaded = false;

    const toggle = (): void => {
      if (detailContainer.hidden) {
        detailContainer.hidden = false;
        if (!loaded) {
          loaded = true;
          renderLoadingInto(detailContainer);
          Promise.all([
            fetchNodeInterface(device, name),
            fetchNodeInterfaceBinding(device, name),
          ])
            .then(([detail, binding]) => {
              detailContainer.textContent = "";
              detailContainer.appendChild(el("p", { className: "drawer-kind" }, "Interface detail"));
              detailContainer.appendChild(renderValue(detail));
              detailContainer.appendChild(el("p", { className: "drawer-kind" }, "Service binding"));
              detailContainer.appendChild(renderValue(binding));
            })
            .catch((err) => renderErrorInto(detailContainer, err));
        }
      } else {
        detailContainer.hidden = true;
      }
    };

    itemRow.addEventListener("click", toggle);
    itemRow.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    list.appendChild(itemRow);
    list.appendChild(el("li", {}, detailContainer));
  }

  container.appendChild(list);
}

// renderConfigDBTab renders the CONFIG_DB sub-tab with 3-level navigation.
function renderConfigDBTab(container: HTMLElement, device: string, tableMap: unknown): void {
  container.textContent = "";

  let tableNames: string[] = [];
  if (tableMap !== null && typeof tableMap === "object" && !Array.isArray(tableMap)) {
    tableNames = Object.keys(tableMap as Record<string, unknown>).sort();
  } else if (Array.isArray(tableMap)) {
    tableNames = tableMap.map(String).sort();
  }

  if (tableNames.length === 0) {
    container.appendChild(el("p", { className: "topology-empty" }, "CONFIG_DB is empty"));
    return;
  }

  const tableList = el("ul", { className: "configdb-tables" });

  for (const tableName of tableNames) {
    const tableItem = el("li", { className: "configdb-table-item", tabIndex: 0 }, tableName);

    const keysContainer = el("ul", { className: "configdb-keys" });
    keysContainer.hidden = true;

    let keysLoaded = false;

    const toggleTable = (): void => {
      if (keysContainer.hidden) {
        keysContainer.hidden = false;
        if (!keysLoaded) {
          keysLoaded = true;
          const loading = el("li", {}, "Loading…");
          keysContainer.appendChild(loading);
          fetchNodeConfigDBTable(device, tableName)
            .then((keyData) => {
              keysContainer.textContent = "";
              let keys: string[] = [];
              if (Array.isArray(keyData)) {
                keys = keyData.map(String).sort();
              } else if (keyData !== null && typeof keyData === "object") {
                keys = Object.keys(keyData as Record<string, unknown>).sort();
              }
              if (keys.length === 0) {
                keysContainer.appendChild(el("li", { className: "configdb-key-item" }, "(empty)"));
                return;
              }
              for (const keyName of keys) {
                const keyItem = el("li", { className: "configdb-key-item", tabIndex: 0 }, keyName);

                const entryContainer = el("li", {});
                const entryContent = el("div", { className: "configdb-entry" });
                entryContent.hidden = true;

                let entryLoaded = false;

                const toggleKey = (): void => {
                  if (entryContent.hidden) {
                    entryContent.hidden = false;
                    if (!entryLoaded) {
                      entryLoaded = true;
                      renderLoadingInto(entryContent);
                      fetchNodeConfigDBEntry(device, tableName, keyName)
                        .then((entry) => renderValueInto(entryContent, entry))
                        .catch((err) => renderErrorInto(entryContent, err));
                    }
                  } else {
                    entryContent.hidden = true;
                  }
                };

                keyItem.addEventListener("click", toggleKey);
                keyItem.addEventListener("keydown", (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleKey();
                  }
                });

                keysContainer.appendChild(keyItem);
                entryContainer.appendChild(entryContent);
                keysContainer.appendChild(entryContainer);
              }
            })
            .catch((err) => {
              keysContainer.textContent = "";
              const errItem = el("li", { className: "panel-error" }, String(err));
              keysContainer.appendChild(errItem);
            });
        }
      } else {
        keysContainer.hidden = true;
      }
    };

    tableItem.addEventListener("click", toggleTable);
    tableItem.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTable();
      }
    });

    tableList.appendChild(tableItem);
    tableList.appendChild(el("li", {}, keysContainer));
  }

  container.appendChild(tableList);
}

// openNodeDrawer opens the detail drawer for a device and renders node-inspector
// sub-tabs. Each sub-tab fetches its data lazily on first activation.
function openNodeDrawer(device: string): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  // Header.
  content.appendChild(el("p", { className: "drawer-kind" }, "Device"));
  content.appendChild(el("h2", { className: "drawer-name" }, device));

  // Sub-tab strip.
  const tabStrip = el("nav", { className: "node-tabs", role: "tablist", ariaLabel: "Device information" });

  // Tab panels container — each panel is rendered lazily.
  const panelsContainer = el("div", {});

  const panels = new Map<NodeTabId, HTMLElement>();
  const tabButtons = new Map<NodeTabId, HTMLButtonElement>();
  const fetched = new Set<NodeTabId>();

  // activateTab shows the given tab panel and marks the button active.
  const activateTab = (id: NodeTabId): void => {
    for (const [tid, btn] of tabButtons) {
      btn.classList.toggle("node-tab--active", tid === id);
      btn.setAttribute("aria-selected", tid === id ? "true" : "false");
    }
    for (const [tid, panel] of panels) {
      panel.hidden = tid !== id;
    }
    if (!fetched.has(id)) {
      fetched.add(id);
      loadNodeTab(id, panels.get(id)!, device);
    }
  };

  for (const tab of NODE_TABS) {
    const btn = el("button", {
      className: "node-tab",
      type: "button",
      tabIndex: 0,
    }, tab.label);
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("aria-controls", `node-panel-${tab.id}`);
    btn.addEventListener("click", () => activateTab(tab.id));
    tabStrip.appendChild(btn);
    tabButtons.set(tab.id, btn);

    const panel = el("div", { className: "node-tab-panel" });
    panel.setAttribute("id", `node-panel-${tab.id}`);
    panel.setAttribute("role", "tabpanel");
    panel.hidden = true;
    panels.set(tab.id, panel);
    panelsContainer.appendChild(panel);
  }

  content.appendChild(tabStrip);
  content.appendChild(panelsContainer);

  // Activate the Overview tab by default.
  activateTab("overview");
}

// loadNodeTab fetches data for one node-inspector tab and renders it.
function loadNodeTab(id: NodeTabId, container: HTMLElement, device: string): void {
  renderLoadingInto(container);

  switch (id) {
    case "overview":
      fetchNodeInfo(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "interfaces":
      fetchNodeInterfaces(device)
        .then((data) => renderInterfaceTab(container, device, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "vlans":
      fetchNodeVLANs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "vrfs":
      fetchNodeVRFs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "acls":
      fetchNodeACLs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "bgp":
      fetchNodeBGPStatus(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "evpn":
      fetchNodeEVPNStatus(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "lags":
      fetchNodeLAGs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "neighbors":
      fetchNodeNeighbors(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "configdb":
      fetchNodeConfigDB(device)
        .then((data) => renderConfigDBTab(container, device, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    default: {
      // Exhaustiveness check — TypeScript will catch missing cases at compile time.
      const _never: never = id;
      container.textContent = "";
      container.appendChild(el("p", { className: "topology-empty" }, `Unknown tab: ${_never}`));
    }
  }
}

// ---- Topology tab -----------------------------------------------------------

async function mountTopologyTab(root: HTMLElement): Promise<void> {
  root.textContent = "";
  root.appendChild(el("p", { className: "status-loading" }, "Loading topology…"));

  try {
    const data = await fetchTopology();
    root.textContent = "";
    const topoData = (data ?? {}) as TopologyData;
    const svg = renderTopologySVG(topoData, (deviceName) => {
      openNodeDrawer(deviceName);
    });
    root.appendChild(svg);
  } catch (err) {
    root.textContent = "";
    if (err instanceof ApiError && err.kind === "newtron_unavailable") {
      root.appendChild(el("p", { className: "topology-error" }, "newtron is unreachable"));
      const detailObj = err.details as { underlying_error_message?: string } | undefined;
      const detail = detailObj?.underlying_error_message ?? err.message;
      root.appendChild(el("p", { className: "panel-error-detail" }, detail));
    } else if (err instanceof ApiError) {
      root.appendChild(el("p", { className: "topology-error" }, err.message));
    } else {
      root.appendChild(el("p", { className: "topology-error" }, "Failed to load topology"));
      root.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
    }
  }
}

// ---- Tab switching ----------------------------------------------------------

function setupTabs(): void {
  const tabSpecs = document.getElementById("tab-specs");
  const tabTopology = document.getElementById("tab-topology");
  const panelSpecs = document.getElementById("panel-specs");
  const panelTopology = document.getElementById("panel-topology");

  if (!tabSpecs || !tabTopology || !panelSpecs || !panelTopology) return;

  let topologyMounted = false;

  const activateTab = (name: "specs" | "topology"): void => {
    const isSpecs = name === "specs";

    tabSpecs.classList.toggle("workspace-tab--active", isSpecs);
    tabSpecs.setAttribute("aria-selected", isSpecs ? "true" : "false");
    tabTopology.classList.toggle("workspace-tab--active", !isSpecs);
    tabTopology.setAttribute("aria-selected", !isSpecs ? "true" : "false");

    (panelSpecs as HTMLElement).hidden = !isSpecs;
    (panelTopology as HTMLElement).hidden = isSpecs;

    if (!isSpecs && !topologyMounted) {
      topologyMounted = true;
      mountTopologyTab(panelTopology as HTMLElement);
    }
  };

  tabSpecs.addEventListener("click", () => activateTab("specs"));
  tabTopology.addEventListener("click", () => activateTab("topology"));
}

// ---- Entry ------------------------------------------------------------------

async function mount(): Promise<void> {
  const root = document.getElementById("panel-specs");
  if (!root) return;

  // Surface the configured newtron URL in the footer.
  fetch("/api/health", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const target = document.getElementById("newtron-target");
      const d = data as Record<string, unknown> | null;
      const newtronBlock = d?.newtron as Record<string, unknown> | undefined;
      const url = newtronBlock?.url ?? d?.newtron_url;
      if (target && typeof url === "string" && url.length > 0) {
        target.textContent = url;
      }
    })
    .catch(() => {
      /* footer just shows "—" */
    });

  const results = await Promise.allSettled(PANELS.map((p) => fetchSpecList(p.kind)));

  root.textContent = "";
  PANELS.forEach((panel, i) => {
    root.appendChild(renderPanel(panel, results[i]));
  });

  setupTabs();

  document.getElementById("drawer-close")?.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
}

mount();

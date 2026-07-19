// views/drawer/state.ts — the device drawer's State tab (console-uplift
// 1.3b, move-only extraction from app.ts): the collapsible sub-section
// disclosures (Services lens, VLANs/VRFs/ACLs/BGP/EVPN/LAGs/BGP Health),
// the curated resource tables + status pills, and the tucked Raw
// (debugging) section (Config DB / Projection / Intent Tree).
//
// TEMPORARY CYCLE (dissolves in uplift 1.3c): renderValueInto,
// renderConfigDBTab and renderErrorInto still live in app.ts (drawer core);
// they move to views/drawer/ in 1.3c and these imports flip there.

// State sub-sections rendered inside the State tab as collapsible
// disclosures. Each fetches lazily on first expansion; sections with
// no data show "—" inline instead of empty disclosures.
import { fetchNodeACLs, fetchNodeBGPCheck, fetchNodeBGPStatus, fetchNodeConfigDB, fetchNodeEVPNStatus, fetchNodeIntentTree, fetchNodeLAGs, fetchNodeProjection, fetchNodeVLANs, fetchNodeVRFs, fetchTopology } from "../../api/newtcon/nodes.js";
import { renderConfigDBTab, renderErrorInto, renderValueInto } from "../../app.js";
import { ACL_COLUMNS, BGP_NEIGHBOR_COLUMNS, HEALTH_COLUMNS, LAG_COLUMNS, type ResourceColumn, type ServiceUsage, VLAN_COLUMNS, VRF_COLUMNS, countServiceInstances, deviceServiceUsage, isHealthCheckList, shapeResourceRows } from "../../device-resources.js";
import { el } from "../../dom.js";
const STATE_SUBSECTIONS = [
  { id: "vlans",     label: "VLANs" },
  { id: "vrfs",      label: "VRFs" },
  { id: "acls",      label: "ACLs" },
  { id: "bgp",       label: "BGP" },
  { id: "evpn",      label: "EVPN" },
  { id: "lags",      label: "LAGs" },
  { id: "bgp-check", label: "BGP Health" },
] as const;

// Raw / debug-only data — Config DB / Intent Tree / Projection. These
// are storage-layer reads useful for power-user debugging but
// rarely the operator's first stop. Tucked behind a disclosure
// labelled "Raw" below the tab panels.
const RAW_SECTIONS = [
  { id: "configdb",    label: "Config DB" },
  { id: "projection",  label: "Projection" },
  { id: "intent-tree", label: "Intent Tree" },
] as const;


// renderStateTab — collapses the 7 prior reality tabs into one tab
// with disclosable sub-sections. Each sub-section fetches lazily on
// first expansion. A device with no VRFs / ACLs / etc. shows "—"
// inline so the operator doesn't have to expand to discover absence.
export async function renderStateTab(container: HTMLElement, device: string): Promise<void> {
  container.textContent = "";
  container.appendChild(el("p", { className: "node-state-intro" },
    "Provisioned resources on this device + observed runtime state. Sub-sections fetch on expand."));

  // Resource lens (the inverse of the interface table): provisioned services on
  // this device, grouped by service → the interfaces they're applied to.
  container.appendChild(renderServicesDisclosure(device));

  for (const sub of STATE_SUBSECTIONS) {
    const details = el("details", { className: "node-state-section" }) as HTMLDetailsElement;
    const summary = el("summary", { className: "node-state-section-summary" });
    const title = el("span", { className: "node-state-section-title" }, sub.label);
    summary.appendChild(title);
    const badge = el("span", { className: "node-state-section-badge" }, "");
    summary.appendChild(badge);
    details.appendChild(summary);

    const body = el("div", { className: "node-state-section-body" });
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    details.appendChild(body);

    let loaded = false;
    details.addEventListener("toggle", () => {
      if (loaded || !details.open) return;
      loaded = true;
      void fetchStateSubsection(sub.id, device).then((data) => {
        body.textContent = "";
        const count = countItems(data);
        badge.textContent = count === 0 ? "—" : `${count}`;
        if (count === 0) {
          body.appendChild(el("p", { className: "node-summary-stat-clean" }, "(none)"));
          return;
        }
        renderStateSubsection(sub.id, body, data);
      }).catch((err) => renderErrorInto(body, err));
    });

    container.appendChild(details);
  }
}

// renderServicesDisclosure builds the resource-lens "Services" disclosure:
// services provisioned on this device → the interfaces they're applied to
// (derived from the topology's apply-service steps; the inverse of the
// per-interface service column in the Interfaces table).
function renderServicesDisclosure(device: string): HTMLElement {
  const details = el("details", { className: "node-state-section node-state-section--services" }) as HTMLDetailsElement;
  details.open = true;
  const summary = el("summary", { className: "node-state-section-summary" });
  summary.appendChild(el("span", { className: "node-state-section-title" }, "Services"));
  const badge = el("span", { className: "node-state-section-badge" }, "");
  summary.appendChild(badge);
  details.appendChild(summary);
  const body = el("div", { className: "node-state-section-body" });
  body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
  details.appendChild(body);

  void fetchTopology()
    .then((topo) => {
      const entry = ((topo as { nodes?: Record<string, unknown> } | null)?.nodes ?? {})[device] ?? null;
      const usage = deviceServiceUsage(entry);
      const n = countServiceInstances(usage);
      badge.textContent = n === 0 ? "—" : `${n}`;
      renderServiceLensInto(body, usage);
    })
    .catch((err) => renderErrorInto(body, err));
  return details;
}

// renderServiceLensInto renders each provisioned service as a card listing the
// interfaces it's applied to (+ per-interface vlan / ip / peer-AS).
function renderServiceLensInto(body: HTMLElement, usage: ServiceUsage[]): void {
  body.textContent = "";
  if (usage.length === 0) {
    body.appendChild(el("p", { className: "node-summary-stat-clean" },
      "No services applied to this device's interfaces yet — apply one from the Interfaces tab."));
    return;
  }
  for (const u of usage) {
    const card = el("div", { className: "svc-lens-card" });
    const head = el("div", { className: "svc-lens-head" });
    head.appendChild(el("span", { className: "iface-svc-chip" }, u.service));
    head.appendChild(el("span", { className: "svc-lens-count" },
      `${u.instances.length} interface${u.instances.length === 1 ? "" : "s"}`));
    card.appendChild(head);
    const table = el("table", { className: "svc-lens-table" });
    const hr = el("tr");
    for (const h of ["Interface", "VLAN", "IP", "Peer AS"]) hr.appendChild(el("th", {}, h));
    table.appendChild(hr);
    for (const inst of u.instances) {
      const tr = el("tr");
      tr.appendChild(el("td", { className: "iface-name" }, inst.iface));
      tr.appendChild(el("td", {}, inst.vlan ?? "—"));
      tr.appendChild(el("td", { className: "iface-cell-mono" }, inst.ip ?? "—"));
      tr.appendChild(el("td", {}, inst.peerAs ?? "—"));
      table.appendChild(tr);
    }
    card.appendChild(table);
    body.appendChild(card);
  }
}

function fetchStateSubsection(id: typeof STATE_SUBSECTIONS[number]["id"], device: string): Promise<unknown> {
  switch (id) {
    case "vlans":     return fetchNodeVLANs(device);
    case "vrfs":      return fetchNodeVRFs(device);
    case "acls":      return fetchNodeACLs(device);
    case "bgp":       return fetchNodeBGPStatus(device);
    case "evpn":      return fetchNodeEVPNStatus(device);
    case "lags":      return fetchNodeLAGs(device);
    case "bgp-check": return fetchNodeBGPCheck(device);
  }
}

// Best-effort item count for a state sub-section's response. Arrays
// use length directly; objects use key count; primitives count as 0.
// Used for the badge next to each disclosure title.
function countItems(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return Object.keys(data).length;
  return 0;
}

// renderStateSubsection — dispatches to a per-domain renderer for the
// State tab's sub-sections. Each renderer knows the shape of its own
// endpoint and emits a tabular or labeled view; falls back to a
// generic auto-table for shapes we haven't specifically handled.
function renderStateSubsection(
  id: typeof STATE_SUBSECTIONS[number]["id"],
  body: HTMLElement,
  data: unknown,
): void {
  switch (id) {
    case "bgp":       renderBGPStatus(body, data); break;
    case "evpn":      renderEVPNStatus(body, data); break;
    case "vrfs":      renderResourceTable(body, data, VRF_COLUMNS); break;
    case "vlans":     renderResourceTable(body, data, VLAN_COLUMNS); break;
    case "acls":      renderResourceTable(body, data, ACL_COLUMNS); break;
    case "lags":      renderResourceTable(body, data, LAG_COLUMNS); break;
    // /bgp/check returns device health-checks (check/status/message); render
    // those as a status table, falling back to the auto-table for any other
    // shape.
    case "bgp-check":
      if (isHealthCheckList(data)) renderResourceTable(body, data, HEALTH_COLUMNS);
      else renderAutoTable(body, data);
      break;
  }
}

// renderResourceTable renders a State resource as a curated, scannable table —
// replacing the generic auto-table's raw key dump. Columns flagged `status`
// render as colored pills (up/ok → ok, warn → warn, else down).
function renderResourceTable(body: HTMLElement, data: unknown, columns: ResourceColumn[]): void {
  body.textContent = "";
  const { headers, rows } = shapeResourceRows(data, columns);
  if (rows.length === 0) {
    body.appendChild(el("p", { className: "node-summary-stat-clean" }, "(none)"));
    return;
  }
  const table = el("table", { className: "resource-table" });
  const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", {}, h));
  table.appendChild(hr);
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, j) => {
      if (columns[j]?.status && cell !== "—") {
        tr.appendChild(el("td", {}, el("span", { className: `resource-pill resource-pill--${statusTone(cell)}` }, cell)));
      } else {
        tr.appendChild(el("td", {}, cell));
      }
    });
    table.appendChild(tr);
  }
  body.appendChild(table);
}

// statusTone maps a status string to a pill tone.
function statusTone(value: string): "ok" | "warn" | "down" {
  const s = value.toLowerCase();
  if (/\b(up|ok|ready|enabled|healthy|active|established|pass)\b/.test(s)) return "ok";
  if (/\b(warn|warning|degraded|pending|partial)\b/.test(s)) return "warn";
  return "down";
}

// renderBGPStatus — BGP /status returns
//   { local_as, router_id, loopback_ip, neighbors: [{neighbor_ip, vrf, type, remote_as, admin_status}], evpn_peers: [string] }
// Rendered as: top-level facts as labeled rows + neighbors table +
// EVPN peer chips. Falls back to generic tree for unfamiliar shapes.
function renderBGPStatus(body: HTMLElement, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(body, data);
    return;
  }
  const d = data as Record<string, unknown>;
  const facts: Array<[string, unknown]> = [
    ["Local ASN", d.local_as],
    ["Router ID", d.router_id],
    ["Loopback IP", d.loopback_ip],
  ];
  const factDl = el("dl", { className: "node-summary-dl" });
  for (const [label, value] of facts) {
    if (value === undefined || value === null || value === "") continue;
    factDl.appendChild(el("dt", { className: "node-summary-dt" }, label));
    factDl.appendChild(el("dd", { className: "node-summary-dd" }, String(value)));
  }
  body.appendChild(factDl);

  const neighbors = Array.isArray(d.neighbors) ? d.neighbors : [];
  if (neighbors.length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "Neighbors"));
    renderResourceTable(body, neighbors, BGP_NEIGHBOR_COLUMNS);
  }
  const evpnPeers = Array.isArray(d.evpn_peers) ? d.evpn_peers : [];
  if (evpnPeers.length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "EVPN peers"));
    const chips = el("p", { className: "node-chip-row" });
    for (const p of evpnPeers) {
      chips.appendChild(el("span", { className: "node-chip" }, String(p)));
    }
    body.appendChild(chips);
  }
}

// renderEVPNStatus — EVPN /status returns
//   { vteps: {name: ip}, nvos: {name: vtep}, vni_count: number }
// Small structured object; render as labeled groups.
function renderEVPNStatus(body: HTMLElement, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(body, data);
    return;
  }
  const d = data as Record<string, unknown>;
  const vteps = (d.vteps && typeof d.vteps === "object") ? d.vteps as Record<string, unknown> : {};
  const nvos  = (d.nvos  && typeof d.nvos  === "object") ? d.nvos  as Record<string, unknown> : {};
  const vniCount = typeof d.vni_count === "number" ? d.vni_count : null;

  if (vniCount !== null) {
    const row = el("p", { className: "node-summary-stat-row" });
    row.appendChild(el("span", { className: "node-summary-stat-total" }, String(vniCount)));
    row.appendChild(el("span", { className: "node-summary-stat-label" }, `VNI${vniCount === 1 ? "" : "s"}`));
    body.appendChild(row);
  }
  if (Object.keys(vteps).length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "VTEPs"));
    const dl = el("dl", { className: "node-summary-dl" });
    for (const [k, v] of Object.entries(vteps)) {
      dl.appendChild(el("dt", { className: "node-summary-dt" }, k));
      dl.appendChild(el("dd", { className: "node-summary-dd" }, String(v)));
    }
    body.appendChild(dl);
  }
  if (Object.keys(nvos).length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "NVOs"));
    const dl = el("dl", { className: "node-summary-dl" });
    for (const [k, v] of Object.entries(nvos)) {
      dl.appendChild(el("dt", { className: "node-summary-dt" }, k));
      dl.appendChild(el("dd", { className: "node-summary-dd" }, String(v)));
    }
    body.appendChild(dl);
  }
}

// renderAutoTable — generic renderer for "array of homogeneous objects":
// derives columns from the union of keys, renders as <table>. Falls
// back to renderValueInto for shapes that aren't tabular (single
// object, mixed-shape array, primitives).
function renderAutoTable(body: HTMLElement, data: unknown): void {
  if (!Array.isArray(data) || data.length === 0) {
    renderValueInto(body, data);
    return;
  }
  // All items must be plain objects for table mode; one non-object
  // and we fall back to the tree renderer (safer than rendering a
  // wonky table with blank cells).
  const allObjects = data.every((x) => x && typeof x === "object" && !Array.isArray(x));
  if (!allObjects) {
    renderValueInto(body, data);
    return;
  }
  const rows = data as Array<Record<string, unknown>>;
  // Column order: first-row insertion order, plus any keys other
  // rows add at the end (rare but possible).
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const table = el("table", { className: "node-state-table" });
  const thead = el("thead", {});
  const trHead = el("tr", {});
  for (const c of cols) {
    trHead.appendChild(el("th", { className: "node-state-th" }, humanizeKey(c)));
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody", {});
  for (const row of rows) {
    const tr = el("tr", {});
    for (const c of cols) {
      const v = row[c];
      const cell = el("td", { className: "node-state-td" });
      if (v === undefined || v === null || v === "") {
        cell.appendChild(el("span", { className: "node-state-td--empty" }, "—"));
      } else if (typeof v === "object") {
        // Nested object/array in a cell — collapse to a short JSON
        // marker rather than blow out the column width.
        cell.appendChild(el("code", { className: "node-state-td--nested" },
          Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`));
      } else {
        cell.appendChild(document.createTextNode(String(v)));
      }
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

// humanizeKey — wire field name → operator label. Snake-case turned
// into Title Case so columns read as words rather than identifiers.
//   "admin_status" → "Admin status"
//   "remote_as"    → "Remote ASN"  (special-case common acronyms)
function humanizeKey(key: string): string {
  const special: Record<string, string> = {
    as:     "ASN",
    asn:    "ASN",
    ip:     "IP",
    vrf:    "VRF",
    vlan:   "VLAN",
    vni:    "VNI",
    bgp:    "BGP",
    evpn:   "EVPN",
    id:     "ID",
    url:    "URL",
    mac:    "MAC",
    sonic:  "SONiC",
  };
  const parts = key.split(/[_\-]/);
  const titled = parts.map((p, i) => {
    const lower = p.toLowerCase();
    if (special[lower]) return special[lower];
    if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    return p.toLowerCase();
  });
  return titled.join(" ");
}

// renderRawSection — collapsed disclosure rendering the three
// power-user / debugging surfaces (Config DB · Projection · Intent
// Tree). Hidden by default below the primary tab panels.
export function renderRawSection(host: HTMLElement, device: string): void {
  const wrap = el("details", { className: "node-raw-wrap" }) as HTMLDetailsElement;
  const sum = el("summary", { className: "node-raw-summary" }, "Raw (debugging)");
  wrap.appendChild(sum);
  const inner = el("div", { className: "node-raw-body" });
  wrap.appendChild(inner);

  for (const sec of RAW_SECTIONS) {
    const d = el("details", { className: "node-raw-section" }) as HTMLDetailsElement;
    d.appendChild(el("summary", { className: "node-raw-section-summary" }, sec.label));
    const body = el("div", { className: "node-raw-section-body" });
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    d.appendChild(body);
    let loaded = false;
    d.addEventListener("toggle", () => {
      if (loaded || !d.open) return;
      loaded = true;
      const fetcher: Promise<unknown> =
        sec.id === "configdb" ? fetchNodeConfigDB(device).then((data) => {
          body.textContent = "";
          renderConfigDBTab(body, device, data);
          return data;
        }) :
        sec.id === "projection" ? fetchNodeProjection(device).then((data) => {
          body.textContent = "";
          renderValueInto(body, data);
          return data;
        }) :
        fetchNodeIntentTree(device).then((data) => {
          body.textContent = "";
          renderValueInto(body, data);
          return data;
        });
      void fetcher.catch((err) => renderErrorInto(body, err));
    });
    inner.appendChild(d);
  }

  host.appendChild(wrap);
}


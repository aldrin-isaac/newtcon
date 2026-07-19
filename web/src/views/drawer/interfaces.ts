// views/drawer/interfaces.ts — the device drawer's Interfaces tab
// (console-uplift 1.3a, move-only extraction from app.ts): the unified
// per-port table (inventory-first join via device-interfaces.ts), expand-in-
// place port detail + LIVE STATUS panel (interface-status.ts), the IRB
// interfaces (VLAN) section (irb-interfaces.ts), and the staged per-port /
// per-interface action forms (port mode, apply-service, port properties,
// populate-default-ports, add-VLAN).

// renderInterfaceTab renders the unified, sorted device interface view: one row
// per platform port (configured AND available), joining inventory + topology
// port config + live state + service bindings + topology links. Rows expand
// in place to full per-port detail + actions. `data` is the live interface
// list already fetched by the tab loader; the rest is fetched here and joined
// via buildDeviceInterfaceView (pure).
import { apiPath } from "../../api-path.js";
import { loadDeviceModel } from "../../device-model.js";
import { fetchPlatformPorts, fetchSpecDetail, fetchSpecList } from "../../api/newtcon/network.js";
import { fetchInterfaceStatus, fetchTopology } from "../../api/newtcon/nodes.js";
import { fetchSchema } from "../../api/newtcon/schema.js";
import { confirmInline } from "../../confirm-inline.js";
import { type InterfaceRow, applyFilter as applyIfaceFilter, buildDeviceInterfaceView, countView, deriveDeviceBindings, linksForDevice } from "../../device-interfaces.js";
import { el, renderValue, makeCopyable } from "../../dom.js";
import { type InterfaceStatus, counterPairs, formatBps, formatPps, hasCounterAlerts, lldpFarEnd, memberSummaries, neighborLines } from "../../interface-status.js";
import { type IrbRow, deriveIrbRows, macvpnVlanHints, pendingCreateVlanIds } from "../../irb-interfaces.js";
import { comparePorts } from "../../port-config.js";
import { formatErrorBrief } from "../../render-error.js";
import { renderSchemaForm } from "../../schema-form.js";
import { deviceQueue, enqueueDeviceAction, enqueueInterfaceAction, enqueuePortConfig, enqueueTopologyRemoveLink } from "../../staging.js";
import { showToast } from "../../toast.js";
import { type ActionDef, type ActionField, INTERFACE_ACTIONS } from "../../topology-actions.js";
export function renderInterfaceTab(container: HTMLElement, device: string): void {
  container.textContent = "";
  const host = el("div", { className: "iface-view" });
  container.appendChild(host);
  void buildAndRenderIfaceView(host, device);
}

async function buildAndRenderIfaceView(host: HTMLElement, device: string): Promise<void> {
  host.textContent = "";
  host.appendChild(el("p", { className: "iface-view-loading" }, "Building interface view…"));

  // Inventory-first: the table is driven by the platform inventory + the
  // declared topology — both known from the spec, WITHOUT the node running. The
  // live interface read is a best-effort oper-status overlay; its absence (an
  // un-deployed/unreachable node) must NOT hide the ports or block staging
  // services. So the live read can fail and we still render every platform port.
  // One fetch bundle (device-model.ts) — spec + topology + live overlays.
  const model = await loadDeviceModel(device);
  const { liveUnavailable, inventory, live, liveVlans } = model;
  const devEntry = model.entry;
  const topoPorts = devEntry.ports ?? {};
  const bindings = deriveDeviceBindings(devEntry);
  const links = linksForDevice(model.links, device);

  const rows = buildDeviceInterfaceView({ inventory, topoPorts, live, bindings, links });
  const reload = (): void => { void buildAndRenderIfaceView(host, device); };
  if (rows.length === 0) {
    host.textContent = "";
    host.appendChild(el("p", { className: "topology-empty" },
      "No interfaces — this node has no platform (no port inventory) and no configured ports."));
    renderIrbSection(host, device, devEntry.steps, liveVlans, reload);
    return;
  }
  renderIfaceTable(host, device, rows, liveUnavailable, reload);
  // IRB interfaces (SVIs) — a VlanN section below the physical ports. An
  // irb-type service binds ON the SVI (newtron #434+), so the SVI needs a row
  // to be discoverable and actionable from the console.
  renderIrbSection(host, device, devEntry.steps, liveVlans, reload);
}

const IFACE_FILTERS: { id: import("../../device-interfaces.js").ViewFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "configured", label: "Configured" },
  { id: "available", label: "Available" },
  { id: "up", label: "Up" },
];

function renderIfaceTable(host: HTMLElement, device: string, rows: InterfaceRow[], liveUnavailable: boolean, reload: () => void): void {
  host.textContent = "";
  const counts = countView(rows);

  // Header: port-utilization summary.
  host.appendChild(el("p", { className: "iface-view-counts" },
    `${counts.total} ports · ${counts.configured} configured · ${counts.up} up · ${counts.available} available`));

  // Live-state overlay unavailable (un-deployed / unreachable device): the table
  // still shows every platform port from the inventory + the declared topology,
  // so ports can be configured and services staged before the node comes up.
  if (liveUnavailable) {
    host.appendChild(el("p", { className: "iface-view-offline-note" },
      "Device not reachable — showing declared topology + platform inventory (live status unavailable). You can still configure ports and stage services; they apply on deploy."));
  }

  // Controls: segmented filter + text search.
  let filter: import("../../device-interfaces.js").ViewFilter = "all";
  let query = "";
  const controls = el("div", { className: "iface-view-controls" });
  const seg = el("div", { className: "iface-seg" });
  const segBtns = new Map<string, HTMLButtonElement>();
  for (const f of IFACE_FILTERS) {
    const b = el("button", { type: "button", className: "iface-seg-btn" + (f.id === filter ? " iface-seg-btn--active" : "") }, f.label) as HTMLButtonElement;
    b.addEventListener("click", () => { filter = f.id; for (const [id, btn] of segBtns) btn.classList.toggle("iface-seg-btn--active", id === f.id); renderRows(); });
    seg.appendChild(b);
    segBtns.set(f.id, b);
  }
  controls.appendChild(seg);
  const search = el("input", { type: "search", className: "iface-search form-control", placeholder: "Filter ports…" }) as HTMLInputElement;
  search.addEventListener("input", () => { query = search.value; renderRows(); });
  controls.appendChild(search);
  // Populate default ports from the platform template (newtron #301). Bulk bring-up
  // for a freshly-created node whose ports are empty — the operator picks the subset.
  const populateBtn = el("button", { type: "button", className: "btn btn-secondary btn-sm iface-populate-btn" }, "Populate default ports");
  controls.appendChild(populateBtn);
  host.appendChild(controls);
  const populateHost = el("div", { className: "iface-populate-host" });
  host.appendChild(populateHost);
  populateBtn.addEventListener("click", () => void openPopulateDefaultPorts(populateHost, device, reload));

  // Table.
  const table = el("table", { className: "table table--2xs iface-table" });
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["Port", "Role", "Speed/MTU", "VLAN / VRF / IP", "Service", "Link"]) hr.appendChild(el("th", {}, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  table.appendChild(tbody);
  host.appendChild(table);

  const empty = el("p", { className: "iface-table-empty" }, "No ports match this filter.");
  empty.hidden = true;
  host.appendChild(empty);

  const renderRows = (): void => {
    tbody.textContent = "";
    const pending = new Set(
      deviceQueue(device)
        .filter((p) => p.group === "interface")
        .map((p) => (p as { iface?: string }).iface)
        .filter((x): x is string => !!x),
    );
    const shown = applyIfaceFilter(rows, filter, query);
    empty.hidden = shown.length > 0;
    for (const row of shown) renderIfaceRow(tbody, device, row, reload, pending);
  };
  renderRows();
}

function renderIfaceRow(tbody: HTMLElement, device: string, row: InterfaceRow, reload: () => void, pending: Set<string>): void {
  const isPending = pending.has(row.name);
  const tr = el("tr", { className: "iface-row" + (row.available ? " iface-row--available" : "") + (isPending ? " iface-row--pending" : ""), tabIndex: 0 });

  // Port cell: status dot + name (+ pending marker when a queued action targets it).
  const portCell = el("td", { className: "iface-cell-port" });
  portCell.appendChild(el("span", { className: `status-dot status-dot--${row.status === "up" ? "ok" : row.status === "down" ? "muted" : "faint"}`, title: statusTitle(row) }));
  portCell.appendChild(el("span", { className: "iface-name" }, row.name));
  if (isPending) portCell.appendChild(el("span", { className: "chip chip--warning", title: "Queued changes — Save to apply" }, "pending"));
  tr.appendChild(portCell);

  tr.appendChild(el("td", {}, el("span", { className: `iface-role iface-role--${row.role}` }, roleLabel(row.role))));
  tr.appendChild(el("td", { className: "iface-cell-mono" }, [row.speed, row.mtu !== undefined ? String(row.mtu) : ""].filter(Boolean).join(" / ") || "—"));
  tr.appendChild(el("td", { className: "iface-cell-l2l3" }, row.l2l3 || "—"));

  // Service cell: chip if bound, else an inline "+ Apply" CTA on serviceless ports.
  const svcCell = el("td", { className: "iface-cell-svc" });
  if (row.service) {
    svcCell.appendChild(el("span", { className: "chip chip--link" }, row.service));
  } else {
    const apply = el("button", { type: "button", className: "iface-apply-cta" }, "+ Apply");
    apply.addEventListener("click", (e) => { e.stopPropagation(); expand(true); });
    svcCell.appendChild(apply);
  }
  tr.appendChild(svcCell);

  tr.appendChild(el("td", { className: "iface-cell-link" }, row.link || "—"));
  tbody.appendChild(tr);

  // Expand-in-place detail row.
  const detailTr = el("tr", { className: "iface-detail-row" });
  const detailTd = el("td", { className: "iface-detail-cell" });
  detailTd.setAttribute("colspan", "6");
  detailTr.appendChild(detailTd);
  detailTr.hidden = true;
  tbody.appendChild(detailTr);

  let built = false;
  // expand opens the detail (optionally auto-opening the Apply-service form);
  // toggle collapses if already open.
  const expand = (autoApply: boolean): void => {
    detailTr.hidden = false;
    tr.classList.add("iface-row--expanded");
    if (!built || autoApply) { built = true; renderIfaceDetail(detailTd, device, row, reload, autoApply); }
  };
  const toggle = (): void => {
    if (detailTr.hidden) { expand(false); return; }
    detailTr.hidden = true;
    tr.classList.remove("iface-row--expanded");
  };
  tr.addEventListener("click", toggle);
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}

function renderIfaceDetail(host: HTMLElement, device: string, row: InterfaceRow, reload: () => void, autoApply = false): void {
  host.textContent = "";

  // Properties (tailored, not a JSON dump).
  const props: Array<[string, string]> = [
    ["Admin", row.adminStatus ?? "—"],
    ["Oper", row.operStatus || "—"],
    ["Speed", row.speed || "—"],
    ["MTU", row.mtu !== undefined ? String(row.mtu) : "—"],
    ["Role", roleLabel(row.role)],
  ];
  if (row.live?.pc_member === true) props.push(["Port-channel member", "yes"]);
  if (row.link) props.push(["Link", row.link]);
  const dl = el("dl", { className: "kv kv--tight iface-prop-grid" });
  for (const [k, v] of props) { dl.appendChild(el("dt", {}, k)); dl.appendChild(el("dd", {}, v)); }
  host.appendChild(dl);

  // Live operational diagnostics (counters/rates/ARP/LLDP) — fetched lazily on
  // expand. Best-effort: an un-deployed / unreachable device just shows a note.
  renderIfaceLiveStatus(host, device, row.name);

  // Service binding.
  if (row.service) {
    const svc = el("div", { className: "iface-detail-svc" });
    svc.appendChild(el("span", { className: "chip chip--link" }, row.service));
    if (row.l2l3) svc.appendChild(el("span", { className: "iface-detail-svc-meta" }, row.l2l3));
    host.appendChild(svc);
  }

  // Already-queued actions for this port (workspace queue overlay).
  const queued = deviceQueue(device).filter((p) => p.group === "interface" && (p as { iface?: string }).iface === row.name);
  if (queued.length > 0) {
    const q = el("div", { className: "iface-detail-queued" });
    q.appendChild(el("span", { className: "chip chip--warning" }, "pending"));
    q.appendChild(el("span", { className: "iface-detail-queued-list" }, queued.map((p) => (p as { label: string }).label).join(" · ")));
    host.appendChild(q);
  }

  // Actions — staged through the workspace queue (preview + undo), consistent
  // with the rest of the workspace. Buttons reveal an inline form in formHost
  // for actions that take fields; field-less actions stage on click.
  const actions = el("div", { className: "iface-actions" });
  const formHost = el("div", { className: "iface-action-form-host" });

  actions.appendChild(portModeMenu(formHost, device, row.name, reload));

  // Physical port properties (admin_status / mtu / speed / …) — the schema-driven
  // PortConfig form, staged as a whole-device update. This is the drawer home for
  // what used to live only in the Topology side panel's "Configure a port".
  const propsBtn = el("button", { type: "button", className: "iface-action-btn" }, "Properties");
  propsBtn.addEventListener("click", () => void openPortPropsForm(formHost, device, row.name, reload));
  actions.appendChild(propsBtn);

  if (row.canApplyService) {
    const apply = el("button", { type: "button", className: "iface-action-btn" }, "Apply service");
    apply.addEventListener("click", () => openIfaceForm(formHost, device, row.name, findIfaceAction("Service", "apply-service"), reload));
    actions.appendChild(apply);
  } else {
    const unbind = el("button", { type: "button", className: "iface-action-btn iface-action-btn--danger" }, "Unbind service");
    unbind.addEventListener("click", () => void stageIfaceAction(device, row.name, findIfaceAction("Service", "remove-service"), {}, reload));
    actions.appendChild(unbind);
  }

  if (row.link) {
    const rmLink = el("button", { type: "button", className: "iface-action-btn iface-action-btn--danger" }, "Remove link");
    rmLink.addEventListener("click", () => { enqueueTopologyRemoveLink(device, row.name); showToast({ kind: "success", title: "Queued", body: `Remove link on ${row.name} — Save to apply.` }); reload(); });
    actions.appendChild(rmLink);
  }
  host.appendChild(actions);
  host.appendChild(formHost);

  if (autoApply && row.canApplyService) {
    openIfaceForm(formHost, device, row.name, findIfaceAction("Service", "apply-service"), reload);
  }

  // Raw, tucked for power users (replaces the old always-on JSON dump).
  if (row.live) {
    const raw = el("details", { className: "disclosure iface-detail-raw" });
    raw.appendChild(el("summary", {}, "Raw"));
    raw.appendChild(renderValue(row.live));
    host.appendChild(raw);
  }
}

// renderIfaceLiveStatus fetches the per-interface operational diagnostic
// (newtron #431) and renders it into the expanded row: the LLDP far-end (the
// wiring truth — what the port is actually cabled to), resolved ARP neighbors,
// SONiC-computed rates, and cumulative counters (errors/discards flagged). This
// is what turns "the link is down" into a localizable picture without SSH.
// Best-effort: an un-deployed / unreachable device renders a single note. On a
// platform without COUNTERS_DB (or with no LLDP heard), those blocks are simply
// absent — newtron omits them and we render only what's present.
function renderIfaceLiveStatus(host: HTMLElement, device: string, iface: string): void {
  const section = el("div", { className: "iface-live" });
  section.appendChild(el("p", { className: "iface-live-loading" }, "Loading live status…"));
  host.appendChild(section);

  void fetchInterfaceStatus(device, iface)
    .then((raw) => {
      const s = (raw && typeof raw === "object" ? raw : {}) as InterfaceStatus;
      section.textContent = "";

      const header = el("div", { className: "iface-live-header" });
      header.appendChild(el("span", { className: "iface-live-title" }, "Live status"));
      if (hasCounterAlerts(s.counters)) {
        header.appendChild(el("span", { className: "iface-live-alert", title: "Non-zero errors or discards on this port" }, "⚠ errors/discards"));
      }
      section.appendChild(header);

      // LLDP far-end — the headline. What the cable actually reaches. A LAG/SVI
      // has no LLDP by design (kind-aware /status omits it and carries members
      // instead), so the "none heard" fallback only applies to physical ports.
      const far = lldpFarEnd(s.lldp_peer);
      const isAggregate = Array.isArray(s.members) && s.members.length > 0;
      if (far || !isAggregate) {
        const lldpRow = el("div", { className: "iface-live-lldp" + (far ? "" : " iface-live-lldp--none") });
        lldpRow.appendChild(el("span", { className: "iface-live-lldp-label" }, "Cabled to"));
        const peer = el("span", { className: "iface-live-lldp-peer" }, far ?? "no LLDP neighbor heard");
        lldpRow.appendChild(far ? makeCopyable(peer) : peer);
        section.appendChild(lldpRow);
      }

      // LAG / SVI members (kind-aware /status, newtron #441) — present only on
      // PortChannelN / VlanN; physical ports omit the field entirely.
      const members = memberSummaries(s.members);
      if (members.length) {
        const mem = el("div", { className: "iface-live-members" });
        mem.appendChild(el("span", { className: "iface-live-members-label" }, "Members"));
        const list = el("span", { className: "iface-live-members-list" });
        for (const m of members) {
          const chip = el("span", { className: "iface-live-member" + (m.up ? "" : " iface-live-member--down") });
          chip.appendChild(el("span", { className: `status-dot status-dot--${m.up ? "ok" : "muted"}` }));
          chip.appendChild(el("span", { className: "iface-live-member-name" }, m.name));
          if (m.speed !== "—") chip.appendChild(el("span", { className: "iface-live-member-speed" }, m.speed));
          list.appendChild(chip);
        }
        mem.appendChild(list);
        section.appendChild(mem);
      }

      // Resolved ARP neighbors (presence = resolved; absence = never resolved).
      const nbrs = neighborLines(s.neighbors);
      const arp = el("div", { className: "iface-live-arp" });
      arp.appendChild(el("span", { className: "iface-live-arp-label" }, "ARP"));
      if (nbrs.length) {
        const list = el("span", { className: "iface-live-arp-list" });
        for (const n of nbrs) list.appendChild(makeCopyable(el("code", { className: "iface-live-arp-item" }, n)));
        arp.appendChild(list);
      } else {
        arp.appendChild(el("span", { className: "iface-live-arp-none" }, "none resolved"));
      }
      section.appendChild(arp);

      // Rates (SONiC-computed — no client-side delta math).
      if (s.rates) {
        const rates = el("div", { className: "iface-live-rates" });
        rates.appendChild(el("span", { className: "iface-live-rates-label" }, "Rates"));
        rates.appendChild(makeCopyable(el("span", { className: "iface-live-rate" }, `Rx ${formatBps(s.rates.rx_bps)} · ${formatPps(s.rates.rx_pps)}`)));
        rates.appendChild(makeCopyable(el("span", { className: "iface-live-rate" }, `Tx ${formatBps(s.rates.tx_bps)} · ${formatPps(s.rates.tx_pps)}`)));
        section.appendChild(rates);
      }

      // Counters — Rx/Tx table, error/discard rows flagged.
      const pairs = counterPairs(s.counters);
      if (pairs.length) {
        const table = el("table", { className: "table table--bare table--mono-all iface-live-counters" });
        const thead = el("tr", {});
        thead.append(el("th", {}, ""), el("th", { className: "iface-live-num" }, "Rx"), el("th", { className: "iface-live-num" }, "Tx"));
        table.appendChild(thead);
        for (const p of pairs) {
          const tr = el("tr", { className: p.alert ? "iface-live-counter--alert" : "" });
          const rxCell = el("td", { className: "iface-live-num" });
          rxCell.appendChild(makeCopyable(el("span", { className: "detail-num" }, p.rx)));
          const txCell = el("td", { className: "iface-live-num" });
          txCell.appendChild(makeCopyable(el("span", { className: "detail-num" }, p.tx)));
          tr.append(el("td", {}, p.label), rxCell, txCell);
          table.appendChild(tr);
        }
        section.appendChild(table);
      }
    })
    .catch(() => {
      section.textContent = "";
      section.appendChild(el("p", { className: "iface-live-unavail" },
        "Live status unavailable — device not reachable (deploy + provision to read runtime state)."));
    });
}

// renderIrbSection — the "IRB interfaces (VLAN)" section under the physical
// port table. An irb-type service binds ON the SVI (Vlan{N}); this section
// makes SVIs discoverable and actionable: existing ones (live read + topology
// intent + staged create-vlan, joined by deriveIrbRows) render as expandable
// rows with the same LIVE STATUS panel and Apply-service action physical
// ports get, and "+ Add VLAN interface" stages a create-vlan through the
// normal queue (so the Apply-All modal's Delivery chip applies to it too).
// The right VLAN id is usually pinned by a macvpn — the add form surfaces
// those as hints.
function renderIrbSection(
  host: HTMLElement,
  device: string,
  steps: unknown,
  liveVlans: unknown,
  reload: () => void,
): void {
  const rows = deriveIrbRows({
    steps,
    liveVlans,
    pendingVlanIds: pendingCreateVlanIds(deviceQueue(device)),
  });

  const section = el("div", { className: "irb-section" });
  const head = el("div", { className: "irb-section-head" });
  head.appendChild(el("h4", { className: "irb-section-title" }, "IRB interfaces (VLAN)"));
  const addBtn = el("button", { type: "button", className: "iface-action-btn" }, "+ Add VLAN interface");
  head.appendChild(addBtn);
  section.appendChild(head);

  const formHost = el("div", { className: "irb-add-form-host" });
  section.appendChild(formHost);
  addBtn.addEventListener("click", () => { void openAddVlanForm(formHost, device, reload); });

  if (rows.length === 0) {
    section.appendChild(el("p", { className: "irb-section-empty" },
      "No VLAN interfaces. An IRB-type service (irb / evpn-irb) is applied on a VLAN interface — add one to create the SVI, then bind the service on it."));
  } else {
    const table = el("div", { className: "irb-rows" });
    for (const row of rows) table.appendChild(renderIrbRow(device, row, reload));
    section.appendChild(table);
  }
  host.appendChild(section);
}

function renderIrbRow(device: string, row: IrbRow, reload: () => void): HTMLElement {
  const wrap = el("div", { className: "irb-row-wrap" });
  const line = el("div", { className: "irb-row", tabIndex: 0 });

  // Status dot: live svi state when known; otherwise the source badge tells it.
  const dotState = row.svi === "up" ? "up" : row.svi === "down" ? "down" : "unknown";
  line.appendChild(el("span", { className: `status-dot status-dot--${dotState === "up" ? "ok" : dotState === "down" ? "muted" : "faint"}` }));
  line.appendChild(el("span", { className: "iface-name" }, row.name));
  if (row.source !== "live") {
    line.appendChild(el("span", {
      className: "chip chip--sm chip--dashed chip--muted",
      title: row.source === "intent"
        ? "Authored in the topology — not observed live (device unreachable or not yet provisioned)."
        : "Staged in the pending queue — Save to apply.",
    }, row.source === "intent" ? "intent" : "pending"));
  }
  const meta: string[] = [];
  if (row.l2Vni !== undefined) meta.push(`L2VNI ${row.l2Vni}`);
  if (row.macvpn) meta.push(row.macvpn);
  if (row.memberCount !== undefined) meta.push(`${row.memberCount} member${row.memberCount === 1 ? "" : "s"}`);
  line.appendChild(el("span", { className: "irb-row-meta" }, meta.join(" · ") || "—"));
  if (row.service) line.appendChild(el("span", { className: "chip chip--link" }, row.service));
  wrap.appendChild(line);

  // Expand-in-place: LIVE STATUS (kind-aware — members) + actions.
  const detail = el("div", { className: "irb-row-detail" });
  detail.hidden = true;
  wrap.appendChild(detail);
  let built = false;
  const toggle = (): void => {
    detail.hidden = !detail.hidden;
    line.classList.toggle("irb-row--expanded", !detail.hidden);
    if (!detail.hidden && !built) {
      built = true;
      renderIfaceLiveStatus(detail, device, row.name);
      const actions = el("div", { className: "iface-actions" });
      const formHost = el("div", { className: "iface-action-form-host" });
      const apply = el("button", { type: "button", className: "iface-action-btn" }, row.service ? "Re-apply service" : "Apply service");
      apply.addEventListener("click", () => openIfaceForm(formHost, device, row.name, findIfaceAction("Service", "apply-service"), reload));
      actions.appendChild(apply);
      const del = el("button", { type: "button", className: "iface-action-btn iface-action-btn--danger" }, "Delete VLAN");
      del.addEventListener("click", () => {
        enqueueDeviceAction(device, "delete-vlan", `Delete VLAN ${row.vlanId} (SVI ${row.name})`, { id: row.vlanId }, true);
        showToast({ kind: "success", title: "Queued", body: `Delete VLAN ${row.vlanId} — Save to apply.` });
        reload();
      });
      actions.appendChild(del);
      detail.appendChild(actions);
      detail.appendChild(formHost);
    }
  };
  line.addEventListener("click", toggle);
  line.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  return wrap;
}

// openAddVlanForm — inline create-vlan form for the IRB section. The macvpn
// pins the VLAN id for an irb service, so authored macvpns surface as hints.
async function openAddVlanForm(formHost: HTMLElement, device: string, reload: () => void): Promise<void> {
  formHost.textContent = "";
  const form = el("form", { className: "vform vform--tight vform--card iface-action-form" });
  form.appendChild(el("p", { className: "iface-action-form-title" }, "Add VLAN interface (SVI)"));
  const row = el("div", { className: "iface-field" });
  row.appendChild(el("label", { className: "iface-field-label" }, "VLAN ID *"));
  const input = el("input", { type: "number", className: "form-control", placeholder: "1–4094" }) as HTMLInputElement;
  row.appendChild(input);
  form.appendChild(row);
  const hintEl = el("p", { className: "form-help-text" }, "Creates VLAN N; SONiC materializes the VlanN interface. Then apply the IRB service on it.");
  form.appendChild(hintEl);
  const errOut = el("div", { className: "form-error-out" });
  form.appendChild(errOut);
  const btnRow = el("div", { className: "form-foot iface-action-form-actions" });
  const cancel = el("button", { type: "button", className: "btn btn-ghost btn-sm" }, "Cancel");
  cancel.addEventListener("click", () => { formHost.textContent = ""; });
  const queueBtn = el("button", { type: "submit", className: "btn btn-primary btn-sm" }, "Queue");
  btnRow.append(cancel, queueBtn);
  form.appendChild(btnRow);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = Number(input.value);
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      errOut.textContent = "VLAN ID must be an integer between 1 and 4094.";
      return;
    }
    enqueueDeviceAction(device, "create-vlan", `Create VLAN ${id} (SVI Vlan${id})`, { id });
    showToast({ kind: "success", title: "Queued", body: `Create VLAN ${id} — Save to apply, then bind the IRB service on Vlan${id}.` });
    formHost.textContent = "";
    reload();
  });
  formHost.appendChild(form);
  input.focus();

  // macvpn pins, best-effort: "MACVPN pins VLAN 100" appended to the hint.
  try {
    const names = await fetchSpecList("macvpns");
    const details = await Promise.all(names.map((n) => fetchSpecDetail("macvpns", n).catch(() => null)));
    const hints = macvpnVlanHints(details.filter((d): d is Record<string, unknown> => !!d));
    if (hints.length) hintEl.textContent += ` (${hints.join("; ")}.)`;
  } catch { /* hints are optional */ }
}

// openPortPropsForm renders the schema-driven PortConfig form (admin_status /
// mtu / speed / description) for one port, prefilled from its current topology
// config, and stages the edit as a whole-device update (enqueuePortConfig folds
// every port edit on a device into one PUT so sibling ports aren't clobbered).
async function openPortPropsForm(formHost: HTMLElement, device: string, port: string, reload: () => void): Promise<void> {
  formHost.textContent = "";
  formHost.appendChild(el("p", { className: "iface-action-form-loading" }, "Loading port properties…"));

  let schema: Awaited<ReturnType<typeof fetchSchema>>;
  let currentDevice: Record<string, unknown>;
  try {
    const [sc, topo] = await Promise.all([fetchSchema("PortConfig"), fetchTopology()]);
    schema = sc;
    currentDevice = ((topo as { nodes?: Record<string, Record<string, unknown>> } | null)?.nodes ?? {})[device] ?? {};
  } catch {
    formHost.textContent = "";
    formHost.appendChild(el("p", { className: "panel-error" },
      "Port configuration isn't available — this newtron build exposes no PortConfig schema."));
    return;
  }

  const currentPort = ((currentDevice.ports as Record<string, Record<string, unknown>>) ?? {})[port] ?? {};
  // `port` is the ports-map key, not a body field — skip it in the form.
  const sf = await renderSchemaForm({ schema, prefill: { ...currentPort }, skipFields: new Set(["port"]) });

  formHost.textContent = "";
  const wrap = el("div", { className: "iface-action-form iface-portprops-form" });
  wrap.appendChild(el("p", { className: "iface-action-form-title" }, `Port properties · ${port}`));
  wrap.appendChild(sf.form);
  const errOut = el("div", { className: "form-error-out" });
  wrap.appendChild(errOut);
  const btnRow = el("div", { className: "form-foot iface-action-form-actions" });
  const cancel = el("button", { type: "button", className: "btn btn-ghost btn-sm" }, "Cancel");
  cancel.addEventListener("click", () => { formHost.textContent = ""; });
  const stage = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Queue");
  btnRow.appendChild(cancel);
  btnRow.appendChild(stage);
  wrap.appendChild(btnRow);
  formHost.appendChild(wrap);

  stage.addEventListener("click", () => {
    errOut.textContent = "";
    if (!sf.validate()) return;
    enqueuePortConfig(device, port, sf.getValues(), currentDevice);
    showToast({ kind: "success", title: "Queued", body: `Port properties on ${port} — Save to apply.` });
    reload();
  });
}

// openPopulateDefaultPorts fetches the platform's default port template (newtron
// #301), lists the node's UN-configured ports, and lets the operator pick which to
// fill with newtron's defaults. Chosen ports fold into one whole-device update
// (enqueuePortConfig → PUT topology/nodes on Save). The console relays newtron's
// template values verbatim — it holds no port-config convention of its own.
async function openPopulateDefaultPorts(host: HTMLElement, device: string, reload: () => void): Promise<void> {
  host.textContent = "";
  host.appendChild(el("p", { className: "iface-action-form-loading" }, "Loading default port template…"));
  let template: Record<string, Record<string, unknown>>;
  let currentDevice: Record<string, unknown>;
  let topoPorts: Record<string, unknown>;
  try {
    const node = await fetchSpecDetail("nodes", device);
    const platform = (node as { platform?: string }).platform ?? "";
    if (!platform) {
      host.textContent = "";
      host.appendChild(el("p", { className: "iface-view-offline-note" },
        "This node has no platform, so there's no default-port template to apply."));
      return;
    }
    const [tmpl, topo] = await Promise.all([fetchPlatformPorts(platform), fetchTopology()]);
    template = tmpl;
    currentDevice = ((topo as { nodes?: Record<string, Record<string, unknown>> } | null)?.nodes ?? {})[device] ?? {};
    topoPorts = (currentDevice.ports as Record<string, unknown>) ?? {};
  } catch (err) {
    host.textContent = "";
    host.appendChild(el("p", { className: "panel-error" }, `Couldn't load the default port template: ${formatErrorBrief(err)}`));
    return;
  }

  const unconfigured = Object.keys(template).filter((p) => !(p in topoPorts)).sort(comparePorts);
  host.textContent = "";
  if (unconfigured.length === 0) {
    host.appendChild(el("p", { className: "iface-view-offline-note" },
      Object.keys(template).length === 0
        ? "This platform exposes no default-port template."
        : "Every port in the platform template is already configured."));
    return;
  }

  const wrap = el("div", { className: "iface-action-form iface-populate-form" });
  wrap.appendChild(el("p", { className: "iface-action-form-title" }, `Populate default ports · ${unconfigured.length} available`));
  wrap.appendChild(el("p", { className: "iface-populate-hint" },
    "Applies the platform's default config (from newtron) to the ports you select. Uncheck any you don't want."));
  const list = el("div", { className: "iface-populate-list" });
  const boxes = new Map<string, HTMLInputElement>();
  for (const p of unconfigured) {
    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = true;
    boxes.set(p, cb);
    const label = el("label", { className: "iface-populate-item" });
    label.appendChild(cb);
    label.appendChild(el("span", {}, p));
    list.appendChild(label);
  }
  wrap.appendChild(list);

  const btnRow = el("div", { className: "form-foot iface-action-form-actions" });
  const cancel = el("button", { type: "button", className: "btn btn-ghost btn-sm" }, "Cancel");
  cancel.addEventListener("click", () => { host.textContent = ""; });
  const add = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Add ports") as HTMLButtonElement;
  const selected = (): string[] => unconfigured.filter((p) => boxes.get(p)?.checked);
  const sync = (): void => { const n = selected().length; add.textContent = `Add ${n} port${n === 1 ? "" : "s"}`; add.disabled = n === 0; };
  for (const cb of boxes.values()) cb.addEventListener("change", sync);
  sync();
  add.addEventListener("click", () => {
    const chosen = selected();
    for (const p of chosen) enqueuePortConfig(device, p, { ...(template[p] ?? {}) }, currentDevice);
    showToast({ kind: "success", title: "Queued", body: `${chosen.length} default port${chosen.length === 1 ? "" : "s"} on ${device} — Save to apply.` });
    host.textContent = "";
    reload();
  });
  btnRow.appendChild(cancel);
  btnRow.appendChild(add);
  wrap.appendChild(btnRow);
  host.appendChild(wrap);
}

// findIfaceAction locates an INTERFACE_ACTIONS def by group + id (+ optional
// label, for the configure-interface variants that share one id).
function findIfaceAction(group: string, id: string, label?: string): ActionDef | undefined {
  const g = INTERFACE_ACTIONS.find((x) => x.group === group);
  return g?.items.find((a) => a.id === id && (label === undefined || a.label === label));
}

// portModeMenu builds the "Configure ▾" button; clicking it lists the Port-mode
// variants (access / trunk / routed / clear) into formHost. Field actions open
// an inline form; the field-less Clear confirms then stages.
function portModeMenu(formHost: HTMLElement, device: string, iface: string, reload: () => void): HTMLElement {
  const btn = el("button", { type: "button", className: "iface-action-btn" }, "Configure ▾");
  btn.addEventListener("click", () => {
    formHost.textContent = "";
    const menu = el("div", { className: "iface-portmode-menu" });
    const group = INTERFACE_ACTIONS.find((x) => x.group === "Port mode");
    for (const action of group?.items ?? []) {
      const b = el("button", { type: "button", className: "iface-action-btn" + (action.danger ? " iface-action-btn--danger" : "") }, action.label);
      b.addEventListener("click", async () => {
        if ((action.fields ?? []).length === 0) {
          if (action.confirm && !await confirmInline({ title: `${action.label}?`, body: action.confirm, danger: !!action.danger, confirmLabel: "Queue" })) return;
          await stageIfaceAction(device, iface, action, {}, reload);
        } else {
          openIfaceForm(formHost, device, iface, action, reload);
        }
      });
      menu.appendChild(b);
    }
    formHost.appendChild(menu);
  });
  return btn;
}

// openIfaceForm renders an interface action's inline form into formHost.
function openIfaceForm(formHost: HTMLElement, device: string, iface: string, action: ActionDef | undefined, reload: () => void): void {
  formHost.textContent = "";
  if (!action) return;
  const form = el("form", { className: "vform vform--tight vform--card iface-action-form" });
  form.appendChild(el("p", { className: "iface-action-form-title" }, `${action.label} · ${iface}`));
  const reads: Array<{ field: ActionField; get: () => string | number }> = [];
  for (const field of action.fields ?? []) {
    const r = renderActionField(field);
    form.appendChild(r.row);
    reads.push({ field, get: r.get });
  }
  const errOut = el("div", { className: "form-error-out" });
  form.appendChild(errOut);
  const btnRow = el("div", { className: "form-foot iface-action-form-actions" });
  const cancel = el("button", { type: "button", className: "btn btn-ghost btn-sm" }, "Cancel");
  cancel.addEventListener("click", () => { formHost.textContent = ""; });
  const stage = el("button", { type: "submit", className: "btn btn-primary btn-sm" + (action.danger ? " btn-danger" : "") }, "Queue");
  btnRow.appendChild(cancel);
  btnRow.appendChild(stage);
  form.appendChild(btnRow);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errOut.textContent = "";
    const values: Record<string, unknown> = {};
    for (const { field, get } of reads) {
      const v = get();
      if (field.required && (v === "" || v === undefined)) {
        errOut.appendChild(el("p", { className: "panel-error" }, `${field.label} is required.`));
        return;
      }
      if (v !== "" && v !== undefined) values[field.name] = v;
    }
    if (action.confirm && !await confirmInline({ title: `${action.label}?`, body: action.confirm, danger: !!action.danger, confirmLabel: "Queue" })) return;
    formHost.textContent = "";
    await stageIfaceAction(device, iface, action, values, reload);
  });
  formHost.appendChild(form);
}

// renderActionField renders one interface action field (text / number / select).
// The "service" field is a dropdown populated from the network's services.
function renderActionField(field: ActionField): { row: HTMLElement; get: () => string | number } {
  const row = el("div", { className: "iface-field" });
  row.appendChild(el("label", { className: "iface-field-label" }, field.label + (field.required ? " *" : "")));
  if (field.name === "service") {
    const sel = el("select", { className: "form-control" }) as HTMLSelectElement;
    sel.appendChild(new Option("Loading…", ""));
    void fetch(apiPath("services"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { services: [] }))
      .then((d: unknown) => {
        sel.textContent = "";
        sel.appendChild(new Option("Select a service…", ""));
        for (const s of (d as { services?: { name: string }[] }).services ?? []) sel.appendChild(new Option(s.name, s.name));
      })
      .catch(() => { sel.textContent = ""; sel.appendChild(new Option("(couldn't load services)", "")); });
    row.appendChild(sel);
    return { row, get: () => sel.value };
  }
  const input = el("input", { type: field.type === "number" ? "number" : "text", className: "form-control" }) as HTMLInputElement;
  if (field.hint) input.placeholder = field.hint;
  row.appendChild(input);
  return {
    row,
    get: () => field.type === "number"
      ? (input.value.trim() === "" ? "" : Number(input.value))
      : input.value.trim(),
  };
}

// stageIfaceAction enqueues an interface action onto the workspace queue (which
// computes its undo inverse) and refreshes the view to reflect the pending edit.
async function stageIfaceAction(device: string, iface: string, action: ActionDef | undefined, values: Record<string, unknown>, reload: () => void): Promise<void> {
  if (!action) return;
  const body = { ...(action.wireBody ?? {}), ...values };
  enqueueInterfaceAction(device, iface, action.id, `${action.label} · ${iface}`, body, action.danger);
  showToast({ kind: "success", title: "Queued", body: `${action.label} on ${iface} — Save to apply.` });
  reload();
}

function statusTitle(row: InterfaceRow): string {
  return `admin ${row.adminStatus ?? "?"} · oper ${row.operStatus || "?"}`;
}
function roleLabel(role: InterfaceRow["role"]): string {
  switch (role) {
    case "lag-member": return "LAG member";
    case "available": return "Available";
    default: return role.charAt(0).toUpperCase() + role.slice(1);
  }
}


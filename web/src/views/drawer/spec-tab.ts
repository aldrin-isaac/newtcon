// views/drawer/spec-tab.ts — the device drawer's Spec tab: this device's
// DECLARED intent, from both places the network spec keeps it.
//
//   - the node spec — static identity (mgmt_ip, loopback_ip, zone, platform,
//     service bindings). The unified-substrate convention (PR #148) names the
//     node spec after the device, so it's fetchSpecDetail("nodes", device).
//   - the topology.json device entry — provisioning steps + per-port config,
//     i.e. the intents provisioning actually replays.
//
// Both render so "declared intent" is complete; actuated reality lives on the
// other tabs.

import { fetchSpecDetail } from "../../api/newtcon/network.js";
import { fetchTopology } from "../../api/newtcon/nodes.js";
import { fetchSchema, resolveSlugToKind } from "../../api/newtcon/schema.js";
import { ApiError } from "../../api/newtcon/services.js";
import { el, renderValue } from "../../dom.js";
import { comparePorts } from "../../port-config.js";
import { renderErrorInto, renderSpecDetailInto, renderValueInto, toSpecField } from "../../spec-render.js";
import { displaySchemaFor } from "../specs/index.js";

export function renderSpecTab(container: HTMLElement, device: string): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "node-spec-intro" },
    "Declared intent for this device — node + topology.json. To inspect actuated reality, switch tabs."));

  const profSection = el("div", { className: "node-spec-section" });
  profSection.appendChild(el("h4", { className: "node-spec-section-title" }, "Node"));
  const profBody = el("div", { className: "node-spec-body" });
  profBody.appendChild(el("p", { className: "spec-detail-empty-state" }, "Loading…"));
  profSection.appendChild(profBody);
  container.appendChild(profSection);

  const topoSection = el("div", { className: "node-spec-section" });
  topoSection.appendChild(el("h4", { className: "node-spec-section-title" }, "Topology intent"));
  const topoBody = el("div", { className: "node-spec-body" });
  topoBody.appendChild(el("p", { className: "spec-detail-empty-state" }, "Loading…"));
  topoSection.appendChild(topoBody);
  container.appendChild(topoSection);

  void fetchSpecDetail("nodes", device)
    .then(async (data) => {
      const schemaKindForDetail = await resolveSlugToKind("nodes").catch(() => null);
      const schemaForDetail = schemaKindForDetail
        ? await fetchSchema(schemaKindForDetail).catch(() => null)
        : null;
      profBody.textContent = "";
      if (schemaForDetail) {
        renderSpecDetailInto(profBody, schemaForDetail.fields.map(toSpecField), data, ["name"]);
      } else {
        const fields = displaySchemaFor("nodes");
        if (fields) renderSpecDetailInto(profBody, fields, data, ["name"]);
        else renderValueInto(profBody, data);
      }
    })
    .catch((err) => {
      profBody.textContent = "";
      if (err instanceof ApiError && err.status === 404) renderProfileNotFound(profBody, device);
      else renderErrorInto(profBody, err);
    });

  void fetchTopology()
    .then((topo) => {
      const devices = (topo as { nodes?: Record<string, unknown> } | null)?.nodes ?? {};
      renderTopologyIntentInto(topoBody, devices[device] ?? null);
    })
    .catch((err) => { topoBody.textContent = ""; renderErrorInto(topoBody, err); });
}

// renderProfileNotFound renders the empty-state for the Node section when
// no node spec is named after the device. Two reasons this can happen:
//
//   - Older topologies created before the unified-substrate convention
//     (PR #148) may name node spec and device differently.
//   - The node spec was deleted but the topology entry survived.
//
// We surface this honestly rather than rendering a generic "not found" — the
// operator's mental model of "every device has a node spec" should not be
// silently violated by the UI.
function renderProfileNotFound(container: HTMLElement, device: string): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "panel-error" }, "No node found"));
  container.appendChild(el(
    "p",
    { className: "panel-error-detail" },
    `No profile spec named "${device}" exists for this device. ` +
    "Nodes and device names are conventionally identical (created together " +
    "from the Topology view). If this device's node uses a different name, " +
    "find it under the Specs view → Nodes."
  ));
}

// humanizeStepUrl turns a topology step verb ("/setup-device") into a readable
// title ("Setup device").
function humanizeStepUrl(url: string): string {
  const slug = url.replace(/^\//, "").replace(/-/g, " ").trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Step";
}

// renderTopologyIntentInto renders a device's topology.json entry — its
// provisioning steps (the declared intent newtron replays on provision) and its
// per-port config. Steps render as labeled field groups; ports as a compact
// table ordered low→high (comparePorts).
function renderTopologyIntentInto(host: HTMLElement, entry: unknown): void {
  host.textContent = "";
  const e = entry && typeof entry === "object" ? entry as { steps?: unknown; ports?: unknown } : {};
  const steps = Array.isArray(e.steps) ? e.steps : [];
  const ports = e.ports && typeof e.ports === "object" ? e.ports as Record<string, Record<string, unknown>> : {};
  const portNames = Object.keys(ports).sort(comparePorts);

  if (steps.length === 0 && portNames.length === 0) {
    host.appendChild(el("p", { className: "spec-detail-empty-state" },
      "No topology intent declared — no provisioning steps or port config in topology.json for this device."));
    return;
  }

  if (steps.length > 0) {
    host.appendChild(el("h5", { className: "node-spec-subtitle" }, `Provisioning steps (${steps.length})`));
    for (const raw of steps) {
      const step = raw && typeof raw === "object" ? raw as { url?: unknown; params?: unknown } : {};
      const url = typeof step.url === "string" ? step.url : "step";
      const det = el("details", { className: "node-spec-step" });
      (det as HTMLDetailsElement).open = true;
      det.appendChild(el("summary", { className: "node-spec-step-summary" }, humanizeStepUrl(url)));
      const params = step.params && typeof step.params === "object" ? step.params as Record<string, unknown> : {};
      const fields = params.fields && typeof params.fields === "object" ? params.fields as Record<string, unknown> : params;
      const dl = el("dl", { className: "spec-detail drawer-detail" });
      const fieldEntries = Object.entries(fields);
      if (fieldEntries.length === 0) {
        dl.appendChild(el("dd", { className: "spec-detail-value spec-detail-empty" }, "—"));
      } else {
        for (const [k, v] of fieldEntries) {
          dl.appendChild(el("dt", { className: "spec-detail-label" }, k));
          const dd = el("dd", { className: "spec-detail-value" });
          dd.appendChild(renderValue(v));
          dl.appendChild(dd);
        }
      }
      det.appendChild(dl);
      host.appendChild(det);
    }
  }

  if (portNames.length > 0) {
    host.appendChild(el("h5", { className: "node-spec-subtitle" }, `Port config (${portNames.length})`));
    const cols = ["admin_status", "mtu", "speed", "description"];
    const table = el("table", { className: "table table--2xs node-spec-port-table" });
    const thead = el("thead");
    const hr = el("tr");
    for (const l of ["Port", "Admin", "MTU", "Speed", "Description"]) hr.appendChild(el("th", {}, l));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const name of portNames) {
      const cfg = ports[name] ?? {};
      const tr = el("tr");
      tr.appendChild(el("td", { className: "node-spec-port-name" }, name));
      for (const c of cols) {
        const v = cfg[c];
        tr.appendChild(el("td", {}, v === undefined || v === null || v === "" ? "—" : String(v)));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
  }
}

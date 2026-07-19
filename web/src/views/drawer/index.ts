// views/drawer/index.ts — the device drawer core (console-uplift 1.3c,
// move-only extraction from app.ts, completing the stacked 1.3): NODE_TABS +
// tab dispatch (loadNodeTab), openNodeDrawer + header, Drift / Config-DB /
// History tabs, the lifecycle section, the link drawer, and the shared
// detail-render helpers (renderErrorInto / renderLoadingInto /
// renderValueInto / renderSpecDetailInto / toSpecField) that views/specs and
// views/drawer/state previously cycle-imported from app.ts — both temporary
// cycles dissolve here.
//
// ONE remaining temp import (dissolves in uplift 1.4): isProvisioning lives
// with the topology poll in app.ts until the Topology view extracts.

// NODE_TABS — the 6 primary tabs the device drawer surfaces. Down from
// 14 (collapsed VLANs / VRFs / ACLs / BGP / EVPN / LAGs / Neighbors
// under "State"; tucked Config DB / Intent Tree / Projection under a
// "Raw" disclosure rendered below the panels). Ordered by operator
// priority: Summary (at-a-glance dashboard) → Interfaces (most-acted-
// on surface) → State (observed reality, grouped) → Spec (declared
// intent, visually distinct) → Drift (actionable diff, first-class)
// → History (audit timeline).

import { type AuditEvent, fetchAuditEvents } from "../../api/newtcon/audit.js";
import { type LabState, fetchLabStatus, postLabStartNode, postLabStopNode } from "../../api/newtcon/lab.js";
import { type SpecKind, fetchSpecDetail } from "../../api/newtcon/network.js";
import { fetchNodeConfigDBEntry, fetchNodeConfigDBTable, fetchNodeDrift, fetchNodeInfo, fetchNodeInterface, fetchNodeInterfaceBinding, fetchNodeInterfaces, fetchTopology, postNodeReconcile } from "../../api/newtcon/nodes.js";
import { fetchSchema, resolveKindToSlug, resolveSlugToKind } from "../../api/newtcon/schema.js";
import { ApiError } from "../../api/newtcon/services.js";
import { isProvisioning, type TopoLink } from "../topology/index.js";
import { renderEventsError, renderEventsTable } from "../../audit.js";
import { confirmInline } from "../../confirm-inline.js";
import { resolveDeviceStatus } from "../../device-status.js";
import { el, renderValue } from "../../dom.js";
import { activeNetwork } from "../../network-switcher.js";
import { comparePorts } from "../../port-config.js";
import { engineOpErrorBody, extractUnderlyingMessage, formatErrorBrief } from "../../render-error.js";
import { type SpecField, buildSpecDetailShape } from "../../spec-detail-shape.js";
import { showToast } from "../../toast.js";
import { type TopologyViewMode } from "../../topology-view-mode.js";
import { displaySchemaFor, kindTitleFor, openDetail } from "../specs/index.js";
import { renderInterfaceTab } from "./interfaces.js";
import { renderRawSection, renderStateTab } from "./state.js";
const NODE_TABS = [
  { id: "interfaces", label: "Interfaces" },
  { id: "state",      label: "State" },
  { id: "spec",       label: "Spec" },
  { id: "drift",      label: "Drift" },
  { id: "history",    label: "History" },
] as const;

type NodeTabId = typeof NODE_TABS[number]["id"];

// renderLoadingInto clears a container and shows a loading indicator.
export function renderLoadingInto(container: HTMLElement): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "status-loading" }, "Loading…"));
}

// renderErrorInto clears a container and shows an error message.
export function renderErrorInto(container: HTMLElement, err: unknown): void {
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

// renderProfileNotFound renders the empty-state for the Profile sub-tab when
// no profile spec is named after the device. Two reasons this can happen:
//
//   - Older topologies created before the unified-substrate convention
//     (PR #148) may name profile and device differently.
//   - The profile was deleted but the topology entry survived.
//
// We surface this honestly rather than rendering a generic "not found" — the
// operator's mental model of "every node has a profile" should not be
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

// renderValueInto places renderValue output into a container, adding .drawer-detail.
export function renderValueInto(container: HTMLElement, data: unknown): void {
  container.textContent = "";
  const body = renderValue(data);
  if (body instanceof HTMLElement) {
    body.classList.add("drawer-detail");
  }
  container.appendChild(body);
}

// renderSpecDetailInto renders spec data with a tailored, schema-aware
// layout: each schema field becomes a labeled row in the order the schema
// defines, and any extra fields newtron returned (not in the schema) sit
// inside an "All fields" disclosure so the operator never silently loses
// visibility of newtron data — even fields the schema hasn't been updated
// to cover (additions made after this build). The one exception is ssh_pass,
// redacted below — it's a credential some reads return in the clear.
//
// extraExcludes is for fields already rendered elsewhere in the drawer
// (e.g. sub-rule children for kinds that have a dedicated rules / queues /
// prefixes section below the body). Pass [] for the default.
//
// Falls back to renderValueInto when data is not an object (defensive
// against newtron returning a primitive or null).
// toSpecField adapts a newtron SchemaField to the narrower SpecField the
// detail renderer consumes. ref_kind is carried through only for type
// "ref" fields, so the renderer knows which rows become cross-link chips.
export function toSpecField(f: import("../../api/newtcon/schema.js").SchemaField): SpecField {
  const out: SpecField = { name: f.name, label: f.label };
  if (f.type === "ref" && f.ref_kind) out.refKind = f.ref_kind;
  return out;
}

export function renderSpecDetailInto(container: HTMLElement, fields: SpecField[], data: unknown, extraExcludes: string[] = []): void {
  container.textContent = "";
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(container, data);
    return;
  }
  // "name" is rendered in the drawer header already (drawer-name); skip it
  // here to avoid a redundant row in the body. extraExcludes adds caller-
  // supplied fields (typically a sub-rule's wire-field name).
  //
  // ssh_pass is redacted globally: some reads (GET /nodes/{name}) return the
  // RESOLVED login with ssh_pass IN THE CLEAR (newtlab dials with it), and since
  // it left the NodeSpec schema (newtron#388) it would otherwise surface in the
  // "All fields" disclosure. The device password is never rendered here — the SSH
  // Login control shows only the masked, per-scope authored value.
  const shape = buildSpecDetailShape(fields, data as Record<string, unknown>, ["name", "ssh_pass", ...extraExcludes]);

  // Empty-state: the schema is just `name` (zones today) AND newtron returned
  // nothing else. Operator gets an honest "nothing more to see" rather than
  // a blank drawer body that looks like a render failure.
  if (shape.rows.length === 0 && shape.extras.length === 0) {
    container.appendChild(el("p", { className: "spec-detail-empty-state" },
      "This spec has no additional fields."));
    return;
  }

  const dl = el("dl", { className: "spec-detail drawer-detail" });
  for (const row of shape.rows) {
    dl.appendChild(el("dt", { className: "spec-detail-label" }, row.label));
    const dd = el("dd", { className: "spec-detail-value" });
    dd.appendChild(renderSpecValue(row));
    dl.appendChild(dd);
  }
  container.appendChild(dl);

  if (shape.extras.length > 0) {
    const det = el("details", { className: "disclosure spec-detail-extras" });
    det.appendChild(el("summary", { className: "spec-detail-extras-summary" },
      `All fields (${shape.extras.length} additional)`));
    const dlx = el("dl", { className: "kv spec-detail" });
    for (const row of shape.extras) {
      dlx.appendChild(el("dt", { className: "spec-detail-label spec-detail-label--extra" }, row.label));
      const dd = el("dd", { className: "spec-detail-value" });
      dd.appendChild(renderSpecValue(row));
      dlx.appendChild(dd);
    }
    det.appendChild(dlx);
    container.appendChild(det);
  }
}

// humanizeStepUrl turns a topology step verb ("/setup-device") into a readable
// title ("Setup device").
function humanizeStepUrl(url: string): string {
  const slug = url.replace(/^\//, "").replace(/-/g, " ").trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Step";
}

// renderTopologyIntentInto renders a device's topology.json entry — its
// provisioning steps (the declared intent newtron replays on provision) and its
// per-port config — into the Spec tab. Steps render as labeled field groups;
// ports as a compact table ordered low→high (comparePorts).
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

// renderSpecValue renders one SpecRow's value cell. Empty values show
// "—". Ref rows (refKind set) with a non-empty string value render as a
// clickable chip that opens the referenced spec's drawer; everything
// else falls through to the generic renderValue. Resolution of the
// ref's kind → URL slug happens lazily on click (the schema cache is
// already warm by the time a detail drawer is open, so it's instant).
function renderSpecValue(row: import("../../spec-detail-shape.js").SpecRow): Node {
  if (row.empty) return el("span", { className: "spec-detail-empty" }, "—");
  if (row.refKind && typeof row.value === "string" && row.value !== "") {
    return renderRefChip(row.refKind, row.value);
  }
  return renderValue(row.value);
}

// renderRefChip builds a clickable chip for a cross-spec reference. The
// click resolves refKind (a newtron kind name) to its URL slug and
// opens that spec's detail drawer over the current one. A failed
// resolution (embedded kind, schema not loaded) surfaces a toast rather
// than a dead click.
function renderRefChip(refKind: string, name: string): HTMLElement {
  const chip = el("button", {
    type: "button",
    className: "chip chip--mono chip--clickable chip--ref",
    title: `Open ${name}`,
  }, name) as HTMLButtonElement;
  chip.addEventListener("click", () => {
    void (async () => {
      const slug = await resolveKindToSlug(refKind).catch(() => null);
      if (!slug) {
        showToast({
          kind: "error",
          title: `Can't open "${name}"`,
          body: "Its spec type isn't separately viewable.",
        });
        return;
      }
      const kind = slug as SpecKind;
      await openDetail(kind, kindTitleFor(kind), name);
    })();
  });
  return chip;
}

// renderConfigDBTab renders the CONFIG_DB sub-tab with 3-level navigation.
// renderDriftTab renders the drift list + a Reconcile button. Newtron returns
// either an empty array (no drift) or an array of drift items per table/key.
function renderDriftTab(container: HTMLElement, data: unknown, device?: string): void {
  container.textContent = "";
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    container.appendChild(
      el("p", { className: "drift-empty" }, "No delta drift detected. Device matches its last-applied intent."),
    );
    container.appendChild(
      el(
        "p",
        { className: "drift-empty-help" },
        "Use Reconcile (mode: topology) below to compare the device against the full topology spec from scratch.",
      ),
    );
    if (device) {
      container.appendChild(renderReconcileSection(device));
    }
    return;
  }
  const heading = el(
    "p",
    { className: "drift-header" },
    `${items.length} drift item${items.length === 1 ? "" : "s"} — device does not match intent.`,
  );
  container.appendChild(heading);
  const body = renderValue(data);
  if (body instanceof HTMLElement) body.classList.add("drift-detail");
  container.appendChild(body);

  if (device) {
    container.appendChild(renderReconcileSection(device));
  }
}

// renderReconcileSection emits the "Reconcile" button + preview/apply flow.
// Preview path: POST .../reconcile?dry_run=true → show ChangeSet structure.
// Apply path: confirm + POST without dry_run → show result + auto-refresh drift.
function renderReconcileSection(device: string): HTMLElement {
  const section = el("section", { className: "reconcile-section" });
  section.appendChild(el("h3", { className: "reconcile-heading" }, "Reconcile"));
  section.appendChild(
    el(
      "p",
      { className: "reconcile-help" },
      "Preview the corrective intent newtron would push to restore this device to its intent. Apply executes the change atomically per-device.",
    ),
  );

  const controls = el("div", { className: "reconcile-controls" });
  const modeLabel = el("label", { className: "reconcile-mode-label" }, "Mode: ");
  const modeSelect = el("select", { className: "reconcile-mode-select" }) as HTMLSelectElement;
  const optDelta = el("option", { value: "" }, "delta (changes since last apply)") as HTMLOptionElement;
  const optTopology = el("option", { value: "topology" }, "topology (full reconcile to topology spec)") as HTMLOptionElement;
  modeSelect.appendChild(optDelta);
  modeSelect.appendChild(optTopology);
  modeLabel.appendChild(modeSelect);
  controls.appendChild(modeLabel);
  const previewBtn = el("button", { type: "button", className: "reconcile-btn reconcile-btn--preview" }, "Preview reconcile");
  controls.appendChild(previewBtn);
  section.appendChild(controls);
  const out = el("div", { className: "reconcile-output" });
  section.appendChild(out);

  previewBtn.addEventListener("click", async () => {
    previewBtn.disabled = true;
    out.textContent = "";
    const chosenMode = modeSelect.value || undefined;
    out.appendChild(el("p", { className: "status-loading" }, `Previewing (mode: ${chosenMode ?? "delta"})…`));
    try {
      const preview = chosenMode === undefined ? await postNodeReconcile(device, { dryRun: true }) : await postNodeReconcile(device, { dryRun: true, mode: chosenMode });
      out.textContent = "";
      const previewItems = Array.isArray(preview) ? preview : [];
      out.appendChild(
        el(
          "p",
          { className: previewItems.length === 0 ? "reconcile-noop" : "reconcile-preview-header" },
          previewItems.length === 0
            ? "Preview returned no changes — nothing to reconcile."
            : `Preview: ${previewItems.length} corrective change${previewItems.length === 1 ? "" : "s"}. Review before applying.`,
        ),
      );
      const body = renderValue(preview);
      if (body instanceof HTMLElement) body.classList.add("reconcile-preview-body");
      out.appendChild(body);

      if (previewItems.length > 0) {
        const applyBtn = el("button", { type: "button", className: "reconcile-btn reconcile-btn--apply" }, "Apply reconcile (atomic per device)");
        out.appendChild(applyBtn);
        applyBtn.addEventListener("click", async () => {
          const ok = await confirmInline({
            title: `Reconcile ${device}?`,
            body: "Corrective changes will be written to the device's CONFIG_DB atomically. Verify the preview above first.",
            confirmLabel: "Apply reconcile",
          });
          if (!ok) return;
          applyBtn.disabled = true;
          previewBtn.disabled = true;
          applyBtn.textContent = "Applying…";
          try {
            const result = chosenMode === undefined ? await postNodeReconcile(device, { dryRun: false }) : await postNodeReconcile(device, { dryRun: false, mode: chosenMode });
            applyBtn.replaceWith(
              el("p", { className: "reconcile-applied" }, "Reconcile applied. Result:"),
            );
            const resBody = renderValue(result);
            if (resBody instanceof HTMLElement) resBody.classList.add("reconcile-result-body");
            out.appendChild(resBody);
            // Re-fetch drift to refresh the upper drift list.
            const fresh = await fetchNodeDrift(device);
            out.appendChild(el("hr", { className: "reconcile-sep" }));
            out.appendChild(el("p", { className: "reconcile-refresh-header" }, "Drift after reconcile:"));
            const driftBody = renderValue(fresh);
            if (driftBody instanceof HTMLElement) driftBody.classList.add("drift-detail");
            out.appendChild(driftBody);
          } catch (err) {
            applyBtn.replaceWith(el("p", { className: "panel-error" }, "Apply failed"));
            renderErrorInto(out, err);
          }
        });
      }
    } catch (err) {
      out.textContent = "";
      renderErrorInto(out, err);
    } finally {
      previewBtn.disabled = false;
    }
  });

  return section;
}

export function renderConfigDBTab(container: HTMLElement, device: string, tableMap: unknown): void {
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

// Phase 3: Lifecycle section in the device inspector. Substrate-agnostic
// state + substrate-aware actions:
//   - Lab VM running   → Stop button + SSH/console snippets
//   - Lab VM stopped   → Start button
//   - Lab VM booting   → state pill only (transition in progress)
//   - Not realized     → guidance text pointing at "Deploy as lab"
//   - Reachable via probe (not lab) → state pill only (start/stop n/a)
//
// engineOpErrorBody: for newtlab lifecycle ops (deploy / provision / destroy),
// prefer newtron's real underlying error — e.g. a reconcile failure
// "…DEVICE_METADATA|localhost not found in CONFIG_DB" (device booted but SONiC
// config uninitialised, so Provision can't bootstrap it) — over newtcon's generic
// "upstream unreachable" wrapper, which points the operator at the wrong thing.
// Phase 4 may move this into a standalone module if the lifecycle surface
// grows further (console viewer, log tail, etc.).
async function renderLifecycleSection(host: HTMLElement, device: string, viewMode?: TopologyViewMode): Promise<void> {
  host.textContent = "";
  // Section label reflects the substrate the drawer is showing — same
  // operator-intent framing as the topology view chips. Default
  // ("Lifecycle") covers the cases where the drawer is opened outside
  // a view-mode context.
  const sectionLabel = viewMode === "spec-physical" ? "Physical state"
    : viewMode === "spec-lab" ? "Lab VM"
    : viewMode === "spec" ? "Spec"
    : "Lifecycle";
  host.appendChild(el("p", { className: "lifecycle-header" }, sectionLabel));
  const body = el("div", { className: "lifecycle-body" });
  body.appendChild(el("p", { className: "lifecycle-loading" }, "Checking substrate…"));
  host.appendChild(body);

  const network = activeNetwork();
  let labState: LabState | null = null;
  // Physical view inspects the physical substrate only — don't even
  // fetch lab state, so a coincidentally-running lab VM with the same
  // name can't bleed VM details into the drawer. Same principle for
  // Spec view (intent only, no actuation).
  if (viewMode !== "spec-physical" && viewMode !== "spec") {
    try { labState = await fetchLabStatus(network); } catch { /* lab unknown */ }
  }
  let online: boolean | undefined;
  let probeErr: unknown;
  try { await fetchNodeInfo(device); online = true; } catch (e) { online = false; probeErr = e; }

  const status = resolveDeviceStatus(device, labState, online, isProvisioning(network));
  const labNode = labState?.nodes?.[device];

  body.textContent = "";

  // Spec view: intent only. Show a single hint that the device is
  // declared but no actuation overlay is being requested here.
  if (viewMode === "spec") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is declared in this network's topology spec. Switch to Lab or Physical to inspect actuation state.`));
    return;
  }

  // Physical view: physical-substrate state only. Skip the lab pill
  // and any VM affordances even when a lab happens to be running.
  if (viewMode === "spec-physical") {
    const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${online ? "running" : "down"}` });
    pill.appendChild(el("span", { className: "lifecycle-pill-state" }, online ? "online" : "offline"));
    pill.appendChild(el("span", { className: "lifecycle-pill-detail" },
      online ? "physical device reachable" : "no response from device"));
    body.appendChild(pill);
    if (!online) {
      body.appendChild(el("p", { className: "lifecycle-hint" },
        `Newtron's /info probe got no response from ${device}. The device may be unreachable, not yet provisioned, or running but firewalled.`));
    }
    return;
  }

  // Lab view (and the default "Lifecycle" fallback path for legacy
  // openNodeDrawer callers) — show the substrate pill, lab VM
  // controls, and SSH/console snippets.
  const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${status.state}` });
  pill.appendChild(el("span", { className: "lifecycle-pill-state" }, status.state));
  pill.appendChild(el("span", { className: "lifecycle-pill-detail" }, status.detail));
  body.appendChild(pill);

  if (status.state === "unrealized") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `No substrate is realizing ${device} yet. Switch to the Lab view and click "Deploy" to deploy this network as VMs.`));
    return;
  }

  if (status.state === "unreachable") {
    // Surface the REAL cause. newtcon classifies newtron's http_5xx as
    // "newtron_unavailable", but newtron is up — the device is. The genuinely
    // useful detail (e.g. "DEVICE_METADATA|localhost not found in CONFIG_DB" →
    // the device is booted but SONiC config isn't initialized) lives in the
    // probe error's underlying_error_message, not the generic "upstream
    // unreachable" wrapper.
    const reason = probeErr instanceof ApiError ? extractUnderlyingMessage(probeErr.details) : null;
    const hint = el("p", { className: "lifecycle-hint" },
      `${device}'s VM is running, but newtron can't read its live state. You can still stop the VM or SSH in to investigate.`);
    body.appendChild(hint);
    if (reason) {
      body.appendChild(el("p", { className: "lifecycle-hint lifecycle-hint--detail" },
        `newtron reports: ${reason}`));
    }
  }

  if (status.state === "provisioning") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is being provisioned — newtron is pushing config + restarting containers. Live reads pause until it completes; the status returns to running automatically.`));
  }

  // Start/Stop — only meaningful for lab-managed VMs.
  if (labNode) {
    const actions = el("div", { className: "lifecycle-actions" });
    if (status.state === "running" || status.state === "booting" || status.state === "unreachable" || status.state === "provisioning") {
      const stop = el("button", { type: "button", className: "btn btn-danger btn-sm" }, "Stop VM");
      stop.addEventListener("click", async () => {
        const ok = await confirmInline({
          title: `Stop VM "${device}"?`,
          body: `In lab "${network}". The device will go offline.`,
          danger: true,
          confirmLabel: "Stop",
        });
        if (!ok) return;
        stop.setAttribute("disabled", "");
        stop.textContent = "Stopping…";
        postLabStopNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            stop.removeAttribute("disabled");
            stop.textContent = "Stop VM";
            showToast({ kind: "error", title: "Stop failed", body: engineOpErrorBody(err) });
          });
      });
      actions.appendChild(stop);
    }
    if (status.state === "down") {
      const start = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Start VM");
      start.addEventListener("click", () => {
        start.setAttribute("disabled", "");
        start.textContent = "Starting…";
        postLabStartNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            start.removeAttribute("disabled");
            start.textContent = "Start VM";
            showToast({ kind: "error", title: "Start failed", body: engineOpErrorBody(err) });
          });
      });
      actions.appendChild(start);
    }
    body.appendChild(actions);

    // SSH/console snippets — only when the VM is up and ports are known
    // (incl. unreachable: the VM is up, so SSH is exactly how you'd investigate).
    if ((status.state === "running" || status.state === "unreachable") && labNode.ssh_port) {
      const sshUser = labNode.ssh_user || "admin";
      const sshCmd = `ssh -p ${labNode.ssh_port} ${sshUser}@localhost`;
      body.appendChild(buildCopyRow("SSH", sshCmd));
    }
    if (labNode.console_port) {
      const consoleCmd = `telnet localhost ${labNode.console_port}`;
      body.appendChild(buildCopyRow("Console", consoleCmd));
    }
  }
}

function buildCopyRow(label: string, value: string): HTMLElement {
  const row = el("div", { className: "lifecycle-snippet" });
  row.appendChild(el("span", { className: "lifecycle-snippet-label" }, label));
  const code = el("code", { className: "lifecycle-snippet-value" }, value);
  row.appendChild(code);
  const copyBtn = el("button", {
    type: "button",
    className: "btn btn-ghost btn-sm lifecycle-snippet-copy",
    title: `Copy ${label.toLowerCase()} command`,
  }, "Copy");
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      window.setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    });
  });
  row.appendChild(copyBtn);
  return row;
}

// openLinkDrawer opens the detail drawer for a topology link, rendering
// both endpoints' configuration side-by-side. Reuses the existing
// detail drawer; opening overwrites whatever the drawer was showing.
//
// The render is layered:
//
//   1. STATIC config from the topology data (always available, no
//      fetch): port admin_status, mtu, the link itself. This is
//      what's in topology.json — visible even when the device is
//      offline / lab not deployed.
//   2. LIVE data fetched per-endpoint (oper_status, real-time
//      bindings, runtime VLAN membership). Adds runtime context when
//      the device is reachable; renders as a pedagogical "device
//      offline" line when not.
//
// Each endpoint renders independently so one device being unreachable
// doesn't hide the other side.
export function openLinkDrawer(
  link: TopoLink,
  rawDevices: Record<string, { ports?: Record<string, unknown> }>,
): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  const a = { device: link.local_device ?? "?", iface: link.local_interface ?? "?" };
  const z = { device: link.remote_device ?? "?", iface: link.remote_interface ?? "?" };

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, "Link"));
  content.appendChild(el(
    "h2",
    { className: "drawer-name" },
    `${a.device}:${a.iface} ↔ ${z.device}:${z.iface}`,
  ));

  const grid = el("div", { className: "link-drawer-grid" });
  content.appendChild(grid);

  for (const endpoint of [a, z]) {
    const col = el("section", { className: "link-drawer-endpoint" });
    col.appendChild(el("h3", { className: "link-drawer-endpoint-heading" }, `${endpoint.device}:${endpoint.iface}`));
    const body = el("div", { className: "link-drawer-endpoint-body" });
    col.appendChild(body);
    grid.appendChild(col);

    // Static port config — render immediately from the topology data
    // the operator already has on screen. No fetch dependency.
    const staticPort = extractStaticPortConfig(rawDevices, endpoint.device, endpoint.iface);
    body.appendChild(el("p", { className: "drawer-kind" }, "Port config (from topology)"));
    if (staticPort) {
      body.appendChild(renderValue(staticPort));
    } else {
      body.appendChild(el("p", { className: "panel-note" },
        "No port entry for " + endpoint.iface + " in this network's topology."));
    }

    // Live data — optional enhancement; failures render as the
    // "device offline" pedagogical line rather than a system error.
    const livePlaceholder = el("p", { className: "status-loading" }, "Loading live state…");
    body.appendChild(el("p", { className: "drawer-kind" }, "Live state"));
    body.appendChild(livePlaceholder);

    void Promise.allSettled([
      fetchNodeInterface(endpoint.device, endpoint.iface),
      fetchNodeInterfaceBinding(endpoint.device, endpoint.iface),
    ]).then(([detailResult, bindingResult]) => {
      livePlaceholder.remove();
      if (detailResult.status === "fulfilled") {
        body.appendChild(el("p", { className: "drawer-subkind" }, "Interface"));
        body.appendChild(renderValue(detailResult.value));
      } else {
        body.appendChild(renderLiveDataError(detailResult.reason, "interface", endpoint.device));
      }
      if (bindingResult.status === "fulfilled") {
        body.appendChild(el("p", { className: "drawer-subkind" }, "Service binding"));
        body.appendChild(renderValue(bindingResult.value));
      } else if (!(bindingResult.reason instanceof ApiError && bindingResult.reason.kind === "newtron_unavailable")) {
        // Skip the binding's offline note when the interface fetch
        // already showed the same message — avoids duplicate
        // "switch1 is not reachable" lines. Non-offline errors still
        // surface (the operator should see them).
        body.appendChild(renderLiveDataError(bindingResult.reason, "service binding", endpoint.device));
      }
    });
  }
}

// extractStaticPortConfig pulls a port's static config from the
// topology data (rawDevices), without fetching anything. Returns null
// when the port isn't in the topology (e.g. the link references a
// port that hasn't been declared in topology.json).
function extractStaticPortConfig(
  rawDevices: Record<string, { ports?: Record<string, unknown> }>,
  device: string,
  iface: string,
): unknown {
  const dev = rawDevices[device];
  if (!dev || !dev.ports) return null;
  const port = dev.ports[iface];
  if (port === undefined) return null;
  return port;
}

// renderLiveDataError translates a failed per-device live fetch into
// operator-friendly text. The common case in newtcon today is that a
// network's devices aren't deployed (the lab is down, the device's
// CONFIG_DB / SSH transport is unreachable) — surfacing the raw
// "newtron_unavailable" envelope reads as a system failure when
// actually it's the expected condition. For other error kinds (genuine
// problems worth seeing) fall back to formatErrorBrief.
function renderLiveDataError(
  err: unknown,
  what: "interface" | "service binding",
  device: string,
): HTMLElement {
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    return el("p", { className: "panel-note" },
      `${device} is not reachable. Live ${what} state will appear here once the device is up.`);
  }
  return el("p", { className: "panel-error" }, formatErrorBrief(err));
}

// openNodeDrawer opens the detail drawer for a device and renders
// node-inspector sub-tabs. Each sub-tab fetches its data lazily on
// first activation.
//
// viewMode (optional) — the topology view-mode the drawer was opened
// from. Threads through to renderLifecycleSection so the substrate
// section matches the operator's view intent: Lab view shows VM
// state + SSH/console; Physical view shows only physical-substrate
// state (no lab VM bleed-through); Spec view shows a "no actuation"
// hint. Defaults to "Lifecycle" (legacy behavior) when omitted.
export function openNodeDrawer(device: string, viewMode?: TopologyViewMode): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  // ── Header ──────────────────────────────────────────────────────
  // Three rows: name + status badges · subtitle · quick-action row.
  // All three fill in async — name + viewMode are sync; identity
  // chips wait on /info; drift badge waits on /drift; action buttons
  // wait on labState. The skeleton renders immediately so the drawer
  // doesn't look blank during the round-trips.
  const header = el("header", { className: "node-drawer-header" });
  const titleRow = el("div", { className: "node-drawer-title-row" });
  const titleName = el("h2", { className: "node-drawer-name" }, device);
  titleRow.appendChild(titleName);
  const badges = el("div", { className: "node-drawer-badges" });
  titleRow.appendChild(badges);
  header.appendChild(titleRow);

  const subtitle = el("p", { className: "node-drawer-subtitle" }, "");
  header.appendChild(subtitle);

  // At-a-glance stats (interface counts + drift) — folds the old Summary tab
  // into the always-visible header so triage facts travel across every tab.
  const stats = el("div", { className: "node-drawer-stats" });
  header.appendChild(stats);

  const actions = el("div", { className: "node-drawer-actions" });
  header.appendChild(actions);

  content.appendChild(header);

  // Async-populate header chips + badges + stats + actions. Per-source
  // failures degrade silently — operator still gets the rest of the
  // header rendered.
  void renderDrawerHeader(badges, subtitle, stats, actions, device, viewMode);

  // Lifecycle section (existing) — view-mode-aware substrate state +
  // Start/Stop/SSH/console. Stays for now; the Summary tab also
  // surfaces the substrate state from its own pull, so this section
  // is a touch redundant in observation views — kept here as the
  // canonical "lifecycle controls live here" surface until per-domain
  // renderers absorb its action buttons.
  const lifecycleSection = el("section", { className: "lifecycle-section" });
  content.appendChild(lifecycleSection);
  void renderLifecycleSection(lifecycleSection, device, viewMode);

  // ── Tab strip + panels ─────────────────────────────────────────
  const tabStrip = el("nav", { className: "node-tabs", role: "tablist", ariaLabel: "Device information" });
  const panelsContainer = el("div", {});

  const panels = new Map<NodeTabId, HTMLElement>();
  const tabButtons = new Map<NodeTabId, HTMLButtonElement>();
  const fetched = new Set<NodeTabId>();

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

    const panel = el("div", {
      className: "node-tab-panel" + (tab.id === "spec" ? " node-tab-panel--spec" : ""),
    });
    panel.setAttribute("id", `node-panel-${tab.id}`);
    panel.setAttribute("role", "tabpanel");
    panel.hidden = true;
    panels.set(tab.id, panel);
    panelsContainer.appendChild(panel);
  }

  content.appendChild(tabStrip);
  content.appendChild(panelsContainer);

  // Raw (debugging) disclosure — Config DB / Projection / Intent
  // Tree tucked away below the primary panels. Most operators never
  // open it; the ones who need it know where to look.
  renderRawSection(content, device);

  // Pick the default tab based on the view-mode the drawer was
  // opened from: Spec view → Spec; Lab/Physical → Summary (the
  // operator's at-a-glance triage view). Legacy callers without a
  // view-mode also default to Summary.
  const defaultTab: NodeTabId = viewMode === "spec" ? "spec" : "interfaces";
  activateTab(defaultTab);
}

// renderDrawerHeader — populates the badges + subtitle + actions row
// asynchronously from /info + /drift + lab state. Each source
// failure degrades silently; the header always renders the name +
// device label even if every fetch fails.
async function renderDrawerHeader(
  badges: HTMLElement,
  subtitle: HTMLElement,
  stats: HTMLElement,
  actions: HTMLElement,
  device: string,
  viewMode: TopologyViewMode | undefined,
): Promise<void> {
  // /info — full identity line in the subtitle (folds the old Summary identity
  // card: platform · zone · ASN · mgmt · loopback · router-id · vtep) + the
  // substrate badge. One fetch, used for both.
  void fetchNodeInfo(device).then((data) => {
    const d = (data ?? {}) as Record<string, unknown>;
    const fact = (label: string, key: string): string => {
      const v = d[key];
      return typeof v === "string" && v !== "" || typeof v === "number" ? `${label} ${String(v)}` : "";
    };
    subtitle.textContent = [
      typeof d.platform === "string" ? d.platform : "",
      fact("zone", "zone"),
      fact("AS", "bgp_as"),
      fact("mgmt", "mgmt_ip"),
      fact("lo", "loopback_ip"),
      fact("rtr-id", "router_id"),
      fact("vtep", "vtep_source_ip"),
    ].filter(Boolean).join(" · ");
    // Substrate badge stays view-mode-aware (physical only; lab/spec defer to
    // the lifecycle section, preserving the intent-only stance of spec view).
    if (viewMode === "spec-physical") {
      badges.appendChild(el("span", { className: "node-drawer-badge node-drawer-badge--running" }, "● online"));
    }
  }).catch(() => {
    // /info is a live probe — unavailable when the device is unreachable or not
    // yet deployed. Fall back to the NodeSpec so the identity line still shows the
    // declared facts (platform · zone · AS · mgmt · loopback) rather than going
    // blank. router-id / vtep are live-only and omitted here.
    void fetchSpecDetail("nodes", device).then((spec) => {
      if (subtitle.textContent !== "") return; // /info already populated it
      const s = (spec ?? {}) as Record<string, unknown>;
      const fact = (label: string, key: string): string => {
        const v = s[key];
        return (typeof v === "string" && v !== "") || typeof v === "number" ? `${label} ${String(v)}` : "";
      };
      subtitle.textContent = [
        typeof s.platform === "string" ? s.platform : "",
        fact("zone", "zone"),
        fact("AS", "underlay_asn"),
        fact("mgmt", "mgmt_ip"),
        fact("lo", "loopback_ip"),
      ].filter(Boolean).join(" · ");
    }).catch(() => { /* spec also unavailable — leave the subtitle empty */ });
    if (viewMode === "spec-physical") {
      badges.appendChild(el("span", { className: "node-drawer-badge node-drawer-badge--down" }, "● offline"));
    }
  });

  // /interfaces — interface counts in the stats row (folds the Summary
  // interfaces card).
  void fetchNodeInterfaces(device).then((data) => {
    const list = Array.isArray(data) ? data : [];
    let up = 0, down = 0;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const oper = String((item as Record<string, unknown>).oper_state ?? (item as Record<string, unknown>).oper_status ?? "").toLowerCase();
      if (oper === "up") up++; else if (oper === "down") down++;
    }
    stats.appendChild(el("span", { className: "node-drawer-stat" }, `${list.length} interfaces`));
    if (up > 0) stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--up" }, `${up} up`));
    if (down > 0) stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--down" }, `${down} down`));
  }).catch(() => { /* counts unavailable */ });

  // /drift — once: drives the badge, the stat chip, and the Review-drift action
  // (folds the Summary drift card).
  void fetchNodeDrift(device).then((data) => {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) {
      stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--clean" }, "no drift"));
      return;
    }
    const label = `${items.length} drift item${items.length === 1 ? "" : "s"}`;
    badges.appendChild(el("span", { className: "node-drawer-badge node-drawer-badge--drift" }, `⚠ ${label}`));
    stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--drift" }, label));
    const reconcileBtn = el("button", { type: "button", className: "node-drawer-action-btn node-drawer-action-btn--primary" }, "Review drift");
    reconcileBtn.addEventListener("click", () => {
      (document.querySelector('.node-tab[aria-controls="node-panel-drift"]') as HTMLButtonElement | null)?.click();
    });
    actions.appendChild(reconcileBtn);
  }).catch(() => { /* drift unavailable */ });
}

// loadNodeTab fetches data for one node-inspector tab and renders it.
// Each tab is operator-priority-ordered (Summary first; History last)
// and uses a per-domain renderer rather than the generic recursive
// tree.
function loadNodeTab(id: NodeTabId, container: HTMLElement, device: string): void {
  renderLoadingInto(container);

  switch (id) {
    case "interfaces":
      // Inventory-first; the live read is best-effort inside the builder, so an
      // un-deployed/unreachable node still shows its full port inventory.
      renderInterfaceTab(container, device);
      break;

    case "state":
      void renderStateTab(container, device);
      break;

    case "spec": {
      // A device's declared intent lives in TWO places in the network spec:
      //   - the device profile — static identity (mgmt_ip, loopback_ip, zone,
      //     platform, service bindings). Unified-substrate convention (PR #148)
      //     names the profile after the device → fetchSpecDetail("nodes", …).
      //   - the topology.json device entry — provisioning steps + per-port
      //     config, i.e. the intents provisioning actually replays.
      // The Spec tab shows both so "declared intent" is complete.
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
      break;
    }

    case "drift":
      fetchNodeDrift(device)
        .then((data) => renderDriftTab(container, data, device))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "history":
      void renderHistoryTab(container, device);
      break;

    default: {
      const _never: never = id;
      container.textContent = "";
      container.appendChild(el("p", { className: "topology-empty" }, `Unknown tab: ${_never}`));
    }
  }
}


// renderHistoryTab — per-device audit timeline. Fetches newtron's
// audit.events filtered to {device} and renders the same row layout
// the global Audit tab uses (consistent operator vocabulary). The
// per-device filter is server-side via the ?device= query param so
// the response size stays bounded even on busy networks.
//
// Empty-state cases are first-class:
//   - 404 from newtron → audit logging disabled on this deployment.
//   - 403 → operator lacks audit.read for this network.
//   - empty events array → no recorded activity for this device yet.
async function renderHistoryTab(container: HTMLElement, device: string): Promise<void> {
  container.textContent = "";

  const header = el("div", { className: "node-history-header" });
  header.appendChild(el("p", { className: "node-history-intro" },
    `Recorded activity targeting ${device}. Source: newtron's audit log.`));
  const refresh = el("button", { type: "button", className: "node-history-refresh" }, "Refresh");
  header.appendChild(refresh);
  container.appendChild(header);

  const body = el("div", { className: "node-history-body" });
  body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
  container.appendChild(body);

  const load = async (): Promise<void> => {
    body.textContent = "";
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    // newtron returns audit events newest-first by default (newtron
    // #274); offset 0 = the most recent for this device. Pass order=desc
    // explicitly for clarity. Show the newest page (older history is on
    // the Audit tab).
    let total = 0;
    let events: AuditEvent[] = [];
    try {
      const page = await fetchAuditEvents({ device, order: "desc", limit: 100 });
      total = page.total;
      events = page.events ?? [];
    } catch (err) {
      body.textContent = "";
      body.appendChild(el("p", { className: "panel-error" }, renderEventsError(err)));
      return;
    }
    body.textContent = "";
    if (events.length === 0) {
      body.appendChild(el("p", { className: "node-summary-stat-clean" },
        `No recorded activity for ${device} yet. Operator writes that touch this device will appear here once audit logging captures them.`));
      return;
    }
    const summary = el("p", { className: "node-history-summary" },
      `${events.length} of ${total} event${total === 1 ? "" : "s"} (most recent first).`);
    body.appendChild(summary);
    body.appendChild(renderEventsTable(events));
    if (total > events.length) {
      body.appendChild(el("p", { className: "node-history-paging-hint" },
        "Older events exist. Use the Audit tab for full pagination + cross-device filters."));
    }
  };

  refresh.addEventListener("click", () => { void load(); });
  void load();
}


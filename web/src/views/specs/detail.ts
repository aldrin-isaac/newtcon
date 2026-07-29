// views/specs/detail.ts — the spec DETAIL drawer: openDetail / closeDetail
// plus the two cross-reference sections that hang off a spec's detail
// (a service's interface bindings, and the reverse "used by services" for
// every other kind).
//
// The drawer body is assembled in layers: header → Edit control → the
// schema-rendered fields → the sub-rule table (subrules.ts) → the
// cross-reference section.
//
// CYCLE (deliberate, load-safe): almost every affordance in the view re-opens
// the drawer after staging a change, so drawers.ts / subrules.ts /
// facet-panels.ts all import openDetail from here while this module imports
// enterSpecEditMode + renderSubRuleTable + subRuleTables from them. All are
// hoisted `function` declarations, and subRuleTables is read at call time —
// never at module-init — so evaluation order doesn't matter.

import { type SpecKind, fetchSpecDetail, fetchSpecList } from "../../api/newtcon/network.js";
import { fetchTopology } from "../../api/newtcon/nodes.js";
import { fetchSchema, resolveSlugToKind } from "../../api/newtcon/schema.js";
import { ApiError } from "../../api/newtcon/services.js";
import { el, renderValue } from "../../dom.js";
import { deriveServiceBindings } from "../../service-bindings.js";
import { type RefFieldDescriptor, deriveServiceReferences } from "../../service-references.js";
import { type SpecKind as StagingSpecKind, pendingSpecCreateItems } from "../../staging.js";
import { openNodeDrawer, renderErrorInto, renderSpecDetailInto, toSpecField } from "../drawer/index.js";
import { enterSpecEditMode } from "./drawers.js";
import { displaySchemaFor, isEditableKind } from "./fields.js";
import { kindTitleFor } from "./panels.js";
import { announceRoute } from "./route-state.js";
import { renderSubRuleTable, subRuleTables } from "./subrules.js";

export async function openDetail(kind: SpecKind, kindTitle: string, name: string): Promise<void> {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  announceRoute({ facet: kind, detail: name, device: null });

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  // The fixed breadcrumb row hosts the DEVICE mini-header (name + substrate
  // chip) when opened from Topology (uplift 6.2). A spec has no substrate —
  // own the breadcrumb here so a prior device's "switch info" line can't
  // linger above a spec detail. Show the spec identity, no status chip.
  const crumb = document.getElementById("drawer-breadcrumb");
  if (crumb) {
    crumb.textContent = "";
    crumb.appendChild(el("span", { className: "crumb-kind" }, kindTitle));
    crumb.appendChild(el("span", { className: "crumb-main" }, name));
  }
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, name));
  const loading = el("p", { className: "status-loading" }, "Loading…");
  content.appendChild(loading);

  try {
    // A not-yet-applied (pending-create) spec has no server detail —
    // fetchSpecDetail would 404. Fall back to the staged create body so the
    // operator can author sub-rules (QoS queues, filter / route-policy rules)
    // BEFORE the first Save: they stage as sub-creates and apply right after the
    // parent in the same Save (no more "apply the parent first, then add rules").
    const pendingCreate = pendingSpecCreateItems(kind as StagingSpecKind).find((p) => p.name === name);
    const detail = pendingCreate ? pendingCreate.body : await fetchSpecDetail(kind, name);
    content.removeChild(loading);

    if (pendingCreate) {
      content.appendChild(el("p", { className: "drawer-pending-note" },
        "Not applied yet — fields and sub-rules you add here are staged and apply together on Save."));
    }

    // Edit-mode controls — Edit button if the kind has any top-level field
    // beyond the identifier. Kinds whose schema is just `name` (zones,
    // prefix-lists) get no Edit button — their meaningful content lives in
    // sub-rules and is managed via the existing sub-rule UI.
    if (isEditableKind(kind)) {
      const controls = el("div", { className: "drawer-controls" });
      const editBtn = el("button", { type: "button", className: "drawer-edit-btn" }, "Edit");
      editBtn.addEventListener("click", () => {
        enterSpecEditMode(kind, kindTitle, name, detail, content);
      });
      controls.appendChild(editBtn);
      content.appendChild(controls);
    }

    // Schema-aware rendering — prefer newtron's schema (canonical labels +
    // tooltips), fall back to newtcon's hand-typed displaySpecForms /
    // specForms for kinds without a schema, and finally to the generic
    // recursive tree so unknown kinds still render.
    //
    // Sub-rule wire fields are excluded so child rules don't double-
    // display — they get a dedicated section below via renderSubRuleTable.
    const subRuleConf = subRuleTables[kind];
    const extraExcludes = subRuleConf ? [subRuleConf.wireField] : [];
    const schemaKindForDetail = await resolveSlugToKind(kind).catch(() => null);
    const schemaForDetail = schemaKindForDetail
      ? await fetchSchema(schemaKindForDetail).catch(() => null)
      : null;
    if (schemaForDetail) {
      const body = el("div");
      // Adapter: SchemaField → SpecField shape. buildSpecDetailShape
      // needs name + label for the layout, plus ref_kind so ref fields
      // render as clickable cross-link chips. Other field metadata
      // (required / immutable / etc.) is irrelevant for read-only display.
      renderSpecDetailInto(
        body,
        schemaForDetail.fields.map(toSpecField),
        detail,
        extraExcludes,
      );
      content.appendChild(body);
    } else {
      const fields = displaySchemaFor(kind);
      if (fields) {
        const body = el("div");
        renderSpecDetailInto(body, fields, detail, extraExcludes);
        content.appendChild(body);
      } else {
        const body = renderValue(detail);
        if (body instanceof HTMLElement) {
          body.classList.add("drawer-detail");
        }
        content.appendChild(body);
      }
    }

    // Sub-rules: one unified inline-table section per kind (#173.A).
    if (subRuleConf) {
      renderSubRuleTable(kind, name, detail, content, subRuleConf);
    }

    // Services: show where the service is actually applied (its interface
    // bindings), derived from the topology's per-device steps — one
    // GET /topology, no device round-trips. Other kinds: show which
    // services reference this resource (the reverse of the cross-link
    // chips), derived from the service specs' ref fields.
    if (kind === "services") {
      renderServiceBindings(content, name);
    } else {
      renderServiceUsage(content, kind, name);
    }
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

// renderServiceBindings appends a "Bindings" section to the service
// detail drawer: every interface this service is applied to, read from
// the topology's per-device steps (deriveServiceBindings). Each row
// drills into that device's inspector. Empty → a teaching line.
function renderServiceBindings(container: HTMLElement, serviceName: string): void {
  const section = el("section", { className: "svc-bindings" });
  section.appendChild(el("h3", { className: "svc-bindings-title" }, "Bindings"));
  const body = el("div", { className: "svc-bindings-body" });
  body.appendChild(el("p", { className: "status-loading" }, "Loading…"));
  section.appendChild(body);
  container.appendChild(section);

  void fetchTopology()
    .then((topo) => {
      body.textContent = "";
      const bindings = deriveServiceBindings(topo, serviceName);
      if (bindings.length === 0) {
        body.appendChild(el("p", { className: "svc-bindings-empty" },
          "Not applied to any interface yet. Bind it from the Topology view (a port's Bind service action)."));
        return;
      }
      body.appendChild(el("p", { className: "svc-bindings-count" },
        `Applied to ${bindings.length} interface${bindings.length === 1 ? "" : "s"}.`));
      const table = el("table", { className: "table table--mono-all svc-bindings-table" });
      const head = el("tr");
      for (const h of ["Device", "Interface", "Details"]) {
        head.appendChild(el("th", { className: "svc-bindings-th" }, h));
      }
      table.appendChild(head);
      for (const b of bindings) {
        const tr = el("tr", { className: "svc-bindings-row" });
        // Device drills into the inspector (shares #detail-drawer).
        const devCell = el("td", { className: "svc-bindings-td" });
        const devBtn = el("button", { type: "button", className: "svc-bindings-device" }, b.device);
        devBtn.addEventListener("click", () => openNodeDrawer(b.device));
        devCell.appendChild(devBtn);
        tr.appendChild(devCell);
        tr.appendChild(el("td", { className: "svc-bindings-td svc-bindings-iface" }, b.iface));
        const detailParts: string[] = [];
        if (b.ipAddress) detailParts.push(b.ipAddress);
        if (b.peerAs) detailParts.push(`peer-as ${b.peerAs}`);
        if (b.vlan) detailParts.push(`vlan ${b.vlan}`);
        tr.appendChild(el("td", { className: "svc-bindings-td" }, detailParts.join(" · ") || "—"));
        table.appendChild(tr);
      }
      body.appendChild(table);
    })
    .catch((err) => { body.textContent = ""; renderErrorInto(body, err); });
}

// buildServiceRefFields derives, from the schema, which ServiceSpec
// fields (incl. one level of nested object — the routing block) are refs
// to `targetKind`. Schema-driven so no service field names are hardcoded.
async function buildServiceRefFields(serviceKind: string, targetKind: string): Promise<RefFieldDescriptor[]> {
  const out: RefFieldDescriptor[] = [];
  const svc = await fetchSchema(serviceKind).catch(() => null);
  if (!svc || !Array.isArray(svc.fields)) return out;
  for (const f of svc.fields) {
    if (f.type === "ref" && f.ref_kind === targetKind) {
      out.push({ path: [f.name], label: f.label });
    } else if (f.type === "object" && f.item_kind) {
      const inner = await fetchSchema(f.item_kind).catch(() => null);
      if (inner && Array.isArray(inner.fields)) {
        for (const inf of inner.fields) {
          if (inf.type === "ref" && inf.ref_kind === targetKind) {
            out.push({ path: [f.name, inf.name], label: inf.label });
          }
        }
      }
    }
  }
  return out;
}

// renderServiceUsage appends a "Used by services" section to a resource
// (IP-VPN / MAC-VPN / filter / QoS or route policy / prefix list) detail
// drawer — the reverse of the forward cross-link chips. Renders nothing
// when the kind isn't referenced by any service field (e.g. zones,
// platforms). Scans the service specs (cheap spec-file reads) for refs
// to this resource.
function renderServiceUsage(container: HTMLElement, slug: SpecKind, name: string): void {
  if (slug === "services") return;
  void (async () => {
    const targetKind = await resolveSlugToKind(slug).catch(() => null);
    const serviceKind = await resolveSlugToKind("services").catch(() => null);
    if (!targetKind || !serviceKind) return;
    const refFields = await buildServiceRefFields(serviceKind, targetKind);
    if (refFields.length === 0) return; // not a service-referenceable kind

    const section = el("section", { className: "svc-usage" });
    section.appendChild(el("h3", { className: "svc-usage-title" }, "Used by services"));
    const body = el("div", { className: "svc-usage-body" });
    body.appendChild(el("p", { className: "status-loading" }, "Loading…"));
    section.appendChild(body);
    container.appendChild(section);

    try {
      const names = await fetchSpecList("services");
      const details = await Promise.all(
        names.map((n) =>
          fetchSpecDetail("services", n)
            .then((detail) => ({ name: n, detail }))
            .catch(() => ({ name: n, detail: {} as unknown })),
        ),
      );
      const refs = deriveServiceReferences(details, refFields, name);
      body.textContent = "";
      if (refs.length === 0) {
        body.appendChild(el("p", { className: "svc-usage-empty" },
          "Not referenced by any service yet."));
        return;
      }
      body.appendChild(el("p", { className: "svc-usage-count" },
        `Referenced by ${refs.length} service${refs.length === 1 ? "" : "s"}.`));
      const ul = el("ul", { className: "svc-usage-list" });
      for (const r of refs) {
        const li = el("li", { className: "svc-usage-item" });
        const btn = el("button", { type: "button", className: "svc-usage-link" }, r.service);
        btn.addEventListener("click", () => { void openDetail("services", kindTitleFor("services"), r.service); });
        li.appendChild(btn);
        li.appendChild(el("span", { className: "svc-usage-via" }, r.via.join(", ")));
        ul.appendChild(li);
      }
      body.appendChild(ul);
    } catch (err) {
      body.textContent = "";
      renderErrorInto(body, err);
    }
  })();
}

export function closeDetail(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;
  const wasOpen = drawer.classList.contains("open");
  drawer.setAttribute("aria-hidden", "true");
  drawer.classList.remove("open");
  // The one drawer hosts both the spec detail and the node inspector —
  // closing clears both params (only if it was actually open, so idempotent
  // close calls on tab switches don't spam the router).
  if (wasOpen) announceRoute({ detail: null, device: null });
}

// views/specs/facet-panels.ts — the facet list: one panel per spec kind, its
// rows, and the affordances hung off them (+ Add, + override, ×, the
// pedagogical empty state, the sample-seed quickstart).
//
// Rows model newtron's scope model: for overridable kinds a name appears once
// per scope it's defined at (network base + each zone/node override), and the
// overrides nest under their base as a collapsible group — the delete floor
// made visible (a base with overrides can't be deleted until they go).

import { type SpecKind, fetchSpecInstances, fetchSpecList } from "../../api/newtcon/network.js";
import { fetchTopology } from "../../api/newtcon/nodes.js";
import { resolveSlugToKind } from "../../api/newtcon/schema.js";
import { ApiError } from "../../api/newtcon/services.js";
import { confirmInline } from "../../confirm-inline.js";
import { el } from "../../dom.js";
import { emptyStateFor } from "../../empty-states.js";
import { deriveNodeLinks } from "../../node-references.js";
import { formatErrorBrief } from "../../render-error.js";
import { SAMPLE_SEEDS, planLoad, summarisePlan } from "../../sample-network.js";
import { deriveServiceBindings } from "../../service-bindings.js";
import { type SpecKind as StagingSpecKind, enqueueSpecCreate, enqueueSpecDelete, isSpecPendingDelete, isSpecPendingUpdate, pendingSpecCreateItems } from "../../staging.js";
import { openDetail } from "./detail.js";
import { openCreateDrawer, openOverrideDrawer } from "./drawers.js";
import { type Panel } from "./panels.js";

// One row in a spec panel: a spec definition at a given scope. The same
// name appears once per scope it's defined at (network base + each
// override) — that duplication is the override signal (newtron #285/#287).
export interface SpecRowData { name: string; scope: string; scope_instance: string; }

// Kinds that support scope overrides (newtron P2). For these the panel
// rows come from /spec-instances (real scope + scope_instance); the
// container kinds (profiles/zones/platforms) aren't overridable and aren't
// in that inventory, so they keep the network-only list.
const SCOPED_KINDS: ReadonlySet<SpecKind> = new Set<SpecKind>([
  "services", "ipvpns", "macvpns", "prefix-lists", "filters", "qos-policies", "route-policies",
]);

function scopeRank(scope: string): number {
  return scope === "network" ? 0 : scope === "zone" ? 1 : scope === "node" ? 2 : 3;
}

// loadFacetRows returns the rows for a facet: scope-tagged from
// /spec-instances for overridable kinds, network-only (from the plain
// list) for the rest. Sorted by name, then network-before-overrides.
export async function loadFacetRows(kind: SpecKind): Promise<SpecRowData[]> {
  if (SCOPED_KINDS.has(kind)) {
    const [instances, newtronKind] = await Promise.all([
      fetchSpecInstances(),
      resolveSlugToKind(kind).catch(() => null),
    ]);
    if (newtronKind) {
      return instances
        .filter((i) => i.kind === newtronKind)
        .map((i) => ({ name: i.name, scope: i.scope, scope_instance: i.scope_instance }))
        .sort((a, b) =>
          a.name.localeCompare(b.name)
          || scopeRank(a.scope) - scopeRank(b.scope)
          || a.scope_instance.localeCompare(b.scope_instance));
    }
    // newtronKind unresolved → fall through to the plain list.
  }
  const names = await fetchSpecList(kind);
  return names.map((n) => ({ name: n, scope: "network", scope_instance: "" }));
}

// refreshPanel re-fetches the spec list for a panel and replaces its DOM node.
function refreshPanel(panel: Panel, container: HTMLElement): void {
  loadFacetRows(panel.kind)
    .then((rows) => {
      const fresh = buildPanel(panel, { status: "fulfilled", value: rows });
      container.replaceWith(fresh);
    })
    .catch((err) => {
      const fresh = buildPanel(panel, { status: "rejected", reason: err });
      container.replaceWith(fresh);
    });
}

// buildPanel constructs the panel DOM for a spec type.
// Separated from renderPanel so refreshPanel can rebuild after mutations.
function buildPanel(panel: Panel, result: PromiseSettledResult<SpecRowData[]>): HTMLElement {
  const container = el("section", { className: "panel" });
  const header = el("div", { className: "panel-header" });
  header.appendChild(el("h2", { className: "panel-title" }, panel.title));
  const scoped = SCOPED_KINDS.has(panel.kind);

  if (result.status === "fulfilled") {
    const items = result.value;
    header.appendChild(el("span", { className: "panel-count" }, String(items.length)));

    // "Add" button — only for kinds newtron's schema says are creatable.
    if (panel.canCreate) {
      const addBtn = el("button", {
        type: "button",
        className: "panel-add-btn",
        title: "Add " + panel.title.toLowerCase().replace(/s$/, ""),
      }, "+ Add");
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCreateDrawer(panel.kind, panel.title, () => refreshPanel(panel, container));
      });
      header.appendChild(addBtn);
    }

    container.appendChild(header);

    // Combine server-side definitions with pending creates (overlay so the
    // operator sees both committed and queued items in one list, with color).
    // A pending create carries its scope/scope_instance, so an override queues
    // as a green sub-line at its real scope — not collapsed onto the base.
    type Row = SpecRowData & { pending: "none" | "create" };
    const allRows: Row[] = items.map((i) => ({ ...i, pending: "none" as const }));
    const committedKeys = new Set(items.map((i) => `${i.scope}::${i.scope_instance}::${i.name}`));
    for (const q of pendingSpecCreateItems(panel.kind as StagingSpecKind)) {
      const scope = typeof q.body.scope === "string" && q.body.scope !== "" ? q.body.scope : "network";
      const scope_instance = typeof q.body.scope_instance === "string" ? q.body.scope_instance : "";
      const key = `${scope}::${scope_instance}::${q.name}`;
      if (!committedKeys.has(key)) allRows.push({ name: q.name, scope, scope_instance, pending: "create" });
    }

    if (allRows.length === 0) {
      container.appendChild(renderPanelEmpty(panel.kind, panel.canCreate));
    } else {
      const list = el("ul", {
        className: "panel-list" + (scoped ? " panel-list--scoped panel-list--nested" : ""),
      });

      // buildNameRow renders a clickable name row. Used for unscoped rows and
      // for the network-base parent row of a scoped kind. `deleteDisabled`,
      // when set, renders the × disabled with that tooltip — the delete-floor
      // made visible: a base with overrides can't be deleted until they go.
      const buildNameRow = (
        r: Row,
        opts: { overrideCount?: number; deleteDisabled?: string; onAddOverride?: () => void } = {},
      ): HTMLElement => {
        const isPendingCreate = r.pending === "create";
        const isPendingDelete = isSpecPendingDelete(panel.kind as StagingSpecKind, r.name);
        // Pending edit (queued update) — only meaningful on a committed row,
        // and superseded by a queued delete.
        const isPendingUpdate = !isPendingCreate && !isPendingDelete
          && isSpecPendingUpdate(panel.kind as StagingSpecKind, r.name);
        const row = el("li", {
          className: "panel-list-row"
            + (isPendingCreate ? " panel-list-row--pending-add" : "")
            + (isPendingDelete ? " panel-list-row--pending-del" : "")
            + (isPendingUpdate ? " panel-list-row--pending-mod" : ""),
        });
        const item = el("span", { className: "panel-list-item", tabIndex: 0 }, r.name);
        item.addEventListener("click", () => openDetail(panel.kind, panel.title, r.name));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(panel.kind, panel.title, r.name);
          }
        });
        row.appendChild(item);

        // Override count hint on the parent — signals there's more nested below.
        if (opts.overrideCount && opts.overrideCount > 0) {
          row.appendChild(el("span", { className: "panel-override-count" },
            `${opts.overrideCount} override${opts.overrideCount === 1 ? "" : "s"}`));
        }

        // "Add override" — opens the create drawer prefilled from this base so
        // the operator only sets the scope (newtron P2). On hover, like ×.
        if (opts.onAddOverride && !isPendingCreate) {
          const ovBtn = el("button", {
            type: "button",
            className: "panel-override-add-btn",
            title: "Add a zone/node override of " + r.name,
            ariaLabel: "Add override of " + r.name,
          }, "+ override");
          ovBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            opts.onAddOverride!();
          });
          row.appendChild(ovBtn);
        }

        // Delete affordance — × on hover. A network base with overrides shows
        // the × disabled (the floor: delete-<kind> would 409 until the
        // overrides are removed); otherwise it maps to delete-<kind>.
        if (panel.canDelete && !isPendingCreate) {
          const disabled = opts.deleteDisabled !== undefined;
          const delBtn = el("button", {
            type: "button",
            className: "panel-delete-btn",
            title: disabled ? opts.deleteDisabled!
              : (isPendingDelete ? "Cancel delete" : "Delete " + r.name),
            ariaLabel: disabled ? opts.deleteDisabled!
              : (isPendingDelete ? "Cancel delete of " + r.name : "Delete " + r.name),
          }, isPendingDelete ? "↺" : "×");
          if (disabled) {
            delBtn.disabled = true;
          } else {
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void (async () => {
                // A service that's still applied can't be plain-deleted —
                // newtron's #319 guard 409s. Detect the bindings client-side
                // (instant feedback), and on confirm stage a FORCE delete so
                // newtron cascades the binding steps. (spec→spec refs are
                // guarded engine-side; only services — applied via apply-service
                // steps — surface bindings here.)
                let force = false;
                if (panel.kind === "services") {
                  const topo = await fetchTopology().catch(() => null);
                  const bindings = deriveServiceBindings(topo, r.name);
                  if (bindings.length > 0) {
                    const where = bindings.slice(0, 6).map((b) => `${b.device}:${b.iface}`).join(", ");
                    const more = bindings.length > 6 ? `, +${bindings.length - 6} more` : "";
                    const n = bindings.length, s = n === 1 ? "" : "s";
                    const ok = await confirmInline({
                      title: `Force-delete service "${r.name}"?`,
                      body: `It's applied on ${n} interface${s} (${where}${more}). newtron won't delete an applied service; "Force delete" also removes those ${n} binding${s} from the topology. (On a deployed device, un-apply there first to avoid CONFIG_DB drift.)`,
                      danger: true,
                      confirmLabel: "Force delete",
                    });
                    if (!ok) return;
                    force = true;
                  }
                } else if (panel.kind === "nodes") {
                  // newtron won't delete a node a link still wires to (409); detect
                  // the links client-side and, on confirm, force-cascade them so the
                  // node + its links are removed together.
                  const topo = await fetchTopology().catch(() => null);
                  const links = deriveNodeLinks(topo, r.name);
                  if (links.length > 0) {
                    const peers = [...new Set(links.map((l) => l.peer).filter(Boolean))];
                    const shown = peers.slice(0, 6).join(", ");
                    const more = peers.length > 6 ? `, +${peers.length - 6} more` : "";
                    const n = links.length, s = n === 1 ? "" : "s";
                    const ok = await confirmInline({
                      title: `Force-delete node "${r.name}"?`,
                      body: `${n} link${s} still wire to it (${shown}${more}). newtron won't delete a linked node; "Force delete" removes the node and cascades those ${n} link${s} from the topology.`,
                      danger: true,
                      confirmLabel: "Force delete",
                    });
                    if (!ok) return;
                    force = true;
                  }
                }
                enqueueSpecDelete(panel.kind as StagingSpecKind, r.name, undefined, undefined, force);
                refreshPanel(panel, container);
              })();
            });
          }
          row.appendChild(delBtn);
        }
        return row;
      };

      // buildOverrideRow renders a zone/node override as an indented sub-line
      // (scope · instance) beneath its network base. No × yet — scoped delete
      // needs scope on the wire (not built); clicking opens detail (the base,
      // until per-scope override detail lands).
      const buildOverrideRow = (r: Row): HTMLElement => {
        const isPendingCreate = r.pending === "create";
        const isPendingDelete = isSpecPendingDelete(panel.kind as StagingSpecKind, r.name, r.scope, r.scope_instance);
        const row = el("li", {
          className: "panel-list-row panel-list-row--override"
            + (isPendingCreate ? " panel-list-row--pending-add" : "")
            + (isPendingDelete ? " panel-list-row--pending-del" : ""),
        });
        row.appendChild(el("span", { className: "panel-override-marker", ariaHidden: "true" }, "↳"));
        row.appendChild(el("span", {
          className: "panel-scope-badge panel-scope-badge--" + r.scope,
        }, r.scope));
        const item = el("span", { className: "panel-list-item panel-list-item--override", tabIndex: 0 },
          r.scope_instance || "—");
        item.addEventListener("click", () => openDetail(panel.kind, panel.title, r.name));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(panel.kind, panel.title, r.name);
          }
        });
        row.appendChild(item);

        // Scoped delete (newtron #319): remove just this zone/node override. A
        // scoped delete falls back to the network base, so it's safe — no
        // binding guard to trip, no confirm needed (staged + reversible).
        if (panel.canDelete) {
          const label = `${r.scope} override (${r.scope_instance || "—"}) of ${r.name}`;
          const delBtn = el("button", {
            type: "button",
            className: "panel-delete-btn",
            title: isPendingDelete ? "Cancel delete" : (isPendingCreate ? "Cancel add" : "Delete " + label),
            ariaLabel: isPendingDelete ? "Cancel delete of " + label : "Delete " + label,
          }, isPendingDelete ? "↺" : "×");
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            enqueueSpecDelete(panel.kind as StagingSpecKind, r.name, r.scope, r.scope_instance);
            refreshPanel(panel, container);
          });
          row.appendChild(delBtn);
        }
        return row;
      };

      if (!scoped) {
        for (const r of allRows) list.appendChild(buildNameRow(r));
      } else {
        // Group by name: the network base is the parent record; zone/node
        // overrides nest beneath it as dependents (mirrors the floor: an
        // override requires its base; deleting/pausing the base reckons with
        // the children). allRows arrives name-sorted then scope-ranked.
        const order: string[] = [];
        const byName = new Map<string, { base?: Row; overrides: Row[] }>();
        for (const r of allRows) {
          let g = byName.get(r.name);
          if (!g) { g = { overrides: [] }; byName.set(r.name, g); order.push(r.name); }
          if (r.scope === "network") g.base = r; else g.overrides.push(r);
        }
        for (const name of order) {
          const g = byName.get(name)!;
          // Floor invariant guarantees a base; synthesize a label row if a
          // stray override ever arrives without one rather than dropping it.
          const base: Row = g.base ?? { name, scope: "network", scope_instance: "", pending: "none" };
          const baseOpts: { overrideCount?: number; deleteDisabled?: string; onAddOverride?: () => void } = {
            overrideCount: g.overrides.length,
          };
          if (g.overrides.length > 0) {
            baseOpts.deleteDisabled =
              `Remove ${g.overrides.length} override${g.overrides.length === 1 ? "" : "s"} first`;
          }
          // Overrides are authored from the base so they autofill from it — only
          // available when the kind is creatable (newtron exposes create-<kind>).
          if (panel.canCreate) {
            baseOpts.onAddOverride = () =>
              openOverrideDrawer(panel.kind, panel.title, name, () => refreshPanel(panel, container));
          }
          const baseRow = buildNameRow(base, baseOpts);
          const ovRows = g.overrides.map((ov) => buildOverrideRow(ov));
          if (ovRows.length > 0) {
            // Collapsible override group: a disclosure caret on the base toggles
            // its nested overrides. Default collapsed — the override-count badge
            // already signals there's content, keeping the facet compact.
            let expanded = false;
            const caret = el("button", {
              type: "button",
              className: "panel-override-toggle",
              ariaLabel: `Show/hide ${ovRows.length} override${ovRows.length === 1 ? "" : "s"} of ${name}`,
            }, "▸");
            const apply = () => {
              caret.textContent = expanded ? "▾" : "▸";
              caret.setAttribute("aria-expanded", String(expanded));
              for (const r of ovRows) r.hidden = !expanded;
            };
            const toggle = (e: Event) => { e.stopPropagation(); expanded = !expanded; apply(); };
            caret.addEventListener("click", toggle);
            baseRow.insertBefore(caret, baseRow.firstChild);
            // The count badge doubles as a click target for the disclosure.
            const countBadge = baseRow.querySelector(".panel-override-count");
            if (countBadge) {
              countBadge.classList.add("panel-override-count--toggle");
              countBadge.addEventListener("click", toggle);
            }
            apply();
            list.appendChild(baseRow);
            for (const r of ovRows) list.appendChild(r);
          } else {
            // No overrides: reserve the caret's width so the name lines up with
            // base rows that do carry a disclosure caret.
            baseRow.insertBefore(
              el("span", { className: "panel-override-toggle panel-override-toggle--placeholder", ariaHidden: "true" }, "▸"),
              baseRow.firstChild,
            );
            list.appendChild(baseRow);
          }
        }
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

export function renderPanel(panel: Panel, result: PromiseSettledResult<SpecRowData[]>): HTMLElement {
  return buildPanel(panel, result);
}

// renderPanelEmpty renders the pedagogical empty-state block for a spec
// facet (slice #169.A). Replaces the previous bare "none defined" line
// with copy that tells the operator what the kind is and what to do
// next.
function renderPanelEmpty(kind: SpecKind, canAdd: boolean): HTMLElement {
  const copy = emptyStateFor(kind);
  const block = el("div", { className: "panel-empty" });
  block.appendChild(el("p", { className: "panel-empty-headline" }, copy.title));
  if (copy.body) {
    block.appendChild(el("p", { className: "panel-empty-body" }, copy.body));
  }
  if (canAdd) {
    block.appendChild(el("p", { className: "panel-empty-cta" },
      "Click + Add above to create one."));
  }
  if (copy.hint) {
    block.appendChild(el("p", { className: "panel-empty-hint" }, copy.hint));
  }
  // Sample-seed quickstart (slice #169.E). Surface a "Load sample"
  // affordance on the Services facet — the most common landing point
  // for a new operator — so they can stage a representative pair of
  // specs (IP VPN + service) and see the apply workflow without
  // authoring from scratch.
  if (kind === "services" && canAdd) {
    block.appendChild(renderSampleSeedAffordance());
  }
  return block;
}

// renderSampleSeedAffordance renders the "Load sample" link + its
// post-click status line. Idempotent — repeated clicks plan against
// the current spec names so previously-loaded seeds are skipped, not
// duplicated.
function renderSampleSeedAffordance(): HTMLElement {
  const wrap = el("div", { className: "panel-empty-sample" });
  const link = el("button", {
    type: "button",
    className: "panel-empty-sample-link",
    title: "Stage a small IP VPN + service so you can see the apply workflow",
  }, "Or load a sample IP VPN + service");
  wrap.appendChild(link);
  const status = el("p", { className: "panel-empty-sample-status" });
  status.hidden = true;
  wrap.appendChild(status);

  link.addEventListener("click", async () => {
    link.setAttribute("disabled", "");
    link.textContent = "Loading…";
    try {
      const existing = await loadSampleConflictMap();
      const plan = planLoad(existing);
      const summary = summarisePlan(plan);
      for (const p of plan) {
        if (p.action === "queue") {
          enqueueSpecCreate(p.seed.kind as StagingSpecKind, p.seed.name, p.seed.body);
        }
      }
      status.textContent = "";
      const head = el("strong", { className: "panel-empty-sample-status-head" },
        summary.queued > 0
          ? `Staged ${summary.queued} change${summary.queued === 1 ? "" : "s"} — click Save in the header to apply.`
          : "Nothing to load — all sample specs already exist.");
      status.appendChild(head);
      const list = el("ul", { className: "panel-empty-sample-status-list" });
      for (const line of summary.lines) {
        list.appendChild(el("li", { className: "panel-empty-sample-status-line" }, line));
      }
      status.appendChild(list);
      status.hidden = false;
      link.remove();
    } catch (err) {
      link.removeAttribute("disabled");
      link.textContent = "Or load a sample IP VPN + service";
      status.textContent = "Couldn't load sample: " + formatErrorBrief(err);
      status.hidden = false;
    }
  });
  return wrap;
}

// loadSampleConflictMap fetches the current name lists for each
// SAMPLE_SEEDS kind in parallel, then builds the existing-names map
// planLoad expects. A list fetch failure is tolerated (the kind is
// treated as empty — planLoad will queue the seed; if it duplicates,
// newtron's create will reject with a conflict the operator sees).
async function loadSampleConflictMap(): Promise<Map<SpecKind, Set<string>>> {
  const kinds = Array.from(new Set(SAMPLE_SEEDS.map((s) => s.kind)));
  const results = await Promise.all(
    kinds.map((kind) =>
      fetchSpecList(kind).then(
        (names) => [kind, new Set(names)] as const,
        () => [kind, new Set<string>()] as const,
      ),
    ),
  );
  return new Map(results);
}

// views/registry.ts — the workspace view registry (console-uplift 1.1).
//
// Each top-level view (a sidebar tab + its panel) registers itself here and
// the tab dispatcher in app.ts consults the registry instead of hardcoding
// per-view mount calls. The Phase-1 extractions (Specs 1.2, drawer 1.3,
// Topology 1.4 — docs/console-uplift-plan.md) migrate their mounts behind
// this as they move out of app.ts; History + Audit are the first residents.

export interface ViewDef {
  /** Tab name as used by the dispatcher ("history"). */
  id: string;
  /** DOM id of the view's panel element ("panel-history"). */
  panelId: string;
  /** Mount (or re-mount) the view into its panel. */
  mount: (panel: HTMLElement) => void | Promise<void>;
  /** True → re-mount on every tab activation (fresh-data views). */
  remountOnActivate: boolean;
}

const views = new Map<string, ViewDef>();

export function registerView(def: ViewDef): void {
  views.set(def.id, def);
}

export function viewFor(id: string): ViewDef | undefined {
  return views.get(id);
}

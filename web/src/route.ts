// route.ts — pure hash-route codec for the workspace (uplift 2.4).
//
// Shape: #/{net}/{view}[/...params]
//   #/prod/specs                      Specs view, default facet
//   #/prod/specs/ipvpns               Specs view, ipvpns facet
//   #/prod/specs/ipvpns/blue          ipvpns facet with detail "blue" open
//   #/prod/specs/general/ssh          Specs → General → SSH Login
//   #/prod/topology                   Topology view
//   #/prod/topology/device/switch1    Topology + device drawer for switch1
//   #/prod/history   #/prod/audit     resident views
//
// Segments are encodeURIComponent-encoded so device/spec names with "/" or
// "#" survive. Pure: no DOM, no location — wiring lives in router.ts.

export type ViewName = "specs" | "topology" | "history" | "audit";

export interface Route {
  net: string;
  view: ViewName;
  /** Specs: facet kind (e.g. "ipvpns") or "general". */
  facet?: string;
  /** Specs: open spec detail name (requires facet) or general surface key. */
  detail?: string;
  /** Topology: device whose drawer is open. */
  device?: string;
}

const VIEWS: readonly ViewName[] = ["specs", "topology", "history", "audit"];

export function parseHash(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) return null;
  const seg = raw.split("/").map((s) => decodeURIComponent(s));
  const [net, view] = seg;
  if (!net || !view || !(VIEWS as readonly string[]).includes(view)) return null;
  const route: Route = { net, view: view as ViewName };
  if (view === "specs") {
    if (seg[2]) route.facet = seg[2];
    if (seg[3]) route.detail = seg[3];
  } else if (view === "topology") {
    if (seg[2] === "device" && seg[3]) route.device = seg[3];
  }
  return route;
}

export function formatHash(route: Route): string {
  const e = encodeURIComponent;
  let h = `#/${e(route.net)}/${route.view}`;
  if (route.view === "specs" && route.facet) {
    h += `/${e(route.facet)}`;
    if (route.detail) h += `/${e(route.detail)}`;
  } else if (route.view === "topology" && route.device) {
    h += `/device/${e(route.device)}`;
  }
  return h;
}

/** retargetHashToNetwork — rewrite a hash to another network, preserving the
 *  view but dropping params (device / facet / detail aren't portable across
 *  networks). Unparseable or empty hashes land on the new network's Specs. */
export function retargetHashToNetwork(hash: string, net: string): string {
  const route = parseHash(hash);
  return formatHash({ net, view: route?.view ?? "specs" });
}

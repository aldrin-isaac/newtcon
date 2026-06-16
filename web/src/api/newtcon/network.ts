// Typed client for newtcon-server's network-level spec list and write endpoints.
// List calls return the names defined for that spec type in the selected
// newtron network. Write calls forward JSON bodies to newtron's create/delete
// RPC verbs and sub-rule verbs.
//
// All routes are network-scoped — newtcon mirrors newtron's geometry
// /networks/{netID}/... at /api/networks/{netID}/... Every function below
// targets the operator's active network by default; pass `network` to target
// a specific network (cross-engine workflows).

import { apiFetch, apiSend } from "./_transport.js";
import { apiPath } from "../../api-path.js";

export interface SpecListResponse {
  names: string[];
}

export type SpecKind =
  | "services"
  | "ipvpns"
  | "macvpns"
  | "qos-policies"
  | "filters"
  | "prefix-lists"
  | "route-policies"
  | "profiles"
  | "zones"
  | "platforms";

function pathFor(suffix: string, network?: string): string {
  return network ? apiPath.network(network, suffix) : apiPath(suffix);
}

export async function fetchSpecDetail(kind: SpecKind, name: string, network?: string): Promise<unknown> {
  return apiFetch(pathFor(`${kind}/${encodeURIComponent(name)}`, network), { cache: "no-store" });
}

// ============================================================================
// Write helpers
// ============================================================================

// createSpec calls POST /api/networks/{netID}/{kind} with the given body.
export async function createSpec(kind: SpecKind, body: Record<string, unknown>, network?: string): Promise<unknown> {
  return apiSend(pathFor(kind, network), "POST", body);
}

// deleteSpec calls DELETE /api/networks/{netID}/{kind}/{name}.
export async function deleteSpec(kind: SpecKind, name: string, network?: string): Promise<unknown> {
  return apiSend(pathFor(`${kind}/${encodeURIComponent(name)}`, network), "DELETE");
}

// updateSpec calls PUT /api/networks/{netID}/{kind}/{name} which forwards
// to newtron's POST /update-<kind> verb (newtron PR #172). Body shape
// mirrors createSpec — top-level fields only. Sub-collections (queues,
// rules, statements) are preserved by newtron and managed via addSubRule
// / remove* — do NOT include them in the body here.
//
// The URL path-param identifies the spec to update; any "name" in body
// is overwritten server-side with the path value so an operator can't
// rename via this verb. To rename a spec, delete + create.
export async function updateSpec(kind: SpecKind, name: string, body: Record<string, unknown>, network?: string): Promise<unknown> {
  return apiSend(pathFor(`${kind}/${encodeURIComponent(name)}`, network), "PUT", body);
}

// addSubRule calls POST /api/networks/{netID}/{kind}/{name}/queues|rules|entries with the body.
// endpoint is the sub-collection segment: "queues", "rules", or "entries".
export async function addSubRule(kind: SpecKind, name: string, endpoint: string, body: Record<string, unknown>, network?: string): Promise<unknown> {
  return apiSend(pathFor(`${kind}/${encodeURIComponent(name)}/${endpoint}`, network), "POST", body);
}

// removeQoSQueue calls DELETE /api/networks/{netID}/qos-policies/{name}/queues/{queueId}.
export async function removeQoSQueue(name: string, queueId: number, network?: string): Promise<unknown> {
  return apiSend(pathFor(`qos-policies/${encodeURIComponent(name)}/queues/${queueId}`, network), "DELETE");
}

// removeFilterRule calls DELETE /api/networks/{netID}/filters/{name}/rules/{seq}.
export async function removeFilterRule(name: string, seq: number, network?: string): Promise<unknown> {
  return apiSend(pathFor(`filters/${encodeURIComponent(name)}/rules/${seq}`, network), "DELETE");
}

// removePrefixListEntry calls DELETE /api/networks/{netID}/prefix-lists/{name}/entries/{prefix}.
export async function removePrefixListEntry(name: string, prefix: string, network?: string): Promise<unknown> {
  return apiSend(pathFor(`prefix-lists/${encodeURIComponent(name)}/entries/${encodeURIComponent(prefix)}`, network), "DELETE");
}

// removeRoutePolicyRule calls DELETE /api/networks/{netID}/route-policies/{name}/rules/{seq}.
export async function removeRoutePolicyRule(name: string, seq: number, network?: string): Promise<unknown> {
  return apiSend(pathFor(`route-policies/${encodeURIComponent(name)}/rules/${seq}`, network), "DELETE");
}

// ============================================================================
// List endpoints
// ============================================================================

export async function fetchSpecList(kind: SpecKind, network?: string): Promise<string[]> {
  const body = (await apiFetch(pathFor(kind, network), { cache: "no-store" })) as
    | { names?: string[] | null; services?: { name: string }[] }
    | null;

  // /api/networks/{netID}/services returns {services: [{name, type, ...}]};
  // everything else returns {names: [string]}.
  if (kind === "services" && Array.isArray(body?.services)) {
    return body.services.map((s) => s.name);
  }
  return Array.isArray(body?.names) ? body.names : [];
}

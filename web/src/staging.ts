// staging.ts — workspace-level pending-changes queue.
//
// Every "edit" the operator makes in Specs or Topology lands here as a
// pending change instead of going straight to the server. The Specs and
// Topology views render queued additions in green and queued deletions in
// red. A sticky workspace-top bar shows the pending count and exposes
// Save / Discard.
//
// Save runs each queued operation against the corresponding /api endpoint
// (specs are network-scoped; topology has its own /api/topology endpoints)
// in dependency order, surfaces per-item success/failure, and clears the
// successfully-applied items from the queue. Discard drops everything.
//
// Per-device intent (VLANs, VRFs, ACLs, …) is *not* staged here — those
// already go through newtron's intent/save lifecycle in the device panel.

import { ApiError, type ErrorEnvelope } from "./api/newtcon/services.js";
import { apiPath } from "./api-path.js";
import { formatErrorBrief as formatError } from "./render-error.js";

// ---- Pending change shapes -----------------------------------------------

export type SpecKind =
  | "services" | "ipvpns" | "macvpns" | "qos-policies" | "filters"
  | "route-policies" | "prefix-lists" | "profiles" | "zones";

export type Pending =
  | { id: string; group: "spec";      kind: SpecKind; op: "create"; name: string; body: Record<string, unknown>; }
  | { id: string; group: "spec";      kind: SpecKind; op: "update"; name: string; body: Record<string, unknown>; }
  | { id: string; group: "spec";      kind: SpecKind; op: "delete"; name: string; }
  | { id: string; group: "topology";  op: "add-device";    name: string; body: Record<string, unknown>; }
  | { id: string; group: "topology";  op: "remove-device"; name: string; }
  | { id: string; group: "topology";  op: "add-link";      a: string; z: string; }
  | { id: string; group: "topology";  op: "remove-link";   device: string; iface: string; }
  | { id: string; group: "device";    op: "action";    device: string; actionId: string; label: string; danger?: boolean; body: Record<string, unknown>; }
  | { id: string; group: "interface"; op: "action";    device: string; iface: string; actionId: string; label: string; danger?: boolean; body: Record<string, unknown>; };

// ---- Store ---------------------------------------------------------------

const queue: Pending[] = [];
const listeners: Set<() => void> = new Set();
let nextID = 1;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify(): void { listeners.forEach((fn) => fn()); }

export function getQueue(): readonly Pending[] { return queue.slice(); }
export function pendingCount(): number { return queue.length; }

// ---- Mutators ------------------------------------------------------------

export function enqueueSpecCreate(kind: SpecKind, name: string, body: Record<string, unknown>): Pending {
  // If a delete is pending for this name, cancel it instead.
  const i = queue.findIndex((p) => p.group === "spec" && p.kind === kind && p.op === "delete" && p.name === name);
  if (i >= 0) { queue.splice(i, 1); notify(); return queue[queue.length - 1] ?? { id: "", group: "spec", kind, op: "create", name, body }; }
  const p: Pending = { id: String(nextID++), group: "spec", kind, op: "create", name, body };
  queue.push(p);
  notify();
  return p;
}

// enqueueSpecUpdate queues an edit of an existing spec (PUT /update-<kind>),
// so edits stage and apply through the same Save loop as create/delete instead
// of firing instantly.
export function enqueueSpecUpdate(kind: SpecKind, name: string, body: Record<string, unknown>): Pending {
  // Editing a spec that's still pending-create: fold the edit into the create
  // (one create with the latest values), keeping create-only fields like scope.
  const ci = queue.findIndex((p) => p.group === "spec" && p.kind === kind && p.op === "create" && p.name === name);
  if (ci >= 0) {
    const c = queue[ci] as { body: Record<string, unknown> };
    c.body = { ...c.body, ...body };
    notify();
    return queue[ci]!;
  }
  // Collapse repeated edits of the same spec to the latest body.
  const ui = queue.findIndex((p) => p.group === "spec" && p.kind === kind && p.op === "update" && p.name === name);
  if (ui >= 0) {
    (queue[ui] as { body: Record<string, unknown> }).body = body;
    notify();
    return queue[ui]!;
  }
  const p: Pending = { id: String(nextID++), group: "spec", kind, op: "update", name, body };
  queue.push(p);
  notify();
  return p;
}

export function enqueueSpecDelete(kind: SpecKind, name: string): Pending | null {
  // If a create is pending for this name, just cancel it (no API round trip).
  const i = queue.findIndex((p) => p.group === "spec" && p.kind === kind && p.op === "create" && p.name === name);
  if (i >= 0) { queue.splice(i, 1); notify(); return null; }
  // A pending edit of a spec being deleted is moot — drop it.
  const ui = queue.findIndex((p) => p.group === "spec" && p.kind === kind && p.op === "update" && p.name === name);
  if (ui >= 0) queue.splice(ui, 1);
  const p: Pending = { id: String(nextID++), group: "spec", kind, op: "delete", name };
  queue.push(p);
  notify();
  return p;
}

export function enqueueTopologyAddDevice(name: string, body: Record<string, unknown>): Pending {
  const p: Pending = { id: String(nextID++), group: "topology", op: "add-device", name, body };
  queue.push(p); notify(); return p;
}

export function enqueueTopologyRemoveDevice(name: string): Pending | null {
  const i = queue.findIndex((p) => p.group === "topology" && p.op === "add-device" && p.name === name);
  if (i >= 0) { queue.splice(i, 1); notify(); return null; }
  const p: Pending = { id: String(nextID++), group: "topology", op: "remove-device", name };
  queue.push(p); notify(); return p;
}

export function enqueueTopologyAddLink(a: string, z: string): Pending {
  const p: Pending = { id: String(nextID++), group: "topology", op: "add-link", a, z };
  queue.push(p); notify(); return p;
}

export function enqueueTopologyRemoveLink(device: string, iface: string): Pending {
  const p: Pending = { id: String(nextID++), group: "topology", op: "remove-link", device, iface };
  queue.push(p); notify(); return p;
}

export function enqueueDeviceAction(device: string, actionId: string, label: string, body: Record<string, unknown>, danger?: boolean): Pending {
  const p: Pending = { id: String(nextID++), group: "device", op: "action", device, actionId, label, body, ...(danger ? { danger: true } : {}) };
  queue.push(p); notify(); return p;
}

export function enqueueInterfaceAction(device: string, iface: string, actionId: string, label: string, body: Record<string, unknown>, danger?: boolean): Pending {
  const p: Pending = { id: String(nextID++), group: "interface", op: "action", device, iface, actionId, label, body, ...(danger ? { danger: true } : {}) };
  queue.push(p); notify(); return p;
}

// Filter helpers — used by per-device Apply/Discard buttons.

export function deviceQueue(device: string): readonly Pending[] {
  return queue.filter((p) =>
    (p.group === "device" && (p as { device: string }).device === device) ||
    (p.group === "interface" && (p as { device: string }).device === device) ||
    (p.group === "topology" && p.op === "remove-device" && (p as { name: string }).name === device) ||
    (p.group === "topology" && p.op === "add-device" && (p as { name: string }).name === device));
}

export async function applyDevice(device: string): Promise<ApplyResult> {
  const targets = deviceQueue(device);
  const onlineStatus = await probeOnline(device);
  // Use topology mode for offline devices so the POST writes to the in-memory
  // tree without trying to talk to redis. Online devices use the default
  // (intent) mode so the change lands on the actual switch.
  const mode: "default" | "topology" = onlineStatus === false ? "topology" : "default";
  const result = await applySubset(targets, mode);
  // After the per-action POSTs succeed for this device, persist the resulting
  // intent tree to topology.json so the offline representation includes them
  // (matches the operator's "(1) saved to offline topology" requirement).
  // Only call /intent/save if at least one device-targeted action applied —
  // otherwise nothing changed on the in-memory tree and saving is a no-op.
  const touched = result.applied.some((p) =>
    (p.group === "device" && (p as { device: string }).device === device) ||
    (p.group === "interface" && (p as { device: string }).device === device));
  if (touched) {
    try {
      await postJSON(apiPath(`nodes/${encodeURIComponent(device)}/rpc/intent/save${mode === "topology" ? "?mode=topology" : ""}`), {});
    } catch (err) {
      // The actions landed (on device + in-memory) but the topology.json save
      // failed. Surface as a synthetic failed entry so the operator sees it.
      result.failed.push({
        pending: { id: "intent-save", group: "device", op: "action", device, actionId: "intent/save", label: "save device intent to the network", body: {} } as Pending,
        error: formatError(err),
      });
    }
  }
  return result;
}

// Probe newtron's /info to learn whether a device is reachable. Caches a
// freshness window so a burst of applyDevice calls in close succession only
// probes once per device.
const onlineCache: Map<string, { at: number; online: boolean }> = new Map();
const ONLINE_CACHE_MS = 5_000;

async function probeOnline(device: string): Promise<boolean | undefined> {
  const cached = onlineCache.get(device);
  if (cached && Date.now() - cached.at < ONLINE_CACHE_MS) return cached.online;
  try {
    const r = await fetch(apiPath(`nodes/${encodeURIComponent(device)}/info`), { cache: "no-store" });
    const online = r.ok;
    onlineCache.set(device, { at: Date.now(), online });
    return online;
  } catch {
    onlineCache.set(device, { at: Date.now(), online: false });
    return false;
  }
}

export function discardDevice(device: string): void {
  for (const p of deviceQueue(device)) {
    const i = queue.findIndex((q) => q.id === p.id);
    if (i >= 0) queue.splice(i, 1);
  }
  notify();
}

export function discardAll(): void {
  queue.length = 0;
  notify();
}

export function removeFromQueue(id: string): void {
  const i = queue.findIndex((p) => p.id === id);
  if (i >= 0) { queue.splice(i, 1); notify(); }
}

// ---- Pending-derived helpers used by views to draw green/red overlays ----

export function pendingSpecCreates(kind: SpecKind): string[] {
  return queue.filter((p) => p.group === "spec" && p.kind === kind && p.op === "create").map((p) => (p as { name: string }).name);
}

// pendingSpecCreateItems returns queued creates with their body, so the Specs
// list can place a pending override at its real scope (its name matches the
// existing network base, so a name-only overlay would hide it under the base).
export function pendingSpecCreateItems(kind: SpecKind): { name: string; body: Record<string, unknown> }[] {
  return queue
    .filter((p) => p.group === "spec" && p.kind === kind && p.op === "create")
    .map((p) => ({ name: (p as { name: string }).name, body: (p as { body: Record<string, unknown> }).body }));
}

export function isSpecPendingDelete(kind: SpecKind, name: string): boolean {
  return queue.some((p) => p.group === "spec" && p.kind === kind && p.op === "delete" && p.name === name);
}

export function isSpecPendingUpdate(kind: SpecKind, name: string): boolean {
  return queue.some((p) => p.group === "spec" && p.kind === kind && p.op === "update" && p.name === name);
}

export function pendingTopologyDeviceAdds(): { name: string; body: Record<string, unknown> }[] {
  return queue.filter((p) => p.group === "topology" && p.op === "add-device")
    .map((p) => ({ name: (p as { name: string }).name, body: (p as { body: Record<string, unknown> }).body }));
}

export function isDevicePendingRemove(name: string): boolean {
  return queue.some((p) => p.group === "topology" && p.op === "remove-device" && (p as { name: string }).name === name);
}

export function pendingTopologyLinkAdds(): { a: string; z: string }[] {
  return queue.filter((p) => p.group === "topology" && p.op === "add-link")
    .map((p) => ({ a: (p as { a: string }).a, z: (p as { z: string }).z }));
}

export function isLinkPendingRemove(device: string, iface: string): boolean {
  return queue.some((p) => p.group === "topology" && p.op === "remove-link"
    && (p as { device: string }).device === device
    && (p as { iface: string }).iface === iface);
}

// ---- Save: apply queued operations in dependency order ------------------

export interface ApplyResult {
  applied: Pending[];
  failed: { pending: Pending; error: string }[];
}

export async function applyAll(): Promise<ApplyResult> {
  // Default mode for everyone; per-device applies decide topology mode based
  // on online status. applyAll is the workspace-wide Save; individual offline
  // devices in the queue will have their actions fail, which is correct
  // behavior (their items stay queued; surface the failure to the operator).
  const result = await applySubset(queue.slice(), "default");
  // After cross-device actions land, fan out an intent/save per touched device
  // so topology.json picks up the changes. Best-effort — any save failures
  // surface as synthetic failed entries.
  const touchedDevices = new Set<string>();
  for (const p of result.applied) {
    if (p.group === "device" || p.group === "interface") {
      touchedDevices.add((p as { device: string }).device);
    }
  }
  for (const d of touchedDevices) {
    try {
      await postJSON(apiPath(`nodes/${encodeURIComponent(d)}/rpc/intent/save`), {});
    } catch (err) {
      result.failed.push({
        pending: { id: "intent-save", group: "device", op: "action", device: d, actionId: "intent/save", label: "persist to topology.json", body: {} } as Pending,
        error: formatError(err),
      });
    }
  }
  return result;
}

async function applySubset(targets: readonly Pending[], mode: "default" | "topology"): Promise<ApplyResult> {
  // Order: spec creates → device adds → link adds → device-actions →
  // interface-actions → link removes → device removes → spec deletes
  const ordered = targets.slice().sort((a, b) => groupOrder(a) - groupOrder(b));
  const result: ApplyResult = { applied: [], failed: [] };
  for (const p of ordered) {
    try {
      await applyOne(p, mode);
      removeFromQueue(p.id);
      result.applied.push(p);
    } catch (err) {
      result.failed.push({ pending: p, error: formatError(err) });
    }
  }
  notify();
  return result;
}

function groupOrder(p: Pending): number {
  if (p.group === "spec" && p.op === "create") return 1;
  if (p.group === "spec" && p.op === "update") return 1.5;
  if (p.group === "topology" && p.op === "add-device") return 2;
  if (p.group === "topology" && p.op === "add-link") return 3;
  if (p.group === "device") return 4;
  if (p.group === "interface") return 5;
  if (p.group === "topology" && p.op === "remove-link") return 6;
  if (p.group === "topology" && p.op === "remove-device") return 7;
  if (p.group === "spec" && p.op === "delete") return 8;
  return 9;
}

async function applyOne(p: Pending, mode: "default" | "topology"): Promise<void> {
  const modeQS = mode === "topology" ? "?mode=topology" : "";
  if (p.group === "spec" && p.op === "create") {
    await postJSON(apiPath(p.kind), p.body);
    return;
  }
  if (p.group === "spec" && p.op === "update") {
    await put(apiPath(`${p.kind}/${encodeURIComponent(p.name)}`), p.body);
    return;
  }
  if (p.group === "spec" && p.op === "delete") {
    await del(apiPath(`${p.kind}/${encodeURIComponent(p.name)}`));
    return;
  }
  if (p.group === "topology" && p.op === "add-device") {
    await postJSON(apiPath("topology/nodes"), { name: p.name, device: p.body });
    return;
  }
  if (p.group === "topology" && p.op === "remove-device") {
    await del(apiPath(`topology/nodes/${encodeURIComponent(p.name)}`));
    return;
  }
  if (p.group === "topology" && p.op === "add-link") {
    await postJSON(apiPath("topology/links"), { a: p.a, z: p.z });
    return;
  }
  if (p.group === "topology" && p.op === "remove-link") {
    await del(apiPath(`topology/links/${encodeURIComponent(p.device)}/${encodeURIComponent(p.iface)}`));
    return;
  }
  if (p.group === "device" && p.op === "action") {
    await postJSON(apiPath(`nodes/${encodeURIComponent(p.device)}/rpc/${p.actionId}${modeQS}`), p.body);
    return;
  }
  if (p.group === "interface" && p.op === "action") {
    await postJSON(apiPath(`nodes/${encodeURIComponent(p.device)}/interfaces/${encodeURIComponent(p.iface)}/rpc/${p.actionId}${modeQS}`), p.body);
    return;
  }
  throw new Error("unknown pending op");
}

async function postJSON(path: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return parseOrThrow(r);
}

async function put(path: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return parseOrThrow(r);
}

async function del(path: string): Promise<unknown> {
  const r = await fetch(path, { method: "DELETE" });
  return parseOrThrow(r);
}

async function parseOrThrow(r: Response): Promise<unknown> {
  const text = await r.text();
  let parsed: unknown = null;
  if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!r.ok) {
    const inner = (parsed as { error?: { kind?: string; message?: string; details?: Record<string, unknown> } })?.error;
    const envelope: ErrorEnvelope = {
      error: {
        kind: inner?.kind ?? "internal",
        message: inner?.message ?? (typeof parsed === "string" && parsed !== "" ? parsed : r.statusText),
        details: inner?.details ?? {},
      },
    };
    throw new ApiError(r.status, envelope);
  }
  return parsed;
}


// ---- Description (for the pending-bar list) ------------------------------

export function describePending(p: Pending): string {
  if (p.group === "spec" && p.op === "create") return `+ ${p.kind} ${p.name}`;
  if (p.group === "spec" && p.op === "update") return `~ ${p.kind} ${p.name}`;
  if (p.group === "spec" && p.op === "delete") return `− ${p.kind} ${p.name}`;
  if (p.group === "topology" && p.op === "add-device") return `+ device ${p.name}`;
  if (p.group === "topology" && p.op === "remove-device") return `− device ${p.name}`;
  if (p.group === "topology" && p.op === "add-link") return `+ link ${p.a} ↔ ${p.z}`;
  if (p.group === "topology" && p.op === "remove-link") return `− link ${p.device}:${p.iface}`;
  if (p.group === "device" && p.op === "action") return `${p.device}: ${p.label}`;
  if (p.group === "interface" && p.op === "action") return `${p.device}:${p.iface}: ${p.label}`;
  return "?";
}

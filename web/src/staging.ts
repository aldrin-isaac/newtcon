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

// ---- Pending change shapes -----------------------------------------------

export type SpecKind =
  | "services" | "ipvpns" | "macvpns" | "qos-policies" | "filters"
  | "route-policies" | "prefix-lists" | "profiles" | "zones";

export type Pending =
  | { id: string; group: "spec";     kind: SpecKind; op: "create"; name: string; body: Record<string, unknown>; }
  | { id: string; group: "spec";     kind: SpecKind; op: "delete"; name: string; }
  | { id: string; group: "topology"; op: "add-device";    name: string; body: Record<string, unknown>; }
  | { id: string; group: "topology"; op: "remove-device"; name: string; }
  | { id: string; group: "topology"; op: "add-link";      a: string; z: string; }
  | { id: string; group: "topology"; op: "remove-link";   device: string; iface: string; };

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

export function enqueueSpecDelete(kind: SpecKind, name: string): Pending | null {
  // If a create is pending for this name, just cancel it (no API round trip).
  const i = queue.findIndex((p) => p.group === "spec" && p.kind === kind && p.op === "create" && p.name === name);
  if (i >= 0) { queue.splice(i, 1); notify(); return null; }
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

export function isSpecPendingDelete(kind: SpecKind, name: string): boolean {
  return queue.some((p) => p.group === "spec" && p.kind === kind && p.op === "delete" && p.name === name);
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
  // Order: spec creates → spec deletes → topology device adds → topology link adds
  //        → topology link removes → topology device removes
  // (Specs first so topology that references them resolves; deletes after creates;
  //  removes last so we don't tear down something that a create depends on.)
  const ordered = queue.slice().sort((a, b) => groupOrder(a) - groupOrder(b));

  const result: ApplyResult = { applied: [], failed: [] };
  for (const p of ordered) {
    try {
      await applyOne(p);
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
  if (p.group === "topology" && p.op === "add-device") return 2;
  if (p.group === "topology" && p.op === "add-link") return 3;
  if (p.group === "topology" && p.op === "remove-link") return 4;
  if (p.group === "topology" && p.op === "remove-device") return 5;
  if (p.group === "spec" && p.op === "delete") return 6;
  return 9;
}

async function applyOne(p: Pending): Promise<void> {
  if (p.group === "spec" && p.op === "create") {
    await postJSON(`/api/${p.kind}`, p.body);
    return;
  }
  if (p.group === "spec" && p.op === "delete") {
    await del(`/api/${p.kind}/${encodeURIComponent(p.name)}`);
    return;
  }
  if (p.group === "topology" && p.op === "add-device") {
    await postJSON("/api/topology/nodes", { name: p.name, device: p.body });
    return;
  }
  if (p.group === "topology" && p.op === "remove-device") {
    await del(`/api/topology/nodes/${encodeURIComponent(p.name)}`);
    return;
  }
  if (p.group === "topology" && p.op === "add-link") {
    await postJSON("/api/topology/links", { a: p.a, z: p.z });
    return;
  }
  if (p.group === "topology" && p.op === "remove-link") {
    await del(`/api/topology/links/${encodeURIComponent(p.device)}/${encodeURIComponent(p.iface)}`);
    return;
  }
  throw new Error("unknown pending op");
}

async function postJSON(path: string, body: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.kind ?? "error"}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---- Description (for the pending-bar list) ------------------------------

export function describePending(p: Pending): string {
  if (p.group === "spec" && p.op === "create") return `+ ${p.kind} ${p.name}`;
  if (p.group === "spec" && p.op === "delete") return `− ${p.kind} ${p.name}`;
  if (p.group === "topology" && p.op === "add-device") return `+ device ${p.name}`;
  if (p.group === "topology" && p.op === "remove-device") return `− device ${p.name}`;
  if (p.group === "topology" && p.op === "add-link") return `+ link ${p.a} ↔ ${p.z}`;
  if (p.group === "topology" && p.op === "remove-link") return `− link ${p.device}:${p.iface}`;
  return "?";
}

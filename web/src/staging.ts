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
import { mergePort } from "./port-config.js";

// ---- Pending change shapes -----------------------------------------------

export type SpecKind =
  | "services" | "ipvpns" | "macvpns" | "qos-policies" | "filters"
  | "route-policies" | "prefix-lists" | "nodes" | "zones";

// The holistic thread: every spec / sub-rule / override change is one flat
// HTTP mutation — a method + resource path + body. The queue holds these
// uniformly (group "mutation"); applyAll just replays them. `effect` is the
// method's meaning (POST=create, PUT=update, DELETE=delete) carried for the
// preview/overlay. `kind`+`name` (+ optional `sub`) are the resource identity
// used to fold edits and to overlay pending state on a row. Topology +
// device/interface actions keep their richer typed shapes below (RPCs, wrapped
// bodies, per-device apply) — they ride the same flat queue.
// PendingInverse is the op that reverses a Pending — the same shape minus the
// queue id and its own inverse. The inverse of any op is itself an op, so this
// mirrors Pending's variants. Every op computes its inverse when it's staged
// (full context: path, verb, body, prior state); undo just replays it. The
// fields a remove can't know until apply (a re-create's body, a re-link's far
// endpoint) are optional here and backfilled at apply from capturePreApplyBodies.
export type PendingInverse =
  | { group: "mutation"; method: "POST" | "PUT" | "DELETE"; path: string;
      effect: "create" | "update" | "delete"; kind: SpecKind; name: string;
      sub?: { endpoint: string; key?: string | number }; title: string; body?: Record<string, unknown>;
      scope?: string; scopeInstance?: string; }
  | { group: "topology";  op: "update-device"; name: string; body: Record<string, unknown>; }
  | { group: "topology";  op: "add-link";      a?: string; z?: string; }
  | { group: "topology";  op: "remove-link";   device: string; iface: string; }
  | { group: "device";    op: "action";    device: string; actionId: string; label: string; danger?: boolean; body: Record<string, unknown>; }
  | { group: "interface"; op: "action";    device: string; iface: string; actionId: string; label: string; danger?: boolean; body: Record<string, unknown>; }
  // SSH login (scoped scalar): set/clear at a scope. Its own group because it's an
  // upsert/clear verb, not spec-CRUD-by-name. Inverse carries the prior scope value.
  | { group: "ssh-login"; op: "set" | "clear"; scope: string; scopeInstance: string; body?: Record<string, unknown>; title: string; };

export type Pending =
  | { id: string; group: "mutation"; method: "POST" | "PUT" | "DELETE"; path: string;
      effect: "create" | "update" | "delete"; kind: SpecKind; name: string;
      sub?: { endpoint: string; key?: string | number }; title: string;
      body?: Record<string, unknown>;
      // Scope selector for a zone/node override (absent = network base). On a
      // delete it targets the override; on the inverse recreate it's merged
      // into the create body so undo lands on the same scope.
      scope?: string; scopeInstance?: string;
      // Prior server state (display + spec-delete inverse backfill). Captured
      // from the UI at stage time, or fetched at apply for a bare ×.
      preBody?: Record<string, unknown>;
      inverse?: PendingInverse; }
  | { id: string; group: "topology";  op: "update-device"; name: string; body: Record<string, unknown>; inverse?: PendingInverse; }
  | { id: string; group: "topology";  op: "add-link";      a: string; z: string; inverse?: PendingInverse; }
  | { id: string; group: "topology";  op: "remove-link";   device: string; iface: string; inverse?: PendingInverse; }
  | { id: string; group: "device";    op: "action";    device: string; actionId: string; label: string; danger?: boolean; body: Record<string, unknown>; inverse?: PendingInverse; }
  | { id: string; group: "interface"; op: "action";    device: string; iface: string; actionId: string; label: string; danger?: boolean; body: Record<string, unknown>; inverse?: PendingInverse; }
  | { id: string; group: "ssh-login"; op: "set" | "clear"; scope: string; scopeInstance: string; body?: Record<string, unknown>; title: string; inverse?: PendingInverse; };

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

// ---- Flat mutation helpers ----------------------------------------------

const enc = encodeURIComponent;
const specPath = (kind: SpecKind, name?: string): string =>
  name ? `${kind}/${enc(name)}` : kind;
const subBasePath = (kind: SpecKind, spec: string, endpoint: string): string =>
  `${kind}/${enc(spec)}/${endpoint}`;

// Logical identity of a mutation's target — folds create/update/delete of the
// same resource together. Sub-creates have no key yet, so each is its own
// identity (keyed by id); sub-updates/deletes key on the row.
function mutationIdentity(p: Extract<Pending, { group: "mutation" }>): string {
  if (p.sub) {
    return p.sub.key === undefined
      ? `sub-add:${p.id}`
      : `${p.kind}/${p.name}/${p.sub.endpoint}/${p.sub.key}`;
  }
  // Scoped overrides share the base's name; the scope distinguishes them so a
  // base delete and a zone/node override delete don't fold together.
  return p.scope ? `${p.kind}/${p.name}@${p.scope}:${p.scopeInstance ?? ""}` : `${p.kind}/${p.name}`;
}

function findMutation(identity: string, effect?: "create" | "update" | "delete"): number {
  return queue.findIndex((p) =>
    p.group === "mutation" && mutationIdentity(p) === identity
    && (effect === undefined || p.effect === effect));
}

function pushMutation(m: Omit<Extract<Pending, { group: "mutation" }>, "id">): Pending {
  const p: Pending = { ...m, id: String(nextID++) };
  queue.push(p);
  notify();
  return p;
}

// ---- Spec create / update / delete (flat mutations) ----------------------
// Each op computes its own inverse from the context it has at stage time, so
// undo never re-derives it. create⇄delete, update→update(preBody).

export function enqueueSpecCreate(kind: SpecKind, name: string, body: Record<string, unknown>): Pending {
  // A pending delete of the same spec is superseded by recreating it.
  const di = findMutation(`${kind}/${name}`, "delete");
  if (di >= 0) queue.splice(di, 1);
  const inverse: PendingInverse = { group: "mutation", method: "DELETE", path: specPath(kind, name), effect: "delete", kind, name, title: name };
  return pushMutation({ group: "mutation", method: "POST", path: specPath(kind), effect: "create", kind, name, title: name, body, inverse });
}

// enqueueSpecUpdate queues an edit (PUT /{kind}/{name}); preBody (the spec
// before the edit) is the inverse body.
export function enqueueSpecUpdate(kind: SpecKind, name: string, body: Record<string, unknown>, preBody?: Record<string, unknown>): Pending {
  const identity = `${kind}/${name}`;
  // Editing a spec still pending-create folds into the create (latest values),
  // preserving create-only fields (e.g. scope) — the create's inverse stands.
  const ci = findMutation(identity, "create");
  if (ci >= 0) {
    const c = queue[ci] as { body?: Record<string, unknown> };
    c.body = { ...(c.body ?? {}), ...body };
    notify();
    return queue[ci]!;
  }
  // Collapse repeated edits to the latest body (keep the earliest inverse).
  const ui = findMutation(identity, "update");
  if (ui >= 0) {
    (queue[ui] as { body?: Record<string, unknown> }).body = body;
    notify();
    return queue[ui]!;
  }
  const inverse: PendingInverse | undefined = preBody
    ? { group: "mutation", method: "PUT", path: specPath(kind, name), effect: "update", kind, name, title: name, body: preBody }
    : undefined;
  return pushMutation({ group: "mutation", method: "PUT", path: specPath(kind, name), effect: "update", kind, name, title: name, body, ...(preBody ? { preBody } : {}), ...(inverse ? { inverse } : {}) });
}

export function enqueueSpecDelete(kind: SpecKind, name: string, scope?: string, scopeInstance?: string, force?: boolean): Pending | null {
  // A real override has a non-network scope; treat network/empty as the base.
  const scoped = !!scope && scope !== "network";
  const sc = scoped ? scope : undefined;
  const si = scoped ? (scopeInstance ?? "") : "";
  const identity = sc ? `${kind}/${name}@${sc}:${si}` : `${kind}/${name}`;
  // Toggle: a second × on an already-queued delete cancels it (the ↺ affordance).
  const di = findMutation(identity, "delete");
  if (di >= 0) { queue.splice(di, 1); notify(); return null; }
  // Deleting a spec that's only pending-create just cancels the create.
  const ci = findMutation(identity, "create");
  if (ci >= 0) { queue.splice(ci, 1); notify(); return null; }
  // A pending edit of a spec being deleted is moot.
  const ui = findMutation(identity, "update");
  if (ui >= 0) queue.splice(ui, 1);
  // Scoped delete carries the scope on the wire as a query (?scope&scope_instance);
  // force=true cascades active bindings (newtron #319). The backend forwards
  // both to newtron's delete-<kind>.
  const params = [
    ...(sc ? [`scope=${enc(sc)}`, `scope_instance=${enc(si ?? "")}`] : []),
    ...(force ? ["force=true"] : []),
  ];
  const q = params.length ? `?${params.join("&")}` : "";
  // The × hasn't read the spec, so the inverse's body is backfilled at apply
  // (capturePreApplyBodies); the inverse carries the scope so undo recreates the
  // override on the same scope (applyOne merges it into the create body).
  const inverse: PendingInverse = { group: "mutation", method: "POST", path: specPath(kind), effect: "create", kind, name, title: name, ...(sc ? { scope: sc, scopeInstance: si } : {}) };
  return pushMutation({ group: "mutation", method: "DELETE", path: specPath(kind, name) + q, effect: "delete", kind, name, title: name, ...(sc ? { scope: sc, scopeInstance: si } : {}), inverse });
}

// ---- Sub-rule add / update / remove (flat mutations) ---------------------
// queues / rules / entries on a parent spec — same flat queue, deeper path.

// `key` is the row's identity (seq / queue_id / prefix the operator chose) —
// carried even on create so the inverse can DELETE exactly that row.
export function enqueueSubCreate(
  kind: SpecKind, spec: string, endpoint: string, key: string | number, body: Record<string, unknown>, title: string,
): Pending {
  const base = subBasePath(kind, spec, endpoint);
  const inverse: PendingInverse = { group: "mutation", method: "DELETE", path: `${base}/${enc(String(key))}`, effect: "delete", kind, name: spec, sub: { endpoint, key }, title };
  return pushMutation({ group: "mutation", method: "POST", path: base, effect: "create", kind, name: spec, sub: { endpoint, key }, title, body, inverse });
}

// preBody (the row before the edit) is the inverse body.
export function enqueueSubUpdate(
  kind: SpecKind, spec: string, endpoint: string, key: string | number, body: Record<string, unknown>, title: string, preBody?: Record<string, unknown>,
): Pending {
  const identity = `${kind}/${spec}/${endpoint}/${key}`;
  const ui = findMutation(identity, "update");
  if (ui >= 0) {
    (queue[ui] as { body?: Record<string, unknown>; title: string }).body = body;
    (queue[ui] as { title: string }).title = title;
    notify();
    return queue[ui]!;
  }
  const base = subBasePath(kind, spec, endpoint);
  const path = `${base}/${enc(String(key))}`;
  // Inverse. A plain field edit restores the prior body at the SAME key. But a
  // key-changing edit — a renumber/rename, which composeUpdateBody emits as
  // new_<keyField> — moves the row to newKey, so "restore preBody at the original
  // key" would target a now-empty key. Invert by renumbering back: PUT
  // .../{newKey} {new_<key>: originalKey, …prior other fields}. Mirrors
  // enqueueSubReorder's inverse, for the Edit-form renumber path (the seq field
  // is editable in the sub-rule Edit form, so a renumber can arrive here too).
  const renumberField = Object.keys(body).find((k) => k.startsWith("new_"));
  const newKey = renumberField ? body[renumberField] : undefined;
  let inverse: PendingInverse | undefined;
  if (renumberField && newKey !== undefined && newKey !== null) {
    const invBody: Record<string, unknown> = { [renumberField]: key };
    if (preBody) {
      const keyName = renumberField.slice(4); // strip "new_"
      for (const [k, v] of Object.entries(preBody)) if (k !== keyName) invBody[k] = v;
    }
    inverse = { group: "mutation", method: "PUT", path: `${base}/${enc(String(newKey as string | number))}`, effect: "update", kind, name: spec, sub: { endpoint, key: newKey as string | number }, title, body: invBody };
  } else if (preBody) {
    inverse = { group: "mutation", method: "PUT", path, effect: "update", kind, name: spec, sub: { endpoint, key }, title, body: preBody };
  }
  return pushMutation({ group: "mutation", method: "PUT", path, effect: "update", kind, name: spec, sub: { endpoint, key }, title, body, ...(preBody ? { preBody } : {}), ...(inverse ? { inverse } : {}) });
}

// preBody (the removed row, with the parent-ref the re-create needs) is the
// inverse body.
export function enqueueSubDelete(
  kind: SpecKind, spec: string, endpoint: string, key: string | number, title: string, preBody?: Record<string, unknown>,
): Pending | null {
  const identity = `${kind}/${spec}/${endpoint}/${key}`;
  // Removing a row that's only pending-create just cancels the create.
  const ci = findMutation(identity, "create");
  if (ci >= 0) { queue.splice(ci, 1); notify(); return null; }
  // A pending edit of a row being removed is moot.
  const ui = findMutation(identity, "update");
  if (ui >= 0) queue.splice(ui, 1);
  const base = subBasePath(kind, spec, endpoint);
  const inverse: PendingInverse | undefined = preBody
    ? { group: "mutation", method: "POST", path: base, effect: "create", kind, name: spec, sub: { endpoint, key }, title, body: preBody }
    : undefined;
  return pushMutation({ group: "mutation", method: "DELETE", path: `${base}/${enc(String(key))}`, effect: "delete", kind, name: spec, sub: { endpoint, key }, title, ...(preBody ? { preBody } : {}), ...(inverse ? { inverse } : {}) });
}

// enqueueSubReorder queues a renumber (PUT .../{fromKey} {new_<key>: toKey});
// its inverse is the opposite renumber (PUT .../{toKey} {new_<key>: fromKey}).
// The caller composes both bodies (it knows the keyField) — no body-sniffing.
export function enqueueSubReorder(
  kind: SpecKind, spec: string, endpoint: string,
  fromKey: string | number, toKey: string | number,
  fwdBody: Record<string, unknown>, invBody: Record<string, unknown>, title: string,
): Pending {
  const base = subBasePath(kind, spec, endpoint);
  const inverse: PendingInverse = { group: "mutation", method: "PUT", path: `${base}/${enc(String(toKey))}`, effect: "update", kind, name: spec, sub: { endpoint, key: toKey }, title, body: invBody };
  return pushMutation({ group: "mutation", method: "PUT", path: `${base}/${enc(String(fromKey))}`, effect: "update", kind, name: spec, sub: { endpoint, key: fromKey }, title, body: fwdBody, inverse });
}

// ---- Topology ops (carry their own inverse) ------------------------------
// A remove-link can't know its re-create far endpoint at stage time (the ×
// only has the near side), so the inverse carries the structure and
// capturePreApplyBodies backfills the rest at apply.

// enqueuePortConfig stages a per-port config edit on a topology device. Port
// config lives in the device's `ports` map and persists via the whole-device
// PUT (newtron has no per-port verb), so every port edit to one device FOLDS
// into a single update-device op carrying the full merged {steps, ports} — a
// separate PUT per port would replace the device and clobber sibling ports.
// `currentDevice` is the device's committed body (full {steps, ports}); it
// seeds the merge and is the inverse body that undo restores.
export function enqueuePortConfig(
  device: string,
  port: string,
  config: Record<string, unknown>,
  currentDevice: Record<string, unknown>,
): Pending {
  // Existing pending update-device → merge into its body (earliest inverse stands).
  const ui = queue.findIndex((p) => p.group === "topology" && p.op === "update-device" && (p as { name: string }).name === device);
  if (ui >= 0) {
    const u = queue[ui] as { body: Record<string, unknown> };
    u.body = mergePort(u.body, port, config);
    notify();
    return queue[ui]!;
  }
  // First edit → new update-device; its inverse restores the pre-edit device.
  const body = mergePort(currentDevice, port, config);
  const inverse: PendingInverse = { group: "topology", op: "update-device", name: device, body: currentDevice };
  const p: Pending = { id: String(nextID++), group: "topology", op: "update-device", name: device, body, inverse };
  queue.push(p); notify(); return p;
}

export function enqueueTopologyAddLink(a: string, z: string): Pending {
  // Inverse removes the link by its A endpoint (newtron matches either side).
  const colon = a.indexOf(":");
  const inverse: PendingInverse = colon >= 0
    ? { group: "topology", op: "remove-link", device: a.slice(0, colon), iface: a.slice(colon + 1) }
    : { group: "topology", op: "remove-link", device: a, iface: "" };
  const p: Pending = { id: String(nextID++), group: "topology", op: "add-link", a, z, inverse };
  queue.push(p); notify(); return p;
}

export function enqueueTopologyRemoveLink(device: string, iface: string): Pending {
  const inverse: PendingInverse = { group: "topology", op: "add-link" }; // a/z backfilled at apply
  const p: Pending = { id: String(nextID++), group: "topology", op: "remove-link", device, iface, inverse };
  queue.push(p); notify(); return p;
}

export function enqueueDeviceAction(device: string, actionId: string, label: string, body: Record<string, unknown>, danger?: boolean): Pending {
  // No node-level inverses mapped yet (NODE_ACTIONS is empty) → not undoable.
  const p: Pending = { id: String(nextID++), group: "device", op: "action", device, actionId, label, body, ...(danger ? { danger: true } : {}) };
  queue.push(p); notify(); return p;
}

export function enqueueInterfaceAction(device: string, iface: string, actionId: string, label: string, body: Record<string, unknown>, danger?: boolean): Pending {
  const inverse = interfaceActionInverse(device, iface, actionId, body);
  const p: Pending = { id: String(nextID++), group: "interface", op: "action", device, iface, actionId, label, body, ...(danger ? { danger: true } : {}), ...(inverse ? { inverse } : {}) };
  queue.push(p); notify(); return p;
}

// interfaceActionInverse composes the inverse RPC for an interface action, from
// the action + its body (all known at stage time). Returns undefined when no
// faithful inverse exists (→ not undoable). Relocated here from undo-plan so the
// op is born with its inverse like every other op.
//   apply-service                  → remove-service
//   configure-interface trunk-add  → remove-trunk-vlan (atomic per-VLAN strip)
//   configure-interface access/rtd → unconfigure-interface (newtron case A:
//                                    these modes are only entered from empty)
function interfaceActionInverse(
  device: string, iface: string, actionId: string, body: Record<string, unknown>,
): PendingInverse | undefined {
  if (actionId === "apply-service") {
    return { group: "interface", op: "action", device, iface, actionId: "remove-service", label: "Unbind service from " + device + ":" + iface, body: {}, danger: true };
  }
  if (actionId === "configure-interface") {
    if (body["tagged"] === true) {
      const vlanId = body["vlan_id"];
      if (typeof vlanId !== "number") return undefined;
      return { group: "interface", op: "action", device, iface, actionId: "remove-trunk-vlan", label: "Remove trunk VLAN " + vlanId + " from " + device + ":" + iface, body: { vlan_id: vlanId }, danger: true };
    }
    const isAccess = body["tagged"] === false && typeof body["vlan_id"] === "number";
    const isRouted = typeof body["vrf"] === "string" || typeof body["ip"] === "string";
    if (!isAccess && !isRouted) return undefined;
    return { group: "interface", op: "action", device, iface, actionId: "unconfigure-interface", label: "Clear port configuration on " + device + ":" + iface, body: {}, danger: true };
  }
  return undefined;
}

// Filter helpers — used by per-device Apply/Discard buttons.

export function deviceQueue(device: string): readonly Pending[] {
  return queue.filter((p) =>
    (p.group === "device" && (p as { device: string }).device === device) ||
    (p.group === "interface" && (p as { device: string }).device === device) ||
    (p.group === "topology" && p.op === "update-device" && (p as { name: string }).name === device));
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

// pendingSpecCreateItems returns queued spec creates (top-level, not sub-rule)
// with their body, so the Specs list can place a pending override at its real
// scope (its name matches the network base, so a name-only overlay would hide
// it under the base).
export function pendingSpecCreateItems(kind: SpecKind): { name: string; body: Record<string, unknown> }[] {
  return queue
    .filter((p): p is Extract<Pending, { group: "mutation" }> =>
      p.group === "mutation" && !p.sub && p.kind === kind && p.effect === "create")
    .map((p) => ({ name: p.name, body: p.body ?? {} }));
}

export function isSpecPendingDelete(kind: SpecKind, name: string, scope?: string, scopeInstance?: string): boolean {
  const scoped = !!scope && scope !== "network";
  return queue.some((p) => p.group === "mutation" && !p.sub && p.kind === kind && p.effect === "delete" && p.name === name
    && (scoped ? (p.scope === scope && (p.scopeInstance ?? "") === (scopeInstance ?? "")) : !p.scope));
}

export function isSpecPendingUpdate(kind: SpecKind, name: string): boolean {
  return queue.some((p) => p.group === "mutation" && !p.sub && p.kind === kind && p.effect === "update" && p.name === name);
}

// pendingSubMutations returns queued sub-rule ops for one parent spec's
// collection, so the inline table can overlay them on the committed rows.
export function pendingSubMutations(
  kind: SpecKind, spec: string, endpoint: string,
): { id: string; effect: "create" | "update" | "delete"; key?: string | number; body?: Record<string, unknown> }[] {
  return queue
    .filter((p): p is Extract<Pending, { group: "mutation" }> =>
      p.group === "mutation" && !!p.sub && p.kind === kind && p.name === spec && p.sub.endpoint === endpoint)
    .map((p) => ({
      id: p.id, effect: p.effect,
      ...(p.sub!.key !== undefined ? { key: p.sub!.key } : {}),
      ...(p.body !== undefined ? { body: p.body } : {}),
    }));
}

// pendingPortConfigs returns the ports staged for a device — from a pending
// update-device — so the port picker can mark rows "configured (pending)".
export function pendingPortConfigs(device: string): Record<string, Record<string, unknown>> {
  const p = queue.find((q) => q.group === "topology"
    && q.op === "update-device"
    && (q as { name: string }).name === device);
  if (!p) return {};
  const ports = ((p as { body?: Record<string, unknown> }).body ?? {}).ports;
  return ports && typeof ports === "object" ? ports as Record<string, Record<string, unknown>> : {};
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

// ---- SSH login (scoped scalar) --------------------------------------------
// set/clear stage like any spec mutation → committed via the header Save, with an
// undo inverse that restores the prior AUTHORED value at the scope (a set of it,
// or a clear when nothing was authored). Repeated edits at one scope coalesce.
// prior is the login authored at the scope BEFORE this change (from ShowSSHCredentials).
type SSHPrior = { ssh_user?: string; ssh_pass?: string } | null;

function pushSSHLogin(p: Extract<Pending, { group: "ssh-login" }>): Pending {
  const i = queue.findIndex((q) => q.group === "ssh-login" && q.scope === p.scope && q.scopeInstance === p.scopeInstance);
  if (i >= 0) queue[i] = p; else queue.push(p);
  notify();
  return p;
}

export function enqueueSSHLoginSet(scope: string, scopeInstance: string, body: Record<string, unknown>, title: string, prior: SSHPrior): Pending {
  const inverse: PendingInverse = prior && (prior.ssh_user || prior.ssh_pass)
    ? { group: "ssh-login", op: "set", scope, scopeInstance, body: { ssh_user: prior.ssh_user ?? "", ssh_pass: prior.ssh_pass ?? "" }, title }
    : { group: "ssh-login", op: "clear", scope, scopeInstance, title };
  return pushSSHLogin({ id: String(nextID++), group: "ssh-login", op: "set", scope, scopeInstance, body, title, inverse });
}

export function enqueueSSHLoginClear(scope: string, scopeInstance: string, title: string, prior: SSHPrior): Pending {
  const inverse: PendingInverse | undefined = prior && (prior.ssh_user || prior.ssh_pass)
    ? { group: "ssh-login", op: "set", scope, scopeInstance, body: { ssh_user: prior.ssh_user ?? "", ssh_pass: prior.ssh_pass ?? "" }, title }
    : undefined; // nothing authored → clear is a no-op, nothing to undo
  return pushSSHLogin({ id: String(nextID++), group: "ssh-login", op: "clear", scope, scopeInstance, title, ...(inverse ? { inverse } : {}) });
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
  if (p.group === "mutation") {
    const sub = !!p.sub;
    if (p.method === "POST") return sub ? 1.3 : 1.0;   // parent specs before their sub-rules
    if (p.method === "PUT") return 1.5;
    return sub ? 7.7 : 8.0;                            // sub-rules deleted before parent specs
  }
  // Port config runs before links / interface actions, so ports exist before anything references them.
  if (p.group === "topology" && p.op === "update-device") return 2.5;
  if (p.group === "topology" && p.op === "add-link") return 3;
  if (p.group === "device") return 4;
  if (p.group === "interface") return 5;
  if (p.group === "topology" && p.op === "remove-link") return 6;
  if (p.group === "ssh-login") {
    if (p.op === "set") return p.scope === "network" ? 0.9 : 1.7;  // network base before zone/node overrides
    return p.scope === "network" ? 8.1 : 7.6;                       // overrides cleared before the base
  }
  return 9;
}

// pendingPath returns the HTTP method + relative API path a Pending applies to
// — the exact target applyOne hits (scope query included for scoped mutations).
// Surfaced in the apply preview + results so the operator sees which endpoint
// (and scope) each change targets. KEEP IN SYNC with applyOne below.
export function pendingPath(p: Pending, mode: "default" | "topology" = "default"): { method: string; path: string } {
  const modeQS = mode === "topology" ? "?mode=topology" : "";
  if (p.group === "mutation") return { method: p.method, path: p.path };
  if (p.group === "topology" && p.op === "update-device") return { method: "PUT", path: `topology/nodes/${enc(p.name)}` };
  if (p.group === "topology" && p.op === "add-link") return { method: "POST", path: "topology/links" };
  if (p.group === "topology" && p.op === "remove-link") return { method: "DELETE", path: `topology/links/${enc(p.device)}/${enc(p.iface)}` };
  if (p.group === "device" && p.op === "action") return { method: "POST", path: `nodes/${enc(p.device)}/rpc/${p.actionId}${modeQS}` };
  if (p.group === "interface" && p.op === "action") return { method: "POST", path: `nodes/${enc(p.device)}/interfaces/${enc(p.iface)}/rpc/${p.actionId}${modeQS}` };
  if (p.group === "ssh-login") return { method: "POST", path: p.op === "set" ? "set-ssh-credentials" : "clear-ssh-credentials" };
  return { method: "?", path: "" };
}

async function applyOne(p: Pending, mode: "default" | "topology"): Promise<void> {
  const modeQS = mode === "topology" ? "?mode=topology" : "";
  // The flat thread: a mutation is just its HTTP verb replayed on its path.
  if (p.group === "mutation") {
    if (p.method === "POST") {
      // A scoped recreate (undo of a scoped delete) carries its scope on the
      // Pending, not in the captured body — merge it into the create body so it
      // lands on the override scope. (Forward override creates already carry
      // scope in the body and leave p.scope unset.)
      const body = p.scope ? { ...(p.body ?? {}), scope: p.scope, scope_instance: p.scopeInstance ?? "" } : (p.body ?? {});
      await postJSON(apiPath(p.path), body);
      return;
    }
    if (p.method === "PUT") { await put(apiPath(p.path), p.body ?? {}); return; }
    await del(apiPath(p.path));
    return;
  }
  if (p.group === "topology" && p.op === "update-device") {
    // Whole-device replace: PUT the full {steps, ports} body.
    await put(apiPath(`topology/nodes/${encodeURIComponent(p.name)}`), p.body);
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
  if (p.group === "ssh-login") {
    const body = p.op === "set"
      ? { scope: p.scope, scope_instance: p.scopeInstance, ...(p.body ?? {}) }
      : { scope: p.scope, scope_instance: p.scopeInstance };
    await postJSON(apiPath(p.op === "set" ? "set-ssh-credentials" : "clear-ssh-credentials"), body);
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
  if (p.group === "mutation") {
    const sign = p.effect === "create" ? "+" : p.effect === "delete" ? "−" : "~";
    const where = p.sub ? `${p.sub.endpoint} ${p.title} on ${p.name}` : `${p.kind} ${p.title}`;
    return `${sign} ${where}`;
  }
  if (p.group === "topology" && p.op === "update-device") return `~ ports on ${p.name}`;
  if (p.group === "topology" && p.op === "add-link") return `+ link ${p.a} ↔ ${p.z}`;
  if (p.group === "topology" && p.op === "remove-link") return `− link ${p.device}:${p.iface}`;
  if (p.group === "device" && p.op === "action") return `${p.device}: ${p.label}`;
  if (p.group === "interface" && p.op === "action") return `${p.device}:${p.iface}: ${p.label}`;
  return "?";
}

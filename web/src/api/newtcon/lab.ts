// Typed clients for newtcon-server's lab lifecycle endpoints.
//
// All calls go through newtcon-server which proxies to newtlab-server.
// Endpoints:
//   GET  /api/labs
//   GET  /api/labs/{name}/status
//   POST /api/labs/{name}/deploy
//   POST /api/labs/{name}/destroy
//   POST /api/labs/{name}/provision
//   GET  /api/labs/{name}/events    ← EventSource-based SSE
//   POST /api/labs/{name}/nodes/{node}/start
//   POST /api/labs/{name}/nodes/{node}/stop

import { apiFetch, apiSend } from "./_transport.js";

// NodeState mirrors pkg/newtlab/state.go NodeState. Only the fields we
// render are typed; additional fields come through as unknown.
export interface NodeState {
  pid: number;
  status: string;   // "running" | "stopped" | "error"
  phase?: string;   // "booting" | "bootstrapping" | "patching"
  ssh_port: number;
  console_port: number;
  original_mgmt_ip: string;
  ssh_user?: string;   // e.g. "admin" for SONiC, "root" for hosts
  host?: string;
  device_type?: string;
}

// LabState mirrors pkg/newtlab/state.go LabState.
// `spec_dir` → `dir` per newtron PR #208 (2026-06-17): after the layout
// collapse the directory IS the network root, so the old name lied.
export interface LabState {
  name: string;
  created: string;    // RFC3339
  dir: string;
  nodes: Record<string, NodeState>;
}

// DeployRequest is the optional body for POST /api/labs/{name}/deploy.
export interface DeployRequest {
  provision?: boolean;
  force?: boolean;
  host?: string;
  parallel?: number;
}

// DeployResponse is the 202 body for POST /api/labs/{name}/deploy.
export interface DeployResponse {
  lab: string;
  started: string;  // RFC3339
}

// fetchLabStatus returns the LabState for one lab from
// GET /api/labs/{name}/status.
export async function fetchLabStatus(name: string): Promise<LabState> {
  return (await apiFetch(`/api/labs/${encodeURIComponent(name)}/status`, { cache: "no-store" })) as LabState;
}

// postLabDeploy starts an async deploy of the named lab.
// Returns the DeployResponse (lab + started timestamp). 202 Accepted
// means the operation is in progress; subscribe to labEvents() for progress.
export async function postLabDeploy(name: string, req: DeployRequest = {}): Promise<DeployResponse> {
  return (await apiSend(`/api/labs/${encodeURIComponent(name)}/deploy`, "POST", req)) as DeployResponse;
}

// postLabDestroy tears down the named lab. Synchronous.
// Returns the upstream result object.
export async function postLabDestroy(name: string): Promise<unknown> {
  return apiSend(`/api/labs/${encodeURIComponent(name)}/destroy`, "POST");
}

// postLabProvision runs the post-deploy provisioning pass. Synchronous.
export async function postLabProvision(name: string, parallel?: number): Promise<unknown> {
  const url = parallel && parallel > 0
    ? `/api/labs/${encodeURIComponent(name)}/provision?parallel=${parallel}`
    : `/api/labs/${encodeURIComponent(name)}/provision`;
  return apiSend(url, "POST");
}

// postLabStartNode starts a stopped node. Synchronous.
export async function postLabStartNode(lab: string, node: string): Promise<unknown> {
  return apiSend(`/api/labs/${encodeURIComponent(lab)}/nodes/${encodeURIComponent(node)}/start`, "POST");
}

// postLabStopNode stops a running node. Synchronous.
export async function postLabStopNode(lab: string, node: string): Promise<unknown> {
  return apiSend(`/api/labs/${encodeURIComponent(lab)}/nodes/${encodeURIComponent(node)}/stop`, "POST");
}

// labEvents opens an EventSource SSE connection to the deploy event stream
// for the named lab.
//
// onEvent is called for each SSE message. The raw event data is the JSON
// string from the server. onError is called on connection errors.
// The returned EventSource can be .close()'d by the caller to stop streaming.
export function labEvents(
  lab: string,
  onEvent: (eventType: string, data: string) => void,
  onError: (err: Event) => void,
): EventSource {
  const src = new EventSource(`/api/labs/${encodeURIComponent(lab)}/events`);

  // newtlab emits three event types: "phase", "complete", "error".
  for (const eventType of ["phase", "complete", "error"]) {
    src.addEventListener(eventType, (e: Event) => {
      const msgEvent = e as MessageEvent;
      onEvent(eventType, msgEvent.data ?? "");
    });
  }

  // Generic message fallback for any event type not explicitly listed above.
  src.onmessage = (e: MessageEvent) => {
    onEvent("message", e.data ?? "");
  };

  src.onerror = onError;

  return src;
}

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

import { ApiError } from "./services.js";

// LabListItem is one entry from GET /api/labs.
export interface LabListItem {
  name: string;
}

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
export interface LabState {
  name: string;
  created: string;    // RFC3339
  spec_dir: string;
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

// fetchLabRaw is the shared helper for lab GET endpoints.
// On non-2xx responses it throws ApiError (JSON envelope) or plain Error
// (non-JSON body).
async function fetchLabRaw(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (cause) {
    throw new Error(`network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      let body: { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (body.error) {
        throw new ApiError(response.status, {
          error: {
            kind: body.error.kind,
            message: body.error.message,
            details: body.error.details ?? {},
          },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// postLab is the shared helper for lab POST endpoints.
// On non-2xx responses it throws ApiError or plain Error.
async function postLab(url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method: "POST",
    cache: "no-store",
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new Error(`network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      let errBody: { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      try {
        errBody = (await response.json()) as typeof errBody;
      } catch {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (errBody.error) {
        throw new ApiError(response.status, {
          error: {
            kind: errBody.error.kind,
            message: errBody.error.message,
            details: errBody.error.details ?? {},
          },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// fetchLabs returns all known labs from GET /api/labs.
export async function fetchLabs(): Promise<LabListItem[]> {
  const data = await fetchLabRaw("/api/labs");
  return data as LabListItem[];
}

// fetchLabStatus returns the LabState for one lab from
// GET /api/labs/{name}/status.
export async function fetchLabStatus(name: string): Promise<LabState> {
  const data = await fetchLabRaw(`/api/labs/${encodeURIComponent(name)}/status`);
  return data as LabState;
}

// postLabDeploy starts an async deploy of the named lab.
// Returns the DeployResponse (lab + started timestamp). 202 Accepted
// means the operation is in progress; subscribe to labEvents() for progress.
export async function postLabDeploy(name: string, req: DeployRequest = {}): Promise<DeployResponse> {
  const data = await postLab(`/api/labs/${encodeURIComponent(name)}/deploy`, req);
  return data as DeployResponse;
}

// postLabDestroy tears down the named lab. Synchronous.
// Returns the upstream result object.
export async function postLabDestroy(name: string): Promise<unknown> {
  return postLab(`/api/labs/${encodeURIComponent(name)}/destroy`);
}

// postLabProvision runs the post-deploy provisioning pass. Synchronous.
export async function postLabProvision(name: string, parallel?: number): Promise<unknown> {
  const url = parallel && parallel > 0
    ? `/api/labs/${encodeURIComponent(name)}/provision?parallel=${parallel}`
    : `/api/labs/${encodeURIComponent(name)}/provision`;
  return postLab(url);
}

// postLabStartNode starts a stopped node. Synchronous.
export async function postLabStartNode(lab: string, node: string): Promise<unknown> {
  return postLab(`/api/labs/${encodeURIComponent(lab)}/nodes/${encodeURIComponent(node)}/start`);
}

// postLabStopNode stops a running node. Synchronous.
export async function postLabStopNode(lab: string, node: string): Promise<unknown> {
  return postLab(`/api/labs/${encodeURIComponent(lab)}/nodes/${encodeURIComponent(node)}/stop`);
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

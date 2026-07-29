// views/topology/lab-ops.ts — newtlab lifecycle from the canvas: the deploy and
// provision modals, the shared SSE-streaming shell they run in, and the
// provisioning marker that keeps the topology honest while a provision runs.
//
// Both ops are async (newtron#373): the POST returns 202 immediately and the
// per-lab SSE stream ("phase" → "complete"/"error") drives the log and the
// completion. Destroy is synchronous and stays inline in the toolbar.

import { labEvents, postLabDeploy, postLabProvision } from "../../api/newtcon/lab.js";
import { el } from "../../dom.js";
import { engineOpErrorBody } from "../../render-error.js";

// Networks with a console-initiated provision in flight. While a network is in
// this set, its running lab devices read as "provisioning" (a known transition)
// instead of flapping to "unreachable" when their live /info reads fail — which
// they do for the whole provision (newtron reconfigures + restarts containers).
// newtlab emits no provision events (newtron#373), so the console is the only
// thing that knows a provision is running: the provision modal owns this set.
const provisioningNetworks = new Set<string>();

export function isProvisioning(network: string): boolean {
  return provisioningNetworks.has(network);
}

// openLabOpModal runs a newtlab lifecycle op (deploy / provision) in a modal that
// streams the per-lab SSE event stream (phase / complete / error) into a live log.
// Both ops are async (newtron#373): the POST returns 202 immediately and the SSE
// "complete"/"error" ends it. run() fires the op-specific POST + first messages; the
// shared shell owns the DOM, the SSE subscription, teardown, and the settle hook.
// onSettle fires exactly once when the op finishes — SSE complete/error, or the
// operator closing the panel — for callers that hold op-scoped state (e.g. the
// provisioning marker that tints the topology dots).
function openLabOpModal(
  network: string,
  opts: {
    title: string;
    hint: string;
    completeLine?: string;
    onSettle?: () => void;
    run: (ctx: { append: (line: string) => void; finish: () => void }) => Promise<void>;
  },
): void {
  // Non-blocking floating panel — NOT a full-screen modal backdrop. Deploy/provision
  // are long ops the operator is told to "close once complete" (they continue in the
  // background via SSE + the status poll), so the operator must be able to watch the
  // topology fill in and pan/zoom while progress streams. A backdrop would freeze the
  // canvas for the whole op. Blocking modals (network create/remove) keep their overlay.
  const modal = el("div", { className: "network-modal deploy-modal lab-op-panel" });
  const title = el("h2", { className: "network-modal-title" }, opts.title);
  const hint = el("p", { className: "network-modal-hint" }, opts.hint);
  const logLines = el("pre", { className: "deploy-modal-log" });
  // Always-enabled Close — the operator can dismiss whenever; the op continues at
  // newtlab's pace and its status surfaces back in the topology view.
  const closeBtn = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Close");
  const actions = el("div", { className: "network-modal-actions" });
  actions.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(hint);
  modal.appendChild(logLines);
  modal.appendChild(actions);
  document.body.appendChild(modal);

  const append = (line: string): void => {
    logLines.textContent += (logLines.textContent ? "\n" : "") + line;
    logLines.scrollTop = logLines.scrollHeight;
  };
  let src: EventSource | null = null;
  let settled = false;
  const finish = (): void => { src?.close(); src = null; };
  const settle = (): void => { if (settled) return; settled = true; opts.onSettle?.(); };
  const close = (): void => { finish(); settle(); modal.remove(); };
  closeBtn.addEventListener("click", close);

  // Stream the per-lab SSE events (newtron#373: deploy AND provision both emit
  // phase → complete/error). The terminal event ends the stream + settles.
  src = labEvents(
    network,
    (eventType, data) => {
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (eventType === "phase") {
          const phase = String(payload["phase"] ?? "");
          const detail = payload["detail"] ? " — " + String(payload["detail"]) : "";
          append(`${phase}${detail}`);
        } else if (eventType === "complete") {
          append(opts.completeLine ?? "[done] complete");
          finish();
          settle();
        } else if (eventType === "error") {
          append("[error] " + String(payload["message"] ?? data));
          finish();
          settle();
        }
      } catch {
        append(data);
      }
    },
    () => {
      // Stream closed or errored. EventSource normally reconnects on a clean
      // close, so we don't auto-close the modal — the operator stays in control.
    },
  );

  void opts.run({ append, finish });
}

// openDeployModal — async op: POST returns 202, the SSE "complete" ends it.
export function openDeployModal(network: string): void {
  openLabOpModal(network, {
    title: `Bringing up "${network}" as a lab`,
    hint: "newtlab is booting one VM per device in the topology. Streaming progress below — close this window once the deploy completes.",
    completeLine: "[done] deploy complete — devices are addressable through the topology view",
    run: async ({ append }) => {
      append(`POST deploy lab=${network}…`);
      try {
        await postLabDeploy(network, {});
        append("accepted; streaming events…");
      } catch (err) {
        append(`[error] deploy request failed: ${engineOpErrorBody(err)}`);
      }
    },
  });
}

// openProvisionModal — async provision (newtron#373): POST 202, the SSE stream
// drives the log + completion, exactly like deploy. Marks the network provisioning
// (topology dots read "provisioning" while devices reconcile) and clears the marker
// when the op settles. `physical` only varies the title (same backend pass today).
export function openProvisionModal(network: string, opts: { physical?: boolean } = {}): void {
  provisioningNetworks.add(network);
  openLabOpModal(network, {
    title: opts.physical ? `Provisioning physical substrate for "${network}"` : `Provisioning "${network}"`,
    hint: "newtlab is reconciling each device to the network spec — this can take a few minutes. Streaming progress below; close this window once it completes.",
    completeLine: "[done] provision complete — devices reconciled to the network spec",
    onSettle: () => provisioningNetworks.delete(network),
    run: async ({ append }) => {
      append(`POST provision lab=${network}…`);
      try {
        await postLabProvision(network);
        append("accepted; streaming events…");
      } catch (err) {
        append(`[error] provision request failed: ${engineOpErrorBody(err)}`);
      }
    },
  });
}

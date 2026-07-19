// web/src/services/services.ts — services-listing page module.
//
// This module owns the DOM for the services-listing page. It fetches
// GET /api/services via the typed client, then renders the result into
// the #services-root element present in services/index.html.
//
// Rendering discipline:
//   - Only name and type are rendered per acceptance criterion 3 of newtcon#105:
//     instance_count, health, and last_modified are zero-valued in v1 and must
//     not be shown — rendering zero-valued aggregates violates operator-philosophy
//     invariant #9 (false confidence is worse than no confidence).
//   - Error kinds are wire-shape identifiers (schema symbols, per editing-guidelines
//     §42); they stay in the wire contract unchanged. Operator-facing rendering
//     translates them into plain language so the operator never reads raw
//     snake_case kind labels.
//   - Loading state is shown immediately so the operator knows the fetch is in
//     flight; no flash of empty content.
//
// Import paths use .js extensions per Node16 moduleResolution (web/README.md).

import {
  fetchServices,
  ApiError,
  type ServiceListResponse,
} from "../api/newtcon/services.js";
import {
  translateErrorKind,
  formatAuthorizationDetails,
} from "../render-error.js";

// ---- DOM helper ---------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const child of children) {
    node.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child
    );
  }
  return node;
}

// ---- Render functions ----------------------------------------------------

/**
 * renderLoading replaces root's content with a loading indicator.
 * Called immediately before the fetch so the operator sees feedback without
 * any flash of empty content.
 */
export function renderLoading(root: HTMLElement): void {
  root.textContent = "";
  const p = el("p", { className: "status-loading" }, "Loading…");
  root.appendChild(p);
}

/**
 * renderServices renders a list of services into root.
 * Only name and type are surfaced — see module godoc for rationale.
 */
export function renderServices(
  root: HTMLElement,
  data: ServiceListResponse
): void {
  root.textContent = "";

  if (data.services.length === 0) {
    const empty = el("div", { className: "state-empty" });
    empty.appendChild(
      el("p", {}, "No services configured in this network.")
    );
    const note = el("p", { className: "note" });
    note.innerHTML =
      '<a href="/docs/operator-philosophy.md#2-manual-mode-parity">' +
      "Manual-mode parity: how to inspect newtron’s service registry directly.</a>";
    empty.appendChild(note);
    root.appendChild(empty);
    return;
  }

  const table = el("table");
  const thead = el("thead");
  const headerRow = el("tr");
  headerRow.appendChild(el("th", {}, "Name"));
  headerRow.appendChild(el("th", {}, "Type"));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const svc of data.services) {
    const row = el("tr");
    row.appendChild(el("td", { className: "svc-name" }, svc.name));
    row.appendChild(el("td", { className: "svc-type" }, svc.type));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  root.appendChild(table);

  const note = el("p", { className: "pending-note" });
  note.innerHTML =
    "Service health and instance counts are not yet available — " +
    'see <a href="/docs/adr/0001-scope-justification-vs-newtrun.md">' +
    "ADR-0001</a>.";
  root.appendChild(note);
}

/**
 * renderError renders the error state into root, branching on the failure type
 * so the operator sees a precise explanation per invariant #7 (errors carry
 * detail) and invariant #9 (confidence and limits are explicit).
 *
 * Three cases:
 *
 * 1. ApiError with kind "newtron_unavailable" — newtcon-server reached the
 *    network but newtron-server was not reachable from there. Renders the
 *    underlying_error and next_action_hint.rationale from the error details,
 *    which carry the specific cause (connection_refused, http_5xx, etc.).
 *
 * 2. ApiError with another kind — a structured error from newtcon-server
 *    that is not an availability problem. Renders a translated label plus
 *    the error message, with HTTP status and the full details in a <details>
 *    block for inspection.
 *
 * 3. Plain Error — fetch() rejected before any HTTP response arrived. This is
 *    a browser → newtcon-server failure, distinct from a newtcon-server →
 *    newtron-server failure. The operator needs to distinguish the two hops.
 */
export function renderError(root: HTMLElement, err: unknown): void {
  root.textContent = "";

  const box = el("div", { className: "state-error" });

  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    renderNewtronUnavailableError(box, err);
  } else if (err instanceof ApiError) {
    renderOtherApiError(box, err);
  } else {
    renderNetworkError(box, err);
  }

  root.appendChild(box);
}

/**
 * renderNewtronUnavailableError renders the 503 newtron_unavailable case.
 * Shows "newtron is unreachable" in plain language and surfaces the
 * underlying_error and next_action_hint.rationale fields from the error
 * details, which carry the specific cause and next step.
 */
function renderNewtronUnavailableError(
  box: HTMLElement,
  err: ApiError
): void {
  box.appendChild(
    el("p", { className: "error-kind" }, "newtron is unreachable")
  );
  box.appendChild(
    el("p", { className: "error-message" }, "newtron-server is unreachable.")
  );

  const underlyingError =
    typeof err.details["underlying_error"] === "string"
      ? err.details["underlying_error"]
      : null;
  const rationale =
    typeof err.details["next_action_hint"] === "object" &&
    err.details["next_action_hint"] !== null &&
    typeof (err.details["next_action_hint"] as Record<string, unknown>)[
      "rationale"
    ] === "string"
      ? (
          (err.details["next_action_hint"] as Record<string, unknown>)[
            "rationale"
          ] as string
        )
      : null;

  if (underlyingError !== null) {
    const cause = el("p", { className: "error-cause" });
    cause.appendChild(
      document.createTextNode("Underlying cause: ")
    );
    cause.appendChild(el("code", {}, underlyingError));
    box.appendChild(cause);
  }

  if (rationale !== null) {
    box.appendChild(
      el("p", { className: "error-rationale" }, rationale)
    );
  }

  const hint = el("p", { className: "error-hint" });
  hint.innerHTML =
    'Check <a href="/api/health">/api/health</a> for newtron-server reachability.';
  box.appendChild(hint);
}

/**
 * renderOtherApiError renders non-503 ApiError cases (validation_failure,
 * internal, precondition_failure, drift_refusal, authorization_failure,
 * authentication_failure). Renders a translated error label plus the error
 * message, with HTTP status and the full details in a <details> block for
 * inspection.
 *
 * For kind="authorization_failure" the typed details fields {caller,
 * permission, resource} are surfaced as the primary line so the operator
 * sees "alice lacks spec.author on svc-b" rather than the server's compound
 * "POST /api/.../create-service: authorization denied: …" string (which
 * repeats the endpoint already visible in the URL bar / breadcrumb).
 */
function renderOtherApiError(box: HTMLElement, err: ApiError): void {
  box.appendChild(
    el("p", { className: "error-kind" }, translateErrorKind(err.kind))
  );
  if (err.kind === "authorization_failure") {
    const structured = formatAuthorizationDetails(err.details);
    if (structured) {
      box.appendChild(el("p", { className: "error-message" }, structured));
    } else {
      box.appendChild(el("p", { className: "error-message" }, err.message));
    }
  } else {
    box.appendChild(el("p", { className: "error-message" }, err.message));
  }

  const details = el("details", { className: "disclosure error-details" });
  const summary = el("summary", {}, "HTTP " + String(err.status) + " — details");
  details.appendChild(summary);
  const pre = el("pre", { className: "error-details-body" });
  try {
    pre.textContent = JSON.stringify(err.details, null, 2);
  } catch {
    pre.textContent = "(details not serialisable)";
  }
  details.appendChild(pre);
  box.appendChild(details);
}

/**
 * renderNetworkError renders the case where fetch() rejected before any HTTP
 * response was received. The operator sees "unreachable from this browser" to
 * distinguish this from the newtcon-server → newtron-server hop failing.
 */
function renderNetworkError(box: HTMLElement, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  box.appendChild(
    el("p", { className: "error-kind" }, "network error")
  );
  box.appendChild(
    el(
      "p",
      { className: "error-message" },
      "newtcon-server is unreachable from this browser."
    )
  );
  box.appendChild(el("p", { className: "error-raw" }, msg));
}

// ---- Mount ---------------------------------------------------------------

/**
 * mount is the page entry point. It selects #services-root, shows the
 * loading state immediately, fetches services, then renders the result or
 * error. Called by the inline script in services/index.html.
 */
export async function mount(): Promise<void> {
  const root = document.getElementById("services-root");
  if (root === null) {
    // Page root not present — no-op so the module is safe to import in
    // tests that only test individual render functions.
    return;
  }

  renderLoading(root);

  try {
    const data = await fetchServices();
    renderServices(root, data);
  } catch (err: unknown) {
    renderError(root, err);
  }
}

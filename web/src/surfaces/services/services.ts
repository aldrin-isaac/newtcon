// web/src/surfaces/services/services.ts — services-listing surface module.
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
//   - Error envelopes are surfaced verbatim (kind + message) per invariant #9.
//   - Loading state is shown immediately so the operator knows the fetch is in
//     flight; no flash of empty content.
//
// Import paths use .js extensions per Node16 moduleResolution (web/README.md).

import {
  fetchServices,
  ApiError,
  type ServiceListResponse,
} from "../../api/newtcon/services.js";

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
    empty.appendChild(el("p", {}, "No services available."));
    const note = el("p", { className: "note" });
    note.innerHTML =
      "Service specs are registered in newtron. See the " +
      '<a href="https://github.com/aldrin-isaac/newtron" ' +
      'rel="noreferrer noopener">newtron documentation</a> ' +
      "for how service specs are defined and loaded.";
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
    "Service health and instance counts pending &mdash; " +
    "see <a href=\"/docs/adr/0001-scope-justification-vs-newtrun.md\">" +
    "ADR-0001</a>. " +
    "newtron substrate does not yet expose per-service aggregates.";
  root.appendChild(note);
}

/**
 * renderError renders the structured error envelope into root.
 * The kind and message fields are surfaced verbatim per invariant #9;
 * no translation, no "something went wrong" substitution.
 */
export function renderError(root: HTMLElement, err: unknown): void {
  root.textContent = "";

  const box = el("div", { className: "state-error" });

  if (err instanceof ApiError) {
    const kind = el("p", { className: "error-kind" });
    kind.appendChild(el("strong", {}, "Error "));
    kind.appendChild(document.createTextNode(err.kind));
    box.appendChild(kind);
    box.appendChild(el("p", { className: "error-message" }, err.message));
    const hint = el("p", { className: "error-hint" });
    hint.innerHTML =
      "Check <a href=\"/api/health\">/api/health</a> for newtron-server " +
      "reachability status, or see " +
      "<a href=\"/docs/operator-philosophy.md#9-confidence-and-limits-are-explicit\">" +
      "operator-philosophy.md §9</a>.";
    box.appendChild(hint);
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    box.appendChild(el("p", { className: "error-kind" }, "network error"));
    box.appendChild(el("p", { className: "error-message" }, msg));
  }

  root.appendChild(box);
}

// ---- Mount ---------------------------------------------------------------

/**
 * mount is the surface entry point. It selects #services-root, shows the
 * loading state immediately, fetches services, then renders the result or
 * error. Called by app.ts once the surface is active.
 */
export async function mount(): Promise<void> {
  const root = document.getElementById("services-root");
  if (root === null) {
    // Surface HTML not present — no-op so the module is safe to import in
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

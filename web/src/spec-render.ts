// spec-render.ts — the shared spec/detail render helpers: loading + error
// states, the generic value dump, and the schema-aware spec-detail layout
// (labeled rows in schema order + an "All fields" disclosure for anything
// newtron returned that the schema doesn't cover).
//
// These are NOT drawer-specific. They lived in views/drawer/index.ts because
// that's where they landed when they moved out of app.ts (uplift 1.3), which
// left views/specs reaching into views/drawer for generic rendering — two
// sibling views coupled through one's internals. They belong here, next to
// spec-detail-shape.ts (the pure layout derivation they consume).
//
// One deliberate cycle: renderRefChip opens the referenced spec's drawer, so
// this module calls into views/specs. It's a hoisted function used only inside
// a click handler — no init-time evaluation, so load order doesn't matter.

import { type SpecKind } from "./api/newtcon/network.js";
import { resolveKindToSlug } from "./api/newtcon/schema.js";
import { ApiError } from "./api/newtcon/services.js";
import { el, renderValue } from "./dom.js";
import { type SpecField, buildSpecDetailShape } from "./spec-detail-shape.js";
import { showToast } from "./toast.js";
import { kindTitleFor, openDetail } from "./views/specs/index.js";

// renderLoadingInto clears a container and shows a loading indicator.
export function renderLoadingInto(container: HTMLElement): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "status-loading" }, "Loading…"));
}

// renderErrorInto clears a container and shows an error message.
export function renderErrorInto(container: HTMLElement, err: unknown): void {
  container.textContent = "";
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "Device unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError && err.kind === "internal" && err.status === 404) {
    container.appendChild(el("p", { className: "panel-error" }, "Not found"));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "Request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
}

// renderValueInto places renderValue output into a container, adding .drawer-detail.
export function renderValueInto(container: HTMLElement, data: unknown): void {
  container.textContent = "";
  const body = renderValue(data);
  if (body instanceof HTMLElement) {
    body.classList.add("drawer-detail");
  }
  container.appendChild(body);
}

// toSpecField adapts a newtron SchemaField to the narrower SpecField the
// detail renderer consumes. ref_kind is carried through only for type
// "ref" fields, so the renderer knows which rows become cross-link chips.
export function toSpecField(f: import("./api/newtcon/schema.js").SchemaField): SpecField {
  const out: SpecField = { name: f.name, label: f.label };
  if (f.type === "ref" && f.ref_kind) out.refKind = f.ref_kind;
  return out;
}

// renderSpecDetailInto renders spec data with a tailored, schema-aware
// layout: each schema field becomes a labeled row in the order the schema
// defines, and any extra fields newtron returned (not in the schema) sit
// inside an "All fields" disclosure so the operator never silently loses
// visibility of newtron data — even fields the schema hasn't been updated
// to cover (additions made after this build). The one exception is ssh_pass,
// redacted below — it's a credential some reads return in the clear.
//
// extraExcludes is for fields already rendered elsewhere in the drawer
// (e.g. sub-rule children for kinds that have a dedicated rules / queues /
// prefixes section below the body). Pass [] for the default.
//
// Falls back to renderValueInto when data is not an object (defensive
// against newtron returning a primitive or null).
export function renderSpecDetailInto(container: HTMLElement, fields: SpecField[], data: unknown, extraExcludes: string[] = []): void {
  container.textContent = "";
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(container, data);
    return;
  }
  // "name" is rendered in the drawer header already (drawer-name); skip it
  // here to avoid a redundant row in the body. extraExcludes adds caller-
  // supplied fields (typically a sub-rule's wire-field name).
  //
  // ssh_pass is redacted globally: some reads (GET /nodes/{name}) return the
  // RESOLVED login with ssh_pass IN THE CLEAR (newtlab dials with it), and since
  // it left the NodeSpec schema (newtron#388) it would otherwise surface in the
  // "All fields" disclosure. The device password is never rendered here — the SSH
  // Login control shows only the masked, per-scope authored value.
  const shape = buildSpecDetailShape(fields, data as Record<string, unknown>, ["name", "ssh_pass", ...extraExcludes]);

  // Empty-state: the schema is just `name` (zones today) AND newtron returned
  // nothing else. Operator gets an honest "nothing more to see" rather than
  // a blank drawer body that looks like a render failure.
  if (shape.rows.length === 0 && shape.extras.length === 0) {
    container.appendChild(el("p", { className: "spec-detail-empty-state" },
      "This spec has no additional fields."));
    return;
  }

  const dl = el("dl", { className: "spec-detail drawer-detail" });
  for (const row of shape.rows) {
    dl.appendChild(el("dt", { className: "spec-detail-label" }, row.label));
    const dd = el("dd", { className: "spec-detail-value" });
    dd.appendChild(renderSpecValue(row));
    dl.appendChild(dd);
  }
  container.appendChild(dl);

  if (shape.extras.length > 0) {
    const det = el("details", { className: "disclosure spec-detail-extras" });
    det.appendChild(el("summary", { className: "spec-detail-extras-summary" },
      `All fields (${shape.extras.length} additional)`));
    const dlx = el("dl", { className: "kv spec-detail" });
    for (const row of shape.extras) {
      dlx.appendChild(el("dt", { className: "spec-detail-label spec-detail-label--extra" }, row.label));
      const dd = el("dd", { className: "spec-detail-value" });
      dd.appendChild(renderSpecValue(row));
      dlx.appendChild(dd);
    }
    det.appendChild(dlx);
    container.appendChild(det);
  }
}

// renderSpecValue renders one SpecRow's value cell. Empty values show
// "—". Ref rows (refKind set) with a non-empty string value render as a
// clickable chip that opens the referenced spec's drawer; everything
// else falls through to the generic renderValue. Resolution of the
// ref's kind → URL slug happens lazily on click (the schema cache is
// already warm by the time a detail drawer is open, so it's instant).
function renderSpecValue(row: import("./spec-detail-shape.js").SpecRow): Node {
  if (row.empty) return el("span", { className: "spec-detail-empty" }, "—");
  if (row.refKind && typeof row.value === "string" && row.value !== "") {
    return renderRefChip(row.refKind, row.value);
  }
  return renderValue(row.value);
}

// renderRefChip builds a clickable chip for a cross-spec reference. The
// click resolves refKind (a newtron kind name) to its URL slug and
// opens that spec's detail drawer over the current one. A failed
// resolution (embedded kind, schema not loaded) surfaces a toast rather
// than a dead click.
function renderRefChip(refKind: string, name: string): HTMLElement {
  const chip = el("button", {
    type: "button",
    className: "chip chip--mono chip--clickable chip--ref",
    title: `Open ${name}`,
  }, name) as HTMLButtonElement;
  chip.addEventListener("click", () => {
    void (async () => {
      const slug = await resolveKindToSlug(refKind).catch(() => null);
      if (!slug) {
        showToast({
          kind: "error",
          title: `Can't open "${name}"`,
          body: "Its spec type isn't separately viewable.",
        });
        return;
      }
      const kind = slug as SpecKind;
      await openDetail(kind, kindTitleFor(kind), name);
    })();
  });
  return chip;
}

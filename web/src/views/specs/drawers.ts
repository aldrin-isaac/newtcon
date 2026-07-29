// views/specs/drawers.ts — the spec AUTHORING drawers: create, edit, and
// "add override". Each opens in the shared #detail-drawer and stages its
// change onto the pending queue (never a direct write) so it flows through
// the same preview / Apply / undo path as every other mutation.
//
// Every kind newtron describes renders schema-driven (renderSchemaForm);
// the legacy* paths are the fallback for schema-orphan kinds, built from
// fields.ts specForms.
//
// CYCLE (deliberate, load-safe): these forms call openDetail / closeDetail
// from detail.ts, and detail.ts calls enterSpecEditMode from here. Both
// directions are hoisted `function` declarations with no init-time
// evaluation, so module-load order doesn't matter — the same pattern the
// view already uses with views/drawer/.

import { type SpecKind, fetchSpecDetail } from "../../api/newtcon/network.js";
import { fetchSchema, resolveSlugToKind } from "../../api/newtcon/schema.js";
import { el } from "../../dom.js";
import { clearFieldErrors } from "../../form-error-binding.js";
import { formatErrorBrief } from "../../render-error.js";
import { renderSchemaForm } from "../../schema-form.js";
import { computePrefillForKind, strategiesFor } from "../../smart-defaults.js";
import { type SpecKind as StagingSpecKind, enqueueSpecCreate, enqueueSpecUpdate } from "../../staging.js";
import { closeDetail, openDetail } from "./detail.js";
import { buildFormFields, prefillFromDetail, specForms } from "./fields.js";

// enterSpecEditMode replaces the drawer body with an edit form pre-filled
// from the current detail. On Save: PUT /api/networks/.../{kind}/{name}
// (newtron's update-<kind>) → re-open the drawer to read the fresh values.
// On Cancel: re-open the drawer (discards changes).
//
// Why re-open instead of swap-back? Newtron's update can synthesize fields
// (timestamps, derived names) we don't know about. Re-fetching is the
// honest path that surfaces the new state verbatim.
export function enterSpecEditMode(
  kind: SpecKind,
  kindTitle: string,
  name: string,
  detail: unknown,
  content: HTMLElement,
): void {
  // Clear the body but keep the kind / name header.
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, name));

  // Schema-driven path: resolve the URL slug to a newtron kind, fetch
  // its schema, render an edit form prefilled from the GET-detail wire
  // shape. Fields with `immutable: true` render read-only — newtron
  // rejects identifier changes via the update verb.
  void (async () => {
    const schemaKind = await resolveSlugToKind(kind).catch(() => null);
    if (schemaKind !== null) {
      await renderSchemaDrivenEdit(kind, kindTitle, name, detail, schemaKind, content);
      return;
    }
    legacyEditForm(kind, kindTitle, name, detail, content);
  })();
}

async function renderSchemaDrivenEdit(
  kind: SpecKind,
  kindTitle: string,
  name: string,
  detail: unknown,
  schemaKind: string,
  content: HTMLElement,
): Promise<void> {
  const loading = el("p", { className: "status-loading" }, "Loading schema…");
  content.appendChild(loading);
  let schema;
  try {
    schema = await fetchSchema(schemaKind);
  } catch (err) {
    loading.remove();
    content.appendChild(el("p", { className: "panel-error" },
      `Schema for ${schemaKind} unavailable: ${formatErrorBrief(err)}`));
    return;
  }
  loading.remove();
  const { form, getValues, validate } = await renderSchemaForm({
    schema,
    prefill: detail && typeof detail === "object" ? detail as Record<string, unknown> : {},
    editMode: true,
  });
  content.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  content.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  content.appendChild(buttons);

  cancelBtn.addEventListener("click", () => {
    void openDetail(kind, kindTitle, name);
  });

  saveBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errOut.textContent = "";
    const values = getValues();
    // The PUT URL identifies the row; newtcon-server overwrites any
    // identifier in the body with the URL value. Strip the identifier
    // here too to keep the wire payload clean.
    //
    // Sub-collection fields (array/map of item_kind — e.g. rules, queues)
    // flow into `values` as empty per renderSchemaForm's "not authorable"
    // notice path. newtron preserves sub-collections on update-X per
    // docs/newtron/api.md §5 (sub-rule verbs own the sub-collection
    // lifecycle), so emitting an empty array doesn't wipe existing rules —
    // but stripping here is belt-and-braces against any future contract change.
    const idField = schema.identifier || "name";
    delete values[idField];
    for (const f of schema.fields) {
      if ((f.type === "array" || f.type === "map") && f.item_kind) {
        delete values[f.name];
      }
    }
    // Queue the edit (PUT /update-<kind>) — it stages and applies through the
    // Save loop like create/delete, not instantly. The list shows the row as
    // pending-modified; the committed values stand until Apply. preBody (the
    // spec before the edit) lets undo restore it.
    const preBody = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
    enqueueSpecUpdate(kind as StagingSpecKind, name, values, preBody);
    saveBtn.disabled = true;
    saveBtn.textContent = "Queued";
    content.insertBefore(
      el("p", { className: "form-success" },
        "Edit added to pending changes. Click Save in the header to apply."),
      buttons);
    setTimeout(() => { closeDetail(); }, 800);
  });
}

function legacyEditForm(
  kind: SpecKind,
  kindTitle: string,
  name: string,
  detail: unknown,
  content: HTMLElement,
): void {
  const fields = specForms[kind];
  if (!fields) return;

  const { form, getValues, validate } = buildFormFields(fields, {
    prefill: prefillFromDetail(kind, detail),
    // Identifier comes from the URL on the server side; rendering it in
    // the form would imply renames are supported here (they aren't).
    excludeNames: ["name"],
  });
  content.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  content.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  content.appendChild(buttons);

  cancelBtn.addEventListener("click", () => {
    void openDetail(kind, kindTitle, name);
  });

  saveBtn.addEventListener("click", () => {
    clearFieldErrors(form);
    if (!validate()) return;
    errOut.textContent = "";
    // Queue the edit (same staging path as create/delete) rather than PUT now.
    const preBody = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
    enqueueSpecUpdate(kind as StagingSpecKind, name, getValues(), preBody);
    saveBtn.disabled = true;
    saveBtn.textContent = "Queued";
    content.insertBefore(
      el("p", { className: "form-success" },
        "Edit added to pending changes. Click Save in the header to apply."),
      buttons);
    setTimeout(() => { closeDetail(); }, 800);
  });
}

// Schema dispatch is dynamic — given newtcon's URL slug, we look up the
// newtron kind name from /api/schema's `paths.list` per kind. No
// hardcoded slug→kind map: newtron is the source of truth for which
// kinds exist, and newtcon discovers them at runtime. See
// resolveSlugToKind() in web/src/api/newtcon/schema.ts.

// openCreateDrawer opens the drawer for creating a new spec of the given kind.
// onSuccess is called after a successful create to refresh the panel list.
export function openCreateDrawer(kind: SpecKind, kindTitle: string, onSuccess: () => void): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add " + kindTitle.toLowerCase().replace(/s$/, "")));

  // Dispatch is dynamic: resolve the URL slug to newtron's kind name
  // via /api/schema. If newtron knows the kind, use the schema-driven
  // path; otherwise fall back to legacy specForms. resolveSlugToKind
  // is async (one lazy fetch per session to build the slug map); we
  // await it before deciding the path.
  void (async () => {
    const schemaKind = await resolveSlugToKind(kind).catch(() => null);
    if (schemaKind !== null) {
      void renderSchemaDrivenCreate(kind, schemaKind, content, onSuccess);
      return;
    }
    // Fall through to the legacy hand-typed specForms path for any
    // kind newtron's schema endpoint doesn't cover.
    legacyCreateForm(kind, content, drawer, onSuccess);
  })();
}

// openOverrideDrawer — "Add override" from a network-level record. Opens the
// create drawer prefilled with the base spec's current values, so the operator
// changes only the scope (and any field that should legitimately differ at the
// zone/node) instead of re-keying the whole spec from a second window. The
// identifier is locked to the base name; scope is seeded to "zone" so the form
// lands on the override path (must pick a scope_instance) rather than the base.
export function openOverrideDrawer(
  kind: SpecKind,
  kindTitle: string,
  baseName: string,
  onSuccess: () => void,
): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle + " override"));
  content.appendChild(el("h2", { className: "drawer-name" }, baseName));

  void (async () => {
    const schemaKind = await resolveSlugToKind(kind).catch(() => null);
    if (schemaKind === null) {
      content.appendChild(el("p", { className: "panel-error" },
        "Overrides aren't available for this spec type."));
      return;
    }
    // Pull the network base so the override starts as a faithful copy.
    const loading = el("p", { className: "status-loading" }, "Loading base values…");
    content.appendChild(loading);
    let baseDetail: Record<string, unknown> = {};
    try {
      const d = await fetchSpecDetail(kind, baseName);
      if (d && typeof d === "object") baseDetail = d as Record<string, unknown>;
    } catch { /* fall through — operator can fill it in */ }
    loading.remove();
    // Seed scope=zone (+ empty instance) so the form opens on the override
    // path; the operator can switch to node. scope/scope_instance aren't part
    // of the spec detail, so we set them explicitly.
    const prefill: Record<string, unknown> = { ...baseDetail, scope: "zone", scope_instance: "" };
    await renderSchemaDrivenCreate(kind, schemaKind, content, onSuccess,
      { prefill, lockIdentifier: true });
  })();
}

// legacyCreateForm — fallback path for kinds newtron's schema endpoint
// doesn't yet describe (e.g. prefix-lists today). Lifted out of
// openCreateDrawer so the dynamic-dispatch flow can call it without
// duplicating the original body.
function legacyCreateForm(
  kind: SpecKind,
  content: HTMLElement,
  drawer: HTMLElement,
  onSuccess: () => void,
): void {
  const fields = specForms[kind];
  if (!fields || fields.length === 0) {
    content.appendChild(el("p", { className: "panel-error" }, "No form defined for this spec type."));
    return;
  }

  const { form, getValues, validate } = buildFormFields(fields);
  content.appendChild(form);

  // Smart defaults (slice #172.D): asynchronously fetch existing specs of
  // this kind and suggest the next-available value for integer-ID fields
  // (l3vni on ipvpns, vni on macvpns). Fire-and-forget — the form is
  // already usable, and any fetch failure leaves it unprefilled.
  if (strategiesFor(kind)) {
    void computePrefillForKind(kind).then((defaults) => {
      for (const [name, value] of Object.entries(defaults)) {
        const input = form.querySelector("#field-" + name) as HTMLInputElement | null;
        // Only fill when the operator hasn't already started typing — the
        // suggestion is a starting point, never an override.
        if (input && input.value === "") input.value = String(value);
      }
    });
  }

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Create");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", () => {
    if (!validate()) return;
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      const values = getValues();
      const name = String(values["name"] ?? values["id"] ?? "(unnamed)");
      enqueueSpecCreate(kind as StagingSpecKind, name, values);
      const ok = el("p", { className: "form-success" }, "Added to pending changes (green). Click Save in the header to apply.");
      content.insertBefore(ok, submitBtn);
      onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  });
}

// renderSchemaDrivenCreate — schema-metadata flavour of openCreateDrawer
// (newtron PR #240). Fetches the schema for the kind, renders a `name`
// identifier input + the schema fields, and wires the same staging
// enqueue + drawer close that the legacy path uses.
async function renderSchemaDrivenCreate(
  kind: SpecKind,
  schemaKind: string,
  content: HTMLElement,
  onSuccess: () => void,
  opts: { prefill?: Record<string, unknown>; lockIdentifier?: boolean } = {},
): Promise<void> {
  // Loading placeholder while the schema fetch is in flight — the
  // first open per session waits one HTTP round-trip; subsequent
  // opens hit the cache.
  const loading = el("p", { className: "status-loading" }, "Loading schema…");
  content.appendChild(loading);
  let schema;
  try {
    schema = await fetchSchema(schemaKind);
  } catch (err) {
    loading.remove();
    content.appendChild(el("p", { className: "panel-error" },
      `Schema for ${schemaKind} unavailable: ${formatErrorBrief(err)}`));
    return;
  }
  loading.remove();

  // Per-field UX overrides — schema gives shape, newtcon decides UX.
  // For ipvpns / macvpns the smart-default integer fields use the same
  // strategiesFor()/computePrefillForKind() machinery as the legacy
  // path so we share one bug surface.
  const overrides: Record<string, import("../../schema-form.js").SchemaFieldOverride> = {};
  // Smart next-available defaults only apply to a blank create — when the
  // override flow supplies a prefill, the base's values win, so skip them.
  if (strategiesFor(kind) && !opts.prefill) {
    const defaults = await computePrefillForKind(kind);
    for (const [name, value] of Object.entries(defaults)) {
      const v: string | number = typeof value === "number" ? value : String(value);
      overrides[name] = { smartDefault: () => v };
    }
  }
  // Override flow: lock the identifier to the base spec's name (prefilled),
  // so the operator can't accidentally retarget the override to another spec.
  if (opts.lockIdentifier) {
    const idField = schema.identifier || "name";
    overrides[idField] = { ...(overrides[idField] ?? {}), readOnly: true };
  }

  // Newtron prepends the identifier field (e.g. `name`) to `fields` as
  // a synthetic field with `immutable: true`. The schema-form renderer
  // emits an input for it like any other field, so we render the form
  // directly with no manual identifier injection.
  const formOpts: import("../../schema-form.js").SchemaFormOpts = { schema, overrides };
  if (opts.prefill) formOpts.prefill = opts.prefill;
  const { form, getValues, validate } = await renderSchemaForm(formOpts);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  // Create + Cancel pair, mirroring the edit form's .form-button-row.
  const buttons = el("div", { className: "form-button-row" });
  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Create");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(submitBtn);
  buttons.appendChild(cancelBtn);
  content.appendChild(buttons);

  // Cancel discards the unsubmitted form and closes the drawer. Unlike
  // the edit form (which returns to the read view) there's no prior
  // detail to fall back to, so just close.
  cancelBtn.addEventListener("click", () => {
    closeDetail();
  });

  submitBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      const values = getValues();
      // Identifier comes from the schema-rendered field (per newtron's
      // synthetic prepend). Fall back to other common identifier names
      // for kinds whose identifier isn't "name" (defensive — schema's
      // `identifier` field is the authoritative source).
      const idField = schema.identifier || "name";
      const name = String(values[idField] ?? "(unnamed)");
      enqueueSpecCreate(kind as StagingSpecKind, name, values);
      submitBtn.textContent = "Queued";
      const ok = el("p", { className: "form-success" }, "Added to pending changes (green). Click Save in the header to apply.");
      content.insertBefore(ok, buttons);
      onSuccess();
      setTimeout(() => { closeDetail(); }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
      errorOut.appendChild(el("p", { className: "panel-error" }, formatErrorBrief(err)));
    }
  });
}

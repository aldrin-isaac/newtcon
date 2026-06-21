// schema-form.ts — render a create form from newtron's schema metadata
// (newtron #240, including the universal-engine extension that adds
// `paths` / `identifier` / `parent_ref` / per-field validation hints).
//
// Drives labels + tooltips + types + required-ness from the schema so
// newtcon stops carrying a parallel hand-typed form definition for each
// authoring kind. Callers layer UX affordances (smart defaults,
// validators, autofill) via the `overrides` map — the schema tells us
// the SHAPE, newtcon decides the UX on top.
//
// Coverage (current slice):
//   string  → text input
//   int     → number input (step 1) + min/max attrs
//   float   → number input (step any)
//   bool    → checkbox
//   enum    → <select>
//   array   → comma-separated text input when item_type is a primitive
//             (string/int/float)
//   ref     → <select> populated from the referenced kind's list endpoint
//             (newtron's paths.list, mapped to newtcon's /api/ space)
//   object  → recursive nested sub-form (item_kind names the inner kind)
//
// Out of scope for this slice (renders a fallback placeholder):
//   array of item_kind — needed for FilterSpec.rules etc. — follow-up
//   map                — never seen in the 15 kinds yet

import {
  fetchSchema,
  type SchemaField,
  type SchemaMeta,
} from "./api/newtcon/schema.js";
import { apiFetch } from "./api/newtcon/_transport.js";
import { activeNetwork } from "./network-switcher.js";
import {
  evaluateRequiredWhen,
  formatRequiredWhen,
} from "./required-when.js";

/**
 * SchemaFieldOverride lets the caller layer UX on top of a single
 * schema field. Only the members the caller wants to change need to
 * be set.
 */
export interface SchemaFieldOverride {
  /** Default value used when the form prefill doesn't carry one.
   *  Sync function or async — async is awaited at field-build time. */
  smartDefault?: () => string | number | Promise<string | number>;
  /** Append to the field's placeholder. Empty string clears it. */
  placeholder?: string;
  /** Override the rendered label entirely (rare — usually keep schema's). */
  label?: string;
  /** Hide the field. Useful when newtcon adds a synthetic identifier
   *  field (e.g. `name`) and the schema's `name` overlaps. */
  hidden?: boolean;
}

export interface SchemaFormOpts {
  /** The fetched schema for the kind. */
  schema: SchemaMeta;
  /** Prefill values keyed by wire field name. Edit-mode uses this. */
  prefill?: Record<string, unknown>;
  /** Per-field UX overrides, keyed by wire field name. */
  overrides?: Record<string, SchemaFieldOverride>;
  /** Wire field names to skip rendering entirely. Synthetic
   *  identifier fields ("name") are typically inserted separately. */
  skipFields?: ReadonlySet<string>;
  /** True when this form is editing an existing spec. Fields with
   *  `immutable: true` (e.g. the identifier) render as read-only so
   *  the operator can see the value but can't change it through the
   *  update verb — newtron rejects identifier changes. */
  editMode?: boolean;
}

export interface SchemaFormResult {
  form: HTMLFormElement;
  /** Read the current field values keyed by wire field name. Empty
   *  optional strings drop out so the body shape matches what newtron
   *  expects (omitempty fields stay omitted). */
  getValues: () => Record<string, unknown>;
  /** HTML constraint validation. Surfaces the built-in browser
   *  per-field error bubble on the first invalid field. */
  validate: () => boolean;
}

/**
 * renderSchemaForm — pure DOM renderer. Returns the form element and
 * a value-reader closure. Does NOT mount the form anywhere; the caller
 * decides where to append it.
 */
export async function renderSchemaForm(
  opts: SchemaFormOpts,
): Promise<SchemaFormResult> {
  const form = document.createElement("form");
  form.className = "schema-form";

  const valueReaders = new Map<string, () => unknown>();
  const prefill = opts.prefill ?? {};
  const overrides = opts.overrides ?? {};
  const skip = opts.skipFields ?? new Set<string>();

  // Trackers for conditional-required fields. Populated alongside the
  // field rows; consulted by the form-change listener to re-evaluate
  // `required_when` against current values and toggle input.required.
  // Each tracker also carries the row's "required *" marker so the
  // visible label updates with the input state.
  interface RequiredWhenTracker {
    field: SchemaField;
    input: HTMLInputElement | HTMLSelectElement;
    labelEl: HTMLElement;
  }
  const trackers: RequiredWhenTracker[] = [];

  // Trackers for conditional-applicability fields (`applies_when`,
  // newtron #265). When a field's condition evaluates false the whole
  // row is hidden, its controls disabled (so HTML validation skips them
  // and they drop from submit), and its name added to `notApplicable`
  // so getValues omits it. Each tracker remembers each control's
  // original disabled state so re-applying doesn't clobber an
  // immutable/locked field.
  interface AppliesWhenTracker {
    field: SchemaField;
    row: HTMLElement;
    controls: Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
    origDisabled: boolean[];
  }
  const appliesTrackers: AppliesWhenTracker[] = [];
  const notApplicable = new Set<string>();

  const readAllValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, read] of valueReaders) out[name] = read();
    return out;
  };

  for (const field of opts.schema.fields) {
    if (skip.has(field.name)) continue;
    const override = overrides[field.name] ?? {};
    if (override.hidden) continue;

    // read_only fields (newtron #269) are computed/derived — newtron
    // returns them for display but rejects them on write. Render a
    // static display row (label + value) and register NO value reader,
    // so the field is never editable and never submitted.
    if (field.read_only) {
      form.appendChild(buildReadOnlyRow(field, prefill[field.name], override));
      continue;
    }

    const row = await buildFieldRow(field, prefill[field.name], override, !!opts.editMode);
    form.appendChild(row.row);
    valueReaders.set(field.name, row.read);

    // Conditional-applicability hookup (`applies_when`). Register a
    // tracker whenever the field declares the condition; the refresh
    // pass below hides + disables the row when it evaluates false.
    if (field.applies_when) {
      const controls = Array.from(
        row.row.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          "input, select, textarea",
        ),
      );
      appliesTrackers.push({
        field,
        row: row.row,
        controls,
        origDisabled: controls.map((c) => c.disabled),
      });
    }

    // Conditional-required hookup. Static required=true wins (no
    // toggling needed; the input is always required). Only register
    // a tracker when the schema declares required_when AND the
    // static required is false.
    if (field.required_when && !field.required) {
      const input = row.row.querySelector("input, select") as
        HTMLInputElement | HTMLSelectElement | null;
      const labelEl = row.row.querySelector(".schema-form-label") as HTMLElement | null;
      if (input && labelEl) {
        trackers.push({ field, input, labelEl });
        // Render the condition as inline help so the operator sees
        // *when* it becomes required, not just *that* it might.
        // Sits alongside any schema-provided description.
        const tip = document.createElement("p");
        tip.className = "schema-form-help schema-form-help--condition";
        tip.textContent = formatRequiredWhen(field.required_when, opts.schema.fields);
        if (tip.textContent !== "") {
          // Insert below any pre-existing description help line.
          row.row.appendChild(tip);
        }
      }
    }
  }

  // Re-evaluate every tracker against the current values. Toggles
  // input.required and updates the visible "*" marker on the label.
  // Called once on mount (in case prefill / smart-defaults already
  // satisfy a condition) and on every form-value change.
  const refreshConditionalRequired = (): void => {
    if (trackers.length === 0) return;
    const values = readAllValues();
    for (const t of trackers) {
      const req = evaluateRequiredWhen(t.field.required_when, values);
      t.input.required = req;
      // Strip a trailing " *" (if any) then re-append when required —
      // keeps the label in sync without re-rendering the row.
      const base = t.labelEl.textContent?.replace(/\s\*$/, "") ?? t.field.label;
      t.labelEl.textContent = req ? base + " *" : base;
    }
  };

  // Re-evaluate applicability. Hidden rows have their controls disabled
  // (barred from HTML validation + dropped from submit) and their names
  // collected in `notApplicable` so getValues omits them. The
  // `applies_when` tree reuses the required_when evaluator — same
  // grammar, same sibling-scoped semantics.
  const refreshApplicability = (): void => {
    if (appliesTrackers.length === 0) return;
    const values = readAllValues();
    for (const t of appliesTrackers) {
      const applies = evaluateRequiredWhen(t.field.applies_when, values);
      // `hidden` reflects to the content attribute; CSS rule
      // `.schema-form-row[hidden]` forces display:none over the row's
      // own display:flex.
      t.row.hidden = !applies;
      t.controls.forEach((c, i) => {
        c.disabled = applies ? t.origDisabled[i]! : true;
      });
      if (applies) notApplicable.delete(t.field.name);
      else notApplicable.add(t.field.name);
    }
  };

  // Applicability first (it gates requiredness — a hidden field must not
  // also carry a required mark), then required.
  refreshApplicability();
  refreshConditionalRequired();

  // Single listener at the form level — input bubbles from every
  // input/select inside, so we don't need per-input wiring.
  if (trackers.length > 0 || appliesTrackers.length > 0) {
    const onChange = (): void => { refreshApplicability(); refreshConditionalRequired(); };
    form.addEventListener("input", onChange);
    form.addEventListener("change", onChange);
  }

  return {
    form,
    getValues() {
      const out: Record<string, unknown> = {};
      for (const [name, read] of valueReaders) {
        // A field whose `applies_when` is currently false doesn't apply
        // to the chosen shape — omit it so newtron isn't sent stale
        // BGP fields for a static service, etc.
        if (notApplicable.has(name)) continue;
        const v = read();
        if (v === "" || v === undefined) continue;
        if (typeof v === "object" && v !== null && Object.keys(v as object).length === 0) continue;
        out[name] = v;
      }
      return out;
    },
    validate() {
      return form.reportValidity();
    },
  };
}

interface FieldRowResult {
  row: HTMLElement;
  read: () => unknown;
}

// buildReadOnlyRow renders a derived/computed field (read_only, newtron
// #269) as a static label + value — a disabled input so it reads like
// the rest of the form but can't be edited. No value reader is
// registered for it, so it never reaches getValues / the wire. When the
// prefill carries no value (e.g. a create form before the deriving field
// is filled), shows an em-dash placeholder.
function buildReadOnlyRow(
  field: SchemaField,
  prefill: unknown,
  override: SchemaFieldOverride,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "schema-form-row schema-form-row--readonly";

  const labelEl = document.createElement("label");
  labelEl.className = "schema-form-label";
  labelEl.textContent = override.label ?? field.label;
  row.appendChild(labelEl);

  if (field.description && field.description !== "") {
    const help = document.createElement("p");
    help.className = "schema-form-help";
    help.textContent = field.description;
    row.appendChild(help);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "schema-form-input schema-form-input--readonly";
  input.disabled = true;
  const val = prefill === undefined || prefill === null ? "" : String(prefill);
  if (val !== "") input.value = val;
  else input.placeholder = "— derived —";
  row.appendChild(input);
  return row;
}

async function buildFieldRow(
  field: SchemaField,
  prefill: unknown,
  override: SchemaFieldOverride,
  editMode: boolean,
): Promise<FieldRowResult> {
  const row = document.createElement("div");
  row.className = "schema-form-row";

  const labelText = override.label ?? field.label;
  const labelEl = document.createElement("label");
  labelEl.className = "schema-form-label";
  labelEl.textContent = labelText + (field.required ? " *" : "");
  row.appendChild(labelEl);

  if (field.description && field.description !== "") {
    const help = document.createElement("p");
    help.className = "schema-form-help";
    help.textContent = field.description;
    row.appendChild(help);
  }

  let defaultValue: string | number = "";
  if (prefill !== undefined && prefill !== null && typeof prefill !== "object") {
    defaultValue = typeof prefill === "number" ? prefill : String(prefill);
  } else if (override.smartDefault) {
    try {
      defaultValue = await override.smartDefault();
    } catch { /* swallow — operator can fill it in */ }
  }

  // editMode + field.immutable → render as read-only. Newtron rejects
  // identifier changes (and any other immutable field) via the update
  // verb, so locking the input prevents the operator from submitting
  // a doomed request. Read still returns the value so the body keeps
  // it (newtron may require it; newtcon-server reconciles with URL).
  const lockField = editMode && !!field.immutable;
  let read: () => unknown;

  switch (field.type) {
    case "string": {
      const input = document.createElement("input");
      input.type = "text";
      input.name = field.name;
      input.className = "schema-form-input" + (lockField ? " schema-form-input--readonly" : "");
      if (field.required) input.required = true;
      if (field.pattern && patternIsBrowserSafe(field.pattern)) input.pattern = field.pattern;
      if (override.placeholder !== undefined) input.placeholder = override.placeholder;
      if (defaultValue !== "") input.value = String(defaultValue);
      if (lockField) input.readOnly = true;
      row.appendChild(input);
      read = () => input.value.trim();
      break;
    }
    case "int":
    case "float": {
      const input = document.createElement("input");
      input.type = "number";
      input.name = field.name;
      input.className = "schema-form-input" + (lockField ? " schema-form-input--readonly" : "");
      input.step = field.type === "int" ? "1" : "any";
      if (field.required) input.required = true;
      if (typeof field.min === "number") input.min = String(field.min);
      if (typeof field.max === "number") input.max = String(field.max);
      if (override.placeholder !== undefined) input.placeholder = override.placeholder;
      if (defaultValue !== "") input.value = String(defaultValue);
      if (lockField) input.readOnly = true;
      row.appendChild(input);
      read = () => {
        const v = input.value.trim();
        if (v === "") return "";
        const n = field.type === "int" ? parseInt(v, 10) : parseFloat(v);
        return Number.isNaN(n) ? "" : n;
      };
      break;
    }
    case "bool": {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = field.name;
      input.className = "schema-form-checkbox";
      if (prefill === true || prefill === "true" || prefill === 1) {
        input.checked = true;
      }
      if (lockField) input.disabled = true;
      row.appendChild(input);
      read = () => input.checked;
      break;
    }
    case "enum": {
      const select = document.createElement("select");
      select.name = field.name;
      select.className = "schema-form-input" + (lockField ? " schema-form-input--readonly" : "");
      if (field.required) select.required = true;
      if (!field.required) {
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "—";
        select.appendChild(blank);
      }
      for (const opt of field.enum ?? []) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        if (String(defaultValue) === opt) o.selected = true;
        select.appendChild(o);
      }
      // Set select.value explicitly after options exist so the read
      // closure returns the prefilled value immediately — needed for
      // applies_when/required_when mount-time evaluation, where a
      // sibling enum is the discriminator (a real browser links
      // option.selected → select.value, but setting it directly is
      // robust and shim-friendly).
      if (defaultValue !== "") select.value = String(defaultValue);
      // <select> has no readOnly; disabled drops it from submit but
      // we capture the value via the read closure regardless.
      if (lockField) select.disabled = true;
      row.appendChild(select);
      read = () => select.value;
      break;
    }
    case "ref": {
      // Fetch the referenced kind's schema → use its paths.list to load
      // available names, render as a dropdown. ref_kind is required by
      // the spec; defensive fallback to disabled if missing.
      const result = await buildRefSelect(field, defaultValue);
      row.appendChild(result.input);
      read = result.read;
      break;
    }
    case "object": {
      // Recurse: fetch the inner kind's schema, build a nested form
      // visually grouped under the parent label. Read combines the
      // nested form's values into one object.
      if (!field.item_kind) {
        row.appendChild(disabledPlaceholder("object without item_kind"));
        read = () => "";
        break;
      }
      const nested = await renderNested(field.item_kind, prefill);
      row.appendChild(nested.container);
      read = () => nested.getValues();
      break;
    }
    case "array": {
      // Primitive arrays render as a comma-separated input. Arrays of
      // item_kind objects are NOT authored inline here: the renderer
      // doesn't support repeatable nested sub-forms yet. Surface the
      // limitation explicitly so the operator knows the field exists,
      // what newtron expects, and that submitting empty creates the
      // spec with no entries.
      if (field.item_kind) {
        const requiredMark = field.required ? " (required by newtron — empty array will be rejected)" : "";
        row.appendChild(unsupportedNotice(
          `array of ${field.item_kind}`,
          `Inline editing of object arrays is not yet supported in newtcon. Submit sends an empty array${requiredMark}.`,
        ));
        read = () => "";
        break;
      }
      const input = document.createElement("input");
      input.type = "text";
      input.name = field.name;
      input.className = "schema-form-input";
      if (field.required) input.required = true;
      input.placeholder = override.placeholder ??
        `comma-separated ${field.item_type ?? "value"}s`;
      if (Array.isArray(prefill)) input.value = prefill.map(String).join(", ");
      row.appendChild(input);
      read = () => {
        const parts = input.value.split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (parts.length === 0) return "";
        if (field.item_type === "int") {
          return parts.map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
        }
        if (field.item_type === "float") {
          return parts.map((s) => parseFloat(s)).filter((n) => !Number.isNaN(n));
        }
        return parts;
      };
      break;
    }
    case "map": {
      // Map fields (e.g. DeviceProfile / ZoneSpec scoped overrides:
      // `filters: map of FilterSpec`). Authoring maps requires a
      // dedicated key-and-value UI the renderer doesn't have yet.
      // Surface the limitation: name what newtron expects, what
      // happens on submit, and whether it's a hard failure.
      const valueDesc = field.item_kind ?? field.item_type ?? "value";
      const requiredMark = field.required ? " (required by newtron — empty map will be rejected)" : "";
      row.appendChild(unsupportedNotice(
        `map of ${valueDesc}`,
        `Inline editing of maps is not yet supported in newtcon. Submit sends an empty map${requiredMark}.`,
      ));
      read = () => "";
      break;
    }
    default: {
      const requiredMark = field.required ? " — required by newtron, expect a 400 on submit" : "";
      row.appendChild(unsupportedNotice(
        field.type,
        `Field type "${field.type}" is not yet supported by the schema-form renderer. The field will be omitted from the request${requiredMark}.`,
      ));
      read = () => "";
      break;
    }
  }

  return { row, read };
}

// ─── ref dropdown ──────────────────────────────────────────────────

interface RefSelectResult {
  input: HTMLElement;
  read: () => string;
}

async function buildRefSelect(
  field: SchemaField,
  defaultValue: string | number,
): Promise<RefSelectResult> {
  if (!field.ref_kind) {
    return {
      input: disabledPlaceholder("ref without ref_kind"),
      read: () => "",
    };
  }
  const select = document.createElement("select");
  select.name = field.name;
  select.className = "schema-form-input";
  if (field.required) select.required = true;

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = field.required ? "— select —" : "—";
  select.appendChild(blank);

  // Append a loading placeholder so the field communicates "fetching"
  // while the list call is in flight. Replaced once names land.
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "loading…";
  loading.disabled = true;
  loading.selected = true;
  select.appendChild(loading);

  // Async-fetch names without blocking the form render. If the fetch
  // fails (no list path, network error), keep the dropdown empty so
  // the operator can see something's off; required-field validation
  // will block submission cleanly.
  void (async () => {
    try {
      const names = await fetchRefNames(field.ref_kind!);
      loading.remove();
      blank.selected = true;
      for (const name of names) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name;
        if (String(defaultValue) === name) o.selected = true;
        select.appendChild(o);
      }
    } catch {
      loading.textContent = `(list unavailable for ${field.ref_kind})`;
    }
  })();

  return {
    input: select,
    read: () => select.value,
  };
}

/**
 * fetchRefNames — for a ref kind, fetch its schema (cached) to learn
 * paths.list, then GET the list and return the names. Newtron's path
 * uses the `/newtron/v1/` prefix; newtcon-server exposes the same
 * surface under `/api/`, so we substitute.
 */
async function fetchRefNames(refKind: string): Promise<string[]> {
  const meta = await fetchSchema(refKind);
  const newtronListPath = meta.paths?.list;
  if (!newtronListPath) return [];
  const path = newtronListPath
    .replace(/^\/newtron\/v1\//, "/api/")
    .replace("{netID}", encodeURIComponent(activeNetwork()));
  const body = (await apiFetch(path, { cache: "no-store" })) as
    | { names?: string[] | null; services?: { name?: string }[] }
    | null;
  // List endpoints return either {names: [...]} or, for services,
  // {services: [{name, type, ...}, ...]}.
  if (Array.isArray(body?.names)) return body!.names!;
  if (Array.isArray(body?.services)) return body!.services!.map((s) => s.name ?? "").filter((n) => n !== "");
  return [];
}

// ─── nested object ─────────────────────────────────────────────────

interface NestedResult {
  container: HTMLElement;
  getValues: () => Record<string, unknown>;
}

async function renderNested(
  itemKind: string,
  prefill: unknown,
): Promise<NestedResult> {
  const container = document.createElement("fieldset");
  container.className = "schema-form-nested";

  try {
    const innerSchema = await fetchSchema(itemKind);
    const innerPrefill = (typeof prefill === "object" && prefill !== null)
      ? prefill as Record<string, unknown>
      : {};
    const inner = await renderSchemaForm({
      schema: innerSchema,
      prefill: innerPrefill,
    });
    container.appendChild(inner.form);
    return { container, getValues: inner.getValues };
  } catch (err) {
    container.appendChild(disabledPlaceholder(
      `(${itemKind} schema unavailable)`,
    ));
    return { container, getValues: () => ({}) };
  }
}

// ─── shared helpers ────────────────────────────────────────────────

// The HTML `pattern` attribute compiles with the `v` (unicodeSets) flag
// where the runtime supports it (current Chrome/Firefox/Safari), else
// `u`. Probe once so patternIsBrowserSafe tests against the exact flag
// the browser will use.
const PATTERN_FLAG: "v" | "u" = (() => {
  try { new RegExp("a", "v"); return "v"; } catch { return "u"; }
})();

// patternIsBrowserSafe — true when `p` compiles under the flag the HTML
// `pattern` attribute uses. `v` is stricter than `u`: some regexes
// newtron ships — valid as RE2 / under `u` — throw under `v` (e.g. an
// unescaped `-` in `[A-Za-z0-9_-]`). Setting such a value makes the
// browser log an error and silently ignore the constraint, so we skip
// applying it. Server-side validation still enforces the real rule; we
// just forgo the client-side hint for that one field.
function patternIsBrowserSafe(p: string): boolean {
  try {
    new RegExp(p, PATTERN_FLAG);
    return true;
  } catch {
    return false;
  }
}

function disabledPlaceholder(message: string): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "schema-form-input schema-form-input--unsupported";
  input.disabled = true;
  input.placeholder = message;
  return input;
}

/**
 * unsupportedNotice — visible callout that newtcon doesn't yet author
 * this field shape, naming what newtron expects so the operator can
 * decide whether to proceed or work around. Replaces silent disabled
 * inputs for limitations that affect what actually gets submitted.
 */
function unsupportedNotice(shapeDesc: string, detail: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "schema-form-notice schema-form-notice--unsupported";
  const head = document.createElement("strong");
  head.className = "schema-form-notice-head";
  head.textContent = `Not authorable here: ${shapeDesc}`;
  const body = document.createElement("p");
  body.className = "schema-form-notice-body";
  body.textContent = detail;
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

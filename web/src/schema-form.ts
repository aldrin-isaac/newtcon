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

  for (const field of opts.schema.fields) {
    if (skip.has(field.name)) continue;
    const override = overrides[field.name] ?? {};
    if (override.hidden) continue;
    const row = await buildFieldRow(field, prefill[field.name], override);
    form.appendChild(row.row);
    valueReaders.set(field.name, row.read);
  }

  return {
    form,
    getValues() {
      const out: Record<string, unknown> = {};
      for (const [name, read] of valueReaders) {
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

async function buildFieldRow(
  field: SchemaField,
  prefill: unknown,
  override: SchemaFieldOverride,
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

  let read: () => unknown;

  switch (field.type) {
    case "string": {
      const input = document.createElement("input");
      input.type = "text";
      input.name = field.name;
      input.className = "schema-form-input";
      if (field.required) input.required = true;
      if (field.pattern) input.pattern = field.pattern;
      if (override.placeholder !== undefined) input.placeholder = override.placeholder;
      if (defaultValue !== "") input.value = String(defaultValue);
      row.appendChild(input);
      read = () => input.value.trim();
      break;
    }
    case "int":
    case "float": {
      const input = document.createElement("input");
      input.type = "number";
      input.name = field.name;
      input.className = "schema-form-input";
      input.step = field.type === "int" ? "1" : "any";
      if (field.required) input.required = true;
      if (typeof field.min === "number") input.min = String(field.min);
      if (typeof field.max === "number") input.max = String(field.max);
      if (override.placeholder !== undefined) input.placeholder = override.placeholder;
      if (defaultValue !== "") input.value = String(defaultValue);
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
      row.appendChild(input);
      read = () => input.checked;
      break;
    }
    case "enum": {
      const select = document.createElement("select");
      select.name = field.name;
      select.className = "schema-form-input";
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
      // objects (item_kind set) are out of scope for this slice and
      // render the placeholder.
      if (field.item_kind) {
        row.appendChild(disabledPlaceholder("array of objects not yet authorable"));
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
    case "map":
    default: {
      row.appendChild(disabledPlaceholder(`${field.type} fields not yet authorable in this form`));
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

function disabledPlaceholder(message: string): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "schema-form-input schema-form-input--unsupported";
  input.disabled = true;
  input.placeholder = message;
  return input;
}

// schema-form.ts — render a create form from newtron's schema metadata.
//
// Drives labels + tooltips + types + required-ness from the schema so
// newtcon stops carrying a parallel hand-typed form definition for each
// authoring kind. Callers layer UX affordances (smart defaults,
// validators, autofill) via the `overrides` map — the schema tells us
// the SHAPE, newtcon decides the UX on top.
//
// The renderer returns a `{form, getValues, validate}` shape compatible
// with the existing `buildFormFields` flow in app.ts so the conversion
// per kind stays local to a single call site.
//
// Coverage in this slice:
//   string  → text input
//   int     → number input (step 1)
//   float   → number input (step any)
//   bool    → checkbox
//   enum    → <select>
//   array   → comma-separated text input when item_type is a primitive
//             (string/int/float). Renders one row per item on read.
//
// Out of scope for this slice (renders a fallback placeholder + logs):
//   ref     → list-of-names dropdown (needs the kind→list-path map)
//   object  → nested sub-form (needs recursive renderSchemaForm)
//   map     → never seen in the 14 kinds yet
//
// Follow-up PRs add ref + object as we convert the kinds that need them.

import type { SchemaField, SchemaMeta } from "./api/newtcon/schema.js";

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

  // Tooltip — render `description` as an inline help line so the
  // operator sees what the field means without hovering.
  if (field.description && field.description !== "") {
    const help = document.createElement("p");
    help.className = "schema-form-help";
    help.textContent = field.description;
    row.appendChild(help);
  }

  // Default value: prefill > schema default > smartDefault override > "".
  let defaultValue: string | number = "";
  if (prefill !== undefined && prefill !== null) {
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
      // bool prefill arrives via the prefill map (top-level path), not
      // via the defaultValue branch which is string|number. Look at
      // the raw prefill so a stored `true` checks the box.
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
    case "array": {
      // Primitive arrays render as a comma-separated input. One row
      // per item is friendlier UX but a heavier slice; this matches
      // newtcon's existing pattern for ad-hoc primitive arrays.
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
    case "ref":
    case "object":
    case "map":
    default: {
      // Out of scope for this slice — render a disabled placeholder
      // so the operator sees that the field exists but knows it
      // isn't authorable here yet. JSON textarea would be the most
      // honest fallback (operator can edit raw); start with a
      // disabled input so we don't quietly accept malformed data.
      const input = document.createElement("input");
      input.type = "text";
      input.name = field.name;
      input.className = "schema-form-input schema-form-input--unsupported";
      input.disabled = true;
      input.placeholder = `${field.type} fields not yet authorable in this form`;
      row.appendChild(input);
      read = () => "";
      break;
    }
  }

  return { row, read };
}

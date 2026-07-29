// views/specs/fields.ts — the hand-typed form-field vocabulary: FieldDef, the
// shared input PATTERNS, the specForms fallback map, and buildFormFields (the
// DOM builder that turns FieldDefs into a form).
//
// This is the LEGACY authoring path. Every kind newtron describes goes through
// the schema-driven renderer (schema-form.ts) instead; these definitions are
// the safety net for schema-orphan kinds, plus the shape sub-rule add/edit
// forms still use (subrules.ts).

import { type SpecKind } from "../../api/newtcon/network.js";
import { el } from "../../dom.js";

// ---- Form field definitions per spec type ----------------------------------
// Each field definition describes one HTML input in the "Add" form drawer.

export interface FieldDef {
  name: string;        // JSON field name sent to newtron
  label: string;       // Operator-visible label (domain language)
  type: "text" | "number" | "select";
  required?: boolean;
  options?: string[];  // for type "select"
  placeholder?: string;

  // Numeric bounds — rendered as input[min] / input[max] HTML attributes;
  // the browser's native constraint UI fires on form.reportValidity() at
  // submit time. Use for fields with well-known wire-shape bounds (VLAN
  // ID 1-4094, ASN 1-4294967295, L3 VNI 1-16777215, etc.).
  min?: number;
  max?: number;

  // Contextual help — one short sentence explaining what the field means
  // when the label alone isn't enough (e.g. "L3 VNI" → "24-bit VXLAN ID
  // for routed traffic; unique per IPVPN"). Rendered as a "?" affordance
  // next to the label that toggles an inline help line.
  help?: string;

  // Regex source string for input[pattern]. The browser enforces it when
  // form.reportValidity() runs. patternTitle becomes the input[title]
  // attribute which the browser surfaces as the per-field error bubble
  // ("must look like …") rather than the default "Please match the
  // requested format." Only meaningful for type="text".
  pattern?: string;
  patternTitle?: string;
}

// PATTERNS — named regex sources for fields that share a constraint.
// Each is a string (HTML pattern attribute), not a RegExp literal, so it
// flows verbatim into the input[pattern] attr.
//
// Deliberately permissive: catch typos (commas, missing digits, dashes
// where dots belong) without rejecting valid edge cases. The substrate
// is authoritative for range / semantic checks — these patterns are the
// first-line filter that saves a backend round-trip on obvious wrong
// shapes.
//
//   IPV4         — single IPv4 address (no CIDR). No 0–255 enforcement.
//   IPV4_CIDR    — IPv4 address with optional /prefix. Prefix range not enforced.
//   MAC          — six octets, colon- or dash-separated, hex.
//
// IPv6 deferred: a single permissive regex that accepts every valid form
// (compressed, dual, zone-id) is too gnarly; field-level help nudges
// operators toward correctness, and the substrate validates.
export const PATTERNS = {
  IPV4: String.raw`^(\d{1,3}\.){3}\d{1,3}$`,
  IPV4_CIDR: String.raw`^(\d{1,3}\.){3}\d{1,3}(/\d{1,2})?$`,
  MAC: String.raw`^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$`,
} as const;

// specForms maps each SpecKind to the form fields needed to create that spec.
// Field names and types are taken verbatim from the newtron request types in
// pkg/newtron/types.go (CreateServiceRequest, CreateIPVPNRequest, etc.).
//
// NOTE: this schema drives the CREATE form. The DETAIL-display layout uses
// `displaySchemaFor(kind)` (below) which defaults to this schema but
// overrides where newtron's GET-detail wire shape diverges from the create
// request shape (e.g., services: "service_type" on detail, "type" on create).
// specForms is now a tiny fallback for kinds newtron's schema endpoint
// doesn't yet describe. The schema-driven dispatch (resolveSlugToKind
// → fetchSchema → renderSchemaForm) covers every authoring kind newtron
// registers; this map exists only as a safety net for schema-orphan
// kinds that newtron may register without metadata in the future.
//
// Empty as of newtron #242 — every registered kind has a schema. The
// fallback path stays wired (legacyCreateForm / legacyEditForm) so the
// system degrades gracefully when newtron-schema is unreachable or a
// future kind ships without metadata.
export const specForms: Partial<Record<SpecKind, FieldDef[]>> = {};

// displaySchemaFor returns the legacy hand-typed display schema for a
// spec kind. Schema-driven kinds bypass this entirely (renderSpecDetailInto
// is called directly with the schema fields). This fallback only fires
// for schema-orphan kinds (prefix-lists today).
export function displaySchemaFor(kind: SpecKind): FieldDef[] | undefined {
  return specForms[kind];
}

// isEditableKind returns true when a spec kind has any top-level field
// beyond the identifier — those are the kinds where the Edit button shows
// up in the detail drawer. For schema-driven kinds this resolves async
// via the schema; the synchronous fallback below covers schema-orphan
// kinds via specForms.
export function isEditableKind(kind: SpecKind): boolean {
  const fields = specForms[kind];
  if (!fields) {
    // Kinds backed by a schema (every kind newtron describes) — Edit
    // button is reasonable to show by default. The edit flow itself
    // resolves the schema and renders fields; if no editable fields
    // exist, the form will just contain the identifier.
    return true;
  }
  return fields.some((f) => f.name !== "name");
}

// prefillFromDetail copies the GET-detail wire shape into the legacy
// edit form's field map. Schema-driven kinds use renderSchemaForm's
// own prefill option (passes the entire detail object verbatim). This
// helper exists only for the legacy fallback path (schema-orphan kinds).
export function prefillFromDetail(_kind: SpecKind, detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  return { ...detail as Record<string, unknown> };
}

// FormOptions controls how buildFormFields renders + reads values.
//   prefill — initial values, keyed by FieldDef.name. Used by edit mode to
//             populate the form from the current spec detail.
//   excludeNames — fields to skip rendering entirely (e.g. "name" in edit
//                  mode — identifier can't be changed via update-X; the
//                  drawer header still shows it).
export interface FormOptions {
  prefill?: Record<string, unknown>;
  excludeNames?: string[];
}

// buildFormFields renders input elements for each field definition.
export function buildFormFields(fields: FieldDef[], opts: FormOptions = {}): {
  form: HTMLFormElement;
  getValues: () => Record<string, unknown>;
  // validate runs the browser's native constraint UI (required, min, max,
  // pattern) and returns true iff every field passes. Save / Add handlers
  // should call this before getValues() so the operator sees the
  // browser's per-field "must be N–M" message rather than a backend
  // round-trip failure.
  validate: () => boolean;
} {
  const form = el("form", { className: "vform vform--roomy spec-form" });
  const prefill = opts.prefill ?? {};
  const exclude = new Set(opts.excludeNames ?? []);
  const renderFields = fields.filter((f) => !exclude.has(f.name));

  form.addEventListener("submit", (e) => e.preventDefault());

  for (const field of renderFields) {
    const group = el("div", { className: "form-group" });
    const labelRow = el("div", { className: "form-label-row" });
    const label = el("label", { className: "form-label" }, field.label);
    if (field.required) {
      label.appendChild(el("span", { className: "form-required" }, " *"));
    }
    label.setAttribute("for", "field-" + field.name);
    labelRow.appendChild(label);

    // Help affordance — "?" icon → click toggles the inline help line.
    // Click here doesn't blur the field, so the operator can read help
    // mid-typing without losing place.
    let helpEl: HTMLElement | null = null;
    if (field.help) {
      const helpBtn = el("button", {
        type: "button",
        className: "form-help-btn",
        title: "Show help",
      }, "?") as HTMLButtonElement;
      helpEl = el("p", { className: "form-help-text" }, field.help);
      helpEl.hidden = true;
      helpBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (helpEl) helpEl.hidden = !helpEl.hidden;
      });
      labelRow.appendChild(helpBtn);
    }
    group.appendChild(labelRow);

    const prefillStr = field.name in prefill && prefill[field.name] != null
      ? String(prefill[field.name])
      : "";

    if (field.type === "select" && field.options) {
      const select = el("select", { className: "form-control", id: "field-" + field.name, name: field.name }) as HTMLSelectElement;
      if (!field.required) {
        select.appendChild(el("option", { value: "" }, "— optional —") as HTMLOptionElement);
      }
      for (const opt of field.options) {
        const o = el("option", { value: opt }, opt) as HTMLOptionElement;
        if (opt === prefillStr) o.selected = true;
        select.appendChild(o);
      }
      group.appendChild(select);
    } else {
      const input = el("input", {
        className: "form-control",
        id: "field-" + field.name,
        name: field.name,
        type: field.type === "number" ? "number" : "text",
        placeholder: field.placeholder ?? "",
      }) as HTMLInputElement;
      if (field.required) input.required = true;
      if (field.type === "number") {
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
      }
      if (field.type === "text" && field.pattern) {
        input.pattern = field.pattern;
        // title becomes the browser's per-field invalid-bubble text.
        if (field.patternTitle) input.title = field.patternTitle;
      }
      if (prefillStr) input.value = prefillStr;
      group.appendChild(input);
    }

    if (helpEl) group.appendChild(helpEl);

    form.appendChild(group);
  }

  const getValues = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const field of renderFields) {
      const el2 = form.querySelector(`#field-${field.name}`) as HTMLInputElement | HTMLSelectElement | null;
      if (!el2) continue;
      const raw = el2.value.trim();
      if (!raw && !field.required) continue;
      if (field.type === "number") {
        const n = Number(raw);
        if (!isNaN(n)) values[field.name] = n;
      } else {
        if (raw) values[field.name] = raw;
      }
    }
    return values;
  };

  return { form, getValues, validate: () => form.reportValidity() };
}

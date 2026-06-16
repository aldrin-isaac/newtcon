// form-error-binding.ts — turn newtron's validation_failure errors into
// per-field UI feedback.
//
// Today the Save handlers catch ApiError and render "permission denied: …"
// or similar via formatErrorBrief into the form's bottom error-out box.
// For validation failures specifically the operator wants the error
// attached to the field that's wrong — not a sentence at the bottom of
// the form mentioning a field they then have to find by eye.
//
// Newtron emits validation errors in a canonical shape:
//
//   {"error": "validation error: <field>: <detail>"}
//
// The handler wraps it as KindValidationFailure with the raw body in
// details.underlying_error_message. This module:
//
//   - extractFieldFromValidationError(s)  — pure parser, testable in isolation
//   - attachServerValidationToForm(form, err) — pulls underlying_error_message,
//                                                parses, attaches to the field
//   - attachFieldError(form, field, msg)  — DOM mutation
//   - clearFieldErrors(form)              — wipe previous errors before retry

import { ApiError } from "./api/newtcon/services.js";

/**
 * extractFieldFromValidationError pulls a field name + cleaned message out
 * of a newtron-style validation error string. Returns {field: null,
 * cleaned: <input>} when no recognised pattern matches; the caller falls
 * back to rendering the original message inline.
 *
 * Patterns tried, in order:
 *
 *   1. "validation error: <field>: <detail>"   ← newtron's canonical
 *   2. "<field>: <detail>"                     ← stripped envelope variants
 *   3. "<field> is required" / "<field> must …" / "<field> cannot …"
 */
export function extractFieldFromValidationError(message: string): {
  field: string | null;
  cleaned: string;
} {
  // Strip a JSON wrapper if present: '{"error":"validation error: …"}'.
  let inner = message;
  if (inner.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed.error === "string") inner = parsed.error;
    } catch { /* fall through with the original string */ }
  }

  // Newtron canonical: "validation error: <field>: <detail>"
  let m = /^validation error:\s+([a-z][a-z0-9_]*)\s*:\s*(.+)$/i.exec(inner);
  if (m) return { field: m[1], cleaned: m[2] };

  // Bare "<field>: <detail>" — field name is the strict snake_case form
  // so accidental prefixes ("QoS policy 'X' not found") don't match.
  m = /^([a-z][a-z0-9_]*)\s*:\s*(.+)$/.exec(inner);
  if (m) return { field: m[1], cleaned: m[2] };

  // "<field> is required" / "<field> must …" / "<field> cannot …"
  m = /^([a-z][a-z0-9_]*)\s+(is required|must\s+.+|cannot\s+.+)$/i.exec(inner);
  if (m) return { field: m[1], cleaned: m[2] };

  return { field: null, cleaned: inner };
}

/**
 * attachServerValidationToForm inspects err. If it's an ApiError with
 * kind "validation_failure" AND the underlying message names a field the
 * form contains, the error attaches to that field's group and the
 * function returns true. Otherwise returns false so the caller can fall
 * back to the form's general error-out.
 */
export function attachServerValidationToForm(form: HTMLFormElement, err: unknown): boolean {
  if (!(err instanceof ApiError) || err.kind !== "validation_failure") return false;
  const raw = typeof err.details?.["underlying_error_message"] === "string"
    ? (err.details["underlying_error_message"] as string)
    : err.message;
  const { field, cleaned } = extractFieldFromValidationError(raw);
  if (!field) return false;
  return attachFieldError(form, field, cleaned);
}

/**
 * attachFieldError installs a per-field error line under the matching
 * input and marks the input aria-invalid. Returns false if the form has
 * no input named `field` — the caller surfaces the error generically.
 */
export function attachFieldError(form: HTMLFormElement, field: string, message: string): boolean {
  const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`#field-${CSS.escape(field)}`);
  if (!input) return false;
  const group = input.closest<HTMLElement>(".form-group");
  if (!group) return false;
  // Replace any existing field-error for this group so retries don't stack.
  group.querySelectorAll(".form-field-error").forEach((el) => el.remove());
  const err = document.createElement("p");
  err.className = "form-field-error";
  err.textContent = message;
  group.appendChild(err);
  input.setAttribute("aria-invalid", "true");
  return true;
}

/**
 * clearFieldErrors wipes every per-field error line and aria-invalid mark
 * on the form. Call at the top of each Save / Submit attempt so stale
 * errors from a previous attempt don't linger.
 */
export function clearFieldErrors(form: HTMLFormElement): void {
  form.querySelectorAll(".form-field-error").forEach((el) => el.remove());
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
}

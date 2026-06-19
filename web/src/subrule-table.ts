// subrule-table.ts — pure helpers backing the unified sub-rule table
// (slice #173.A). The Specs drawer previously rendered child rules
// across two sections — "Existing X" + a separate collapsed "Add X"
// form — for every kind that carries sub-rules (qos-policies queues,
// filters rules, prefix-lists entries, route-policies rules). This
// module supplies the per-row data extraction + key lookup that the
// new single-section table renderer in app.ts uses.

export type SubRuleItemType = "object" | "string";

export interface SubRuleColumn {
  /** Wire field on the item object. Ignored when itemType is "string". */
  field: string;
  /** Column header. */
  label: string;
}

/**
 * getSubRuleItems pulls the items array off a spec-detail payload by
 * its wire field name. Returns [] when the field is missing or not an
 * array — both are valid "no items" states.
 */
export function getSubRuleItems(detail: unknown, wireField: string): unknown[] {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
  const v = (detail as Record<string, unknown>)[wireField];
  return Array.isArray(v) ? v : [];
}

/**
 * extractRowCells returns the per-column string values for one item.
 *
 *   itemType "string": the item itself is the value — returns one cell
 *                      with the string. (prefix-lists case.)
 *   itemType "object": looks up each column's field on the item;
 *                      missing / null / "" render as "" so the row
 *                      renderer can show an em-dash placeholder.
 */
export function extractRowCells(
  item: unknown,
  columns: readonly SubRuleColumn[],
  itemType: SubRuleItemType,
): string[] {
  if (itemType === "string") {
    return [typeof item === "string" ? item : String(item)];
  }
  if (!item || typeof item !== "object") return columns.map(() => "");
  const obj = item as Record<string, unknown>;
  return columns.map((c) => {
    const v = obj[c.field];
    if (v === undefined || v === null || v === "") return "";
    return String(v);
  });
}

/**
 * itemKey resolves the identifier used to delete an item. For string
 * items the item IS the key; for object items it pulls `keyField`.
 * Returns null when the key can't be determined — the renderer should
 * suppress the delete button rather than build a URL with `undefined`.
 */
export function itemKey(
  item: unknown,
  itemType: SubRuleItemType,
  keyField?: string,
): string | number | null {
  if (itemType === "string") return typeof item === "string" ? item : null;
  if (!item || typeof item !== "object") return null;
  if (!keyField) return null;
  const v = (item as Record<string, unknown>)[keyField];
  if (typeof v === "string" || typeof v === "number") return v;
  return null;
}

/**
 * computeReorderSeq (slice #173.C) — given the sorted seq list of the
 * current rows and the seq of the row the operator wants to move,
 * returns the target `new_seq` value that puts that row immediately
 * BEFORE / AFTER its neighbour.
 *
 * Strategy: midpoint-of-gap. With the common operator convention of
 * gappy seqs (10, 20, 30), there's room for new_seq = 15 to land
 * between 10 and 20. Honest about the failure mode: when neighbours
 * are consecutive (no integer between them), or the target is already
 * at the boundary, return null — the caller suppresses the button or
 * surfaces a "no room to reorder; renumber via Edit" message.
 *
 * Returns null when:
 *
 *   - currentSeq is not in sortedSeqs (caller bug)
 *   - direction is "up" and currentSeq is already first
 *   - direction is "down" and currentSeq is already last
 *   - the gap between neighbours leaves no integer slot
 */
export function computeReorderSeq(
  sortedSeqs: readonly number[],
  currentSeq: number,
  direction: "up" | "down",
): number | null {
  const idx = sortedSeqs.indexOf(currentSeq);
  if (idx < 0) return null;
  if (direction === "up") {
    if (idx === 0) return null; // already at top
    const prev = sortedSeqs[idx - 1]!;
    if (idx === 1) {
      // Moving to top — pick any integer < prev. Use prev - 1 when prev > 1,
      // else there's no room (seq 1 is the absolute floor in newtron).
      return prev > 1 ? prev - 1 : null;
    }
    const prevPrev = sortedSeqs[idx - 2]!;
    return midpoint(prevPrev, prev);
  }
  // down
  if (idx === sortedSeqs.length - 1) return null; // already at bottom
  const next = sortedSeqs[idx + 1]!;
  if (idx === sortedSeqs.length - 2) {
    // Moving to bottom — any integer > next. Step of 10 matches the
    // gappy-seq operator convention; collision falls back to validation.
    return next + 10;
  }
  const nextNext = sortedSeqs[idx + 2]!;
  return midpoint(next, nextNext);
}

function midpoint(a: number, b: number): number | null {
  if (b - a < 2) return null; // no integer between a and b
  return Math.floor((a + b) / 2);
}

/**
 * composeUpdateBody (slice #173.B) — turns form-output values into the
 * body shape newtron's update-<sub-rule> verbs expect.
 *
 * Only object items are editable in place. Prefix-list entries
 * (itemType "string") have no editable field besides the key — newtron
 * #239 removed `update-prefix-list-entry` entirely; the caller compiles
 * any rename to `remove-prefix-list-entry` + `add-prefix-list-entry`,
 * which never reaches this helper.
 *
 * Rules:
 *
 *   itemType "object" with keyField:
 *     Drop the keyField from the body (the URL path identifies the
 *     row). If the form value for the keyField DIFFERS from
 *     originalKey, that's a renumber request — translate to
 *     `new_<keyField>` (newtron PR #215/216/217).
 *
 *   itemType "object" without keyField:
 *     Send the body verbatim. Defensive — no current kinds.
 */
export function composeUpdateBody(
  values: Record<string, unknown>,
  _itemType: SubRuleItemType,
  keyField: string | undefined,
  originalKey: string | number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...values };
  if (keyField) {
    const formKey = body[keyField];
    if (formKey !== undefined && String(formKey) !== String(originalKey)) {
      body["new_" + keyField] = formKey;
    }
    delete body[keyField];
  }
  return body;
}

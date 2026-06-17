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

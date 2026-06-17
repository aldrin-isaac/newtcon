// audit-format.ts — pure formatters for the Audit tab (slice #175.B).
// Strings only; rendering lives in audit.ts.

/**
 * shortHash collapses a SHA-256 chain-head hash to a glanceable short
 * form like `27bfbff5…57662044` — 8 leading + 8 trailing chars + ellipsis.
 * Short inputs (< 17 chars) return as-is so we never mangle non-hashes.
 */
export function shortHash(hash: string): string {
  if (hash.length <= 17) return hash;
  return hash.slice(0, 8) + "…" + hash.slice(-8);
}

/**
 * formatTimestamp turns an RFC3339 string into a locale-aware display
 * string. Falls back to the raw input on parse failure so the operator
 * still sees something useful.
 */
export function formatTimestamp(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * eventStatusLabel returns the operator-readable status for an audit
 * event:
 *
 *   success && dry_run         "dry-run"
 *   success && !execute_mode   "preview" (newtron applied in-memory only)
 *   success && execute_mode    "applied"
 *   !success                   "failed"
 */
export function eventStatusLabel(e: {
  success: boolean;
  dry_run?: boolean;
  execute_mode?: boolean;
}): "applied" | "preview" | "dry-run" | "failed" {
  if (!e.success) return "failed";
  if (e.dry_run) return "dry-run";
  if (e.execute_mode === false) return "preview";
  return "applied";
}

/**
 * activeFilterCount returns the number of filters with a non-empty
 * value. Used for the "Filters (N)" badge so the operator sees at a
 * glance whether anything is narrowing the table.
 */
export function activeFilterCount(filters: Record<string, unknown>): number {
  let n = 0;
  for (const v of Object.values(filters)) {
    if (v === undefined || v === null || v === "") continue;
    n += 1;
  }
  return n;
}

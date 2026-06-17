// api/newtcon/audit.ts — typed client for newtcon-server's audit
// endpoints (slice #175.B). Forwards to newtron PR #197.
//
// Both endpoints can return 404 when newtron-server was started
// without --audit-log; the caller should render a teaching empty
// state rather than treating that as a transient error.

import { apiFetch } from "./_transport.js";
import { apiPath } from "../../api-path.js";

/** Per-event payload from GET /audit/events. Mirrors newtron's AuditEvent. */
export interface AuditEvent {
  id: string;
  timestamp: string;
  user: string;
  device: string;
  operation: string;
  service?: string;
  interface?: string;
  changes?: unknown[] | null;
  success: boolean;
  error?: string;
  execute_mode: boolean;
  dry_run: boolean;
  duration: string;
  client_ip?: string;
  session_id?: string;
}

/** Page response from GET /audit/events. */
export interface AuditEventPage {
  events: AuditEvent[];
  total: number;
  /** Cursor for the next page; absent when the page exhausted the filter. */
  next_offset?: number;
}

/** Response from GET /audit/integrity. */
export interface AuditIntegrityResult {
  chain_head_hash: string;
  entry_count: number;
  /** 1-based line of the first broken entry; 0 means clean chain. */
  break_at: number;
  /** "prev_hash mismatch" | "id mismatch" | "" — always present. */
  break_reason: string;
  verified_at: string;
}

/** EventFilters maps to the query parameters newtron's events endpoint accepts. */
export interface EventFilters {
  device?: string;
  user?: string;
  operation?: string;
  service?: string;
  interface?: string;
  since?: string;
  until?: string;
  success?: boolean;
  limit?: number;
  offset?: number;
}

function pathFor(suffix: string, network?: string): string {
  return network ? apiPath.network(network, suffix) : apiPath(suffix);
}

function buildQuery(filters: EventFilters): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === "" || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : "?" + parts.join("&");
}

/**
 * fetchAuditEvents fetches /api/networks/{netID}/audit/events with the
 * given filters applied as query params.
 */
export async function fetchAuditEvents(
  filters: EventFilters = {},
  network?: string,
): Promise<AuditEventPage> {
  const url = pathFor("audit/events", network) + buildQuery(filters);
  return (await apiFetch(url, { cache: "no-store" })) as AuditEventPage;
}

/**
 * fetchAuditIntegrity fetches /api/networks/{netID}/audit/integrity.
 */
export async function fetchAuditIntegrity(
  network?: string,
): Promise<AuditIntegrityResult> {
  const url = pathFor("audit/integrity", network);
  return (await apiFetch(url, { cache: "no-store" })) as AuditIntegrityResult;
}

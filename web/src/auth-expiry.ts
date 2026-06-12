// auth-expiry.ts — session-expiry formatting + near-expiry detection.
//
// The newtron L2c session key has an absolute TTL (newtron PR #143:
// "Using a key does not extend it. Default 8h via --session-key-ttl.").
// The frontend doesn't try to refresh the key — there's no refresh endpoint —
// but it does surface the expiry to the operator in two ways:
//
//   1. The user-pill dropdown shows the remaining lifetime in plain language
//      ("in 4 h 12 min", "in 8 min", etc.) so the operator can plan around it.
//   2. When less than EXPIRY_WARN_THRESHOLD_MS remains, the pill flips to an
//      amber "warning" state so the operator notices before the next /api/*
//      call surprises them with a 401.
//
// Both helpers are pure functions of (expiresAt, now) — auth-gate.ts drives
// them on a 30 s interval; tests inject `now` directly.

/**
 * EXPIRY_WARN_THRESHOLD_MS is the remaining lifetime under which the user
 * pill switches to its warning style. Chosen at 15 min: short enough that
 * the warning means "act soon," long enough that an operator mid-task can
 * finish a save before re-signing in.
 */
export const EXPIRY_WARN_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * formatExpiryRelative renders the time-until-expiry as a short
 * operator-readable string.
 *
 * Examples (msLeft → output):
 *   8h 12min → "in 8 h 12 min"
 *   1h 0min  → "in 1 h"
 *   8 min    → "in 8 min"
 *   45 sec   → "in less than a minute"
 *   already-past → "expired (was 14:32:11)"
 *
 * Granularity drops to minute precision deliberately — the operator
 * doesn't act on sub-minute changes, and the value updates on a 30 s timer.
 */
export function formatExpiryRelative(expiresAt: Date, now: Date = new Date()): string {
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) {
    return `expired (was ${expiresAt.toLocaleTimeString()})`;
  }
  const minutes = Math.floor(msLeft / 60_000);
  if (minutes < 1) return "in less than a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `in ${hours} h` : `in ${hours} h ${remMin} min`;
}

/** isNearExpiry returns true when remaining lifetime is in (0, threshold]. */
export function isNearExpiry(expiresAt: Date, now: Date = new Date()): boolean {
  const msLeft = expiresAt.getTime() - now.getTime();
  return msLeft > 0 && msLeft <= EXPIRY_WARN_THRESHOLD_MS;
}

/** isExpired returns true when remaining lifetime is ≤ 0. */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

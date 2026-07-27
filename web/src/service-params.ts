// service-params.ts — pure: which apply-service parameters a service spec
// demands from the operator at bind time.
//
// newtron marks a parameter that must be SUPPLIED by the caller with the
// sentinel string "request" in the service spec. RTD (a routed BGP transit
// service), for example, carries:
//
//   { "service_type": "routed", "routing": { "protocol": "bgp", "peer_as": "request" } }
//
// "peer_as": "request" means the operator must provide the peer ASN when
// binding the service — leaving it blank makes newtron reject the apply. The
// Bind-service form uses this to mark the matching field required BEFORE submit,
// instead of letting the engine fail the operation.
//
// The param keys newtron uses (peer_as, …) match the apply-service body /
// form-field names, so no name translation is needed.

/**
 * requestedParams returns the parameter names a service spec marks as "request"
 * (must be supplied at apply time). Scans the spec's top level and its `routing`
 * section — the two places newtron places bind-time params. Order-preserving,
 * de-duplicated; returns [] for a missing/garbled spec.
 */
export function requestedParams(detail: unknown): string[] {
  const out: string[] = [];
  if (!detail || typeof detail !== "object") return out;
  const collect = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (val === "request" && !out.includes(key)) out.push(key);
    }
  };
  const top = detail as Record<string, unknown>;
  collect(top);
  collect(top.routing);
  return out;
}

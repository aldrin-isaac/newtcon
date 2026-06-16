// web/src/api/newtcon/authorization.ts — typed client for
// GET /api/networks/{netID}/authorization.
//
// Returns newtron's AuthorizationDetail verbatim (newtron PR #160 closed
// newtron#150). The PermissionGrant in each permissions entry is
// polymorphic — shorthand (a list of user/group names) OR a typed object
// {allow, where}. The renderer in authorization.ts handles both.

import { apiPath } from "../../api-path.js";
import { apiFetch } from "./_transport.js";

/**
 * AuthorizationDetail mirrors internal/types/authorization.go
 * AuthorizationDetail. PermissionGrant is left as `unknown` because of the
 * shorthand-vs-typed polymorphism; the renderer narrows it.
 */
export interface AuthorizationDetail {
  super_users: string[];
  user_groups: Record<string, string[]>;
  permissions: Record<string, unknown>;
}

/**
 * fetchAuthorization fetches /api/networks/{netID}/authorization for the
 * given network (or the active network when omitted).
 */
export async function fetchAuthorization(network?: string): Promise<AuthorizationDetail> {
  const url = network
    ? apiPath.network(network, "authorization")
    : apiPath("authorization");
  return (await apiFetch(url, { cache: "no-store" })) as AuthorizationDetail;
}

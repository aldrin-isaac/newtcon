// web/src/api/newtcon/ssh-credentials.ts — read side of the network SSH login (a
// scoped scalar). The WRITE side (set/clear) stages through the pending queue
// like every other spec authoring (staging.ts enqueueSSHLoginSet/Clear → applyAll
// → POST set-/clear-ssh-credentials), so there is no direct write client here.
// ssh_pass is masked on read (a ${secret:KEY} reference is returned intact;
// plaintext as ***redacted***). Mirrors internal/handlers/ssh_credentials.go.

import { apiFetch } from "./_transport.js";
import { apiPath } from "../../api-path.js";

/** SSHCredentialsView — the login AUTHORED at one scope (masked ssh_pass). */
export interface SSHCredentialsView {
  scope: string;
  scope_instance: string;
  ssh_user: string;
  ssh_pass: string;
}

// showSSHCredentials reads the login authored at a scope. Empty ssh_user/ssh_pass
// mean nothing is authored at that scope (it inherits from the next scope up).
export async function showSSHCredentials(
  network: string, scope: string, scopeInstance?: string,
): Promise<SSHCredentialsView> {
  const q = new URLSearchParams({ scope });
  if (scopeInstance) q.set("scope_instance", scopeInstance);
  const url = `${apiPath.network(network, "ssh-credentials")}?${q.toString()}`;
  return (await apiFetch(url, { cache: "no-store" })) as SSHCredentialsView;
}

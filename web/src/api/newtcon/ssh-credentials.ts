// web/src/api/newtcon/ssh-credentials.ts — typed client for the network SSH login
// (a scoped scalar: one value per network/zone/node, upsert/clear). Mirrors
// internal/handlers/ssh_credentials.go. ssh_pass is masked on read (a
// ${secret:KEY} reference is returned intact; plaintext as ***redacted***) and
// should be written through the secret store as a ${secret:KEY} reference.

import { apiFetch, apiSend } from "./_transport.js";
import { apiPath } from "../../api-path.js";

/** SSHCredentialsView — the login AUTHORED at one scope (masked ssh_pass). */
export interface SSHCredentialsView {
  scope: string;
  scope_instance: string;
  ssh_user: string;
  ssh_pass: string;
}

/** SSHCredentialsWrite — body for set-ssh-credentials. */
export interface SSHCredentialsWrite {
  scope: string;
  scope_instance?: string;
  ssh_user?: string;
  ssh_pass?: string; // a ${secret:KEY} reference, not plaintext
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

// setSSHCredentials upserts the login at a scope. Enforces the network-floor
// invariant upstream (400 when overriding with no network base set).
export async function setSSHCredentials(network: string, body: SSHCredentialsWrite): Promise<void> {
  await apiSend(apiPath.network(network, "set-ssh-credentials"), "POST", body);
}

// clearSSHCredentials removes the whole override at a scope (409 when clearing
// the network base while a zone/node override still exists).
export async function clearSSHCredentials(
  network: string, scope: string, scopeInstance?: string,
): Promise<void> {
  const body: { scope: string; scope_instance?: string } = { scope };
  if (scopeInstance) body.scope_instance = scopeInstance;
  await apiSend(apiPath.network(network, "clear-ssh-credentials"), "POST", body);
}

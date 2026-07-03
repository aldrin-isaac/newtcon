// web/src/api/newtcon/secrets.ts — typed client for the network-scoped secret
// store (/api/networks/{netID}/secrets). Values are WRITE-ONLY: listSecrets
// returns key NAMES only; there is no "get value". Never log a value passed to
// setSecret. Mirrors internal/handlers/secrets.go.

import { apiFetch, apiSend } from "./_transport.js";
import { apiPath } from "../../api-path.js";

/** SecretsListResponse mirrors internal/types SecretsListResponse (names only). */
export interface SecretsListResponse {
  keys: string[];
}

// listSecrets returns the stored key names for a network (sorted, [] when none).
// Never returns values. Defaults to the active network unless one is passed.
export async function listSecrets(network?: string): Promise<string[]> {
  const url = network ? apiPath.network(network, "secrets") : apiPath("secrets");
  const resp = (await apiFetch(url, { cache: "no-store" })) as SecretsListResponse;
  return resp.keys ?? [];
}

// setSecret stores value under key so a spec field can reference ${secret:key}.
// The value is write-only upstream — do not log it.
export async function setSecret(network: string, key: string, value: string): Promise<void> {
  await apiSend(apiPath.network(network, "secrets"), "POST", { key, value });
}

// deleteSecret removes key from the network's store (idempotent upstream).
export async function deleteSecret(network: string, key: string): Promise<void> {
  await apiSend(apiPath.network(network, `secrets/${encodeURIComponent(key)}`), "DELETE");
}

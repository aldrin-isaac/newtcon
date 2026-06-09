// URL builder for newtcon's network-scoped API endpoints.
//
// newtcon's HTTP surface mirrors newtron's: network-scoped resources nest
// under /api/networks/{netID}/...  (matching /newtron/v1/networks/{netID}/...
// minus the engine-prefix and version). The netID is positional in the
// path — no `?net=` query parameter, no fetch interceptor magic.
//
// Two flavours:
//
//   apiPath("services")              → /api/networks/{active}/services
//   apiPath.network("prod", "services") → /api/networks/prod/services
//
// The first reads the operator's active network from the switcher (most
// call sites — "act on whatever the operator is currently looking at").
// The second names the network explicitly (cross-engine workflows where
// the target network isn't the active one).
//
// Routes that aren't network-scoped (`/api/health`, `/api/networks`,
// `/api/labs/...`) don't use this helper — call fetch() with the literal
// path.

import { activeNetwork } from "./network-switcher.js";

interface ApiPathFn {
  (suffix: string): string;
  network(netID: string, suffix: string): string;
}

function build(netID: string, suffix: string): string {
  const trimmed = suffix.startsWith("/") ? suffix.slice(1) : suffix;
  return `/api/networks/${encodeURIComponent(netID)}/${trimmed}`;
}

export const apiPath: ApiPathFn = Object.assign(
  (suffix: string): string => build(activeNetwork(), suffix),
  {
    network(netID: string, suffix: string): string {
      return build(netID, suffix);
    },
  },
);

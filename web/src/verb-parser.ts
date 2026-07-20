// verb-parser.ts — pure Cmd-K verb grammar (uplift 5.1, #432).
//
//   apply <service> on <device>:<iface>   → stage apply-service
//   create vlan <n> on <device>           → stage create-vlan
//   deploy <network>                      → GO TO Topology (deploy lives
//                                           there as a lifecycle action — it
//                                           is substrate lifecycle, not
//                                           intent, so it must NOT counterfeit
//                                           the staging queue)
//
// The parser returns SUGGESTIONS while typing (prefix-completed against the
// live catalog) and marks a suggestion complete only when every argument
// resolves. Staging itself happens in the palette wiring — never here.

export interface VerbContext {
  services: readonly string[];
  devices: readonly string[];
  interfacesByDevice: Map<string, readonly string[]>;
  networks: readonly string[];
}

export interface VerbSuggestion {
  kind: "apply" | "create-vlan" | "deploy";
  /** Ready-to-run: every argument parsed and resolved against the catalog. */
  complete: boolean;
  /** Display line, e.g. "apply EVPNIRB on switch1:Ethernet2". */
  label: string;
  /** Incomplete suggestions: the input text that advances to the next
   *  argument when clicked (the click-through picker path, uplift 6.3). */
  advance?: string;
  service?: string;
  device?: string;
  iface?: string;
  vlanId?: number;
  network?: string;
}

const MAX_SUGGESTIONS = 8;

function prefixMatches(prefix: string, pool: readonly string[]): string[] {
  const p = prefix.toLowerCase();
  return pool.filter((x) => x.toLowerCase().startsWith(p));
}

/** parseVerb — input → suggestions (empty when the input isn't verb-shaped). */
export function parseVerb(input: string, ctx: VerbContext): VerbSuggestion[] {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (trimmed === "") return [];
  const lower = trimmed.toLowerCase();

  if (lower.startsWith("apply") || "apply".startsWith(lower)) return applySuggestions(trimmed, ctx);
  if (lower.startsWith("create vlan") || "create vlan".startsWith(lower)) return vlanSuggestions(trimmed, ctx);
  if (lower.startsWith("deploy") || "deploy".startsWith(lower)) return deploySuggestions(trimmed, ctx);
  return [];
}

function applySuggestions(input: string, ctx: VerbContext): VerbSuggestion[] {
  // A bare prefix of the verb itself ("a", "app") seeds the service list.
  if (!/^apply\b/i.test(input)) {
    return ctx.services.slice(0, MAX_SUGGESTIONS).map((service) => ({
      kind: "apply" as const, complete: false, label: `apply ${service} on …`, service,
      advance: `apply ${service} on `,
    }));
  }
  // apply [<service> [on [<device>[:<iface>]]]]
  const m = input.match(/^apply(?:\s+(\S+))?(?:\s+on(?:\s+(\S*))?)?$/i);
  if (!m) return [];
  const [, svcTok, targetTokRaw] = m;
  // "apply SVC on" / "apply SVC on " → device-picking stage (empty token).
  const onPresent = /\bon\b/i.test(input.slice(5));
  const targetTok = targetTokRaw !== undefined ? targetTokRaw : onPresent ? "" : undefined;

  const services = svcTok === undefined ? [...ctx.services]
    : ctx.services.includes(svcTok) ? [svcTok]
    : prefixMatches(svcTok, ctx.services);
  const out: VerbSuggestion[] = [];
  for (const service of services.slice(0, MAX_SUGGESTIONS)) {
    if (targetTok === undefined) {
      out.push({ kind: "apply", complete: false, label: `apply ${service} on …`, service, advance: `apply ${service} on ` });
      continue;
    }
    const [devTok, ifaceTok] = targetTok.split(":", 2);
    const devices = devTok !== undefined && devTok !== "" && ctx.devices.includes(devTok) ? [devTok] : prefixMatches(devTok ?? "", ctx.devices);
    for (const device of devices.slice(0, MAX_SUGGESTIONS)) {
      const pool = ctx.interfacesByDevice.get(device) ?? [];
      if (ifaceTok === undefined) {
        out.push({ kind: "apply", complete: false, label: `apply ${service} on ${device}:…`, service, device, advance: `apply ${service} on ${device}:` });
        continue;
      }
      if (ifaceTok === "") {
        // Port-picking stage: every known port completes directly.
        for (const iface of pool.slice(0, MAX_SUGGESTIONS)) {
          out.push({ kind: "apply", complete: true, label: `apply ${service} on ${device}:${iface}`, service, device, iface });
        }
        if (pool.length === 0) {
          out.push({ kind: "apply", complete: false, label: `apply ${service} on ${device}:<port>`, service, device, advance: `apply ${service} on ${device}:` });
        }
        continue;
      }
      const ifaces = pool.includes(ifaceTok) ? [ifaceTok] : prefixMatches(ifaceTok, pool);
      // An interface the catalog doesn't know still completes (spec-only
      // fabrics have no live port list; the engine validates at apply).
      if (ifaces.length === 0) ifaces.push(ifaceTok);
      for (const iface of ifaces.slice(0, 4)) {
        out.push({ kind: "apply", complete: true, label: `apply ${service} on ${device}:${iface}`, service, device, iface });
      }
    }
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

function vlanSuggestions(input: string, ctx: VerbContext): VerbSuggestion[] {
  if (!/^create\b/i.test(input)) {
    return [{ kind: "create-vlan", complete: false, label: "create vlan <id> on <device>", advance: "create vlan " }];
  }
  const m = input.match(/^create(?:\s+vlan(?:\s+(\d+))?(?:\s+on(?:\s+(\S*))?)?)?$/i);
  if (!m) return [];
  const [, idTok, devTok] = m;
  if (idTok === undefined) return [{ kind: "create-vlan", complete: false, label: "create vlan <id> on <device>", advance: "create vlan " }];
  const vlanId = Number(idTok);
  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) return [];
  if (devTok === undefined || devTok === "") {
    // Device-picking stage after the id.
    return ctx.devices.slice(0, MAX_SUGGESTIONS).map((device) => ({
      kind: "create-vlan" as const, complete: true, label: `create vlan ${vlanId} on ${device}`, vlanId, device,
    }));
  }
  const devices = ctx.devices.includes(devTok) ? [devTok] : prefixMatches(devTok, ctx.devices);
  return devices.slice(0, MAX_SUGGESTIONS).map((device) => ({
    kind: "create-vlan", complete: true, label: `create vlan ${vlanId} on ${device}`, vlanId, device,
  }));
}

function deploySuggestions(input: string, ctx: VerbContext): VerbSuggestion[] {
  if (!/^deploy\b/i.test(input)) {
    return ctx.networks.slice(0, MAX_SUGGESTIONS).map((network) => ({
      kind: "deploy" as const, complete: true, label: `deploy ${network} — open Topology`, network,
    }));
  }
  const m = input.match(/^deploy(?:\s+(\S+))?$/i);
  if (!m) return [];
  const [, netTok] = m;
  const networks = netTok === undefined ? [...ctx.networks]
    : ctx.networks.includes(netTok) ? [netTok]
    : prefixMatches(netTok, ctx.networks);
  return networks.slice(0, MAX_SUGGESTIONS).map((network) => ({
    kind: "deploy", complete: true, label: `deploy ${network} — open Topology`, network,
  }));
}

// device-scaffold.ts — pure helper that builds a fresh topology device entry
// for the "Add node" flow (newtcon #283).
//
// A node is only service-ready once it has a `setup-device` step (the device
// bring-up intent: hwsku, hostname, role, underlay ASN). Without it newtron
// rejects any interface intent with "parent device does not exist", and
// provisioning has no device metadata to push. The old "Add node" staged an
// empty `{steps: [], ports: {}}`, so every web-created node had to be patched
// by hand before a service (even the underlay) could land on it.
//
// Ports are intentionally NOT scaffolded here — they're configured on demand
// via the port-config flow, keeping topology.Ports ⊆ platform inventory.
//
// Pure: no I/O, no DOM.

export interface DeviceScaffoldInput {
  hostname: string;
  /** SONiC DEVICE_METADATA role, e.g. "LeafRouter" / "SpineRouter". */
  type: string;
  /** HWSKU from the platform inventory (omitted → setup-device infers/defaults). */
  hwsku?: string;
  /** Underlay BGP ASN — setup-device's configure-bgp requires it. */
  bgpAsn?: number | string;
}

export interface TopologyStep { url: string; params: { fields: Record<string, string> } }
export interface DeviceEntry { steps: TopologyStep[]; ports: Record<string, Record<string, unknown>> }

/** buildSetupDeviceStep composes the /setup-device step's fields, mirroring the
 *  shape newtron's provisioning replays (docker unified + frr mgmt framework on,
 *  hostname, role, optional hwsku + underlay ASN). */
export function buildSetupDeviceStep(i: DeviceScaffoldInput): TopologyStep {
  const fields: Record<string, string> = {
    hostname: i.hostname,
    type: i.type || "LeafRouter",
    docker_routing_config_mode: "unified",
    frr_mgmt_framework_config: "true",
  };
  if (i.hwsku) fields.hwsku = i.hwsku;
  if (i.bgpAsn !== undefined && String(i.bgpAsn) !== "") fields.bgp_asn = String(i.bgpAsn);
  return { url: "/setup-device", params: { fields } };
}

/** buildDeviceScaffold returns the topology device entry for a new node: the
 *  setup-device step + an empty ports map (ports added on demand later). */
export function buildDeviceScaffold(i: DeviceScaffoldInput): DeviceEntry {
  return { steps: [buildSetupDeviceStep(i)], ports: {} };
}

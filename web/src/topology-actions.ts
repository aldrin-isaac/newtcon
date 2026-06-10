// Newtron action schemas for the topology context menus + side panel.
//
// Each action's `id` is the newtron subpath (POST /nodes/{d}/{id} for node-level,
// POST /nodes/{d}/interfaces/{i}/{id} for interface-level). Field `name`s MUST
// match the JSON keys newtron's handler expects — every field below has been
// verified against pkg/newtron/api/handler_node.go,
// pkg/newtron/api/handler_interface.go, pkg/newtron/api/types.go and
// pkg/newtron/types.go.
//
// Read endpoints (info, health, drift, projection, configdb…) are reached
// by clicking the panel header — those open the inspector drawer. The
// actions below are all POST-shaped state changes.

export interface ActionField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "checkbox" | "textarea";
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
}

export interface ActionDef {
  id: string;            // newtron subpath
  label: string;         // operator-facing menu text
  icon: string;          // icons.ts key
  danger?: boolean;
  confirm?: string;
  fields?: ActionField[];
}

export interface ActionGroup {
  group: string;
  items: ActionDef[];
}

// ============================================================================
// Per-device actions
// ============================================================================
//
// Scope: no per-device write actions are exposed here. Service composition
// (prefix-lists, route-policies, ACLs, VLAN/VRF/IRB creation, IPVPN/MACVPN
// definitions, BGP peer templates, QoS policies, filters) lives in the
// Specs tab.
//
// Substrate operations (Start/Stop VM, Console, SSH access) live in the
// device-inspector Lifecycle section.
//
// The Topology tab's per-port action surface lives in INTERFACE_ACTIONS
// below. It has two layers, matching newtron's substrate:
//
//   1. Port-mode configuration (configure-interface RPC): set the port to
//      bridged access / bridged trunk member / routed mode. This is
//      substrate-level setup — services have nothing to bind to until the
//      port has a mode.
//
//   2. Service binding (apply-service RPC): layer a pre-composed service on
//      top of a configured port. Services are composed in the Specs tab.

export const NODE_ACTIONS: ActionGroup[] = [];

// ============================================================================
// Per-interface actions
// ============================================================================

export const INTERFACE_ACTIONS: ActionGroup[] = [
  {
    group: "Port mode",
    items: [
      {
        // POST /configure-interface { vlan_id, tagged: false } — access mode
        id: "set-access", label: "Set to access (single untagged VLAN)", icon: "settings",
        fields: [
          { name: "vlan_id", label: "VLAN ID", type: "number", required: true, hint: "1–4094" },
        ],
        confirm: "Configure this port as access (single untagged VLAN)? Any existing port-mode config is replaced.",
      },
      {
        // POST /configure-interface { vlan_id, tagged: true } — trunk member
        // Each call adds one tagged VLAN. Multi-VLAN trunk = repeat per VLAN.
        id: "add-trunk-vlan", label: "Add tagged VLAN (trunk)", icon: "plus",
        fields: [
          { name: "vlan_id", label: "VLAN ID", type: "number", required: true, hint: "1–4094 (call repeatedly for multiple)" },
        ],
        confirm: "Add this VLAN as a tagged member of the port? Existing tagged VLANs are preserved.",
      },
      {
        // POST /configure-interface { vrf, ip } — routed mode
        id: "set-routed", label: "Set to routed (VRF + IP)", icon: "settings",
        fields: [
          { name: "vrf", label: "VRF",       type: "text", required: true, hint: "'default' for global; otherwise a VRF derived from an IPVPN spec" },
          { name: "ip",  label: "IP (CIDR)", type: "text", required: true, hint: "e.g. 10.1.0.1/24" },
        ],
        confirm: "Configure this port as routed (VRF + IP)? Any existing port-mode config is replaced.",
      },
      {
        // POST /unconfigure-interface (no body)
        id: "unconfigure-interface", label: "Clear port configuration", icon: "trash", danger: true,
        confirm: "Clear all port-mode configuration? Bound services are not removed by this action.",
      },
    ],
  },
  {
    group: "Service",
    items: [
      {
        // POST /apply-service → ApplyServiceRequest{Service, IPAddress, VLAN, PeerAS, Params}
        id: "apply-service", label: "Bind service", icon: "plus",
        fields: [
          { name: "service",    label: "Service",       type: "text",   required: true, hint: "Name of an existing service spec" },
          { name: "vlan",       label: "VLAN (opt)",    type: "number" },
          { name: "ip_address", label: "IP (CIDR, opt)", type: "text" },
          { name: "peer_as",    label: "Peer ASN (opt)", type: "number" },
        ],
      },
      // remove-service / refresh-service take no body
      { id: "remove-service",  label: "Unbind service",  icon: "trash",   danger: true, confirm: "Unbind the service from this interface?" },
      { id: "refresh-service", label: "Refresh service", icon: "refresh", confirm: "Re-apply the bound service?" },
    ],
  },
];

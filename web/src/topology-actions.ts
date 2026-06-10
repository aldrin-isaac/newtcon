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
// Scope contracted: per-device write actions (create VLAN, create VRF, add
// ACL, bind IPVPN, add BGP peer, …) are no longer exposed here. Service
// composition — including the prefix-lists, route-policies, ACLs, VLANs,
// VRFs that build up a service — happens in the Specs tab. The Topology
// tab is restricted to *applying* pre-composed services to devices
// (interface-level, via apply-service / remove-service / refresh-service
// in INTERFACE_ACTIONS below).
//
// Substrate operations (Start/Stop VM, Console, SSH) live in the device-
// inspector Lifecycle section (phase 3 of the unified-substrate work).

export const NODE_ACTIONS: ActionGroup[] = [];

// ============================================================================
// Per-interface actions
// ============================================================================

export const INTERFACE_ACTIONS: ActionGroup[] = [
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
  // Other interface-level write actions (configure-interface, set/clear
  // property, bind-acl, BGP peers, apply-qos) are intentionally not exposed
  // here. Those primitives compose into services in the Specs tab; the
  // Topology tab only applies the composed service.
];

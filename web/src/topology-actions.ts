// Newtron action schemas for the topology context menus.
//
// Each action knows: its label, icon, the newtron subpath to call, the
// HTTP shape (POST RPC), and a form definition for any parameters it takes.
// Action subpaths verified against newtron's pkg/newtron/api/handler.go:
//   - Per-device:  POST /network/{netID}/node/{device}/{subpath}
//   - Per-iface:   POST /network/{netID}/node/{device}/interface/{name}/{subpath}

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
  id: string;            // newtron subpath, e.g. "create-vlan"
  label: string;         // operator-facing menu text
  icon: string;          // icons.ts key
  danger?: boolean;      // destructive (red)
  confirm?: string;      // confirm prompt text; if absent and no fields, fires immediately
  fields?: ActionField[];
}

export interface ActionGroup {
  group: string;         // category label, e.g. "VLANs"
  items: ActionDef[];
}

// ============================================================================
// Per-device actions — surface every node-level newtron write endpoint.
// Subpaths verified against handler.go lines 137-152.
// ============================================================================

// Note: the Inspector (info, health, CONFIG_DB, drift, projection, etc.) is
// reached by clicking the menu header — those are GET-shaped reads and live
// in the drawer. The actions below are all POST-shaped state changes that map
// 1:1 to newtron subpaths.

export const NODE_ACTIONS: ActionGroup[] = [
  {
    group: "VLANs",
    items: [
      {
        id: "create-vlan", label: "Create VLAN", icon: "plus",
        fields: [
          { name: "vlan_id", label: "VLAN ID", type: "number", required: true, hint: "1–4094" },
          { name: "name", label: "Name (optional)", type: "text" },
        ],
      },
      {
        id: "delete-vlan", label: "Delete VLAN", icon: "trash", danger: true,
        fields: [{ name: "vlan_id", label: "VLAN ID", type: "number", required: true }],
        confirm: "Delete this VLAN? Bound interfaces will lose tagging.",
      },
    ],
  },
  {
    group: "VRFs",
    items: [
      {
        id: "create-vrf", label: "Create VRF", icon: "plus",
        fields: [
          { name: "name", label: "VRF name", type: "text", required: true, hint: "e.g. Vrf_PROD" },
          { name: "vni", label: "VNI (optional)", type: "number", hint: "L3VNI for EVPN" },
        ],
      },
      {
        id: "delete-vrf", label: "Delete VRF", icon: "trash", danger: true,
        fields: [{ name: "name", label: "VRF name", type: "text", required: true }],
        confirm: "Delete this VRF? Bound services will be detached.",
      },
      {
        id: "configure-irb", label: "Configure IRB", icon: "settings",
        fields: [
          { name: "vlan_id", label: "VLAN ID", type: "number", required: true },
          { name: "vrf", label: "VRF", type: "text", required: true },
          { name: "ip_address", label: "IP (CIDR)", type: "text", hint: "e.g. 10.1.0.1/24" },
        ],
      },
      {
        id: "unconfigure-irb", label: "Unconfigure IRB", icon: "trash", danger: true,
        fields: [{ name: "vlan_id", label: "VLAN ID", type: "number", required: true }],
        confirm: "Tear down the IRB on this VLAN?",
      },
    ],
  },
  {
    group: "VPN binding",
    items: [
      {
        id: "bind-ipvpn", label: "Bind IP VPN", icon: "plus",
        fields: [
          { name: "ipvpn", label: "IP VPN", type: "text", required: true, hint: "Name of an existing IP VPN spec" },
          { name: "vrf", label: "VRF (optional)", type: "text" },
        ],
      },
      {
        id: "unbind-ipvpn", label: "Unbind IP VPN", icon: "trash", danger: true,
        fields: [{ name: "ipvpn", label: "IP VPN", type: "text", required: true }],
        confirm: "Unbind this IP VPN from the device?",
      },
      {
        id: "bind-macvpn", label: "Bind MAC VPN", icon: "plus",
        fields: [
          { name: "macvpn", label: "MAC VPN", type: "text", required: true, hint: "Name of an existing MAC VPN spec" },
        ],
      },
      {
        id: "unbind-macvpn", label: "Unbind MAC VPN", icon: "trash", danger: true,
        fields: [{ name: "macvpn", label: "MAC VPN", type: "text", required: true }],
        confirm: "Unbind this MAC VPN from the device?",
      },
    ],
  },
  {
    group: "Routing",
    items: [
      {
        id: "add-static-route", label: "Add static route", icon: "arrow-right",
        fields: [
          { name: "destination", label: "Destination (CIDR)", type: "text", required: true, hint: "e.g. 10.0.0.0/8" },
          { name: "nexthop", label: "Next hop", type: "text", required: true, hint: "IPv4/IPv6" },
          { name: "vrf", label: "VRF (optional)", type: "text" },
        ],
      },
      {
        id: "remove-static-route", label: "Remove static route", icon: "trash", danger: true,
        fields: [
          { name: "destination", label: "Destination (CIDR)", type: "text", required: true },
          { name: "vrf", label: "VRF (optional)", type: "text" },
        ],
        confirm: "Remove this static route?",
      },
      {
        id: "add-bgp-evpn-peer", label: "Add BGP EVPN peer", icon: "plus",
        fields: [
          { name: "peer_ip", label: "Peer IP", type: "text", required: true },
          { name: "peer_as", label: "Peer ASN", type: "number", required: true },
        ],
      },
      {
        id: "remove-bgp-evpn-peer", label: "Remove BGP EVPN peer", icon: "trash", danger: true,
        fields: [{ name: "peer_ip", label: "Peer IP", type: "text", required: true }],
        confirm: "Remove this EVPN peer?",
      },
    ],
  },
  {
    group: "ACLs",
    items: [
      {
        id: "create-acl", label: "Create ACL", icon: "plus",
        fields: [
          { name: "name", label: "ACL name", type: "text", required: true },
          { name: "type", label: "Type", type: "select", required: true,
            options: [{ value: "L3", label: "L3 (IPv4)" }, { value: "L3V6", label: "L3 (IPv6)" }, { value: "L2", label: "L2 (MAC)" }] },
        ],
      },
      {
        id: "delete-acl", label: "Delete ACL", icon: "trash", danger: true,
        fields: [{ name: "name", label: "ACL name", type: "text", required: true }],
        confirm: "Delete this ACL?",
      },
      {
        id: "add-acl-rule", label: "Add ACL rule", icon: "plus",
        fields: [
          { name: "acl", label: "ACL name", type: "text", required: true },
          { name: "priority", label: "Priority", type: "number", required: true, hint: "Lower runs first" },
          { name: "action", label: "Action", type: "select", required: true,
            options: [{ value: "forward", label: "forward" }, { value: "drop", label: "drop" }] },
          { name: "src", label: "Source (CIDR / MAC)", type: "text" },
          { name: "dst", label: "Destination (CIDR / MAC)", type: "text" },
          { name: "protocol", label: "Protocol", type: "text", hint: "e.g. tcp, udp, icmp" },
          { name: "src_port", label: "Source port", type: "number" },
          { name: "dst_port", label: "Destination port", type: "number" },
        ],
      },
      {
        id: "remove-acl-rule", label: "Remove ACL rule", icon: "trash", danger: true,
        fields: [
          { name: "acl", label: "ACL name", type: "text", required: true },
          { name: "priority", label: "Priority", type: "number", required: true },
        ],
        confirm: "Remove this ACL rule?",
      },
    ],
  },
  {
    group: "Port channels",
    items: [
      {
        id: "create-portchannel", label: "Create port-channel", icon: "plus",
        fields: [
          { name: "name", label: "Name", type: "text", required: true, hint: "e.g. PortChannel1" },
          { name: "min_links", label: "Min links (optional)", type: "number" },
        ],
      },
      {
        id: "delete-portchannel", label: "Delete port-channel", icon: "trash", danger: true,
        fields: [{ name: "name", label: "Name", type: "text", required: true }],
        confirm: "Delete this port-channel?",
      },
      {
        id: "add-portchannel-member", label: "Add port-channel member", icon: "plus",
        fields: [
          { name: "portchannel", label: "Port-channel", type: "text", required: true },
          { name: "interface", label: "Member interface", type: "text", required: true, hint: "e.g. Ethernet0" },
        ],
      },
      {
        id: "remove-portchannel-member", label: "Remove port-channel member", icon: "trash", danger: true,
        fields: [
          { name: "portchannel", label: "Port-channel", type: "text", required: true },
          { name: "interface", label: "Member interface", type: "text", required: true },
        ],
        confirm: "Remove this member from the port-channel?",
      },
    ],
  },
  {
    group: "Intent",
    items: [
      {
        id: "intent/reconcile", label: "Reconcile drift", icon: "git-compare",
        fields: [
          { name: "dry_run", label: "Dry run (preview only)", type: "checkbox", defaultValue: true },
          { name: "mode", label: "Mode", type: "select",
            options: [
              { value: "device", label: "device — push device intent to device" },
              { value: "intent", label: "intent — pull device state into intent" },
            ] },
        ],
      },
      { id: "intent/save",  label: "Save intent",  icon: "shield-check",
        confirm: "Save current intent to disk?" },
      { id: "intent/reload", label: "Reload intent", icon: "refresh", danger: true,
        confirm: "Reload intent from disk? Unsaved edits are lost." },
      { id: "intent/clear", label: "Clear intent", icon: "trash", danger: true,
        confirm: "Clear all intent for this device? Destructive." },
    ],
  },
  {
    group: "Config & daemon",
    items: [
      { id: "save-config", label: "Save running-config", icon: "shield-check", confirm: "Save current CONFIG_DB to startup?" },
      { id: "reload-config", label: "Reload from startup", icon: "refresh", danger: true, confirm: "Reload startup config? Live state is replaced." },
      {
        id: "restart-daemon", label: "Restart daemon", icon: "refresh", danger: true,
        fields: [{ name: "daemon", label: "Daemon name", type: "text", required: true, hint: "e.g. bgp, swss" }],
        confirm: "Restart this daemon? Sessions may flap.",
      },
      { id: "init-device", label: "Initialize device", icon: "play", confirm: "Run device init? First-boot only." },
      { id: "setup-device", label: "Setup device", icon: "settings", confirm: "Run device setup?" },
    ],
  },
  {
    group: "Escape hatch",
    items: [
      {
        id: "ssh-command", label: "Run SSH command", icon: "external", danger: true,
        fields: [{ name: "command", label: "Command", type: "textarea", required: true, hint: "Plain shell on the device" }],
      },
    ],
  },
];

// ============================================================================
// Per-interface actions — surface every per-interface newtron endpoint.
// Subpaths verified against handler.go lines 173-185.
// ============================================================================

export const INTERFACE_ACTIONS: ActionGroup[] = [
  {
    group: "Service",
    items: [
      {
        id: "apply-service", label: "Bind service", icon: "plus",
        fields: [
          { name: "service", label: "Service spec", type: "text", required: true, hint: "Name of an existing service" },
          { name: "vlan", label: "VLAN (optional)", type: "number" },
          { name: "ip_address", label: "IP address (optional)", type: "text" },
          { name: "peer_as", label: "Peer ASN (optional)", type: "number" },
        ],
      },
      { id: "remove-service", label: "Unbind service", icon: "trash", danger: true, confirm: "Unbind the service from this interface?" },
      { id: "refresh-service", label: "Refresh service", icon: "refresh", confirm: "Re-apply the bound service?" },
    ],
  },
  {
    group: "Interface configuration",
    items: [
      {
        id: "configure-interface", label: "Configure interface", icon: "settings",
        fields: [
          { name: "ip_address", label: "IP (CIDR)", type: "text" },
          { name: "mtu", label: "MTU", type: "number" },
          { name: "admin_status", label: "Admin status", type: "select",
            options: [{ value: "up", label: "up" }, { value: "down", label: "down" }] },
        ],
      },
      { id: "unconfigure-interface", label: "Unconfigure interface", icon: "trash", danger: true, confirm: "Clear configured properties on this interface?" },
      {
        id: "set-property", label: "Set property", icon: "edit",
        fields: [
          { name: "property", label: "Property", type: "text", required: true, hint: "e.g. mtu, speed, description" },
          { name: "value", label: "Value", type: "text", required: true },
        ],
      },
      {
        id: "clear-property", label: "Clear property", icon: "trash", danger: true,
        fields: [{ name: "property", label: "Property", type: "text", required: true }],
      },
    ],
  },
  {
    group: "ACLs",
    items: [
      {
        id: "bind-acl", label: "Bind ACL", icon: "shield-check",
        fields: [
          { name: "acl", label: "ACL name", type: "text", required: true },
          { name: "direction", label: "Direction", type: "select", required: true,
            options: [{ value: "ingress", label: "ingress" }, { value: "egress", label: "egress" }] },
        ],
      },
      { id: "unbind-acl", label: "Unbind ACL", icon: "trash", danger: true, confirm: "Unbind ACL from this interface?" },
    ],
  },
  {
    group: "BGP",
    items: [
      {
        id: "add-bgp-peer", label: "Add BGP peer", icon: "plus",
        fields: [
          { name: "peer_ip", label: "Peer IP", type: "text", required: true },
          { name: "peer_as", label: "Peer ASN", type: "number", required: true },
        ],
      },
      {
        id: "remove-bgp-peer", label: "Remove BGP peer", icon: "trash", danger: true,
        fields: [{ name: "peer_ip", label: "Peer IP", type: "text", required: true }],
        confirm: "Remove this BGP peer?",
      },
    ],
  },
  {
    group: "QoS",
    items: [
      {
        id: "apply-qos", label: "Apply QoS policy", icon: "activity",
        fields: [
          { name: "qos_policy", label: "Policy name", type: "text", required: true },
          { name: "direction", label: "Direction", type: "select",
            options: [{ value: "ingress", label: "ingress" }, { value: "egress", label: "egress" }] },
        ],
      },
      { id: "remove-qos", label: "Remove QoS policy", icon: "trash", danger: true, confirm: "Remove QoS policy from this interface?" },
    ],
  },
];

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

export const NODE_ACTIONS: ActionGroup[] = [
  {
    group: "VLANs",
    items: [
      {
        // POST /create-vlan → VLANCreateRequest{ID int json:"id"; Description string json:"description"}
        id: "create-vlan", label: "Create VLAN", icon: "plus",
        fields: [
          { name: "id", label: "VLAN ID", type: "number", required: true, hint: "1–4094" },
          { name: "description", label: "Description (optional)", type: "text" },
        ],
      },
      {
        // POST /delete-vlan → {ID int json:"id"}
        id: "delete-vlan", label: "Delete VLAN", icon: "trash", danger: true,
        fields: [{ name: "id", label: "VLAN ID", type: "number", required: true }],
        confirm: "Delete this VLAN? Bound interfaces will lose tagging.",
      },
    ],
  },
  {
    group: "VRFs",
    items: [
      {
        // POST /create-vrf → VRFCreateRequest{Name string json:"name"}
        id: "create-vrf", label: "Create VRF", icon: "plus",
        fields: [{ name: "name", label: "VRF name", type: "text", required: true, hint: "e.g. Vrf_PROD" }],
      },
      {
        // POST /delete-vrf → {Name string json:"name"}
        id: "delete-vrf", label: "Delete VRF", icon: "trash", danger: true,
        fields: [{ name: "name", label: "VRF name", type: "text", required: true }],
        confirm: "Delete this VRF? Bound services will be detached.",
      },
      {
        // POST /configure-irb → IRBConfigureRequest{VlanID json:"vlan_id"; VRF json:"vrf"; IPAddress json:"ip_address"; AnycastMAC json:"anycast_mac"}
        id: "configure-irb", label: "Configure IRB", icon: "settings",
        fields: [
          { name: "vlan_id",      label: "VLAN ID",         type: "number", required: true },
          { name: "vrf",          label: "VRF",             type: "text",   required: true },
          { name: "ip_address",   label: "IP (CIDR)",       type: "text",   hint: "e.g. 10.1.0.1/24" },
          { name: "anycast_mac",  label: "Anycast MAC",     type: "text",   hint: "optional" },
        ],
      },
      {
        // POST /unconfigure-irb → UnconfigureIRBRequest{VlanID json:"vlan_id"}
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
        // POST /bind-ipvpn → {VRF json:"vrf"; IPVPN json:"ipvpn"}
        id: "bind-ipvpn", label: "Bind IP VPN", icon: "plus",
        fields: [
          { name: "vrf",   label: "VRF",    type: "text", required: true },
          { name: "ipvpn", label: "IP VPN", type: "text", required: true, hint: "Name of an existing IP VPN spec" },
        ],
      },
      {
        // POST /unbind-ipvpn → {VRF json:"vrf"}  (no ipvpn field — VRF identifies the binding)
        id: "unbind-ipvpn", label: "Unbind IP VPN", icon: "trash", danger: true,
        fields: [{ name: "vrf", label: "VRF", type: "text", required: true }],
        confirm: "Unbind the IP VPN bound to this VRF?",
      },
      {
        // POST /bind-macvpn → NodeBindMACVPNRequest{VlanID json:"vlan_id"; MACVPN json:"macvpn"}
        id: "bind-macvpn", label: "Bind MAC VPN", icon: "plus",
        fields: [
          { name: "vlan_id", label: "VLAN ID", type: "number", required: true },
          { name: "macvpn",  label: "MAC VPN", type: "text",   required: true, hint: "Name of an existing MAC VPN spec" },
        ],
      },
      {
        // POST /unbind-macvpn → NodeUnbindMACVPNRequest{VlanID json:"vlan_id"}
        id: "unbind-macvpn", label: "Unbind MAC VPN", icon: "trash", danger: true,
        fields: [{ name: "vlan_id", label: "VLAN ID", type: "number", required: true }],
        confirm: "Unbind the MAC VPN on this VLAN?",
      },
    ],
  },
  {
    group: "Routing",
    items: [
      {
        // POST /add-static-route → StaticRouteRequest{VRF, Prefix, NextHop, Metric}
        id: "add-static-route", label: "Add static route", icon: "arrow-right",
        fields: [
          { name: "vrf",     label: "VRF",                 type: "text",   required: true },
          { name: "prefix",  label: "Destination (CIDR)", type: "text",   required: true, hint: "e.g. 10.0.0.0/8" },
          { name: "nexthop", label: "Next hop",            type: "text",   required: true, hint: "IPv4/IPv6" },
          { name: "metric",  label: "Metric (optional)",   type: "number" },
        ],
      },
      {
        // POST /remove-static-route → {VRF, Prefix}
        id: "remove-static-route", label: "Remove static route", icon: "trash", danger: true,
        fields: [
          { name: "vrf",    label: "VRF",                type: "text", required: true },
          { name: "prefix", label: "Destination (CIDR)", type: "text", required: true },
        ],
        confirm: "Remove this static route?",
      },
      {
        // POST /add-bgp-evpn-peer → BGPNeighborConfig{VRF, Interface, RemoteAS, NeighborIP, Description, Multihop}
        id: "add-bgp-evpn-peer", label: "Add BGP EVPN peer", icon: "plus",
        fields: [
          { name: "neighbor_ip", label: "Peer IP",     type: "text",   required: true },
          { name: "remote_as",   label: "Peer ASN",    type: "number", required: true },
          { name: "vrf",         label: "VRF (opt)",   type: "text" },
          { name: "interface",   label: "Source interface (opt)", type: "text" },
          { name: "description", label: "Description", type: "text" },
          { name: "multihop",    label: "Multihop TTL (opt)", type: "number" },
        ],
      },
      {
        // POST /remove-bgp-evpn-peer → {IP json:"ip"}
        id: "remove-bgp-evpn-peer", label: "Remove BGP EVPN peer", icon: "trash", danger: true,
        fields: [{ name: "ip", label: "Peer IP", type: "text", required: true }],
        confirm: "Remove this EVPN peer?",
      },
    ],
  },
  {
    group: "ACLs",
    items: [
      {
        // POST /create-acl → ACLCreateRequest{Name, Type, Stage, Ports, Description}
        id: "create-acl", label: "Create ACL", icon: "plus",
        fields: [
          { name: "name",  label: "ACL name", type: "text", required: true },
          { name: "type",  label: "Type",     type: "select", required: true,
            options: [
              { value: "L3",   label: "L3 (IPv4)" },
              { value: "L3V6", label: "L3 (IPv6)" },
              { value: "L2",   label: "L2 (MAC)" },
            ],
          },
          { name: "stage", label: "Stage", type: "select", required: true,
            options: [
              { value: "INGRESS", label: "INGRESS" },
              { value: "EGRESS",  label: "EGRESS" },
            ],
          },
          { name: "ports",       label: "Ports (optional)",      type: "text", hint: "comma-separated, e.g. Ethernet0,Ethernet4" },
          { name: "description", label: "Description (optional)", type: "text" },
        ],
      },
      {
        // POST /delete-acl → {Name json:"name"}
        id: "delete-acl", label: "Delete ACL", icon: "trash", danger: true,
        fields: [{ name: "name", label: "ACL name", type: "text", required: true }],
        confirm: "Delete this ACL?",
      },
      {
        // POST /add-acl-rule → {ACL, RuleName, Priority, Action, SrcIP, DstIP, Protocol, SrcPort, DstPort}
        id: "add-acl-rule", label: "Add ACL rule", icon: "plus",
        fields: [
          { name: "acl",       label: "ACL",       type: "text",   required: true },
          { name: "rule_name", label: "Rule name", type: "text",   required: true },
          { name: "priority",  label: "Priority",  type: "number", required: true, hint: "Lower runs first" },
          { name: "action",    label: "Action",    type: "select", required: true,
            options: [{ value: "forward", label: "forward" }, { value: "drop", label: "drop" }] },
          { name: "src_ip",    label: "Source IP/CIDR",      type: "text" },
          { name: "dst_ip",    label: "Destination IP/CIDR", type: "text" },
          { name: "protocol",  label: "Protocol",            type: "text", hint: "e.g. tcp, udp, icmp" },
          { name: "src_port",  label: "Source port",         type: "text" },
          { name: "dst_port",  label: "Destination port",    type: "text" },
        ],
      },
      {
        // POST /remove-acl-rule → {ACL, Rule}
        id: "remove-acl-rule", label: "Remove ACL rule", icon: "trash", danger: true,
        fields: [
          { name: "acl",  label: "ACL",       type: "text", required: true },
          { name: "rule", label: "Rule name", type: "text", required: true },
        ],
        confirm: "Remove this ACL rule?",
      },
    ],
  },
  {
    group: "Port channels",
    items: [
      {
        // POST /create-portchannel → PortChannelCreateRequest{Name, Members, MinLinks, FastRate, Fallback, MTU}
        id: "create-portchannel", label: "Create port-channel", icon: "plus",
        fields: [
          { name: "name",      label: "Name",                type: "text",   required: true, hint: "e.g. PortChannel1" },
          { name: "min_links", label: "Min links (opt)",     type: "number" },
          { name: "fast_rate", label: "LACP fast-rate (opt)", type: "checkbox" },
          { name: "fallback",  label: "Fallback (opt)",      type: "checkbox" },
          { name: "mtu",       label: "MTU (opt)",           type: "number" },
        ],
      },
      {
        // POST /delete-portchannel → {Name json:"name"}
        id: "delete-portchannel", label: "Delete port-channel", icon: "trash", danger: true,
        fields: [{ name: "name", label: "Name", type: "text", required: true }],
        confirm: "Delete this port-channel?",
      },
      {
        // POST /add-portchannel-member → PortChannelMemberRequest{PortChannel, Interface}
        id: "add-portchannel-member", label: "Add port-channel member", icon: "plus",
        fields: [
          { name: "portchannel", label: "Port-channel",      type: "text", required: true },
          { name: "interface",   label: "Member interface", type: "text", required: true, hint: "e.g. Ethernet0" },
        ],
      },
      {
        id: "remove-portchannel-member", label: "Remove port-channel member", icon: "trash", danger: true,
        fields: [
          { name: "portchannel", label: "Port-channel",      type: "text", required: true },
          { name: "interface",   label: "Member interface", type: "text", required: true },
        ],
        confirm: "Remove this member from the port-channel?",
      },
    ],
  },
  {
    group: "Intent",
    items: [
      // newtron's intent/reconcile reads ?reconcile=full|delta&execute=true|false from
      // the query string; the operator should use the dedicated reconcile drawer
      // for previews. Here we only surface the side-effecting variants.
      { id: "intent/save",   label: "Save intent",   icon: "shield-check",
        confirm: "Save current intent to disk?" },
      { id: "intent/reload", label: "Reload intent", icon: "refresh", danger: true,
        confirm: "Reload intent from disk? Unsaved edits are lost." },
      { id: "intent/clear",  label: "Clear intent",  icon: "trash", danger: true,
        confirm: "Clear all intent for this device? Destructive." },
    ],
  },
  {
    group: "Config & daemon",
    items: [
      { id: "save-config",   label: "Save running-config", icon: "shield-check", confirm: "Save current CONFIG_DB to startup?" },
      { id: "reload-config", label: "Reload from startup", icon: "refresh", danger: true, confirm: "Reload startup config? Live state is replaced." },
      {
        // POST /restart-daemon → RestartDaemonRequest{Daemon json:"daemon"}
        id: "restart-daemon", label: "Restart daemon", icon: "refresh", danger: true,
        fields: [{ name: "daemon", label: "Daemon name", type: "text", required: true, hint: "e.g. bgp, swss" }],
        confirm: "Restart this daemon? Sessions may flap.",
      },
      { id: "init-device",   label: "Initialize device", icon: "play",     confirm: "Run device init? First-boot only." },
      { id: "setup-device",  label: "Setup device",      icon: "settings", confirm: "Run device setup?" },
    ],
  },
  {
    group: "Escape hatch",
    items: [
      {
        // POST /ssh-command → SSHCommandRequest{Command json:"command"}
        id: "ssh-command", label: "Run SSH command", icon: "external", danger: true,
        fields: [{ name: "command", label: "Command", type: "textarea", required: true, hint: "Plain shell on the device" }],
      },
    ],
  },
];

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
  {
    group: "Interface configuration",
    items: [
      {
        // POST /configure-interface → ConfigureInterfaceRequest{VRF, IP, VLAN json:"vlan_id", Tagged}
        id: "configure-interface", label: "Configure interface", icon: "settings",
        fields: [
          { name: "vrf",     label: "VRF (routed mode)",        type: "text",     hint: "Mutually exclusive with VLAN" },
          { name: "ip",      label: "IP (CIDR, routed mode)",  type: "text",     hint: "e.g. 10.1.0.1/24" },
          { name: "vlan_id", label: "VLAN (bridged mode)",      type: "number",   hint: "Mutually exclusive with VRF" },
          { name: "tagged",  label: "Tagged (bridged mode)",    type: "checkbox" },
        ],
      },
      { id: "unconfigure-interface", label: "Unconfigure interface", icon: "trash", danger: true, confirm: "Clear configured properties on this interface?" },
      {
        // POST /set-property → InterfaceSetRequest{Property, Value}
        id: "set-property", label: "Set property", icon: "edit",
        fields: [
          { name: "property", label: "Property", type: "text", required: true, hint: "e.g. mtu, speed, description" },
          { name: "value",    label: "Value",    type: "text", required: true },
        ],
      },
      {
        // POST /clear-property → InterfaceClearRequest{Property}
        id: "clear-property", label: "Clear property", icon: "trash", danger: true,
        fields: [{ name: "property", label: "Property", type: "text", required: true }],
      },
    ],
  },
  {
    group: "ACLs",
    items: [
      {
        // POST /bind-acl → BindACLRequest{ACL, Direction}
        id: "bind-acl", label: "Bind ACL", icon: "shield-check",
        fields: [
          { name: "acl",       label: "ACL",       type: "text",   required: true },
          { name: "direction", label: "Direction", type: "select", required: true,
            options: [{ value: "ingress", label: "ingress" }, { value: "egress", label: "egress" }] },
        ],
      },
      {
        // POST /unbind-acl → UnbindACLRequest{ACL}
        id: "unbind-acl", label: "Unbind ACL", icon: "trash", danger: true,
        fields: [{ name: "acl", label: "ACL", type: "text", required: true }],
        confirm: "Unbind ACL from this interface?",
      },
    ],
  },
  {
    group: "BGP",
    items: [
      {
        // POST /add-bgp-peer → BGPNeighborConfig{...}
        id: "add-bgp-peer", label: "Add BGP peer", icon: "plus",
        fields: [
          { name: "neighbor_ip", label: "Peer IP",    type: "text",   required: true },
          { name: "remote_as",   label: "Peer ASN",   type: "number", required: true },
          { name: "vrf",         label: "VRF (opt)",  type: "text" },
          { name: "description", label: "Description (opt)", type: "text" },
          { name: "multihop",    label: "Multihop TTL (opt)", type: "number" },
        ],
      },
      // remove-bgp-peer takes no body (interface is in URL path)
      { id: "remove-bgp-peer", label: "Remove BGP peer", icon: "trash", danger: true, confirm: "Remove this interface's BGP peer?" },
    ],
  },
  {
    group: "QoS",
    items: [
      {
        // POST /apply-qos → ApplyQoSRequest{Policy json:"policy"}
        id: "apply-qos", label: "Apply QoS policy", icon: "activity",
        fields: [{ name: "policy", label: "Policy name", type: "text", required: true }],
      },
      // remove-qos takes no body (interface is in URL path)
      { id: "remove-qos", label: "Remove QoS policy", icon: "trash", danger: true, confirm: "Remove QoS policy from this interface?" },
    ],
  },
];

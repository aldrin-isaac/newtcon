// seed-fixture.mjs — idempotently (re)build the stable smoke fixture network.
//
// The smoke suite targets a network with a known shape (3-switch triangle,
// TRANSIT routed underlay applied on every inter-switch link, an EVPN-IRB service
// with its supporting specs, and one zone override). API-created networks are
// wipeable by the environment, so THIS SCRIPT is the durable artifact: re-run it
// whenever the fixture is missing.
//
//   NEWTCON_URL       target server (default http://127.0.0.1:8095)
//   SMOKE_NET         fixture network id (default "smoke-fixture")
//   NEWTCON_TEST_USER / NEWTCON_TEST_PASS   creds when the server enforces auth
//
// Run: NEWTCON_TEST_USER=ron NEWTCON_TEST_PASS=… node test/smoke/seed-fixture.mjs

import { loginCookie } from "./_auth.mjs";

const BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";
const NET = process.env.SMOKE_NET || "smoke-fixture";

// Per-network identity variant. The suite is network-agnostic — smokes discover
// these values via the API rather than hard-coding them — so seeding a second
// network with DISTINCT identity (different platform/hwsku/ASN/loopback/zone) is
// what proves the discovery actually adapts. Any unlisted network falls back to
// the smoke-fixture variant.
const VARIANTS = {
  "smoke-fixture":    { platform: "Force10-S6000_vs",    hwsku: "Force10-S6000",        baseAsn: 65001, lo: "10.1.0.", zone: "myzone" },
  "3node-vs-newtcon": { platform: "cisco-p200-32x100-vs", hwsku: "cisco-p200-32x100-vs", baseAsn: 64512, lo: "10.2.0.", zone: "zoneb" },
};
const V = VARIANTS[NET] || VARIANTS["smoke-fixture"];
const ASNS = [V.baseAsn, V.baseAsn + 1, V.baseAsn + 2];

const cookie = await loginCookie(BASE);
const HDRS = { "Content-Type": "application/json", ...(cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : {}) };

let warn = 0;
async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: HDRS, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  return { status: res.status, txt };
}
// A create is "fine" on 2xx or on an already-exists 409/400.
async function put(path, body, label) {
  const { status, txt } = await req("POST", path, body);
  const ok = status < 300 || status === 409 || /already exists/i.test(txt);
  if (!ok) { warn++; console.log(`  WARN ${label}: ${status} ${txt.slice(0, 120)}`); }
  else console.log(`  ok   ${label} (${status})`);
  return ok;
}
const N = (p) => `/api/networks/${NET}${p}`;

console.log(`seeding ${NET} @ ${BASE}${cookie ? " (auth)" : ""}`);

// 1. network
await put("/api/networks", { id: NET, description: "smoke-suite fixture (seed-fixture.mjs)" }, "register network");

// 2. flat specs (order: referenced before referencer)
await put(N("/zones"), { name: V.zone }, `zone ${V.zone}`);
await put(N("/ipvpns"), { name: "IPVPN", l3vni: 10001, route_targets: ["65001:300"], description: "L3 VRF for EVPNIRB" }, "ipvpn IPVPN");
await put(N("/macvpns"), { name: "MACVPN", vni: 10100, route_targets: ["65533:100"] }, "macvpn MACVPN");
await put(N("/prefix-lists"), { name: "PREFIXLIST1" }, "prefix-list PREFIXLIST1");
await put(N("/prefix-lists/PREFIXLIST1/entries"), { prefix_list: "PREFIXLIST1", seq: 10, prefix: "10.0.0.0/8", action: "permit" }, "  prefixlist entry");
await put(N("/filters"), { name: "FILTER1", type: "ipv4" }, "filter FILTER1");
await put(N("/filters/FILTER1/rules"), { filter: "FILTER1", seq: 100, action: "permit", src_prefix_list: "PREFIXLIST1", dst_prefix_list: "PREFIXLIST1" }, "  filter rule");
await put(N("/qos-policies"), { name: "QOS1" }, "qos QOS1");
for (const q of [{ queue_id: 0, name: "q1", type: "dwrr", weight: 25, dscp: [0] }, { queue_id: 1, name: "q1b", type: "dwrr", weight: 25, dscp: [8] }, { queue_id: 2, name: "q2", type: "dwrr", weight: 25, dscp: [16] }, { queue_id: 3, name: "q3", type: "dwrr", weight: 25, dscp: [24] }]) {
  await put(N("/qos-policies/QOS1/queues"), { policy: "QOS1", ...q }, `  queue ${q.queue_id}`);
}
await put(N("/route-policies"), { name: "ROUTEPOLICY1", description: "route policy" }, "route-policy ROUTEPOLICY1");
await put(N("/services"), { name: "TRANSIT", service_type: "routed", description: "Underlay L3 routed transit fabric", routing: { protocol: "bgp", peer_as: "request" } }, "service TRANSIT");
await put(N("/services"), { name: "EVPNIRB", service_type: "evpn-irb", ipvpn: "IPVPN", macvpn: "MACVPN", ingress_filter: "FILTER1", egress_filter: "FILTER1", qos_policy: "QOS1" }, "service EVPNIRB");

// 3. node specs — must exist before a topology device can reference them
const HOSTS = [["switch1", 0], ["switch2", 1], ["switch3", 2]];
for (const [host, i] of HOSTS) {
  await put(N("/nodes"), { name: host, mgmt_ip: "127.0.0.1", loopback_ip: `${V.lo}${i + 1}`, zone: V.zone, platform: V.platform, underlay_asn: ASNS[i], ssh_user: "admin" }, `node-spec ${host}`);
}

// 4. topology — 3 switches in a triangle
const topo = JSON.parse((await req("GET", N("/topology"))).txt || "{}");
const have = new Set(Object.keys(topo.nodes || {}));
const scaffold = (host, asn, ports) => ({
  steps: [{ url: "/setup-device", params: { fields: { hostname: host, type: "LeafRouter", docker_routing_config_mode: "unified", frr_mgmt_framework_config: "true", hwsku: V.hwsku, bgp_asn: String(asn) } } }],
  ports,
});
for (const [host, i] of HOSTS) {
  if (have.has(host)) { console.log(`  ok   node ${host} (exists)`); continue; }
  await put(N("/topology/nodes"), { name: host, device: scaffold(host, ASNS[i], {}) }, `node ${host}`);
}
// configure the two inter-switch ports on each switch — apply-service requires
// the interface to exist on the device. PUT (whole-device replace) is idempotent.
for (const [host, i] of HOSTS) {
  const body = scaffold(host, ASNS[i], { Ethernet0: { admin_status: "up", mtu: 9100 }, Ethernet4: { admin_status: "up", mtu: 9100 } });
  const { status, txt } = await req("PUT", N(`/topology/nodes/${host}`), body);
  if (status < 300) console.log(`  ok   ports ${host} (${status})`);
  else { warn++; console.log(`  WARN ports ${host}: ${status} ${txt.slice(0, 100)}`); }
}
// links: triangle
const links = [["switch1:Ethernet0", "switch2:Ethernet0"], ["switch2:Ethernet4", "switch3:Ethernet0"], ["switch3:Ethernet4", "switch1:Ethernet4"]];
for (const [a, z] of links) await put(N("/topology/links"), { a, z }, `link ${a} <-> ${z}`);

// 4. TRANSIT applied on all 6 inter-switch endpoints (persist to topology), peer AS = neighbor's
const applies = [
  ["switch1", "Ethernet0", "10.255.255.0/31", ASNS[1]], ["switch1", "Ethernet4", "10.255.255.5/31", ASNS[2]],
  ["switch2", "Ethernet0", "10.255.255.1/31", ASNS[0]], ["switch2", "Ethernet4", "10.255.255.2/31", ASNS[2]],
  ["switch3", "Ethernet0", "10.255.255.3/31", ASNS[1]], ["switch3", "Ethernet4", "10.255.255.4/31", ASNS[0]],
];
for (const [dev, iface, ip, peer] of applies) {
  await put(N(`/nodes/${dev}/interfaces/${iface}/rpc/apply-service?mode=topology&persist=topology`), { service: "TRANSIT", ip_address: ip, peer_as: peer }, `apply TRANSIT ${dev}:${iface}`);
}

// 5. one zone override (for override-* smokes): IPVPN scoped to myzone
await put(N("/ipvpns"), { name: "IPVPN", l3vni: 10002, route_targets: ["65001:301"], scope: "zone", scope_instance: V.zone }, `override ipvpn IPVPN@zone:${V.zone}`);

console.log(warn === 0 ? "\nseed OK" : `\nseed completed with ${warn} warning(s)`);
process.exitCode = 0;

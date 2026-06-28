// device-scaffold.test.js — the "Add node" device-entry scaffold (#283).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildSetupDeviceStep, buildDeviceScaffold } from "../dist/device-scaffold.js";

describe("buildSetupDeviceStep()", () => {
  test("composes the setup-device fields (hwsku + bgp_asn + defaults)", () => {
    const s = buildSetupDeviceStep({ hostname: "spine1", type: "SpineRouter", hwsku: "Force10-S6000", bgpAsn: 65001 });
    assert.equal(s.url, "/setup-device");
    assert.deepEqual(s.params.fields, {
      hostname: "spine1",
      type: "SpineRouter",
      docker_routing_config_mode: "unified",
      frr_mgmt_framework_config: "true",
      hwsku: "Force10-S6000",
      bgp_asn: "65001",
    });
  });

  test("type defaults to LeafRouter; hwsku/bgp_asn omitted when absent", () => {
    const s = buildSetupDeviceStep({ hostname: "leaf9", type: "" });
    assert.equal(s.params.fields.type, "LeafRouter");
    assert.equal("hwsku" in s.params.fields, false);
    assert.equal("bgp_asn" in s.params.fields, false);
  });

  test("bgpAsn as string is preserved; empty string omitted", () => {
    assert.equal(buildSetupDeviceStep({ hostname: "a", type: "LeafRouter", bgpAsn: "65010" }).params.fields.bgp_asn, "65010");
    assert.equal("bgp_asn" in buildSetupDeviceStep({ hostname: "a", type: "LeafRouter", bgpAsn: "" }).params.fields, false);
  });
});

describe("buildDeviceScaffold()", () => {
  test("returns a setup-device step + empty ports (ports are on-demand)", () => {
    const d = buildDeviceScaffold({ hostname: "leaf1", type: "LeafRouter", hwsku: "X", bgpAsn: 65001 });
    assert.equal(d.steps.length, 1);
    assert.equal(d.steps[0].url, "/setup-device");
    assert.deepEqual(d.ports, {});
  });
});

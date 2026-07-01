# Smoke suite status (under `--auth-required`)

**Whole suite green or deploy-gated.** From 3 passing at the start of this effort
to the full suite. Run with the fixture seeded (`node test/smoke/seed-fixture.mjs`)
and `NEWTCON_URL` + `NEWTCON_TEST_USER=ron` / `NEWTCON_TEST_PASS` set.

## Deploy-gated skips (exit 0 via `skipIfNotDeployed`)
`topology-e2e`, `per-device-apply`, `topology-broad`, `resource-lens`,
`state-tables`, `lags-neighbors` — their assertions read live device state
(vlans/vrfs/acls/bgp/LAGs), which 503s on the staged fixture. They pass against a
deployed lab (e.g. `2node-vs` when its VMs are up).

## What the effort found
Every failure was **test drift**, not a product bug, with **one exception**: the
drawer-header identity subtitle went blank for offline/staged devices because it
was sourced only from the live `/info` probe (fixed in #324 — falls back to the
NodeSpec). The recurring drift causes were:

- **Auth** — smokes predated `--auth-required`; direct-newtron and node-side
  verify fetches needed the session cookie (`_auth.mjs` helper + `ron` account).
- **#210 view-mode gating** — spec-only affordances (`+ Create node`, the Inspect
  menu, the empty `NODE_ACTIONS` panel) require Spec view; lab lifecycle requires
  Lab view. Smokes now pin `newtcon:topology-view:<net>`.
- **Renames** — profiles→nodes (`#node-panel-profile`→`#node-panel-spec`), Summary
  tab folded, `.spec-form`→`.schema-form`, "Type"→"Service Type", "Zones"→"Zone".
- **Model shifts** — edit-Save **stages** (staging model) then applies; the schema
  form uses HTML5 `required` + read-only immutable identifiers; newtron
  upper-cases spec names (`smoke-edit-1`→`SMOKE_EDIT_1`).
- **Fixture** — a durable `smoke-fixture` (`seed-fixture.mjs`); note its API-created
  specs (e.g. the `myzone` zone) can be wiped by engine resets — re-seed before a run.

## Durable test infrastructure added
- `_auth.mjs` — `authenticatePage` / `loginCookie` / `skipIfNotDeployed`.
- `seed-fixture.mjs` — idempotent 3-switch triangle + TRANSIT underlay + EVPN-IRB.
- `docs/testing-auth.md` — the `ron` nologin-superuser + cookie-jar recipe.

---

## Deploy-gated smokes vs a live lab (2node-vs)
2node-vs is a running lab whose topology includes `switch1`/`switch2`. Pointing the
device-state smokes at it (`NET=2node-vs`) exercises the real device paths:

**Now green against 2node-vs** (fixed: authenticate the device rpc/topology fetches;
target the switch by `data-device` not the first `.topo-node` — the first node is a
host in a host+switch lab; `DEVICE` env override):
- `state-tables` 3/0, `lags-neighbors` 5/0, `resource-lens` 5/0.

**Obsolete — test a removed feature** (`per-device-apply`, `topology-e2e`,
`topology-broad`): their core is "open the VLANs group in the action panel → Create
VLAN → apply". #210 emptied `NODE_ACTIONS` ("services only" scope), so there is no
node-level Create-VLAN/VRF/ACL affordance anymore — device config flows through
services (covered by `resource-lens`) and interface config (covered by
`iface-actions`). Recommend retiring these three; their staging→apply→lands-on-device
value is already covered.

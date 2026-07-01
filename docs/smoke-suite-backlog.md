# Smoke suite backlog (under `--auth-required`)

Status after the auth/fixture work (PRs #314–#319). **12 / 32 green.** This
enumerates the 20 remaining, grouped by root cause so they can be prioritized.
All runs assume the fixture is seeded (`node test/smoke/seed-fixture.mjs`) and
`NEWTCON_URL` + `NEWTCON_TEST_USER=ron` / `NEWTCON_TEST_PASS` are set.

## Green (12)
apply-results-modal, audit-reopen, auth-gate, delete-service-binding-warn,
deploy-as-lab, iface-actions, iface-table, network-switcher, override-collapse,
spec-tab-intent, staging, subrule-before-apply.

---

## A. Direct-newtron fetches → 401 under auth (mechanical)
Route the node-side fetch through newtcon `/api` with the session cookie
(`loginCookie`), the pattern already applied to staging/override-collapse.
**Caveat:** newtcon proxies device state as *collection* reads
(`/nodes/{device}/vlans|vrfs|acls|bgp/status`), not the per-id newtron paths the
smokes use — so these need fetch-collection-then-filter, not a 1:1 URL swap.

| Smoke | Direct call(s) | Fix |
|---|---|---|
| override-delete | `POST /delete-ipvpn` | newtcon `DELETE ipvpns/{n}?scope=…` + cookie (mirror override-collapse) |
| port-config | 2× `GET /topology` | newtcon `GET /api/networks/{n}/topology` + cookie |
| topology-e2e | 1× `/node/switch1/vlan/{id}` | newtcon `/nodes/switch1/vlans` + filter (+ has B) |
| per-device-apply | 3× `/node/switch1/vlan/{id}` | same VLAN-collection pattern (+ has B) |
| topology-broad | `/vrf/`, `/acl/`, `/bgp/status`, `/topology` | newtcon `/nodes/{d}/{vrfs,acls,bgp/status}` + filter (+ has B) |

## B. Topology deeper (navigation fixed in #319, more remains)
`.topo-node` now renders; these still fail on later steps.
| Smoke | Remaining |
|---|---|
| topology-e2e | VLAN read (A) + link/intent assertions |
| topology-broad | VRF/ACL/BGP reads (A) + `topology has links` assertion |
| per-device-apply | VLAN reads (A) + apply assertions |
| topology-menu | re-run after #319 to surface its next failure (likely A or assertion) |

## C. Later-element timeout (have the view setter, fail past `.topo-node`)
These already set `topology-view:spec` but time out (~6 s) on a drawer/element —
needs per-smoke selector/timing investigation.
- drawer-header, resource-lens, state-tables

## D. Stale create bodies — real schema drift
The smoke sends a create body newtron now rejects (400). Fix the body to the
current schema (e.g. the filter needing `type`, discovered while seeding).
- specs-drawer-edit (`create service` 400)
- specs-drawer-subrule (`add queue` 400)

## E. Element-interaction / profiles→nodes drift
- specs-drawer-services-zones ("Node is not clickable") — selector/timing
- topology-profile-tab ("Node not clickable"; the tab name predates profiles→nodes — likely renamed/removed)

## F. Assertion drift — bespoke, likely the smoke caught a real UI change
Read before greening; some encode an old contract.
- node-create-with-profile (**13** assertions fail — almost certainly the profiles→nodes rename; may need a near-rewrite)
- lags-neighbors (0/5 — LAG/neighbor tables; check fixture has LAGs/neighbors)
- node-scaffold (0/4 — Add-node scaffold flow)
- device-lifecycle (2 — start/stop/deploy lifecycle; may need a deployed device)
- device-status-badges (2 — status pills; may need live device state)
- topology-scope-services-only (2 — scoped-services topology filter)
- lab-tab-retired (1 — asserts the retired Lab tab is gone)

---

## Suggested order
1. **A** (mechanical, ~5 smokes) — same cookie pattern, unblocks B too.
2. **D** + **E** (stale bodies / selectors — small, and D catches real drift).
3. **C** (per-smoke timing).
4. **F** last — read each; some are real drift worth a design look, not just "make green."

Note: a few (device-lifecycle, device-status-badges, and the "live data" bits of
the topology smokes) may not be greenable against the **staged** fixture at all —
they need a **deployed** device. Those should be marked deploy-gated rather than
forced green.

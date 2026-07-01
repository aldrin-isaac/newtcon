# Smoke suite backlog (under `--auth-required`)

**18 / 32 PASS or SKIP** (up from 12 → 18 this pass; 3 at the effort's start).
Run with the fixture seeded (`node test/smoke/seed-fixture.mjs`) and
`NEWTCON_URL` + `NEWTCON_TEST_USER=ron` / `NEWTCON_TEST_PASS` set.

## Green / skip (18)
apply-results-modal, audit-reopen, auth-gate, delete-service-binding-warn,
deploy-as-lab, device-status-badges, iface-actions, iface-table, network-switcher,
override-collapse, override-delete, port-config, spec-tab-intent, staging,
subrule-before-apply — plus deploy-gated **skips** (exit 0): topology-e2e,
per-device-apply, topology-broad (device-state reads need a deployed device).

## Done this pass
- **A (direct-newtron auth):** override-delete, port-config routed through newtcon
  `/api` + cookie. The device-state topology smokes deploy-gated (`skipIfNotDeployed`).
- **device-status-badges:** updated to the #210 palette (`topo-elem--{spec-only|
  actuated-*|drift|unknown}`) + dropped the obsolete palette-vs-lifecycle match.
- **D (stale bodies):** specs-drawer-* auth-env aligned to `NEWTCON_TEST_PASS`/ron;
  `service_type` (not `type`); queue `dwrr` (not `wrr`).

## Remaining 14 — per-smoke UI drift (with next step)
| Smoke | Symptom | Root cause / next step |
|---|---|---|
| lab-tab-retired | nav asserts stale set | nav is `[Specs,Topology,Permissions,Changes,Audit]`; update the expected list |
| node-create-with-profile | no "+ Create node" in toolbar (`[Deploy,Provision,Destroy]`) | profiles→nodes + Add-node moved; retarget the create affordance |
| topology-profile-tab | "Node not clickable" (0/0) | "profile" tab renamed/removed (profiles→nodes); update the tab selector |
| specs-drawer-services-zones | "Node not clickable" | selector drift; find the current clickable element |
| node-scaffold | "topology device has a setup-device step" | scaffold-step assertion; verify against buildDeviceScaffold output |
| topology-scope-services-only | guiding hint text `null` | hint copy/selector changed |
| topology-menu | 404 resource | a fetch 404s (endpoint moved) during the menu flow |
| specs-drawer-edit | 8000ms timeout | UI element after create; find the current selector |
| specs-drawer-subrule | post-queue UI assertion | queue body fixed; a later UI check (queues section) drifted |
| drawer-header | 6000ms timeout | waits on a drawer element past `.topo-node`; per-smoke selector |
| resource-lens | 6000ms timeout | same class — the resource-lens section selector |
| state-tables | 6000ms timeout | same class — the State-tab table selector |
| lags-neighbors | LAG table empty | fixture has no LAGs — seed a LAG, or deploy-gate |
| device-lifecycle | lifecycle pill state `null` | 2node-vs lab IS running; the drawer lifecycle pill isn't resolving lab status — investigate as possible real bug vs. selector |

## Notes
- The three 6000ms-timeout smokes (drawer-header/resource-lens/state-tables)
  likely share one cause (an element that renders only in a view mode or with
  data the fixture lacks) — investigate together.
- device-lifecycle is worth a closer look: the lab is running yet the pill reads
  null. Could be a real resolution bug rather than test drift.
- lags-neighbors needs a LAG in the fixture (extend seed-fixture.mjs) or a
  deploy-gate.

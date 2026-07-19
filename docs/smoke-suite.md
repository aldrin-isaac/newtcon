# Smoke suite (`web/test/smoke/`)

28 headless Puppeteer smokes that drive the real UI against a running
newtcon-server (which proxies newtron). They run under `--auth-required` and are
**network-agnostic** — each smoke discovers or creates the data it needs via the
API instead of hard-coding one fixture's values, so the same smokes run against
any adequately-shaped network.

## Running

Prerequisites: a newtcon-server on `NEWTCON_URL` (default `http://127.0.0.1:8095`)
proxying a newtron with `--auth-required`, Chrome at `CHROME_BIN`, and the `ron`
nologin test superuser (see [`testing-auth.md`](testing-auth.md)).

```sh
export NEWTCON_URL=http://127.0.0.1:8095
export NEWTCON_TEST_USER=ron NEWTCON_TEST_PASS=…      # the ron service account
export CHROME_BIN=/usr/bin/google-chrome

# 1. Seed the fixture network (idempotent). Re-run before a suite — API-created
#    specs can be wiped by an engine reset.
node web/test/smoke/seed-fixture.mjs

# 2. Run one smoke (NET + DEVICE override the target; defaults smoke-fixture / switch1)
NET=smoke-fixture node web/test/smoke/drawer-header.smoke.mjs

# 3. Run the whole suite (console-uplift 0.1): sequential, per-smoke
#    PASS/FAIL/SKIP summary, non-zero exit on any failure.
cd web && npm run smoke                    # all smokes
cd web && npm run smoke -- --filter iface  # filename substring filter
```

The runner passes the environment through untouched. One convenience: when
`NEWTCON_URL` is `https://` and `NODE_TLS_REJECT_UNAUTHORIZED` is unset, it
sets it to `0` for the child processes — the smokes' Node-side `fetch()`
must tolerate the dev server's self-signed cert, matching the
`--ignore-certificate-errors` flag every smoke's browser launch carries.
Per-smoke wall-clock cap: `SMOKE_TIMEOUT_MS` (default 180000). Smokes that
exit 0 after printing a `SKIP:` line (deploy-gated reads against an
un-deployed network) count as skipped, not passed.

A smoke exits 0 on pass, non-zero on fail, and prints `SKIP: …` + exits 0 when it
can't run (a device-state smoke against a device with no live state).

## Network-agnostic — proving it

Fixture smokes **discover** identity/ports/services/zones via `apiGET`; device-state
smokes **self-create** their state via device RPCs and clean up. To prove the
discovery actually adapts, seed a *second* network with a distinct identity and run
the suite against both:

```sh
node web/test/smoke/seed-fixture.mjs                              # smoke-fixture: Force10-S6000 / AS 65001 / 10.1.0.1 / myzone
SMOKE_NET=3node-vs-newtcon node web/test/smoke/seed-fixture.mjs   # cisco-p200-32x100 / AS 64512 / 10.2.0.1 / zoneb
for f in web/test/smoke/*.smoke.mjs; do NET=3node-vs-newtcon node "$f"; done
```

`seed-fixture.mjs` carries a per-network `VARIANTS` table (platform/hwsku/ASN/
loopback/zone) and **upserts** node specs, so re-seeding an existing network
re-stamps its variant identity.

## The smokes

**Shell / workspace / lab (8)** — `apply-results-modal`, `audit-reopen`,
`auth-gate`, `deploy-as-lab`, `network-switcher`, `staging`, `lab-tab-retired`,
`device-status-badges`.

**Spec authoring (8)** — `specs-drawer-edit`, `specs-drawer-services-zones`,
`specs-drawer-subrule`, `spec-tab-intent`, `delete-service-binding-warn`,
`override-collapse`, `override-delete`, `subrule-before-apply`.

**Topology / device drawer (9)** — `drawer-header`, `iface-actions`, `iface-table`,
`port-config`, `topology-click-drawer`, `topology-profile-tab`, `node-scaffold`,
`node-create-with-profile`, `device-lifecycle`.

**Device-state — deploy-gated (3)** — `state-tables`, `lags-neighbors`,
`resource-lens`. These read live device state, so they `skipIfNotDeployed` (exit 0
with a SKIP) against a staged fixture and **pass against a running lab**:

```sh
NET=2node-vs node web/test/smoke/state-tables.smoke.mjs   # 2node-vs's switch1 serves live state
```

## Infrastructure

- **`_auth.mjs`** — `authRequired`, `loginCookie`, `authenticatePage` (installs the
  session cookie on a page before nav), `apiGET(net, path)` (the discovery
  primitive), `deviceIsDeployed`, `skipIfNotDeployed`.
- **`seed-fixture.mjs`** — idempotent 3-switch triangle + TRANSIT routed underlay
  (applied on the inter-switch endpoints) + EVPN-IRB service + supporting specs,
  with the per-network identity `VARIANTS`.
- **`testing-auth.md`** — the `ron` nologin-superuser recipe + curl cookie-jar.

## History

A 2026 pass took the suite from 3 passing to fully green under `--auth-required`,
then made every smoke network-agnostic (verified against smoke-fixture *and* the
distinct 3node-vs-newtcon). It surfaced exactly **one real product bug** — the
drawer-header identity subtitle went blank for offline/staged devices because it
read only the live `/info` probe (fixed to fall back to the NodeSpec, #324).

Retired along the way, as **features they tested were removed** (not as lost
coverage):

- `per-device-apply`, `topology-e2e`, `topology-broad` — tested the pre-#210
  action-panel "Create VLAN → apply" flow; #210 emptied `NODE_ACTIONS` (device
  config now flows through services + interfaces, covered by `resource-lens` +
  `iface-actions`).
- `topology-menu`, `topology-scope-services-only` — tested the docked action panel,
  retired in #333 (a single left-click a device now opens the drawer; link/node
  creation lives on the toolbar). Replaced by `topology-click-drawer`.

## Visual baseline (console-uplift 0.2)

`web/scripts/screenshots.mjs` captures the canonical view set (Specs,
Permissions, Topology spec/lab, drawer Interfaces/State/Spec, Apply-All
modal, Audit) to `web/test/visual-baseline/` (gitignored — per-host review
artifacts):

```sh
node web/scripts/screenshots.mjs            # capture/refresh the baseline set
node web/scripts/screenshots.mjs --compare  # capture "current" + build
                                            #   visual-baseline/compare.html
node web/scripts/screenshots.mjs --filter drawer   # subset by capture id
```

Same env as the smokes. The compare page shows baseline/current side by
side with a byte-size delta as a hint — review by eye; there is no
pixel-diff verdict. The uplift program's move-only phases use this to prove
"zero visual change"; the visual phases use it to review deliberate change.

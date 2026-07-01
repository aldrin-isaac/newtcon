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

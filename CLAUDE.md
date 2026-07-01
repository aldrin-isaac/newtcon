# newtcon Project — Claude Code Instructions

> **BINDING DIRECTIVE: read `docs/DIRECTIVE.md` FIRST.**
>
> It is the authoritative source for the operator workflow loop, the slice plan, team posture, vocabulary discipline, and quality gates. This file contains only the rules below that remain binding regardless of the directive.

newtcon is the operator-facing web console for newtron. The binding direction for *what* to build is in `docs/DIRECTIVE.md`. The rules below govern *how* every change must behave.

## 1. newtron API consumption rule

newtron is a separate application reached over HTTP. newtcon-server talks to `newtron-server` (configured by `--newtron-url`, default `http://127.0.0.1:18080`) using JSON-over-HTTP.

- **No `import "github.com/aldrin-isaac/newtron/..."` anywhere** in newtcon.
- No `replace` directive for newtron in `go.mod`.
- No vendoring of newtron source.
- No copy-paste of newtron internal types — newtcon defines its own DTOs in `internal/types/`.
- No subprocess invocation of `bin/newtron`.

All newtron HTTP traffic is mediated by **one package: `internal/newtronc/`**. No other package may construct an `http.Client` or call `http.Get` / `http.Post` against newtron-server's address.

If newtron's HTTP API does not expose what newtcon needs, follow the **Gap-Handling Protocol** below.

## 2. Gap-handling protocol

When implementing a slice an agent may discover that newtron's HTTP API does not expose required functionality. The agent MUST:

1. **Stop implementing.** Do not work around the gap.
2. **Open an issue** in the newtron repo titled `newtron HTTP API gap: <domain-term>`. The body must contain:
   - The gap described in domain terms.
   - The proposed HTTP shape newtron should expose.
   - An **"Existing newtron API surveyed"** section enumerating every route, handler, method, and type checked in `../newtron/pkg/newtron/api/handler.go`, `pkg/newtron/api/handler_node.go`, `pkg/newtron/api/handler_network.go`, `pkg/newtron/network/`, `pkg/newtron/types.go`, etc. Filing without this section is invalid.
3. **Mark the newtcon issue blocked** with a link to the newtron issue.
4. **Move to the next available slice** (or return to lead).

The survey is the operator's audit trail. Confabulated gap reports have shipped before; the survey forces verification.

Example precedents: `newtron#122` (register-network shouldn't require operator-supplied spec_dir path; closed) and the historical `newtron#53` (the original newtlab HTTP API gap — also closed; newtlab now exposes HTTP via `bin/newt-server`).

## 3. File ownership map

Every feature lives in one file. A reader must be able to guess where something is implemented from the file tree alone.

newtcon's outward HTTP surface mirrors newtron's geometry: network-scoped resources nest under `/api/networks/{netID}/...` (per PR #135). Network-agnostic surfaces (`/api/health`, `/api/networks`, `/api/labs/...`) sit flat.

```
cmd/newtcon-server/main.go    → process entry, flag parsing, server boot, route wiring
internal/server/              → HTTP routing infrastructure
  router.go                   → NewMux + ApplyMiddleware
  middleware.go               → logging, recovery, request ID
  context.go                  → request-context helpers (correlation ID, etc.)
  static.go                   → static asset serving + docs serving
internal/handlers/            → one file per resource family
  health.go                   → /api/health
  config.go                   → /api/config (deployment posture descriptor — auth_required, …)
  auth.go                     → /api/auth/{login,logout,whoami} (operator identity via newtron L2c bearer; cookie ↔ store; returns 404 when --auth-required is off)
  authorization.go            → /api/networks/{netID}/authorization (read-only inspector for newtron's grant table; slice 2.2)
  audit.go                    → /api/networks/{netID}/audit/{events,integrity} (forwards newtron's audit endpoints; slice #175.B)
  networks.go                 → /api/networks (list + register)
  services.go                 → /api/networks/{netID}/services
  network.go                  → /api/networks/{netID}/{ipvpns,macvpns,qos-policies,filters,prefix-lists,route-policies,nodes,zones,platforms} (list+detail+create+delete+sub-rules; "nodes" = newtron NodeSpec, formerly "profiles")
  nodes.go                    → /api/networks/{netID}/topology + /api/networks/{netID}/nodes/{device}/...
  lab.go                      → /api/labs (newtlab lifecycle: list / status / deploy / destroy / provision / events / per-node start/stop)
internal/newtronc/            → THE ONLY HTTP client of newtron-server
  client.go                   → http.Client, base URL, engine-base helpers
  tls.go                      → outbound TLS config (BuildTLSConfig: --newtron-ca-cert / --newtron-skip-tls-verify)
  auth.go                     → Login/Logout RPCs + WithBearer context plumbing + bearer-injecting RoundTripper
  authorization.go            → GetAuthorization (read newtron's live grant table; slice 2.2)
  audit.go                    → AuditEvents + AuditIntegrity (read newtron's audit log + L6 chain status; slice #175.B)
  errors.go                   → typed errors (UnavailableError, NotFoundError, ConflictError, ValidationError, UnauthenticatedError, AuthorizationError)
  services.go                 → service-related newtron calls
  network.go                  → network-level spec list + ShowSpec + writes
  nodes.go                    → topology + per-device + per-interface calls (incl. NodeProjectionDiff for slice #171.B)
  newtlab.go                  → newtlab-engine calls (labs list/status/deploy/destroy/provision/events/node-lifecycle)
internal/session/             → operator session store + cookie helpers + middleware (cookie ↔ {bearer,user,expires_at})
  session.go                  → Store, SetCookie/ClearCookie, Middleware, UserFromContext
internal/types/               → DTOs (request/response shapes) + error envelope kinds
web/                          → frontend (vanilla HTML + TypeScript-as-tsc per ADR-0002)
  src/                        → source
    index.html                → root workspace HTML
    app.ts                    → workspace entry + tab dispatch + topology view + drawers
    workspace.css             → workspace layout (consumes design-system tokens)
    shell.ts                  → app shell (sidebar, tabs, status pill, palette)
    auth-gate.ts              → login overlay + user pill + 401 redirect (slice 1.D)
    auth-gate.css             → styling for the login overlay + user pill
    api-path.ts               → /api/networks/{netID}/... URL helper (PR #135)
    network-switcher.ts       → active-network dropdown (PR #133)
    device-status.ts          → unified-substrate state resolver (PR #137)
    staging.ts                → workspace-level pending-changes queue
    topology-actions.ts       → declarative action specs (per-port: mode + service)
    topology-action-panel.ts  → docked side-panel renderer for actions + interfaces
    topology-actions-ui.ts    → floating right-click context menu
    icons.ts                  → inline-SVG icon set (Lucide)
    render-error.ts           → translateErrorKind + formatAuthorizationDetails + formatErrorBrief (shared error-rendering helpers; slice 2.1)
    form-error-binding.ts     → extractFieldFromValidationError + attachServerValidationToForm + clearFieldErrors (per-field server-error display; slice #172.B)
    topology-viewport.ts      → fitToBounds / zoomAt / panBy / viewBoxStr — pure SVG-viewBox pan/zoom math (Topology view; slice #174.A)
    topology-positions.ts     → loadPositions / savePosition / clearPositions — per-network node-position persistence in localStorage (Topology view; slice #174.B)
    permission-catalog.ts     → describePermission + groupFor + groupPermissions — curated per-permission human descriptions + operator-domain grouping (Permissions tab; slice #170.A)
    permission-derivations.ts → normalizeGrant + summarizeUser + summarizePermission + allUsers — forward + inverse member-of derivations on AuthorizationDetail (Permissions tab lookup; slice #170.B)
    permission-search.ts      → filterAuthorization — single-query substring filter for the Permissions tab (super-users + groups + permissions; matches wire-name / title / body / grant members; slice #170.C)
    apply-preview.ts          → previewQueue — pure derivation that turns the pending queue into a per-change preview (effect / kind / title / scope / danger / body) in apply order; powers the confirm-Apply-All modal (slice #171.A)
    smart-defaults.ts         → strategiesFor + nextAvailable + computePrefillForKind — async next-available-integer suggestion for create-form integer-ID fields (l3vni on ipvpns, vni on macvpns; slice #172.D)
    topology-filters.ts       → emptyFilter + isActive + applyFilter + uniqueZones — pure layered-filter helpers for the Topology view; zone dimension shipped, filter shape extensible to VRF / service (slice #174.E)
    subrule-table.ts          → getSubRuleItems + extractRowCells + itemKey + composeUpdateBody — pure helpers for the unified sub-rule inline table; backs the single-section table-then-add UI for qos-policies / filters / prefix-lists / route-policies (slice #173.A + per-row edit body composition for #173.B)
    action-history.ts         → buildEntry + load/save/append/clear + prependEntry — client-side per-network Apply All history persisted to localStorage (slice #175.A); newtron audit-log viewer is a separate slice
    history.ts                → mountHistoryTab — History tab view: expandable per-Apply entries with per-item outcome + error display (slice #175.A)
    empty-states.ts           → emptyStateFor + hasEmptyState — curated pedagogical empty-state copy (title + body + optional hint) for each spec facet; replaces the generic "(none defined)" with operator-language teaching (slice #169.A)
    projection-aggregator.ts  → groupByDevice + summarizeDiff — pure helpers backing the per-device projection in the apply-preview modal; fanout-and-aggregate over newtron's intent/projection-diff (slice #171.B)
    sample-network.ts         → SAMPLE_SEEDS + planLoad + summarisePlan — quickstart pure data + planner for the "Load sample" link under the empty Services facet (slice #169.E)
    audit-format.ts           → shortHash + formatTimestamp + eventStatusLabel + activeFilterCount — pure formatters backing the Audit tab (slice #175.B)
    audit.ts                  → mountAuditTab — Audit tab view: integrity badge + filter row + paged event table; reads newtron's audit endpoints via the typed client (slice #175.B)
    undo-plan.ts              → planUndo — pure planner that turns a HistoryEntry into the inverse Pending[]; undo is just a forward Apply via the existing modal (slice #175.C.1)
    topology-undo-capture.ts  → extractRemoveDeviceBody + extractRemoveLinkEndpoints + captureTopologyBodies — pure helpers that walk a fetched topology to extract pre-bodies for topology.remove-device + topology.remove-link undo (slice #175.C.1 polish)
    topology-palette.ts       → resolvePalette + resolveDevicePalette — pure resolver from per-element actuation observation to the unified five-state palette (spec-only / actuated-ok / actuated-down / drift / unknown); foundation for the layered Topology views (slice #210.A)
    auth-expiry.ts            → formatExpiryRelative + isNearExpiry + EXPIRY_WARN_THRESHOLD_MS (session lifetime presentation; slice 1 polish)
    spec-detail-shape.ts      → buildSpecDetailShape — pure helper that turns a FieldDef schema + spec data into the per-spec detail layout (labeled rows + "All fields" extras)
    port-config.ts            → mergePort + comparePorts — pure helpers for the schema-driven port-config flow: the device drawer's per-port "Properties" action (openPortPropsForm in app.ts) renders the PortConfig schema form; mergePort folds a chosen port's config into a whole-device write-back (PortConfig schema kind); comparePorts is the numeric interface-name ordering used wherever ports/interfaces are listed. (Port config used to have a second home in the Topology side panel's "Configure a port"; consolidated into the drawer.)
    device-interfaces.ts      → buildDeviceInterfaceView + deriveDeviceBindings + linksForDevice + countView + applyFilter — pure join that turns a device's scattered facts (platform inventory + topology port config + live interface read + service-binding/configure steps + topology links) into one sorted InterfaceRow per port; backs the device drawer's unified Interfaces table (configured AND available ports, role/status/service/link, inline apply)
    device-resources.ts       → deviceServiceUsage + countServiceInstances + shapeResourceRows + isHealthCheckList (+ VRF/VLAN/ACL/LAG/HEALTH/BGP_NEIGHBOR_COLUMNS) — pure resource-lens + State-table helpers: groups a topology device's apply-service steps by service → interfaces (the inverse of the interface table); shapeResourceRows turns a State resource list into curated columns (with derived cells + status flags); backs the State-tab "Services" section + every tailored State table (VRFs/VLANs/ACLs/LAGs/Neighbors/BGP neighbors)
    authorization.ts          → Permissions tab (read-only view of newtron's super_users + user_groups + permissions; slice 2.2)
    device-scaffold.ts        → buildSetupDeviceStep + buildDeviceScaffold — pure helper that builds a fresh topology device entry (a /setup-device bring-up step: hwsku + hostname + role + underlay ASN; empty ports) so "Add node" produces a service-ready node out of the box (#283)
    design-system/            → color, typography, spacing, motion CSS + README
    api/newtcon/              → typed clients for newtcon-server endpoints
      services.ts             → /api/networks/{netID}/services
      network.ts              → /api/networks/{netID}/{kind}/...
      nodes.ts                → /api/networks/{netID}/{topology,nodes/...}
      lab.ts                  → /api/labs/{name}/... (newtlab — not network-scoped)
      auth.ts                 → /api/auth/{login,logout,whoami}
      config.ts               → /api/config (deployment posture — auth_required, …)
      authorization.ts        → /api/networks/{netID}/authorization (super_users + user_groups + permissions)
    services/                 → Specs-tab service detail views
  test/                       → node:test files + puppeteer smokes (web/test/smoke/)
  dist/                       → tsc output (served by --web-dir)
docs/                         → DIRECTIVE.md + operator-philosophy.md + architecture.md (stub) + roadmap.md + adr/ + audits/ + historical/
```

When adding new endpoints, find the existing handler file by resource family; do not create new handler files unless adding a new resource family.

## 4. Build convention

Always `go build -o bin/newtcon-server ./cmd/newtcon-server`. `go run` compiles to a temp directory and breaks sibling binary resolution.

For the frontend: `cd web && npm run build` (runs `tsc --project tsconfig.json && node scripts/copy-static.js`). Pure CSS files in `src/` are copied to `dist/` by the copy-static step.

## 5. Allowed commands (no confirmation required)

- **Go**: `go build`, `go test`, `go vet`, `go mod tidy`, `go list`, `go doc`, `go version`
- **Frontend**: `npm install`, `npm run build`, `npm run test`, `npm run typecheck`, `npx <pinned-tool>`
- **Git**: `git status`, `git diff`, `git log`, `git add`, `git commit`, `git mv`, `git rm`, `git format-patch`, `git checkout` (branches), `git push`, `git pull`
- **GitHub**: `gh pr create|view|edit|merge|close|list`, `gh issue create|view|edit|close|list`, `gh api`
- **Misc**: `ls`, `stat`, `file`, `wc`, `curl`, `jq`, `grep`, `find`, `cat`, `head`, `tail`, `sed`
- **Server lifecycle**: `bin/newtcon-server ...` (start), `kill <pid>` / `pkill -f newtcon-server` (stop)
- **Web access**: `WebSearch` (always allowed); `WebFetch` for `github.com`, `pkg.go.dev`, framework docs

## 6. Regression prevention

Before changing any handler, the agent MUST:

1. List which endpoints exercise this handler.
2. Verify the change does not alter response shape unless intentional.
3. Run `go test ./... -count=1` and confirm all previously passing tests pass.
4. Run a live smoke test against newtron at `:18080` — confirm the affected endpoint still returns real data.

## 7. Greenfield — no backwards compatibility

newtcon is greenfield. No compatibility shims, no deprecated aliases, no dual-format detection. Delete, don't deprecate.

newtcon's outward `/api/*` surface is internal (browser ↔ newtcon-server in the same release); it has no version segment and changes in lockstep with the binary. The engine `/<service>/v1/...` paths (newtron, newtlab, newt-server) are newtron's external-API version surface — see DESIGN_PRINCIPLES_NEWTRON §40.

## What else lives where

- **Mission, scope, team posture, slice plan, vocabulary discipline:** `docs/DIRECTIVE.md`.
- **9 operator-philosophy invariants:** `docs/operator-philosophy.md`.
- **Accepted ADRs:** `docs/adr/`.
- **Active agent role specs:** `.claude/agents/implementer.md` (active), `.claude/agents/critic.md` (conditionally active). Other roles are dormant per the directive.
- **Universal behavioral directives for AI agents:** `../newtron/docs/ai-instructions.md`.
- **Documentation craft principles:** `../newtron/docs/editing-guidelines.md`.
- **Newtron's authoritative design principles:** `../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md`.
- **Historical 8-surface architecture, contract, team-launch:** `docs/historical/` (not authoritative).

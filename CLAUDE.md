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
  secrets.go                  → /api/networks/{netID}/secrets (write-only credential store: GET names / POST set / DELETE key; backs ${secret:…} authoring)
  ssh_credentials.go          → /api/networks/{netID}/{ssh-credentials,set-ssh-credentials,clear-ssh-credentials} (scoped SSH login: read authored / upsert / clear at network|zone|node; backs the "SSH Login" control)
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
  secrets.go                  → ListSecrets + SetSecret + DeleteSecret (network-scoped write-only secret store; values never returned)
  ssh_credentials.go          → ShowSSHCredentials + SetSSHCredentials + ClearSSHCredentials (scoped SSH-login scalar; set/clear/show at network|zone|node)
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
    dom.ts                    → el() + renderValue — the shared DOM helpers (consolidated from four per-module copies; uplift 1.1). renderValue redacts ssh_pass at any depth
    views/                    → workspace view registry (registry.ts + index.ts): top-level views register {panelId, mount, remountOnActivate}; the tab dispatcher consults viewFor(). History + Audit are residents; drawer/Topology migrate in uplift 1.3–1.4
    views/specs/              → the Specs view (uplift 1.2), decomposed one-concern-per-file; index.ts re-exports the public API (openDetail/closeDetail/displaySchemaFor/kindTitleFor/specsViewDegraded/applySpecsRoute/mountSpecsView) so the split stays internal
      index.ts                → view entry: mount, facet subnav + General section, active-facet state, applySpecsRoute + the public re-export barrel
      panels.ts               → the facet catalog: schema-driven PANELS discovery (cached, accessor-only), kindTitleFor, specsViewDegraded, SPEC_GROUPS + resolveGroupings
      facet-panels.ts         → the per-facet list: loadFacetRows, scope-nested rows (base + zone/node overrides), + Add / + override / × affordances, empty states, sample-seed quickstart
      detail.ts               → the spec detail drawer: openDetail/closeDetail + the cross-reference sections (a service's Bindings; "Used by services" for every other kind)
      drawers.ts              → the authoring drawers: create, edit, and "add override" (schema-driven, with the legacy specForms fallback); all stage onto the pending queue
      subrules.ts             → the sub-rule inline table (slice #173): the per-kind subRuleTables definitions AND their renderers (add/edit/delete/reorder), kept together as the single source of truth
      fields.ts               → the legacy FieldDef vocabulary: PATTERNS, specForms, displaySchemaFor, isEditableKind, buildFormFields (fallback path + the shape sub-rule forms use)
      ssh-login.ts            → the General → SSH Login facet: scoped ssh_user/ssh_pass authoring via the ${secret:} store
      route-state.ts          → announceRoute — the view's "newtcon:route-state" announce to router.ts
    views/drawer/             → the device drawer (uplift 1.3), one file per tab
      index.ts                → drawer core: openNodeDrawer, the pinned mini-header, the async header (identity/stats/badges/actions), NODE_TABS + loadNodeTab dispatch
      interfaces.ts           → Interfaces tab + IRB section
      state.ts                → State tab + Debug tab (Projection / Intent Tree; embeds config-db.ts)
      spec-tab.ts             → Spec tab: node spec + topology intent (provisioning steps + port config)
      drift.ts                → Drift tab + the Reconcile preview/apply flow
      history.ts              → History tab (per-device audit timeline)
      config-db.ts            → the lazy 3-level CONFIG_DB browser the Debug tab embeds
      lifecycle.ts            → the substrate section: state pill, lab-VM start/stop, SSH/console snippets
      link-drawer.ts          → the LINK drawer (a different drawer, same #detail-drawer element)
    views/topology/           → the Topology view (uplift 1.4), decomposed one-concern-per-file; index.ts re-exports the public API (mountTopologyTab/stopTopologyPoll/isProvisioning/TopoLink) so the split stays internal
      index.ts                → mount orchestration: owns the view's live state (view mode, lens, zone filter, viewport, pinned positions, palette/status-text maps, cached lab state) + the render fns that read it, and the public re-export barrel
      canvas.ts               → the SVG renderer: topology shape adapter, layout cache (+ resetLayoutCache), zones, links (neighbour-aware seating + occlusion routing + live drag-follow), device cards, badges, pan/zoom wiring
      chrome.ts               → static canvas furniture: zoom toolbar, nav hint, link-truth legend, empty state (pure builders; stateful chip rows stay in index.ts)
      device-probe.ts         → probeDevices: the per-device fan-out (reachability, drift, LLDP, port state/speeds, LAG members, underlay health), all best-effort
      status-poll.ts          → the 5s newtlab-status poll + patchDeviceStatuses (in-place DOM patch, never a re-render) + stopTopologyPoll
      live-heat.ts            → the Live lens's per-link heat poll (createHeatPoll factory; owns its timer so stopTopologyPoll can kill it)
      lab-ops.ts              → deploy / provision modals over a shared SSE-streaming shell + the provisioning marker (isProvisioning)
      add-link.ts             → the Add-link drawer (platform-inventory endpoint pickers + inline "configure with defaults")
      port-tip.ts             → the fast hover tip for canvas dots (singleton overlay; native <title> is ~1s slow)
    app.ts                    → workspace entry only: mount() + drawer-chrome wiring (~60 lines; every view lives in views/, navigation in router.ts)
    route.ts                  → pure hash-route codec (uplift 2.4): parseHash/formatHash for #/{net}/{view}[+params] + retargetHashToNetwork
    router.ts                 → navigation owner (uplift 2.4): tab switching (was app.ts setupTabs), hash ↔ state sync, deep-link apply on boot, back/forward via hashchange; views announce params via "newtcon:route-state" CustomEvents
    workspace.css             → workspace layout (consumes design-system tokens)
    shell.ts                  → app shell (sidebar, tabs, status pill, palette, theme toggle)
    theme.ts                  → light/dark theme owner: data-theme stamp at boot (stored pref ?? DARK — the default per Phase-6 exit), toggleTheme persistence
    auth-gate.ts              → login overlay + user pill + 401 redirect (slice 1.D)
    auth-gate.css             → styling for the login overlay + user pill
    api-path.ts               → /api/networks/{netID}/... URL helper (PR #135)
    network-switcher.ts       → active-network dropdown (PR #133)
    device-status.ts          → unified-substrate state resolver (PR #137)
    staging.ts                → workspace-level pending-changes queue
    topology-actions.ts       → declarative action specs (per-port: mode + service; NODE_ACTIONS empty post-#210) + INTERFACE_ACTIONS used by the drawer Interfaces tab
    topology-actions-ui.ts    → floating right-click context menu (Inspect / delete)
    icons.ts                  → inline-SVG icon set (Lucide)
    render-error.ts           → translateErrorKind + formatAuthorizationDetails + formatErrorBrief (shared error-rendering helpers; slice 2.1)
    form-error-binding.ts     → extractFieldFromValidationError + attachServerValidationToForm + clearFieldErrors (per-field server-error display; slice #172.B)
    topology-viewport.ts      → fitToBounds / zoomAt / panBy / viewBoxStr — pure SVG-viewBox pan/zoom math (Topology view; slice #174.A)
    topology-positions.ts     → loadPositions / savePosition / clearPositions — per-network node-position persistence in localStorage (Topology view; slice #174.B)
    topology-zones.ts         → collapseZones + zoneNodeId/zoneOfNodeId + loadCollapsedZones/saveCollapsedZones — pure zone-fold graph transform for the Topology canvas: a collapsed zone's members leave the graph and become ONE synthetic card, crossing links re-terminate on it (parallel ones merging with an `aggregate` count), intra-zone links vanish. The density affordance for large fabrics; choice persists per network
    permission-catalog.ts     → describePermission + groupFor + groupPermissions — curated per-permission human descriptions + operator-domain grouping (Permissions tab; slice #170.A)
    permission-derivations.ts → normalizeGrant + summarizeUser + summarizePermission + allUsers — forward + inverse member-of derivations on AuthorizationDetail (Permissions tab lookup; slice #170.B)
    permission-search.ts      → filterAuthorization — single-query substring filter for the Permissions tab (super-users + groups + permissions; matches wire-name / title / body / grant members; slice #170.C)
    apply-preview.ts          → previewQueue — pure derivation that turns the pending queue into a per-change preview (effect / kind / title / scope / danger / body) in apply order; powers the confirm-Apply-All modal (slice #171.A). Also deliveryDevices + deliveryLabel — the pure half of the modal's per-device Delivery section (online → "delivers to device" actuated apply; offline → "authors intent", actuates at provision), mirroring applyDevice's mode rule
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
    topology-links.ts         → pure link-truth engine (uplift 4.2): parseLldpTable/parsePortSpeeds/classifyLink (verified/intent-only/mismatch) + linkStrokeWidth/linkSpeedForLink + parseBgpCheckOk/linkUnderlayState
    topology-lenses.ts        → pure lens engine (uplift 4.3): vlanMembership/availableVlans/lensEffect — vni/underlay/drift/live lenses resolve to halo/dim/badge sets, never layout
    topology-live.ts          → pure live-layer derivations (uplift 4.4): COUNTERS_DB parsing (port-name-map, RATES), portUtilization, heat tiers, shouldPollLive gate
    topology-focus.ts         → pure focus-mode derivations (uplift 4.5): neighborsOf/focusDim + nearestInDirection arrow-nav
    fabric-health.ts          → pure header-strip aggregation (uplift 4.5): aggregateFabricHealth folds underlay/drift/lab maps into three toned cells
    drawer-resize.ts          → user-resizable drawer width: left-edge grab handle (drag; double-click resets), clampDrawerWidth bounds, per-browser persistence via --drawer-user-width (both docked + overlay modes; contents reflow — tables are width:100%)
    fabric-health-strip.ts    → the topology-header fabric-health strip (re-homed from global chrome): 60s sweep gated on visibility of the topology panel, mounted by the topology view's header bar, click → refresh
    topology-palette.ts       → resolvePalette + resolveDevicePalette — pure resolver from per-element actuation observation to the unified five-state palette (spec-only / actuated-ok / actuated-down / drift / unknown); foundation for the layered Topology views (slice #210.A)
    auth-expiry.ts            → formatExpiryRelative + isNearExpiry + EXPIRY_WARN_THRESHOLD_MS (session lifetime presentation; slice 1 polish)
    spec-detail-shape.ts      → buildSpecDetailShape — pure helper that turns a FieldDef schema + spec data into the per-spec detail layout (labeled rows + "All fields" extras)
    spec-render.ts            → THE shared spec/detail render helpers (renderLoadingInto / renderErrorInto / renderValueInto / toSpecField / renderSpecDetailInto + the ref-chip cross-link). Top-level because BOTH views/specs and views/drawer need them — they used to sit in views/drawer/index.ts, which made Specs reach into a sibling view for generic rendering
    port-config.ts            → mergePort + comparePorts — pure helpers for the schema-driven port-config flow: the device drawer's per-port "Properties" action (openPortPropsForm in app.ts) renders the PortConfig schema form; mergePort folds a chosen port's config into a whole-device write-back (PortConfig schema kind); comparePorts is the numeric interface-name ordering used wherever ports/interfaces are listed. (Port config used to have a second home in the Topology side panel's "Configure a port"; consolidated into the drawer.)
    device-steps.ts           → parseDeviceSteps — THE topology step-parser (uplift 1.5): normalizes a device entry's steps (guards + interface-verb URL split + spec_name); device-interfaces / device-resources / irb-interfaces are domain logic over its records
    device-model.ts           → loadDeviceModel — the one fetch bundle for a device's scattered facts (spec platform + topology entry/links + live ifaces + live VLANs, inventory-first with liveUnavailable flag); consumed by views/drawer/interfaces
    device-interfaces.ts      → buildDeviceInterfaceView + deriveDeviceBindings + linksForDevice + countView + applyFilter — pure join that turns a device's scattered facts (platform inventory + topology port config + live interface read + service-binding/configure steps + topology links) into one sorted InterfaceRow per port; backs the device drawer's unified Interfaces table (configured AND available ports, role/status/service/link, inline apply)
    device-resources.ts       → deviceServiceUsage + countServiceInstances + shapeResourceRows + isHealthCheckList (+ VRF/VLAN/ACL/LAG/HEALTH/BGP_NEIGHBOR_COLUMNS) — pure resource-lens + State-table helpers: groups a topology device's apply-service steps by service → interfaces (the inverse of the interface table); shapeResourceRows turns a State resource list into curated columns (with derived cells + status flags); backs the State-tab "Services" section + every tailored State table (VRFs/VLANs/ACLs/LAGs/Neighbors/BGP neighbors)
    interface-status.ts       → formatBps/formatPps/formatCount + lldpFarEnd + counterPairs + hasCounterAlerts + neighborLines — pure shapers/formatters for the per-interface LIVE STATUS panel (device drawer → Interfaces → expand a port); backs the newtron #431 console-diagnostics read (interfaces/{iface}/status: counters/rates/ARP/LLDP far-end/optics). Rendering is renderIfaceLiveStatus in app.ts
    irb-interfaces.ts         → deriveIrbRows + pendingCreateVlanIds + macvpnVlanHints — pure join of a device's VLAN interfaces (SVIs) from live /vlans read + topology intent steps (create-vlan / bind-macvpn / interfaces/VlanN/apply-service) + staged create-vlan actions; backs the drawer's "IRB interfaces (VLAN)" section (rows expand to the LIVE STATUS panel; Apply-service on the SVI; "+ Add VLAN interface" stages create-vlan). Rendering is renderIrbSection/renderIrbRow/openAddVlanForm in app.ts
    authorization.ts          → Permissions tab (read-only view of newtron's super_users + user_groups + permissions; slice 2.2)
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

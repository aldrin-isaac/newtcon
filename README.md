# newtcon

Operator-facing web console for [newtron](../newtron). Single-page application
plus HTTP server, designed for network operators who already understand the
substrate and want fast, structured leverage on intent-modeled network state.

newtcon is not a topology editor and not a status dashboard. The primary
surfaces are:

- **Service Composer** — multi-target service apply/refresh/remove with live
  ChangeSet preview.
- **Operator Inbox** — drift, convergence stragglers, partial operations, and
  reconcile-due signals rendered as actionable work cards.
- **Change Workbench** — git-style staging for batched intents with dry-run
  preview and atomic commit.

## Status

Alpha. Not for production. Built primarily by an agent team (see
[`AGENTS.md`](AGENTS.md)) operating against the [`API_CONTRACT.md`](API_CONTRACT.md).

## Relationship to newtron

newtron is a separate application. newtcon-server talks to newtron-server
over HTTP — the same way the `bin/newtron` CLI does. newtcon does **not**
import any newtron Go package; the boundary is a network address, not a Go
module dependency.

If newtcon needs functionality newtron's HTTP API does not expose, the gap is
written up as a newtron issue — never patched locally, never worked around by
subprocess-invoking the CLI. See [`CLAUDE.md`](CLAUDE.md) §Gap-Handling
Protocol and [`AGENTS.md`](AGENTS.md).

## Build

```
go build -o bin/newtcon-server ./cmd/newtcon-server
```

## Provenance

newtcon is a continuation of the same authorial exercise that produced newtron.
See [newtron's PROVENANCE.md](../newtron/docs/PROVENANCE.md).

Copyright © 2026 Aldrin Isaac. All rights reserved.

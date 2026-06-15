# newtcon

Operator-facing web console for [newtron](../newtron) — a single-page
TypeScript frontend plus a Go HTTP server that talks to a running
newtron-server over HTTP.

## Status

Alpha. Built primarily by an agent team (see [`AGENTS.md`](AGENTS.md))
operating against newtron's published HTTP contract.

## Quickstart — anonymous playground

Newtron and newtcon both default to anonymous, cleartext, no-auth mode so
a fresh clone reaches the workspace with one command per binary and no
PAM / certs / grants set up first.

```sh
# Terminal 1 — newtron (from ../newtron)
bin/newt-server --spec-dir <path/to/spec-dir>

# Terminal 2 — newtcon (from this repo)
go build -o bin/newtcon-server ./cmd/newtcon-server
bin/newtcon-server --newtron-url=http://127.0.0.1:18080
```

Open `http://127.0.0.1:8080` — no login overlay, no `--insecure` curls,
straight into Specs / Topology. Define a service, push to a node, watch
drift. That's the core value proposition; everything else is opt-in.

The startup log emits a WARNING reminding the operator that auth is off
and that production deployments must flip it on.

## Production posture — opt in per layer

Every security layer is one explicit flag, on both binaries:

```sh
# newtron
bin/newt-server \
  --tls-cert  /etc/newtron/server.crt \
  --tls-key   /etc/newtron/server.key \
  --tls-ca    /etc/newtron/ca.crt \
  --auth-pam-service newtron-prod \
  --enforce-authorization \
  --audit-log /var/log/newtron-audit.jsonl \
  --spec-dir  /etc/newtron/specs

# newtcon
bin/newtcon-server \
  --tls-cert  /etc/newtcon/server.crt \
  --tls-key   /etc/newtcon/server.key \
  --auth-required \
  --newtron-url=https://newt-server.example.com:18443
```

Layers each binary exposes:

| Layer | newtron flag | newtcon flag |
|---|---|---|
| Encrypted listener | `--tls-cert` / `--tls-key` | `--tls-cert` / `--tls-key` |
| Verified upstream cert | (n/a) | `--newtron-ca-cert` (default: system roots) |
| User authentication | `--auth-pam-service NAME` | `--auth-required` (drives the login overlay) |
| Permission enforcement | `--enforce-authorization` | (consumes 403s as `authorization_failure`) |
| Audit log | `--audit-log PATH` | (n/a — newtron owns the audit boundary) |

### One alignment to keep in mind

Newtron's `--enforce-authorization` (the permission gate) and newtcon's
`--auth-required` (the login UX) are separate flags. If newtron is in
production posture but newtcon is still in anonymous mode, the operator
will see a 403 from newtron whenever they try to mutate state.
newtcon surfaces those as `permission denied: <caller> lacks
<permission> on <resource>` — the fix is to flip newtcon's
`--auth-required` so the operator can sign in.

## Relationship to newtron

newtron is a separate application. newtcon-server talks to newtron-server
over HTTP — the same way the `bin/newtron` CLI does. newtcon does **not**
import any newtron Go package; the boundary is a network address, not a Go
module dependency.

If newtcon needs functionality newtron's HTTP API does not expose, the gap
is written up as a newtron issue — never patched locally, never worked
around by subprocess-invoking the CLI. See [`CLAUDE.md`](CLAUDE.md)
§Gap-Handling Protocol and [`AGENTS.md`](AGENTS.md).

## Build

```sh
go build -o bin/newtcon-server ./cmd/newtcon-server
cd web && npm run build
```

Tests:

```sh
go test ./... -count=1
cd web && npm test
```

Headless puppeteer smokes (require a running newtcon-server) live in
`web/test/smoke/`.

## Provenance

newtcon is a continuation of the same authorial exercise that produced
newtron. See [newtron's PROVENANCE.md](../newtron/docs/PROVENANCE.md).

Copyright © 2026 Aldrin Isaac. All rights reserved.

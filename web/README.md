# newtcon web frontend

Vanilla HTML + TypeScript-as-typed-ES-modules per
[docs/adr/0002-frontend-framework.md](../docs/adr/0002-frontend-framework.md).

## Build

```
cd web
npm install
npm run build
```

`npm run build` runs two steps in sequence:

1. `tsc --project tsconfig.json` — compiles `src/**/*.ts` to ES modules under `dist/`.
2. `node scripts/copy-static.js` — copies `src/**/*.html` and `src/**/*.css` into `dist/`,
   preserving subdirectory structure.

After `npm run build`, `dist/` is a self-contained directory of static assets that
`newtcon-server` serves verbatim when started with `--web-dir web/dist`.

## Type-check (no build output)

```
cd web
npm run typecheck
```

Runs `tsc --noEmit`. Use this in CI or during development when you want type
errors without emitting files.

## Test runner

The test runner is Node.js's built-in `node:test` module (available since
Node v18; project targets Node v22). Tests live under `web/test/` and use
the `.test.js` extension. A small DOM stub is provided at `test/lib/dom-stub.js`
for unit-level rendering tests that need minimal DOM APIs without a full
browser.

To run tests:

```
cd web
npm run build   # tests import from dist/, not src/
npm test
```

`vitest` was considered and rejected at scaffold time (newtcon#104): Node's
built-in `node:test` covers the assertion needs of F1–F3 without adding a
second devDependency. If a future surface needs a richer assertion vocabulary
or snapshot testing, an ADR should evaluate `vitest` at that point.

## Import path convention

Each TypeScript source file at `web/src/foo/bar.ts` imports other modules
using `.js` extensions:

```ts
import { fetchServices } from "./api/newtcon/services.js";
```

The reason: `tsc` compiles `.ts` files to `.js` files under `dist/`; the
browser loads the `.js` files; the import paths in the emitted JS must
therefore reference `.js`. With `moduleResolution: "node16"`, TypeScript
enforces that `.ts` source files use the `.js` extension in their import
paths so that the emitted paths are browser-loadable without a bundler.

This is a one-time cost per import path. The payoff is no bundler.

## Directory layout

```
web/
  src/
    index.html              HTML shell served at /
    app.ts                  browser entry module (<script type="module">)
    api/
      newtcon/              typed clients for newtcon-server endpoints
      newtrun/              typed clients for newtrun-server endpoints
    design-system/          plain CSS files (typography, color, spacing, motion)
                            — populated by F3 (newtcon#106)
    surfaces/               one subdirectory per top-level operator surface
    workflows/              workflow-layer modules composing two backends
  dist/                     build output (gitignored)
  scripts/
    copy-static.js          post-tsc step: copies *.html and *.css into dist/
  test/                     Node node:test unit tests
  package.json
  package-lock.json
  tsconfig.json
  README.md                 (this file)
```

## Serving with newtcon-server

```
go build -o bin/newtcon-server ./cmd/newtcon-server
bin/newtcon-server --web-dir web/dist
```

The `--web-dir` flag (default: `web/dist`) points `newtcon-server` at the
built static assets. API routes (`/api/*`) are served by their registered
handlers; everything else falls through to `http.FileServer` over `--web-dir`.

When `--web-dir` is empty or the directory does not exist, `newtcon-server`
logs a warning and skips static serving. All `/api/*` handlers remain active.

Two additional flags control operator documentation serving (F2, newtcon#105):

- `--docs-dir` (default: `docs`) — directory served at `/docs/`. When run
  from the repo root, `docs/operator-philosophy.md`, `docs/adr/*.md`, and
  other reference documents resolve as local links in the browser.
- `--docs-root-dir` (default: `.`) — repository root; `CLAUDE.md` and
  `API_CONTRACT.md` are served from here at `/CLAUDE.md` and
  `/API_CONTRACT.md` respectively.

Substrate-vocabulary link strategy (newtcon#105): **Option (b) — local serving.**
All operator-facing pages link to `/docs/...`, `/CLAUDE.md`, and
`/API_CONTRACT.md` as local paths that `newtcon-server` resolves from the
filesystem. This is more substrate-honest than GitHub-hosted links: the operator
reads the documentation that shipped with the running binary, not a potentially
diverged remote branch. When started with the default flags from the repo root,
all substrate links resolve correctly without network access.

## Running the services-listing page (newtcon#105)

After building and starting the server from the repo root:

```
go build -o bin/newtcon-server ./cmd/newtcon-server
cd web && npm run build && cd ..
bin/newtcon-server --web-dir web/dist --newtron-url http://127.0.0.1:9090
```

Open `http://localhost:8080/` — the root redirects to
`/surfaces/services/` which shows the services-listing page.

### Verifying acceptance criteria

| Criterion | Verification |
|-----------|-------------|
| Loading state | Open devtools Network tab; throttle to Slow 3G; reload. "Loading…" appears before the fetch completes. |
| Success render | With newtron running: the table shows service name and type. No instance_count / health column present. |
| Empty state | With an empty newtron network: "No service specs registered in this newtron network." + manual-mode parity link. |
| newtron_unavailable error | Start without newtron (`--newtron-url` pointing at nothing): page shows kind `newtron_unavailable`, `underlying_error`, and `next_action_hint.rationale`. |
| Other API error | Not triggerable at services listing in normal operation; covered by unit tests. |
| Network error | Stop `newtcon-server` while the page is open; refresh: "newtcon-server is unreachable from this browser." |
| Substrate links | Click "the substrate" in the page subtitle → `/docs/operator-philosophy.md` loads. Click footer links → each resolves locally. |
| No zero-valued fields | Inspect rendered HTML; no instance_count / health values are present. |

// Package hygiene holds repo-wide quality gates that belong to no single
// package — the Go-side counterpart to web/scripts/ratchet.mjs, which the
// frontend runs first in `npm test`.
//
// There is no CI and no Makefile in this repo; `go test ./...` (CLAUDE.md §6,
// required before any handler change) is the one command everything passes
// through, so a gate that wants to be enforced has to live in a test. Anything
// here must be fast, deterministic, and skip rather than fail when the tool it
// needs is unavailable — a missing local tool is not a code defect.
package hygiene

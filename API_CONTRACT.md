# newtcon HTTP API Contract — superseded

The 8-surface contract (Service Composer / Inbox / Workbench / Provenance / Rehearsal / Manual-Mode Parity / Observation History / Report Bug) previously documented here is **superseded for current UI work**. The binding direction for newtcon is captured in **`docs/DIRECTIVE.md`** (6-step operator workflow loop).

**Binding interface for current UI work:** newtron's actual HTTP API as defined in `../newtron/pkg/newtron/api/handler.go` `buildMux()`. Verified directly against newtron source; not paraphrased.

**Historical content** (kept for reference, not authoritative): `docs/historical/API_CONTRACT_2026-05-29.md`.

If you (agent or lead) need to inform a design decision with what newtron actually exposes today, read `pkg/newtron/api/handler.go` and the related handlers in `pkg/newtron/api/handler_network.go` and `pkg/newtron/api/handler_node.go`. Do not rely on the archived contract.

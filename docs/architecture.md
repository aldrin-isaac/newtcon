# newtcon Architecture — superseded

The 8-surface architecture previously documented here is **superseded** by the 6-step operator workflow loop in **`docs/DIRECTIVE.md`**.

**Background still accurate** (in the historical doc): the 3-tool layering of newtron (per-device configurator) + newtrun (orchestration engine) + newtlab (lab realizer) per ADR-0001. The surface partition described in the historical doc (Composer / Inbox / Workbench etc.) is the part that no longer applies.

**Authoritative tool docs:**
- newtron: `../newtron/docs/newtron/hld.md` + `../newtron/pkg/newtron/api/handler.go`
- newtrun: `../newtron/docs/newtrun/hld.md` + `../newtron/pkg/newtrun/api/`
- newtlab: `../newtron/docs/newtlab/hld.md` + `../newtron/pkg/newtlab/` (no HTTP server yet — see newtron#53)

**Historical content** (kept for reference, not authoritative): `docs/historical/architecture_2026-05-29.md`.

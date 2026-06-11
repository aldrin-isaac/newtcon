# Upstream update — newtron L2c (PAM-issued session keys)

**Source:** `../newtron/docs/newtron/auth-design.md` §L2c, newtron
PR #143 (merged 2026-06-10).
**Why this matters here:** L2c was designed specifically to unblock
browser clients. newtcon is the browser client. This update tells the
lead what shipped, what the wire surface is, and what newtcon would
need to do to adopt it. **It does not commit newtcon to adopting it
yet** — promotion is operator-driven per `DIRECTIVE.md`.

---

## What shipped in newtron

A successful PAM authentication can now mint an opaque session key
the client carries on subsequent requests as `Authorization: Bearer
<key>`. The key resolves to the same verified Unix username PAM
returned; downstream identity, authorization (L3/L4/L5), and audit
(L1/L6) consume it identically to fresh PAM credentials.

Wire surface (per `../newtron/docs/newtron/pam-howto.md` §7):

```
POST /newtron/v1/auth/login          (Authorization: Basic …)
→ 200 { "key": "<43-char URL-safe base64>",
        "expires_at": "2026-06-11T08:00:00Z",
        "user": "alice" }

POST /newtron/v1/auth/logout         (Authorization: Bearer …)
→ 204 No Content (idempotent)

every other newtron route now also accepts Authorization: Bearer …
```

Server-side flags (must be on the `newtron-server` invocation —
`newt-server` does not yet expose PAM):

- `--auth-pam-service=<name>` enables L2b (PAM). L2c auto-engages
  with it.
- `--session-key-ttl=<dur>` tunes absolute key lifetime (default
  `8h`). Using a key does NOT extend it.
- `--session-key-ttl=-1` suppresses L2c while keeping L2b — every
  request hits PAM directly.

Server restart invalidates every key (in-memory store; no
persistence by design).

## Why this is the right primitive for newtcon

The current `internal/newtronc/Client` sends requests with no caller
identity attached. That works only against a server with
`--enforce-authorization=false` or against the aggregated
`newt-server` in its current PAM-less form. Against any
production-grade newtron deployment, every newtcon request would
401 or 403.

Three plausible identity mechanisms for newtcon:

| Option | Verdict | Why |
|---|---|---|
| **Embed Basic auth in every fetch.** Operator types password into a newtcon login page, newtcon stores it in memory and sends it on every backend call. | Wrong. | The browser holds an unhashed password. JS storage is hostile turf. Plus every fetch hits PAM (directory or KDC round-trip per click). |
| **Self-attested `X-Newtron-Caller` header.** The current test-suite mechanism. | Wrong. | newtron docs are explicit: this is "trustworthy only when the operator's deployment confirms no untrusted client can reach the listener." A browser doesn't fit. |
| **L2c session keys.** Operator signs in once via Basic (newtcon → `/auth/login`), newtcon stores the key in memory or a `Secure; HttpOnly; SameSite=Strict` cookie, presents it on every subsequent call. | Right. | Password leaves memory the moment login returns. Bounded TTL. Revocable. PAM hit once per session, not per click. Exactly what L2c was designed for. |

## What newtcon would need to do to adopt

This is a recommendation list for the lead to decide on, not a
slice spec. Sized order-of-magnitude:

1. **Login page** — minimal HTML form, two fields. On submit,
   newtcon-server proxies the Basic auth to newtron's `/auth/login`,
   captures the returned `{key, expires_at, user}`, and either:
   - stores the key on a session cookie set by newtcon-server
     (`Secure; HttpOnly; SameSite=Strict`), or
   - returns it to the browser for in-memory storage.

   The cookie approach is simpler and keeps the key out of JS. The
   in-memory approach is more robust to XSS (no cookie to steal) but
   the trade-off is the session dying on every reload. Operator
   call.

2. **`internal/newtronc/Client` carries a Bearer header.** Three
   options:
   - Per-request: caller passes the key into each method call.
     Explicit but verbose.
   - On the `Client`: `WithSessionKey(key string)` Option at
     construction. Implicit, clean.
   - On the `http.Client.Transport`: a `RoundTripper` wrapper that
     injects the header. Fully transparent.

   The transport approach is the right pattern for a client whose
   identity is fixed for the request's lifetime — matches stdlib
   conventions.

3. **Newtcon-server holds the cookie → key mapping.** When the
   browser sends a session cookie, newtcon-server looks up the key
   it stored at login, constructs a per-request newtronc.Client
   with that key, and proxies the request. The key never crosses
   the browser ↔ newtcon-server boundary as a header — only as a
   cookie newtcon-server set.

4. **Expiry handling.** When newtron 401s with "invalid or expired
   session key", newtcon-server clears the cookie and redirects to
   the login page. Standard pattern; no surprises.

5. **Logout.** `POST /api/logout` on newtcon-server → proxy to
   newtron `/auth/logout` → clear the cookie. The browser ends up
   back at the login page on the next request.

## Open design questions for the lead

These are the calls the lead would close before opening an
implementation slice. None of them block today's work — they're
listed so they're visible:

- **Cookie vs. in-memory?** Cookie is simpler; in-memory is
  XSS-tolerant. Recommendation: cookie, because newtcon's operator
  threat model is "trusted operator on a trusted workstation," not
  "untrusted browser tab." But the lead decides.
- **`newt-server` parity.** Does the lead want to wait until
  `newt-server` has a `--auth-pam-service` flag, or adopt L2c
  against a standalone `newtron-server`? Today the suites use
  `newt-server` exclusively. If newtcon adopts L2c, the deployment
  expectation flips. Worth flagging upstream.
- **Auto-login during dev?** A `--no-auth` newtcon-server flag for
  local development (talk to a newtron without
  `--enforce-authorization`) keeps the dev loop cheap. Default
  prod-mode and document the override.
- **Multi-engine sessions.** L2c is newtron-only today. If newtcon
  ever needs `/newtlab/v1/*` or `/newtrun/v1/*` with caller
  identity, a separate session mechanism would be needed (or the
  upstream work to promote L2c into `httputil` lands first).
  Filing that visibility upstream might be worth doing if newtcon
  cares about it within the next slice or two.

## Open questions for upstream

Worth raising on the newtron side if the lead wants any of these:

- **Cookie endpoint?** L2c returns JSON. A `Set-Cookie`-based
  variant of `/auth/login` would let newtcon-server skip the
  JSON-then-cookie translation step. Not blocking; nice to have.
- **Refresh tokens.** Explicitly out of scope in L2c — using a key
  doesn't extend its lifetime. If 8h is too short for newtcon's
  expected sessions, the operator-side knob is
  `--session-key-ttl`. If it's too long for browser hygiene, raise
  upstream for a shorter cap.
- **CORS.** newtcon-server is the only browser-facing surface; it
  doesn't talk directly to newtron from the browser today. If that
  changes, CORS on `/auth/login` would need explicit handling.

## Status

- newtron L2c: shipped, merged, available against
  `newtron-server --auth-pam-service=<name>`.
- newtron suite coverage: disabled-path safety pinned by
  `1node-vs-auth/25-L2c-disabled-routes`; full round-trip is
  manual-verify-only today.
- newtcon adoption: **not started.** Filed here for visibility
  per `DIRECTIVE.md`'s capability-discipline section ("maximize
  what newtron / newtrun / newtlab offers").

## Cross-references

- `../newtron/docs/newtron/auth-design.md` §L2c — authoritative
  design rationale.
- `../newtron/docs/newtron/pam-howto.md` §7 — operator howto for
  the round trip + revocation knobs.
- `../newtron/newtrun/suites/1node-vs-auth/README.md` — manual
  verification pattern (curl + jq) suitable for adapting into a
  newtcon smoke test.
- newtron PR #143 — implementation.
- newtron PR #144 — suite scenario.

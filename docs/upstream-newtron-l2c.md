# Upstream update — newtron L2c, post-adoption refresh

**Source:** `../newtron/docs/newtron/auth-design.md` §L2c, newtron
PRs #143 (initial L2c) through #151 (multi-user cache + scenario
impersonation).
**Status:** newtcon shipped its L2c adoption in slices 1.A–2.1
(`internal/newtronc/auth.go`, `internal/session/session.go`,
plus the frontend login UI). This document captures the upstream
state newtcon should rely on going forward — what's stable, what
one line of code to refactor, and what newtron added at adjacent
layers that newtcon hasn't touched and probably doesn't need to.

---

## 1. What's stable now (the contract newtcon depends on)

These shapes have settled after the L2c arc. newtcon can treat
them as fixed contracts; any future change here would come with
a deprecation cycle.

### `POST /newtron/v1/auth/login`

```
Request:  Authorization: Basic <base64(user:password)>
Response: 200 + JSON envelope
          {"data": {"key": "<43-char URL-safe base64>",
                    "expires_at": "RFC3339 timestamp",
                    "user": "alice"},
           "error": ""}
```

Failure modes:
- 404 — `--auth-pam-service` is unset on the server (L2c not
  engaged). newtcon-server treats this as "auth not enabled" and
  proceeds without a cookie.
- 401 — PAM rejected the Basic credentials. newtcon-server
  surfaces "invalid credentials" to the operator without leaking
  which dimension failed.
- 200 with `error != ""` — server-side fault; surface as 502 to
  the browser.

The envelope is now the only response shape. See §2 for the
concrete refactor this allows.

### `POST /newtron/v1/auth/logout`

```
Request:  Authorization: Bearer <key>
Response: 204 No Content (idempotent — returns 204 even for
          unknown / expired / never-issued keys)
```

newtcon-server calls this on cookie expiry / explicit logout. A
204 means "the key won't work again from anywhere"; no further
verification needed.

### Bearer semantics on every other endpoint

When `--auth-pam-service` is configured, every newtron route
accepts `Authorization: Bearer <key>` and resolves the caller via
the in-memory session-key store. A revoked or expired key gets
401 immediately — no grace period, no soft fallback.

### Audit log `verification_source` taxonomy

newtcon doesn't read the audit log directly, but the L5
authorization-failure inspector (slice 2.1) renders error
payloads that include `verification_source`. The taxonomy is
stable:

| Value | Meaning |
|---|---|
| `pam` | Caller authenticated via Basic auth on `/auth/login` this request. |
| `session_key` | Caller authenticated via Bearer header. Maps back to a `pam` event from the same user earlier in the log. |
| `unix_peer_creds` | Local Unix-socket caller. Not applicable to newtcon's TCP traffic. |
| `service_cert_cn` | mTLS peer cert. Applicable if newtcon-server ever moves to mTLS-to-newtron. |
| `self_attested_header` | `X-Newtron-Caller` from header mode. **Not** used in PAM-enabled deployments — present only in dev / test setups. |

newtcon's inspector can show "PAM-verified at HH:MM, session
established for 8h" by joining `verification_source: pam` events
with the corresponding `verification_source: session_key`
mutations under the same user.

### TTL knob

`--session-key-ttl` on the server (default 8h). Hard expiry —
using a key does not extend it. newtcon's session-expiry warning
in slice 1.D ("your session expires in N minutes") is the right
shape; no refresh-token flow is coming.

---

## 2. One concrete refactor

**`internal/newtronc/auth.go:76-91`** carries dual-shape decode
logic for `/auth/login`:

```go
// Newtron's /auth/login returns the LoginResponse either enveloped
// ({"data": {…}, "error": ""}) or bare ({"key", "expires_at", "user"});
// both shapes are observed against newtron-server today. Tolerate both:
// peek at the envelope, then fall through to the bare body when no data
// field is present.
```

That comment is no longer true. The envelope is the only shape
newtron emits (PR #148 normalized it; PR #149 confirmed it; PR
#151 didn't touch it). The bare-shape fallback is dead code
against any newtron version newtcon would realistically talk to.

**Refactor**: drop the `payload = body` fallback at line 90.
Decode `env.Data` directly into `LoginResponse`. Roughly:

```go
if env.Error != "" {
    return nil, &UnavailableError{Cause: env.Error}
}
var data LoginResponse
if err := json.Unmarshal(env.Data, &data); err != nil {
    return nil, &UnavailableError{Cause: fmt.Sprintf("decoding login response: %v", err)}
}
if data.Key == "" {
    return nil, &UnavailableError{Cause: "login response missing key"}
}
return &data, nil
```

~10 lines removed. Update the leading comment to "the
{data, error} envelope is the only shape newtron emits."

That's the entire actionable change. Everything else newtron
added since slice 1.C lives at layers newtcon hasn't adopted and
likely won't.

---

## 3. What's at adjacent layers (FYI)

newtron grew three things in PRs #149–#151 that aren't part of
the contract newtcon adopted. Listed here so the team knows they
exist when future slices touch related areas.

### Per-user CLI session cache (`~/.newtron/sessions/`)

Newtron grew a multi-user disk cache for its CLI tools (`bin/newtron`,
`bin/newtrun`, `bin/newtlab`). Layout: one file per `(user, server)`
pair at `~/.newtron/sessions/<user>@<host>.json`, mode 0600. The
CLI commands `newtron auth login` / `auth logout` / `auth status`
manage the cache.

**Relevance to newtcon**: zero today. newtcon's session storage
lives in `internal/session/session.go` and is server-side (cookie
→ Bearer map, in-memory). The two don't overlap. If newtcon ever
adds a "the operator can also run CLI tools that share their web
login" feature — letting an operator who logged in through the
browser then also drive `newtron service list` from a shell — the
disk cache layout is what they'd integrate with. Not on any
roadmap today.

### Scenario-level impersonation in newtrun (`as: <user>`)

newtrun gained a per-step `as: <user>` field in PR #151. The
runner picks up a Bearer for the named user from a multi-user
session map the CLI submits at run start. This is how the
1node-vs-auth suite runs all 11 scenarios under PAM in one server
invocation, with mallory's denial assertions correctly evaluated
against mallory's grants.

**Relevance to newtcon**: zero today. newtcon is a UI for newtron,
not a driver of newtrun. If newtcon ever surfaces "run a suite
from the UI as user X" — for example a CI dashboard or a
test-the-other-team's-grants debug tool — `as:` is the underlying
mechanism. Not on any roadmap today.

### `SessionProblem` surfacing

`pkg/newtron/client.ListSessions` returns a `(valid []*SessionRecord,
problems []SessionProblem, error)` triple — the problems list
carries cache files the loader couldn't trust (wrong mode,
malformed JSON). `newtron auth status` prints these as warnings
so a tampered file can't silently disappear from view.

**Relevance to newtcon**: zero today; only relevant if newtcon
ever reads the disk cache directly (see "Per-user CLI session
cache" above).

---

## 4. What did NOT change

- The bearer-token protocol. `Authorization: Bearer <key>` works
  exactly as it did at slice 1.C adoption time.
- The 401-on-revoke contract. A logged-out or expired key returns
  401 immediately on the next call.
- The audit envelope every other endpoint uses (`{data, error}`).
- The `--audit-log-integrity` hash chain (newtcon doesn't read the
  audit log, but operators who do still get the L6 tamper-evident
  shape).

---

## Cross-references

- `../newtron/docs/newtron/auth-design.md` §L2c — authoritative
  design rationale.
- `../newtron/docs/newtron/pam-howto.md` §7 — server-side operator
  setup, including the per-user CLI cache pattern.
- newtron PR #143 — initial L2c implementation (envelope at this
  point was bare; later normalized).
- newtron PR #148 — `/auth/login` switched to the standard
  envelope shape.
- newtron PR #149 — per-user CLI cache + `newtron auth login`.
- newtron PR #151 — multi-user cache + scenario-level `as:`.
- newtcon PR #154 (slice 1.C) — newtcon's L2c login adoption.
- newtcon PR #155 (slice 1.D) — gated workspace + 401 redirect.
- newtcon PR #156 (slice 2.1) — authorization-failure inspector
  (consumer of `verification_source`).
- newtcon PR #157 (slice 1 polish) — session-expiry warning.

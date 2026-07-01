# Authenticated testing (`--auth-required`)

When newtcon-server runs with `--auth-required` (and newtron enforces auth), every
API call needs a logged-in session. This note captures how to test against that
without hard-coding secrets or using a real operator's credentials.

## The test principal: a nologin superuser service account

Use a dedicated OS user that can authenticate via PAM but has **no shell**, then
promote it to a newtron superuser. A nologin shell blocks SSH / `su` (those PAM
services use `pam_nologin`/`pam_shells`), but the app's PAM auth path
(`common-auth` → `pam_unix`) only checks the password — so the account works for
login while granting **no system access** if the password leaks.

One-time root setup (example user `ron`):

```bash
sudo useradd --shell /usr/sbin/nologin --no-create-home -c "newtron test superuser" ron
sudo passwd ron            # set a throwaway test password (must be non-empty)
# make ron a newtron superuser — pick one:
#   (a) global, all networks (needs an :18080 restart):
#       bin/newt-server … --super-users=<others>,ron
#   (b) no restart, per-network (run as an existing superuser):
#       curl -b <cookie> -X POST .../api/networks/<net>/super-users -d '{"user":"ron"}'
```

Keep the password a secret (env var / uncommitted). This is for dev/test engines
only — never carry a known-password superuser into production.

## curl — cookie jar

```bash
# log in once → capture the session cookie (TTL = newtron --session-key-ttl, e.g. 8h)
curl -c /tmp/nc-cookies.txt -X POST http://127.0.0.1:8095/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"ron","password":"…"}'
# reuse it
curl -b /tmp/nc-cookies.txt http://127.0.0.1:8095/api/schema/NodeSpec
```

To keep the password out of a shared transcript, run the login line yourself
(e.g. the `! ` session-command prefix); downstream `-b` calls carry no secret.

## Puppeteer smokes — `test/smoke/_auth.mjs`

Smokes call `authenticatePage(page)` right after `newPage()` and before
`goto()`. It reads credentials from the environment and installs the session
cookie so the first navigation lands past the login gate:

```js
import { authenticatePage } from "./_auth.mjs";
const p = await b.newPage();
await authenticatePage(p);          // no-op when auth_required:false
await p.goto(BASE, …);
```

Run with:

```bash
NEWTCON_TEST_USER=ron NEWTCON_TEST_PASS=… node test/smoke/<name>.smoke.mjs
```

- `NEWTCON_TEST_USER` defaults to `ron`; `NEWTCON_TEST_PASS` is required when auth
  is on. Missing creds → the helper **throws** (a smoke never silently runs
  unauthenticated and reports confusing 401s).
- When the server reports `auth_required:false`, the helper is a no-op, so the
  same smokes run unchanged in anonymous/playground mode.

Write-path smokes additionally need the principal to be a **superuser** (or hold
the relevant grants) when authorization is enforced; read-only smokes only need a
valid session.

// _auth.mjs — authenticate puppeteer smokes against a --auth-required
// newtcon-server. Credentials come from the environment so nothing is
// hard-coded and no secret lands in a smoke file:
//
//   NEWTCON_TEST_USER   operator to log in as (default "ron")
//   NEWTCON_TEST_PASS   that operator's password (required when auth is on)
//
// Everything no-ops when the server reports auth_required:false, so the same
// smokes run unchanged in anonymous/playground mode.
//
// Recommended test principal: a dedicated nologin service user promoted to
// newtron superuser (see docs) — it authenticates via PAM but has no shell, so
// a leaked test password grants no system access.

const DEFAULT_BASE = process.env.NEWTCON_URL || "http://127.0.0.1:8095";

/** Whether the target newtcon-server is running with --auth-required. */
export async function authRequired(base = DEFAULT_BASE) {
  try {
    const c = await (await fetch(`${base}/api/config`)).json();
    return !!c.auth_required;
  } catch {
    return false;
  }
}

// Log in with env creds and return the session cookie {name, value}. Returns
// null when auth isn't required. Throws when auth IS required but creds are
// missing or the login fails — a smoke must not silently run unauthenticated
// against a locked server (it would just see 401s and report confusing failures).
export async function loginCookie(base = DEFAULT_BASE) {
  if (!(await authRequired(base))) return null;
  const username = process.env.NEWTCON_TEST_USER || "ron";
  const password = process.env.NEWTCON_TEST_PASS;
  if (!password) {
    throw new Error(
      "newtcon auth is required but NEWTCON_TEST_PASS is unset — " +
      "export NEWTCON_TEST_USER (default \"ron\") and NEWTCON_TEST_PASS",
    );
  }
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`newtcon login failed for ${username}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /(newtcon_session)=([^;]+)/.exec(setCookie);
  if (!m) throw new Error("login succeeded but no newtcon_session cookie was returned");
  return { name: m[1], value: m[2] };
}

// Authenticate a puppeteer page: installs the session cookie so the first
// navigation lands past the login gate. Call after browser.newPage() and
// BEFORE page.goto(). Returns true when a session was installed, false when
// auth isn't required (no-op).
export async function authenticatePage(page, base = DEFAULT_BASE) {
  const cookie = await loginCookie(base);
  if (!cookie) return false;
  await page.setCookie({ name: cookie.name, value: cookie.value, url: base, httpOnly: true });
  return true;
}

// Authenticated GET of /api/networks/{net}/{path}, parsed as JSON. This is the
// primitive that lets a smoke DISCOVER a network's real data (device identity,
// port inventory, services with bindings, an existing zone/ipvpn) instead of
// hard-coding fixture-specific values — the key to being network-agnostic. The
// session cookie is fetched once per process and reused.
let _agnosticCookie;
// Authenticated GET of any /api path — the network-agnostic form (/api/networks,
// /api/labs/...). Use this rather than a bare fetch(): under --auth-required a
// bare fetch gets a 401 whose JSON envelope parses fine, so the caller silently
// reads an empty list instead of failing. That cost a 20s timeout in cmdk-verbs
// (SVC came out undefined and the smoke waited for "apply undefined on ...").
//
// Returns the parsed JSON; throws on non-2xx so a auth/permission problem
// surfaces as itself instead of as absent data.
export async function apiGetPath(path, base = DEFAULT_BASE) {
  if (_agnosticCookie === undefined) _agnosticCookie = await loginCookie(base);
  const H = _agnosticCookie ? { Cookie: `${_agnosticCookie.name}=${_agnosticCookie.value}` } : {};
  const r = await fetch(`${base}${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return r.json();
}

// Authenticated GET of a network-scoped resource. The common case.
export async function apiGET(net, path, base = DEFAULT_BASE) {
  return apiGetPath(`/api/networks/${net}/${path}`, base);
}

// True when a device has live state to read (a deployed VM). The staged smoke
// fixture has no config DB, so its device-state endpoints 503. Deploy-gated
// smokes call skipIfNotDeployed() to skip (not fail) in that case.
export async function deviceIsDeployed(net, device, base = DEFAULT_BASE) {
  try {
    const ck = await loginCookie(base);
    const H = ck ? { Cookie: `${ck.name}=${ck.value}` } : {};
    const r = await fetch(`${base}/api/networks/${net}/nodes/${device}/vlans`, { headers: H });
    return r.ok;
  } catch { return false; }
}

// Exit 0 with a SKIP line when the target device isn't deployed. Call at the top
// of a smoke whose assertions read live device state (config DB / BGP / VLAN…).
export async function skipIfNotDeployed(net, device, base = DEFAULT_BASE) {
  if (!(await deviceIsDeployed(net, device, base))) {
    console.log(`SKIP: ${net}/${device} has no live state (needs a deployed device); staged fixture can't verify device reads`);
    process.exit(0);
  }
}

// gotoApp — navigate a puppeteer page to the app with suite-grade robustness:
// one retry for Chromium's ERR_CERT_VERIFIER_CHANGED race (the first
// navigation can race the ignoreHTTPSErrors setup on a loaded host) and a
// generous timeout. Smokes run on the same box as the lab's QEMU VMs — the
// suite's waits are calibrated for that real environment, not an idle one.
export async function gotoApp(page, base = DEFAULT_BASE, opts = {}) {
  const options = { waitUntil: "networkidle0", timeout: 30000, ...opts };
  try {
    await page.goto(base, options);
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    await page.goto(base, options);
  }
}

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

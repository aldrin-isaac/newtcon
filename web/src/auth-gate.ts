// auth-gate.ts — operator sign-in flow + 401 redirect.
//
// Wired by shell.ts at boot. Three responsibilities:
//
//   1. Boot gate — before the workspace renders, call /api/auth/whoami.
//      If signed in, hide the overlay and continue. If 401, show the login
//      overlay.
//   2. Login overlay — username + password form. On submit, POST to
//      /api/auth/login. On 200, hide overlay and re-broadcast a window
//      reload so any view state that depended on "anonymous" reinitializes
//      with the now-authenticated session.
//   3. 401 dispatch — listens for the auth:401 event emitted by
//      api/newtcon/_transport.ts whenever a non-auth-endpoint /api/* call
//      gets a 401. Shows the login overlay over the current view; the
//      operator can re-authenticate without losing what they had on screen.
//
// Sign-out: the user-pill dropdown calls logout() and reloads.
//
// The overlay markup is owned by index.html — this module hydrates it.

import { whoami, login, logout, type WhoamiResponse } from "./api/newtcon/auth.js";
import { fetchConfig } from "./api/newtcon/config.js";
import { ApiError } from "./api/newtcon/services.js";
import { formatExpiryRelative, isNearExpiry } from "./auth-expiry.js";

let currentUser: string | null = null;
let currentExpiresAt: Date | null = null;
let expiryTickHandle: ReturnType<typeof setInterval> | null = null;
let resolveSignedInOnce: () => void = () => { /* replaced below */ };

/**
 * signedInOnce resolves the first time the operator successfully authenticates
 * (or on boot if a valid session cookie is already present). app.ts awaits
 * this before calling its mount() so the workspace doesn't fire /api/* calls
 * anonymously and trigger spurious 401s.
 *
 * It resolves at most once; subsequent re-sign-ins after a session expiry do
 * not re-fire (the views are already mounted by then).
 */
export const signedInOnce: Promise<void> = new Promise<void>((resolve) => {
  resolveSignedInOnce = resolve;
});

/** UserFromGate returns the signed-in operator's display name, or null. */
export function userFromGate(): string | null {
  return currentUser;
}

/**
 * ensureSignedIn runs the boot gate. Resolves when the app is ready to mount
 * — either because anonymous mode is on (newtcon-server started without
 * --auth-required) or because the operator has signed in. Never rejects on
 * auth failure — the overlay stays shown until the operator signs in.
 */
export async function ensureSignedIn(): Promise<void> {
  const overlay = requireOverlay();
  const error = overlay.querySelector<HTMLElement>("#auth-error")!;
  const form = overlay.querySelector<HTMLFormElement>("#auth-form")!;
  const userInput = overlay.querySelector<HTMLInputElement>("#auth-username")!;
  const pwInput = overlay.querySelector<HTMLInputElement>("#auth-password")!;
  const submit = overlay.querySelector<HTMLButtonElement>("#auth-submit")!;

  // Posture check first: if newtcon-server is in anonymous mode (the
  // playground/cold-start default), skip the gate entirely and let the
  // workspace mount. User pill stays hidden — there is no operator
  // identity to display.
  try {
    const cfg = await fetchConfig();
    if (!cfg.auth_required) {
      resolveSignedInOnce();
      hideOverlay();
      return;
    }
  } catch (err) {
    // /api/config failed — newtcon-server isn't reachable. Show the overlay
    // with the error so the operator can see what's wrong; they can still
    // try to sign in once the server comes back.
    error.textContent = `Cannot reach newtcon-server: ${describe(err)}`;
    error.hidden = false;
    showOverlay();
    // Fall through to the sign-in form wiring below — if newtcon-server
    // becomes reachable mid-form, the submit handler will exercise it.
  }

  // Boot-time check: skip if we already see a session.
  try {
    const me = await whoami();
    if (me) {
      setSignedIn(me);
      hideOverlay();
      return;
    }
  } catch (err) {
    error.textContent = `Cannot reach newtcon-server: ${describe(err)}`;
    error.hidden = false;
  }

  showOverlay();

  return new Promise<void>((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = userInput.value.trim();
      const password = pwInput.value;
      if (!username || !password) {
        error.textContent = "Username and password are required.";
        error.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = "Signing in…";
      error.hidden = true;
      try {
        const me = await login(username, password);
        setSignedIn(me);
        // Wipe the password field even though the overlay will hide.
        pwInput.value = "";
        hideOverlay();
        resolve();
      } catch (err) {
        error.textContent = describe(err);
        error.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = "Sign in";
      }
    });
  });
}

/**
 * setupAuthGate wires the global auth:401 listener and the user pill's
 * sign-out behaviour. Call from shell.ts boot AFTER ensureSignedIn settles.
 */
export function setupAuthGate(): void {
  document.addEventListener("auth:401", () => {
    // Session expired mid-session. Clear our display state, show the overlay
    // again. The operator's view (Topology / Specs / whatever) stays in the
    // background; signing back in returns them right where they were.
    currentUser = null;
    renderUserPill(null);
    showOverlay();
    const error = document.querySelector<HTMLElement>("#auth-error");
    if (error) {
      error.textContent = "Your session has expired. Please sign in again.";
      error.hidden = false;
    }
    // Wire a one-shot submit handler for the re-sign-in.
    const overlay = requireOverlay();
    const form = overlay.querySelector<HTMLFormElement>("#auth-form")!;
    const userInput = overlay.querySelector<HTMLInputElement>("#auth-username")!;
    const pwInput = overlay.querySelector<HTMLInputElement>("#auth-password")!;
    const submit = overlay.querySelector<HTMLButtonElement>("#auth-submit")!;
    const handler = async (e: Event): Promise<void> => {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = "Signing in…";
      try {
        const me = await login(userInput.value.trim(), pwInput.value);
        setSignedIn(me);
        pwInput.value = "";
        hideOverlay();
        form.removeEventListener("submit", handler);
      } catch (err) {
        if (error) {
          error.textContent = describe(err);
          error.hidden = false;
        }
      } finally {
        submit.disabled = false;
        submit.textContent = "Sign in";
      }
    };
    form.addEventListener("submit", handler);
  });

  const signOutBtn = document.querySelector<HTMLButtonElement>("#user-signout");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      try {
        await logout();
      } finally {
        // Reload so every view's cached state is shed alongside the session.
        window.location.reload();
      }
    });
  }

  setupUserPillDropdown();
}

/**
 * setupUserPillDropdown wires the click toggle + outside-click close for the
 * user-pill dropdown. Mirrors the network-switcher pattern.
 */
function setupUserPillDropdown(): void {
  const trigger = document.getElementById("user-pill-trigger");
  const dropdown = document.getElementById("user-pill-dropdown");
  if (!trigger || !dropdown) return;

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
    if (!dropdown.hidden) refreshExpiryUI();
  });

  document.addEventListener("click", (e) => {
    if (dropdown.hidden) return;
    if (
      e.target instanceof Node &&
      (dropdown.contains(e.target) || trigger.contains(e.target))
    ) return;
    dropdown.hidden = true;
  });
}

// ---- helpers --------------------------------------------------------------

function setSignedIn(me: WhoamiResponse): void {
  currentUser = me.user;
  currentExpiresAt = new Date(me.expires_at);
  renderUserPill(me);
  startExpiryTick();
  resolveSignedInOnce();
}

/**
 * startExpiryTick refreshes the dropdown's "expires in …" line and the pill's
 * warning state on a 30 s cadence. The session middleware on the server is
 * already authoritative — the browser-side timer is purely UX.
 */
function startExpiryTick(): void {
  if (expiryTickHandle !== null) clearInterval(expiryTickHandle);
  refreshExpiryUI();
  expiryTickHandle = setInterval(refreshExpiryUI, 30_000);
}

function refreshExpiryUI(): void {
  if (!currentExpiresAt) return;
  const pill = document.getElementById("user-pill-trigger");
  const expiresValueEl = document.getElementById("user-pill-dropdown-expires");
  if (expiresValueEl) {
    expiresValueEl.textContent = formatExpiryRelative(currentExpiresAt);
    expiresValueEl.classList.toggle(
      "user-pill-dropdown-value--warning",
      isNearExpiry(currentExpiresAt),
    );
  }
  if (pill) {
    pill.classList.toggle("user-pill--warning", isNearExpiry(currentExpiresAt));
  }
}

function renderUserPill(me: WhoamiResponse | null): void {
  const wrap = document.querySelector<HTMLElement>("#user-pill-wrap");
  const label = document.querySelector<HTMLElement>("#user-pill-name");
  const dropdownName = document.querySelector<HTMLElement>("#user-pill-dropdown-username");
  if (!wrap || !label) return;
  if (!me) {
    wrap.hidden = true;
    if (expiryTickHandle !== null) { clearInterval(expiryTickHandle); expiryTickHandle = null; }
    return;
  }
  label.textContent = me.user;
  if (dropdownName) dropdownName.textContent = me.user;
  wrap.hidden = false;
}

function requireOverlay(): HTMLElement {
  const el = document.getElementById("auth-overlay");
  if (!el) throw new Error("auth-overlay element missing from index.html");
  return el;
}

function showOverlay(): void {
  const el = requireOverlay();
  el.hidden = false;
  // Move focus into the form so the operator can type immediately.
  setTimeout(() => {
    const userInput = el.querySelector<HTMLInputElement>("#auth-username");
    userInput?.focus();
  }, 10);
}

function hideOverlay(): void {
  const el = requireOverlay();
  el.hidden = true;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    // Surface kind + message verbatim per operator-philosophy invariant #9.
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

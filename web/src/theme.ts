// theme.ts — light/dark theme owner (uplift 3.2 draft).
//
// The <html> element ALWAYS carries data-theme ("light" | "dark"): stamped at
// boot from the stored preference, falling back to the system's
// prefers-color-scheme. CSS therefore needs exactly one dark block
// (:root[data-theme="dark"]) and no @media duplication. While the operator
// has no explicit preference, system theme changes are followed live; an
// explicit toggle pins the choice (persisted per browser).

const STORAGE_KEY = "newtcon.theme";

export type Theme = "light" | "dark";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** toggleTheme — flip and persist an explicit preference. Returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode — session-only */ }
  apply(next);
  return next;
}

/** initTheme — stamp data-theme at boot; follow the system while unpinned. */
export function initTheme(): void {
  apply(storedTheme() ?? systemTheme());
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", (e) => {
    if (storedTheme() === null) apply(e.matches ? "dark" : "light");
  });
}

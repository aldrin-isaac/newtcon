// toast.ts — inline replacement for window.alert as a feedback channel.
//
// Single .toast-region appended under <body> lazily on first showToast
// call. Toasts stack newest-on-top. Success / info auto-dismiss after
// AUTO_DISMISS_MS; errors stay sticky until the operator clicks ×, so a
// real failure doesn't disappear before they read it.

export type ToastKind = "error" | "success" | "info";

export interface ToastOpts {
  /** Severity. Drives color + auto-dismiss behaviour. */
  kind: ToastKind;
  /** Short heading line. */
  title: string;
  /** Optional detail line below the title. */
  body?: string;
}

const AUTO_DISMISS_MS = 5000;
const REGION_CLASS = "toast-region";

function getRegion(): HTMLElement {
  let region = document.querySelector("." + REGION_CLASS) as HTMLElement | null;
  if (region) return region;
  region = document.createElement("div");
  region.className = REGION_CLASS;
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.appendChild(region);
  return region;
}

export function showToast(opts: ToastOpts): void {
  const region = getRegion();
  const toast = document.createElement("div");
  toast.className = "toast toast--" + opts.kind;

  const main = document.createElement("div");
  main.className = "toast-main";

  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = opts.title;
  main.appendChild(title);

  if (opts.body !== undefined && opts.body !== "") {
    const body = document.createElement("div");
    body.className = "toast-body";
    body.textContent = opts.body;
    main.appendChild(body);
  }
  toast.appendChild(main);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.appendChild(close);

  // Newest at the top of the region so the operator's eye lands on
  // what just happened first.
  region.insertBefore(toast, region.firstChild);

  if (opts.kind !== "error") {
    window.setTimeout(() => toast.remove(), AUTO_DISMISS_MS);
  }
}

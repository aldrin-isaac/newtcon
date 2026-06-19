// confirm-inline.ts — promise-returning replacement for window.confirm.
//
// Renders an in-app modal so confirmation flows stop visually breaking
// the design system. Returns true on Confirm; false on Cancel, Escape,
// or backdrop click. Each call mounts its own overlay; concurrent
// calls stack visually (rare in practice — operator path is sequential).
//
// Mount target: <body>. Removed on resolve. No global state.

export interface ConfirmInlineOpts {
  /** Heading. One short clause; the body carries the detail. */
  title: string;
  /** Detail line(s). String or pre-built DOM node for richer content. */
  body?: string | HTMLElement;
  /** Style the Confirm button as destructive (red). Defaults to false. */
  danger?: boolean;
  /** Override the Confirm button label. Default "Confirm". */
  confirmLabel?: string;
  /** Override the Cancel button label. Default "Cancel". */
  cancelLabel?: string;
}

export function confirmInline(opts: ConfirmInlineOpts): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const modal = document.createElement("div");
    modal.className = "confirm-modal";
    overlay.appendChild(modal);

    const heading = document.createElement("h2");
    heading.className = "confirm-modal-title";
    heading.textContent = opts.title;
    modal.appendChild(heading);

    if (opts.body !== undefined) {
      const bodyEl = document.createElement("div");
      bodyEl.className = "confirm-modal-body";
      if (typeof opts.body === "string") {
        bodyEl.textContent = opts.body;
      } else {
        bodyEl.appendChild(opts.body);
      }
      modal.appendChild(bodyEl);
    }

    const buttons = document.createElement("div");
    buttons.className = "confirm-modal-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "confirm-modal-btn confirm-modal-btn--cancel";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "confirm-modal-btn confirm-modal-btn--confirm"
      + (opts.danger ? " confirm-modal-btn--danger" : "");
    confirmBtn.textContent = opts.confirmLabel ?? "Confirm";

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    modal.appendChild(buttons);

    document.body.appendChild(overlay);

    // Focus defaults to Cancel — safer when the action is destructive
    // and harmless when it isn't. Operator can Tab to Confirm or click.
    cancelBtn.focus();

    const cleanup = (result: boolean): void => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cleanup(false);
      }
    };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });
    cancelBtn.addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
  });
}

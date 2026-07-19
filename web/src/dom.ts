// dom.ts — shared DOM helpers (console-uplift 1.1). Extracted verbatim from
// app.ts; the local copies history.ts / audit.ts / authorization.ts carried
// are consolidated here (they had drifted only in a loop-variable name).

// el creates an element with properties and children — the codebase's one
// element-construction idiom.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ---- Shared recursive value renderer ----------------------------------------

// copyable — leaf values in the raw tree copy themselves on click, with a
// brief "copied" flash. Redacted values never come through here (the
// ssh_pass path renders its own span), so nothing sensitive is copyable.
function copyable(span: HTMLElement): HTMLElement {
  span.classList.add("detail-copyable");
  span.title = "Click to copy";
  span.addEventListener("click", () => {
    const text = span.textContent ?? "";
    void navigator.clipboard?.writeText(text).then(() => {
      span.classList.add("detail-copied");
      window.setTimeout(() => span.classList.remove("detail-copied"), 900);
    }).catch(() => { /* clipboard unavailable — the click is a no-op */ });
  });
  return span;
}

export function renderValue(value: unknown): HTMLElement | Text {
  if (value === null || value === undefined) {
    return el("span", { className: "detail-null" }, "—");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return el("span", { className: "detail-null" }, "(empty)");
    const list = el("ol", { className: "detail-array" });
    for (const item of value) {
      const li = el("li");
      li.appendChild(renderValue(item));
      list.appendChild(li);
    }
    return list;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return el("span", { className: "detail-null" }, "(empty)");
    const dl = el("dl", { className: "kv detail-object" });
    for (const [k, v] of entries) {
      // Never render a device password verbatim — some reads (GET /nodes/{name})
      // return ssh_pass in the clear. Redact at any nesting depth.
      const redacted = k === "ssh_pass";
      const nested = !redacted && v !== null && typeof v === "object"
        && (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0);
      if (nested) {
        // Non-empty object/array values collapse behind their key: a
        // <details> branch (open by default — collapsing is the operator's
        // move, hiding data is not ours). The wrap spans the kv grid.
        const det = el("details", { className: "detail-branch" }) as HTMLDetailsElement;
        det.open = true;
        const count = Array.isArray(v) ? v.length : Object.keys(v as object).length;
        const summary = el("summary", { className: "detail-branch-summary" });
        summary.append(
          el("span", { className: "detail-branch-key" }, k),
          el("span", { className: "detail-branch-count" }, ` (${count})`),
        );
        det.appendChild(summary);
        const body = el("div", { className: "detail-branch-body" });
        body.appendChild(renderValue(v));
        det.appendChild(body);
        const wrap = el("div", { className: "detail-branch-wrap" });
        wrap.appendChild(det);
        dl.appendChild(wrap);
        continue;
      }
      dl.appendChild(el("dt", {}, k));
      const dd = el("dd");
      dd.appendChild(redacted
        ? el("span", { className: "spec-detail-redacted" }, "••••••")
        : renderValue(v));
      dl.appendChild(dd);
    }
    return dl;
  }
  if (typeof value === "boolean") {
    return copyable(el("span", { className: "detail-bool" }, value ? "true" : "false"));
  }
  if (typeof value === "number") {
    return copyable(el("span", { className: "detail-num" }, String(value)));
  }
  return copyable(el("span", { className: "detail-str" }, String(value)));
}

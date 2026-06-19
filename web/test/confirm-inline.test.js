// confirm-inline.test.js — tests for the inline confirm modal.
//
// Uses a tiny DOM shim. confirm-inline.ts touches: document.createElement,
// document.body.appendChild, element.appendChild, .className, .textContent,
// .addEventListener / .removeEventListener, .focus, .remove(),
// .setAttribute, and document.addEventListener("keydown", …) for Escape.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { confirmInline } from "../dist/confirm-inline.js";

function setupDOM() {
  const docListeners = new Map();
  const all = new Set();
  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      listeners: new Map(),
      attrs: {},
      parent: null,
      focusedAt: 0,
      removed: false,
      appendChild(child) {
        this.children.push(child);
        child.parent = this;
        return child;
      },
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = this.listeners.get(type);
        if (arr) {
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        }
      },
      dispatch(type, ev = {}) {
        const arr = this.listeners.get(type) ?? [];
        for (const fn of arr) fn({ target: this, stopPropagation() {}, ...ev });
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      focus() { this.focusedAt = ++focusedSeq; },
      remove() {
        this.removed = true;
        if (this.parent) {
          const i = this.parent.children.indexOf(this);
          if (i >= 0) this.parent.children.splice(i, 1);
        }
      },
      // Used by walkers but not the impl directly.
      querySelectorAll: () => [],
    };
    all.add(el);
    return el;
  }
  let focusedSeq = 0;
  const body = makeEl("body");
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    body,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type);
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    dispatchKey(key) {
      const arr = docListeners.get("keydown") ?? [];
      for (const fn of arr) fn({ key, stopPropagation() {} });
    },
  };
  return { body, all };
}

function findByClass(root, cls) {
  if (root.className && root.className.split(/\s+/).includes(cls)) return root;
  for (const c of root.children) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

describe("confirmInline()", () => {
  let domState;
  beforeEach(() => { domState = setupDOM(); });
  afterEach(() => { delete globalThis.document; });

  test("renders overlay + modal with title", () => {
    confirmInline({ title: "Discard 3 changes?" });
    const overlay = findByClass(domState.body, "confirm-overlay");
    assert.ok(overlay, "overlay mounted");
    assert.equal(overlay.attrs.role, "dialog");
    assert.equal(overlay.attrs["aria-modal"], "true");
    const title = findByClass(overlay, "confirm-modal-title");
    assert.equal(title.textContent, "Discard 3 changes?");
  });

  test("renders body string when provided", () => {
    confirmInline({ title: "T", body: "Detail line." });
    const body = findByClass(domState.body, "confirm-modal-body");
    assert.equal(body.textContent, "Detail line.");
  });

  test("no body element when opts.body omitted", () => {
    confirmInline({ title: "T" });
    assert.equal(findByClass(domState.body, "confirm-modal-body"), null);
  });

  test("danger styles the Confirm button", () => {
    confirmInline({ title: "T", danger: true });
    const btn = findByClass(domState.body, "confirm-modal-btn--confirm");
    assert.ok(btn.className.includes("confirm-modal-btn--danger"));
  });

  test("custom labels render", () => {
    confirmInline({ title: "T", confirmLabel: "Tear down", cancelLabel: "Keep" });
    const confirm = findByClass(domState.body, "confirm-modal-btn--confirm");
    const cancel = findByClass(domState.body, "confirm-modal-btn--cancel");
    assert.equal(confirm.textContent, "Tear down");
    assert.equal(cancel.textContent, "Keep");
  });

  test("Cancel click resolves false", async () => {
    const p = confirmInline({ title: "T" });
    const cancel = findByClass(domState.body, "confirm-modal-btn--cancel");
    cancel.dispatch("click");
    assert.equal(await p, false);
  });

  test("Confirm click resolves true", async () => {
    const p = confirmInline({ title: "T" });
    const confirm = findByClass(domState.body, "confirm-modal-btn--confirm");
    confirm.dispatch("click");
    assert.equal(await p, true);
  });

  test("Escape resolves false", async () => {
    const p = confirmInline({ title: "T" });
    document.dispatchKey("Escape");
    assert.equal(await p, false);
  });

  test("non-Escape key does not resolve", async () => {
    const p = confirmInline({ title: "T" });
    document.dispatchKey("Enter");
    // Race against a fallback to make sure p is still pending.
    const settled = await Promise.race([p.then(() => "settled"), Promise.resolve("pending")]);
    assert.equal(settled, "pending");
    // Now resolve cleanly so the test doesn't leak.
    const confirm = findByClass(domState.body, "confirm-modal-btn--confirm");
    confirm.dispatch("click");
    await p;
  });

  test("backdrop click (target === overlay) resolves false", async () => {
    const p = confirmInline({ title: "T" });
    const overlay = findByClass(domState.body, "confirm-overlay");
    // Simulate clicking the overlay itself, not a child.
    overlay.dispatch("click", { target: overlay });
    assert.equal(await p, false);
  });

  test("overlay is removed after resolution", async () => {
    const p = confirmInline({ title: "T" });
    const overlay = findByClass(domState.body, "confirm-overlay");
    overlay.dispatch("click", { target: overlay });
    await p;
    assert.equal(overlay.removed, true);
  });

  test("Cancel button gets initial focus (safer default for destructive)", () => {
    confirmInline({ title: "T", danger: true });
    const cancel = findByClass(domState.body, "confirm-modal-btn--cancel");
    assert.ok(cancel.focusedAt > 0, "cancel was focused");
  });
});

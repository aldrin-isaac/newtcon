// toast.test.js — tests for the inline toast region.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { showToast } from "../dist/toast.js";

let timers = [];
function fakeSetTimeout(fn, ms) {
  const t = { fn, ms, fired: false };
  timers.push(t);
  return timers.length;
}
function fireTimers() {
  for (const t of timers) {
    if (!t.fired) { t.fired = true; t.fn(); }
  }
}

function setupDOM() {
  let nodeSeq = 0;
  function makeEl(tag) {
    const el = {
      __id: ++nodeSeq,
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      listeners: new Map(),
      attrs: {},
      parent: null,
      removed: false,
      appendChild(child) {
        this.children.push(child);
        child.parent = this;
        return child;
      },
      insertBefore(child, ref) {
        // Real-DOM semantics: inserting a node that already has a parent
        // MOVES it (needed by the collapse-repeats resurface path).
        if (child.parent) {
          const old = child.parent.children.indexOf(child);
          if (old >= 0) child.parent.children.splice(old, 1);
        }
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i >= 0) this.children.splice(i, 0, child);
        else this.children.unshift(child);
        child.parent = this;
        return child;
      },
      get firstChild() { return this.children[0] ?? null; },
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        for (const fn of this.listeners.get(type) ?? []) fn(ev);
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      remove() {
        this.removed = true;
        if (this.parent) {
          const i = this.parent.children.indexOf(this);
          if (i >= 0) this.parent.children.splice(i, 1);
        }
      },
    };
    return el;
  }
  const body = makeEl("body");
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    body,
    querySelector(sel) {
      // Single supported selector: "." + REGION_CLASS.
      function walk(node) {
        if (!node.removed && sel.startsWith(".")) {
          const cls = sel.slice(1);
          if (node.className && node.className.split(/\s+/).includes(cls)) return node;
        }
        for (const c of node.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      }
      return walk(body);
    },
  };
  globalThis.window = { setTimeout: fakeSetTimeout };
  return body;
}

function findByClass(root, cls) {
  if (root.className && root.className.split(/\s+/).includes(cls)) return root;
  for (const c of root.children) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

function findAllByClass(root, cls, out = []) {
  if (root.className && root.className.split(/\s+/).includes(cls)) out.push(root);
  for (const c of root.children) findAllByClass(c, cls, out);
  return out;
}

describe("showToast()", () => {
  let body;
  beforeEach(() => { body = setupDOM(); timers = []; });
  afterEach(() => { delete globalThis.document; delete globalThis.window; });

  test("lazily creates the toast region on first call", () => {
    assert.equal(findByClass(body, "toast-region"), null);
    showToast({ kind: "info", title: "Hello" });
    const region = findByClass(body, "toast-region");
    assert.ok(region, "region created");
    assert.equal(region.attrs.role, "status");
    assert.equal(region.attrs["aria-live"], "polite");
  });

  test("reuses the existing region on subsequent calls", () => {
    showToast({ kind: "info", title: "One" });
    showToast({ kind: "info", title: "Two" });
    const regions = findAllByClass(body, "toast-region");
    assert.equal(regions.length, 1);
  });

  test("toast kind drives the class suffix", () => {
    showToast({ kind: "error", title: "X" });
    assert.ok(findByClass(body, "toast--error"));
    showToast({ kind: "success", title: "X" });
    assert.ok(findByClass(body, "toast--success"));
    showToast({ kind: "info", title: "X" });
    assert.ok(findByClass(body, "toast--info"));
  });

  test("title + body render in the toast", () => {
    showToast({ kind: "error", title: "Apply failed", body: "Specific reason." });
    const title = findByClass(body, "toast-title");
    const bodyEl = findByClass(body, "toast-body");
    assert.equal(title.textContent, "Apply failed");
    assert.equal(bodyEl.textContent, "Specific reason.");
  });

  test("omitted body produces no .toast-body element", () => {
    showToast({ kind: "info", title: "Just a title" });
    assert.equal(findByClass(body, "toast-body"), null);
  });

  test("empty body string also skips the .toast-body element", () => {
    showToast({ kind: "info", title: "T", body: "" });
    assert.equal(findByClass(body, "toast-body"), null);
  });

  test("close button removes the toast", () => {
    showToast({ kind: "error", title: "X" });
    const toast = findByClass(body, "toast--error");
    const close = findByClass(toast, "toast-close");
    close.dispatch("click");
    assert.equal(toast.removed, true);
  });

  test("info and success schedule auto-dismiss; error does not", () => {
    showToast({ kind: "info", title: "I" });
    showToast({ kind: "success", title: "S" });
    showToast({ kind: "error", title: "E" });
    // Two of the three scheduled a timer; the error did not.
    assert.equal(timers.length, 2);
  });

  test("auto-dismiss timer removes the toast when it fires", () => {
    showToast({ kind: "info", title: "I" });
    const toast = findByClass(body, "toast--info");
    assert.equal(toast.removed, false);
    fireTimers();
    assert.equal(toast.removed, true);
  });

  test("newest toast prepended (insertBefore region.firstChild)", () => {
    showToast({ kind: "info", title: "old" });
    showToast({ kind: "info", title: "new" });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 2);
    const firstTitle = findByClass(region.children[0], "toast-title");
    assert.equal(firstTitle.textContent, "new");
  });

  // ---- Uplift 2.3: visible-stack cap ---------------------------------------

  test("visible stack is capped: a fifth toast drops the oldest", () => {
    for (const t of ["a", "b", "c", "d", "e"]) showToast({ kind: "info", title: t });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 4);
    const titles = region.children.map((t) => findByClass(t, "toast-title").textContent);
    assert.deepEqual(titles, ["e", "d", "c", "b"], "oldest (a) dropped, newest on top");
  });

  test("cap drops the oldest auto-dismissing toast before any sticky error", () => {
    showToast({ kind: "info", title: "info-oldest" });
    for (const t of ["e1", "e2", "e3"]) showToast({ kind: "error", title: t });
    showToast({ kind: "error", title: "e4" });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 4);
    const titles = region.children.map((t) => findByClass(t, "toast-title").textContent);
    assert.deepEqual(titles, ["e4", "e3", "e2", "e1"], "the info fell off; every sticky error survives");
  });

  test("cap drops the oldest error only when errors fill the whole stack", () => {
    for (const t of ["e1", "e2", "e3", "e4", "e5"]) showToast({ kind: "error", title: t });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 4);
    const titles = region.children.map((t) => findByClass(t, "toast-title").textContent);
    assert.deepEqual(titles, ["e5", "e4", "e3", "e2"]);
  });

  // ---- Uplift 2.3: collapse repeats ----------------------------------------

  test("an identical toast collapses into a \u00d7N counter instead of stacking", () => {
    showToast({ kind: "error", title: "Apply failed", body: "same reason" });
    showToast({ kind: "error", title: "Apply failed", body: "same reason" });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 1, "no duplicate stacked");
    assert.equal(findByClass(body, "toast-count").textContent, "\u00d72");
    showToast({ kind: "error", title: "Apply failed", body: "same reason" });
    assert.equal(findByClass(body, "toast-count").textContent, "\u00d73");
  });

  test("same title but different body does NOT collapse", () => {
    showToast({ kind: "error", title: "Apply failed", body: "reason one" });
    showToast({ kind: "error", title: "Apply failed", body: "reason two" });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 2);
  });

  test("a repeat resurfaces its toast to the top of the stack", () => {
    showToast({ kind: "info", title: "first" });
    showToast({ kind: "info", title: "second" });
    showToast({ kind: "info", title: "first" });
    const region = findByClass(body, "toast-region");
    assert.equal(region.children.length, 2);
    const titles = region.children.map((t) => findByClass(t, "toast-title").textContent);
    assert.deepEqual(titles, ["first", "second"]);
  });

  test("a repeat restarts the auto-dismiss window (stale timer no-ops)", () => {
    showToast({ kind: "info", title: "I" });
    const toast = findByClass(body, "toast--info");
    showToast({ kind: "info", title: "I" });
    assert.equal(timers.length, 2, "repeat scheduled a fresh timer");
    // Fire only the ORIGINAL timer: the bumped generation must ignore it.
    timers[0].fired = true; timers[0].fn();
    assert.equal(toast.removed, false, "stale timer no-ops after a repeat");
    timers[1].fired = true; timers[1].fn();
    assert.equal(toast.removed, true, "fresh timer dismisses");
  });

  test("collapsed error repeats stay sticky (no timer scheduled)", () => {
    showToast({ kind: "error", title: "E" });
    showToast({ kind: "error", title: "E" });
    assert.equal(timers.length, 0);
  });
});

// dom-stub.js — minimal DOM stub for unit-level rendering tests run under
// Node.js's built-in node:test module.
//
// Browser globals used by web/src/ modules are shimmed here so that tests can
// import compiled dist/ modules and exercise rendering logic without a full
// browser or jsdom. Only the surface area actually used by newtcon's modules
// is stubbed; this is NOT a complete DOM implementation.
//
// Usage in a test file:
//
//   import { setupDOM } from "./lib/dom-stub.js";
//   setupDOM();
//   import { renderServices } from "../../dist/surfaces/services/services.js";
//
// F2: concrete stubs for document.createElement, document.createTextNode,
// document.getElementById, and Element.appendChild are added here to support
// the services-listing rendering tests. The minimal implementation is
// deliberately not a DOM spec; it covers exactly what services.ts uses.

/**
 * A minimal element stub that tracks tag name, class, textContent,
 * innerHTML, children, and attributes. Sufficient for the services-listing
 * render tests; extended as future surfaces require additional APIs.
 */
class StubElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this._textContent = "";
    this.innerHTML = "";
    this.children = [];
    this._attrs = {};
    this._text = "";
  }

  // textContent = "" is the primary way services.ts clears a node before
  // re-rendering. Setting it to empty must clear children and accumulated text.
  get textContent() {
    return this._textContent;
  }
  set textContent(val) {
    this._textContent = val;
    if (val === "" || val === null) {
      this.children = [];
      this._text = "";
    }
  }

  appendChild(child) {
    if (child instanceof StubElement || child instanceof StubTextNode) {
      this.children.push(child);
    }
    if (child instanceof StubTextNode) {
      this._text += child._data;
    }
    return child;
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }

  setAttribute(name, value) {
    this._attrs[name] = value;
  }

  getAttribute(name) {
    return this._attrs[name] ?? null;
  }

  /** Recursively compute inner text from children. */
  get innerText() {
    return this._collectText();
  }

  _collectText() {
    let text = this._text;
    for (const child of this.children) {
      if (child instanceof StubElement) {
        text += child._collectText();
      } else if (child instanceof StubTextNode) {
        text += child._data;
      }
    }
    return text;
  }
}

class StubTextNode {
  constructor(data) {
    this._data = data;
  }
}

/**
 * setupDOM installs minimal browser globals on the Node.js global object.
 * Call at the top of any test file that imports modules using browser APIs.
 *
 * Stubs provided (F2):
 *   - document.createElement(tag)      — returns StubElement
 *   - document.createTextNode(data)    — returns StubTextNode
 *   - document.getElementById(id)      — returns the element previously
 *                                        registered via registerElement()
 *   - Object.assign on StubElement      — allows setting properties from
 *                                        attrs passed to el()
 */
export function setupDOM() {
  if (typeof globalThis.document !== "undefined") {
    return; // already set up
  }

  const _registry = new Map();

  globalThis.document = {
    createElement(tag) {
      return new StubElement(tag);
    },
    createTextNode(data) {
      return new StubTextNode(data);
    },
    getElementById(id) {
      return _registry.get(id) ?? null;
    },
    _registerElement(id, el) {
      _registry.set(id, el);
    },
  };

  // Expose StubElement so tests can check instanceof.
  globalThis.StubElement = StubElement;
}

/**
 * makeRoot creates a StubElement with id "services-root" and registers it
 * with the stub document so getElementById("services-root") returns it.
 * Resets any previously registered element with the same id.
 */
export function makeRoot(id = "services-root") {
  if (typeof globalThis.document === "undefined") {
    setupDOM();
  }
  const root = globalThis.document.createElement("div");
  root._attrs["id"] = id;
  globalThis.document._registerElement(id, root);
  return root;
}

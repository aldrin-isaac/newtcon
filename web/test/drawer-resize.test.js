// drawer-resize.test.js — width clamping for the resizable drawer.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { clampDrawerWidth, DRAWER_MIN_PX } from "../dist/drawer-resize.js";

describe("clampDrawerWidth()", () => {
  test("passes sane widths through, rounded", () => {
    assert.equal(clampDrawerWidth(500.4, 1500), 500);
  });
  test("floors at the minimum", () => {
    assert.equal(clampDrawerWidth(100, 1500), DRAWER_MIN_PX);
    assert.equal(clampDrawerWidth(-50, 1500), DRAWER_MIN_PX);
  });
  test("caps at 85% of the viewport", () => {
    assert.equal(clampDrawerWidth(5000, 1500), Math.floor(1500 * 0.85));
  });
  test("tiny viewports: the floor wins over the cap (drawer stays usable)", () => {
    assert.equal(clampDrawerWidth(500, 300), DRAWER_MIN_PX);
  });
});

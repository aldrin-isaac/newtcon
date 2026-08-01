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

// Docked, the drawer shares the row with the workspace, so the 85%-of-viewport
// cap is not enough on its own: at 1300px it would allow 1105px against 1068px
// of available track, squeezing the canvas to nothing and overflowing the grid.
// Reachable since the dock threshold dropped 1400 -> 1100; at 1400+ the
// fraction happened to leave enough room, which is why it went unnoticed.
describe("clampDrawerWidth() — docked layout reserve", () => {
  test("overlay is unchanged: the fraction still governs", () => {
    // Nothing is squeezed by a floating drawer, so no layout reserve applies.
    assert.equal(clampDrawerWidth(2000, 1300), Math.floor(1300 * 0.85));
    assert.equal(clampDrawerWidth(2000, 1300, { docked: false, sidebarWidth: 232 }), Math.floor(1300 * 0.85));
  });

  test("docked leaves the middle panel usable", () => {
    // 1300 - 232 sidebar - 420 main = 648
    assert.equal(clampDrawerWidth(2000, 1300, { docked: true, sidebarWidth: 232 }), 648);
    // 1200 - 232 - 420 = 548
    assert.equal(clampDrawerWidth(2000, 1200, { docked: true, sidebarWidth: 232 }), 548);
    // With the collapsed rail there is more room: 1100 - 52 - 420 = 628
    assert.equal(clampDrawerWidth(2000, 1100, { docked: true, sidebarWidth: 52 }), 628);
  });

  test("whichever limit is tighter wins", () => {
    // The layout reserve binds at every ordinary width — the 85% fraction only
    // becomes the tighter limit past ~4350px, because 0.85w < w - 232 - 420
    // needs w > 4347. Both cases asserted so the min() cannot silently invert.
    assert.equal(clampDrawerWidth(9999, 3000, { docked: true, sidebarWidth: 232 }),
      3000 - 232 - 420);                                  // reserve binds
    assert.equal(clampDrawerWidth(9999, 5000, { docked: true, sidebarWidth: 232 }),
      Math.floor(5000 * 0.85));                           // fraction binds
  });

  test("the minimum still beats both caps on a tiny viewport", () => {
    assert.equal(clampDrawerWidth(10, 600, { docked: true, sidebarWidth: 52 }), DRAWER_MIN_PX);
  });

  test("a request that already fits is returned untouched", () => {
    assert.equal(clampDrawerWidth(500, 1300, { docked: true, sidebarWidth: 232 }), 500);
  });
});

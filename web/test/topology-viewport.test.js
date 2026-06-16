// test/topology-viewport.test.js — pure-math tests for the SVG-viewBox
// pan/zoom helpers. No DOM required.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  fitToBounds,
  panBy,
  zoomAt,
  viewBoxStr,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
} from "../dist/topology-viewport.js";

describe("viewBoxStr()", () => {
  test("formats x y w h with spaces", () => {
    assert.equal(viewBoxStr({ x: 1, y: 2, w: 100, h: 200 }), "1 2 100 200");
  });
});

describe("fitToBounds()", () => {
  test("centres on the bounds with margin", () => {
    // Square bounds at origin, square element → square viewport with margin.
    const v = fitToBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 500, 500, 20);
    // Bounds are 100x100; with 20px margin each side → viewport ≥ 140.
    assert.ok(v.w >= 140 && v.w <= 145);
    assert.equal(v.w, v.h, "square element + square bounds → square viewport");
    // Centred on (50, 50).
    assert.ok(Math.abs(v.x + v.w / 2 - 50) < 0.01);
    assert.ok(Math.abs(v.y + v.h / 2 - 50) < 0.01);
  });

  test("matches element aspect ratio (wide element, square bounds)", () => {
    const v = fitToBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 800, 400, 0);
    // Element is 2:1 wide; viewport aspect should match.
    assert.ok(Math.abs(v.w / v.h - 2) < 0.01);
  });

  test("matches element aspect ratio (tall element, wide bounds)", () => {
    const v = fitToBounds({ minX: 0, minY: 0, maxX: 400, maxY: 100 }, 200, 800, 0);
    // Element is 1:4 (tall); bounds are 4:1 (wide). Fit height (bounds
    // taller relative to element when normalised).
    // Element aspect = 0.25; bounds aspect = 4.0 → bounds wider relative
    // to element, so fit width branch: vw = bw + 0 = 400, vh = vw / 0.25 = 1600.
    assert.equal(v.w, 400);
    assert.equal(v.h, 1600);
  });
});

describe("zoomAt()", () => {
  const NATURAL = 1000;
  test("zoom in around the centre keeps the centre fixed", () => {
    const before = { x: 0, y: 0, w: 1000, h: 500 };
    const after = zoomAt(before, ZOOM_STEP, 250, 100, 500, 200, NATURAL);
    // Center pixel maps to: x + (cx / W) * w  =  0 + 0.5 * 1000 = 500
    // After zoom, same pixel still maps to 500.
    const centreAfter = after.x + (250 / 500) * after.w;
    assert.ok(Math.abs(centreAfter - 500) < 0.5);
    // Smaller viewport (zoomed in).
    assert.ok(after.w < before.w);
  });

  test("zoom in around top-left keeps top-left fixed", () => {
    const before = { x: 0, y: 0, w: 1000, h: 1000 };
    const after = zoomAt(before, 2, 0, 0, 500, 500, NATURAL);
    // (0,0) cursor maps to (0,0) before; should still after.
    assert.ok(Math.abs(after.x) < 0.5);
    assert.ok(Math.abs(after.y) < 0.5);
    // Viewport halved.
    assert.ok(Math.abs(after.w - 500) < 0.5);
  });

  test("clamps at maximum zoom (smallest viewBox)", () => {
    // Try to zoom way past ZOOM_MAX.
    let v = { x: 0, y: 0, w: 1000, h: 1000 };
    for (let i = 0; i < 50; i++) v = zoomAt(v, 2, 250, 250, 500, 500, NATURAL);
    // Smallest allowed viewport width = natural / ZOOM_MAX = 1000 / 4 = 250.
    assert.ok(v.w >= 250 - 0.5);
    assert.ok(v.w < 251);
  });

  test("clamps at minimum zoom (largest viewBox)", () => {
    let v = { x: 0, y: 0, w: 1000, h: 1000 };
    for (let i = 0; i < 50; i++) v = zoomAt(v, 0.5, 250, 250, 500, 500, NATURAL);
    // Largest allowed viewport width = natural / ZOOM_MIN = 1000 / 0.25 = 4000.
    assert.ok(v.w <= 4000 + 0.5);
    assert.ok(v.w > 3999);
  });
});

describe("panBy()", () => {
  test("translates by pixel delta scaled to viewBox units", () => {
    const before = { x: 100, y: 200, w: 500, h: 500 };
    // Element is 250x250 → viewBox-to-pixel factor is 2 each direction.
    // Pan 50px right → 100 viewBox-units left in x.
    const after = panBy(before, 50, 30, 250, 250);
    assert.equal(after.x, 100 - 100);
    assert.equal(after.y, 200 - 60);
    assert.equal(after.w, before.w);
    assert.equal(after.h, before.h);
  });

  test("zero delta = identity", () => {
    const v = { x: 5, y: 7, w: 100, h: 80 };
    assert.deepEqual(panBy(v, 0, 0, 500, 400), v);
  });
});

describe("constants", () => {
  test("ZOOM_MIN < 1 < ZOOM_MAX", () => {
    assert.ok(ZOOM_MIN > 0 && ZOOM_MIN < 1);
    assert.ok(ZOOM_MAX > 1);
  });
  test("ZOOM_STEP > 1 (notches multiply)", () => {
    assert.ok(ZOOM_STEP > 1);
  });
});

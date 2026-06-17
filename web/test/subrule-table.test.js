// test/subrule-table.test.js — unit tests for the pure sub-rule table
// helpers (slice #173.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractRowCells,
  getSubRuleItems,
  itemKey,
} from "../dist/subrule-table.js";

const QOS_COLUMNS = [
  { field: "queue_id", label: "ID" },
  { field: "name",     label: "Name" },
  { field: "type",     label: "Type" },
  { field: "weight",   label: "Weight" },
];

const PREFIX_COLUMNS = [
  { field: "", label: "Prefix" },
];

describe("getSubRuleItems()", () => {
  test("pulls items by wire field", () => {
    const d = { queues: [{ queue_id: 0 }, { queue_id: 1 }] };
    assert.deepEqual(getSubRuleItems(d, "queues"), [{ queue_id: 0 }, { queue_id: 1 }]);
  });

  test("missing field → empty array", () => {
    assert.deepEqual(getSubRuleItems({ other: [1] }, "queues"), []);
  });

  test("non-array value → empty array", () => {
    assert.deepEqual(getSubRuleItems({ queues: "not-array" }, "queues"), []);
  });

  test("null / non-object detail → empty array", () => {
    assert.deepEqual(getSubRuleItems(null, "queues"), []);
    assert.deepEqual(getSubRuleItems(42, "queues"), []);
    assert.deepEqual(getSubRuleItems([1, 2], "queues"), []);
  });
});

describe("extractRowCells() — object items", () => {
  test("maps columns → field values", () => {
    const item = { queue_id: 1, name: "voip", type: "strict", weight: 0 };
    assert.deepEqual(extractRowCells(item, QOS_COLUMNS, "object"),
      ["1", "voip", "strict", "0"]);
  });

  test("missing / null / empty-string fields render as empty cell", () => {
    const item = { queue_id: 2, name: "bulk", type: "wrr" }; // no weight
    assert.deepEqual(extractRowCells(item, QOS_COLUMNS, "object"),
      ["2", "bulk", "wrr", ""]);
  });

  test("non-object item → all empty cells", () => {
    assert.deepEqual(extractRowCells(null, QOS_COLUMNS, "object"),
      ["", "", "", ""]);
    assert.deepEqual(extractRowCells("not-object", QOS_COLUMNS, "object"),
      ["", "", "", ""]);
  });

  test("numeric zero renders as '0' (NOT empty — preserves real data)", () => {
    const item = { queue_id: 0, name: "x", type: "strict", weight: 0 };
    const cells = extractRowCells(item, QOS_COLUMNS, "object");
    assert.equal(cells[0], "0");
    assert.equal(cells[3], "0");
  });
});

describe("extractRowCells() — string items (prefix-lists)", () => {
  test("item IS the cell value", () => {
    assert.deepEqual(extractRowCells("10.0.0.0/8", PREFIX_COLUMNS, "string"),
      ["10.0.0.0/8"]);
  });

  test("non-string item → coerced to String()", () => {
    assert.deepEqual(extractRowCells(42, PREFIX_COLUMNS, "string"), ["42"]);
  });
});

describe("itemKey() — object items", () => {
  test("returns the keyField value", () => {
    assert.equal(itemKey({ queue_id: 5, name: "x" }, "object", "queue_id"), 5);
  });

  test("string-valued key returns the string", () => {
    assert.equal(itemKey({ id: "abc" }, "object", "id"), "abc");
  });

  test("missing keyField → null (delete button suppressed)", () => {
    assert.equal(itemKey({ name: "x" }, "object", "queue_id"), null);
  });

  test("no keyField provided → null", () => {
    assert.equal(itemKey({ queue_id: 5 }, "object"), null);
  });

  test("non-object item → null", () => {
    assert.equal(itemKey(null, "object", "id"), null);
    assert.equal(itemKey(42, "object", "id"), null);
  });
});

describe("itemKey() — string items", () => {
  test("the string itself is the key", () => {
    assert.equal(itemKey("10.0.0.0/8", "string"), "10.0.0.0/8");
  });

  test("non-string item → null", () => {
    assert.equal(itemKey(42, "string"), null);
  });
});

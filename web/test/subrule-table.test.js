// test/subrule-table.test.js — unit tests for the pure sub-rule table
// helpers (slice #173.A).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  composeUpdateBody,
  computeReorderSeq,
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

describe("composeUpdateBody() — slice #173.B", () => {
  test("string itemType always emits new_prefix (newtron requires it; idempotent on no-change)", () => {
    const body = composeUpdateBody({ prefix: "10.0.0.0/24" }, "string", undefined, "10.0.0.0/8");
    assert.deepEqual(body, { new_prefix: "10.0.0.0/24" });
  });

  test("string itemType emits new_prefix even when prefix matches original (idempotent)", () => {
    const body = composeUpdateBody({ prefix: "10.0.0.0/8" }, "string", undefined, "10.0.0.0/8");
    assert.deepEqual(body, { new_prefix: "10.0.0.0/8" });
  });

  test("string itemType with missing field emits empty new_prefix", () => {
    // Defensive — real form would have validated required first.
    const body = composeUpdateBody({}, "string", undefined, "old");
    assert.deepEqual(body, { new_prefix: "" });
  });

  test("object itemType drops keyField when value unchanged (URL identifies the row)", () => {
    const body = composeUpdateBody(
      { seq: 10, action: "permit", src_ip: "10.0.0.0/8" },
      "object", "seq", 10,
    );
    assert.deepEqual(body, { action: "permit", src_ip: "10.0.0.0/8" });
    assert.equal("seq" in body, false);
    assert.equal("new_seq" in body, false);
  });

  test("object itemType translates changed keyField into new_<keyField> (renumber)", () => {
    const body = composeUpdateBody(
      { seq: 5, action: "deny" },
      "object", "seq", 10,
    );
    assert.equal(body.new_seq, 5);
    assert.equal(body.action, "deny");
    assert.equal("seq" in body, false);
  });

  test("renumber comparison is string-coerced (10 == '10' counts as no-change)", () => {
    // Form values come back stringified from text inputs; originalKey
    // is the unmarshalled number. The comparison must tolerate both.
    const body = composeUpdateBody({ seq: "10", action: "deny" }, "object", "seq", 10);
    assert.equal("new_seq" in body, false);
  });

  test("queue_id renumber emits new_queue_id (per newtron PR #217 wire shape)", () => {
    const body = composeUpdateBody(
      { queue_id: 3, name: "q-bulk", type: "wrr", weight: 4 },
      "object", "queue_id", 2,
    );
    assert.equal(body.new_queue_id, 3);
    assert.equal("queue_id" in body, false);
  });

  test("object itemType without keyField → body passed verbatim (defensive)", () => {
    const body = composeUpdateBody(
      { something: "value" },
      "object", undefined, "ignored",
    );
    assert.deepEqual(body, { something: "value" });
  });
});

describe("computeReorderSeq() — slice #173.C", () => {
  test("up from middle uses midpoint of gap with prev-prev neighbour", () => {
    // Rows at 10, 20, 30. Moving the 30-row up should land BETWEEN
    // 10 and 20 → midpoint 15.
    assert.equal(computeReorderSeq([10, 20, 30], 30, "up"), 15);
  });

  test("up from second row (no prev-prev) uses prev - 1", () => {
    assert.equal(computeReorderSeq([10, 20], 20, "up"), 9);
  });

  test("up from first row → null (already at top)", () => {
    assert.equal(computeReorderSeq([10, 20], 10, "up"), null);
  });

  test("up from second row with prev == 1 → null (no room)", () => {
    assert.equal(computeReorderSeq([1, 20], 20, "up"), null);
  });

  test("down from middle uses midpoint with next-next", () => {
    assert.equal(computeReorderSeq([10, 20, 30], 10, "down"), 25);
  });

  test("down from second-to-last → next + 10 (gappy step)", () => {
    assert.equal(computeReorderSeq([10, 20], 10, "down"), 30);
  });

  test("down from last row → null", () => {
    assert.equal(computeReorderSeq([10, 20], 20, "down"), null);
  });

  test("no integer between consecutive neighbours → null (operator must renumber)", () => {
    // Rows at 10, 11, 12. Moving 12 up should land between 10 and 11,
    // but there's no integer there.
    assert.equal(computeReorderSeq([10, 11, 12], 12, "up"), null);
  });

  test("seq not in list → null (defensive)", () => {
    assert.equal(computeReorderSeq([10, 20], 999, "up"), null);
  });

  test("single-row list → null in both directions", () => {
    assert.equal(computeReorderSeq([10], 10, "up"), null);
    assert.equal(computeReorderSeq([10], 10, "down"), null);
  });
});

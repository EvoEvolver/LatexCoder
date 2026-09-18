import assert from "node:assert/strict";
import test from "node:test";
import { fileChanges } from "../src/shared/file-diff.ts";

test("full-file diff reconstructs Unicode, empty, and large rewritten files", () => {
  for (const [base, updated] of [["", "new"], ["old", ""], ["unchanged", "unchanged"], ["😀 one 😀 two", "😁 one 🙂 two"], ["same prefix " + "a".repeat(15000) + " same suffix", "same prefix " + "b".repeat(15000) + " same suffix"], ["A\nB\nC", "A!\nB\nC!"]]) {
    const changes = fileChanges(base, updated);
    let actual = base;
    for (const change of [...changes].reverse()) actual = actual.slice(0, change.from) + change.insert + actual.slice(change.to);
    assert.equal(actual, updated);
    for (const change of changes) {
      assert.ok(!(change.from && /[\uD800-\uDBFF]/.test(base[change.from - 1]) && /[\uDC00-\uDFFF]/.test(base[change.from] || "")));
      assert.ok(!(change.to && /[\uD800-\uDBFF]/.test(base[change.to - 1]) && /[\uDC00-\uDFFF]/.test(base[change.to] || "")));
    }
  }
});

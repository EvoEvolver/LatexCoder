import assert from "node:assert/strict";
import test from "node:test";
import { compileSourceMap } from "../src/shared/source-map.ts";
import { stripReviewStorage } from "../src/shared/review.ts";

test("compile source map preserves projection and maps removed multiline review metadata", () => {
  const source = "Before\n\\cmtbg{one}{Name}Body\\cmted{Comment\non another line}\nAfter";
  const result = compileSourceMap(source);
  assert.equal(result.text, stripReviewStorage(source));
  assert.deepEqual(result.lines, [1, 2, 4]);
});

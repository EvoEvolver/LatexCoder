import test from "node:test";
import assert from "node:assert/strict";
import { buildDiagnostics, compileErrors } from "../src/shared/compile-errors.ts";
import { syncTexPositions } from "../src/shared/pdf-map.ts";
import { projectedPosition } from "../src/shared/source-map.ts";

test("compiler errors resolve file-line output and legacy or Tectonic formats", () => {
  assert.deepEqual(compileErrors("./chapters/one.tex:12: Undefined control sequence\nerror: two.tex:4: missing brace"), [{ path: "chapters/one.tex", line: 12, message: "Undefined control sequence" }, { path: "two.tex", line: 4, message: "missing brace" }]);
  assert.equal(compileErrors("(./sub.tex\n! Failure\nl.7 Bad command")[0].path, "sub.tex");
});

test("build diagnostics prioritize the earliest fatal error without hiding warnings or unlocated errors", () => {
  const log = "LaTeX Warning: Citation undefined\n! Missing file\nmain.tex:4: Undefined control sequence\n! Emergency stop.\n";
  const diagnostics = buildDiagnostics(log);
  assert.equal(diagnostics[0].message, "Missing file");
  assert.equal(diagnostics[0].severity, "error");
  assert.ok(diagnostics.some(item => item.path === "main.tex" && item.line === 4));
  assert.equal(diagnostics.at(-1)?.severity, "warning");
  assert.equal(buildDiagnostics("! Undefined control sequence\nl.4 text").length, 1);
});

test("source offsets map across hidden review notes and SyncTeX boxes retain PDF units", () => {
  const source = "\\cmtbg{id}{A}Body\\cmted{Hidden\nnote}\nTarget";
  assert.deepEqual(projectedPosition(source, source.indexOf("Target")), { line: 2, column: 1 });
  const boxes = syncTexPositions("Page:1\nx:120\ny:130\nh:100\nv:140\nW:80\nH:20\n");
  assert.deepEqual(boxes[0], { page: 1, x: 120, y: 130, left: 100, top: 120, width: 80, height: 20 });
});

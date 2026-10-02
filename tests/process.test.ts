import assert from "node:assert/strict";
import test from "node:test";
import { runBinary } from "../src/server/process.ts";

test("early child failure catches stdin errors and logs the original stderr", async t => {
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(
    runBinary(process.execPath, ["-e", 'console.error("fatal: diagnostic from child"); process.exit(7);'], {}, Buffer.alloc(8 * 1024 * 1024)),
    { code: "git_failed", message: "fatal: diagnostic from child" },
  );
  assert.equal(log.mock.callCount(), 1);
  const [message, details] = log.mock.calls[0].arguments;
  assert.equal(message, "Git subprocess failed");
  assert.equal(details.exitCode, 7);
  assert.equal(details.stderr, "fatal: diagnostic from child");
  assert.ok(details.inputError);
});

test("normal binary input and output succeed without error logs", async t => {
  const log = t.mock.method(console, "error", () => {});
  const input = Buffer.from([0, 255, 128, 10]);
  const result = await runBinary(process.execPath, ["-e", "process.stdin.pipe(process.stdout);"], {}, input);
  assert.deepEqual(result, input);
  assert.equal(log.mock.callCount(), 0);
});

test("spawn failure is logged and rejects with the original error", async t => {
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(runBinary("/latexcoder-test-nonexistent-executable", []), { code: "ENOENT" });
  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0].arguments[1].processError.code, "ENOENT");
});

test("timeout logs the termination signal and preserves stderr", async t => {
  const log = t.mock.method(console, "error", () => {});
  await assert.rejects(runBinary(process.execPath, ["-e", 'console.error("waiting for input"); setInterval(() => {}, 1000);'], { timeoutMs: 500 }), { code: "git_failed", message: "waiting for input" });
  const details = log.mock.calls[0].arguments[1];
  assert.equal(details.signal, "SIGKILL");
  assert.equal(details.timedOut, true);
  assert.equal(details.stderr, "waiting for input");
});

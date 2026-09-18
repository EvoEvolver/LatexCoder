import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAutoCheckpoint } from "../src/server/auto-checkpoint.ts";

test("automatic checkpoints debounce edits and stop after closing", async () => {
  let commits = 0;
  const checkpoint = createAutoCheckpoint({ idleMs: 50, checkpoint: async () => { commits++; }, onError: assert.fail });
  try {
    checkpoint.changed();
    await delay(25);
    checkpoint.changed();
    await delay(30);
    assert.equal(commits, 0);
    await delay(50);
    assert.equal(commits, 1);
    checkpoint.changed();
    checkpoint.close();
    await delay(80);
    assert.equal(commits, 1);
  } finally { checkpoint.close(); }
});

test("automatic checkpoints bound continuous editing and keep edits during a commit", async () => {
  let release: () => void = () => {};
  let commits = 0;
  const checkpoint = createAutoCheckpoint({
    idleMs: 1_000, maxWaitMs: 80,
    checkpoint: async () => { commits++; if (commits === 1) await new Promise<void>(resolve => { release = resolve; }); },
    onError: assert.fail,
  });
  const edits = setInterval(() => checkpoint.changed(), 10);
  try {
    checkpoint.changed();
    await delay(140);
    assert.equal(commits, 1);
    clearInterval(edits);
    checkpoint.changed();
    release();
    await delay(130);
    assert.equal(commits, 2);
  } finally { clearInterval(edits); release(); checkpoint.close(); }
});

test("automatic checkpoint failures retry without losing pending work", async () => {
  let attempts = 0;
  let errors = 0;
  const checkpoint = createAutoCheckpoint({
    idleMs: 10, retryMs: 20,
    checkpoint: async () => { if (++attempts === 1) throw new Error("busy"); },
    onError: () => { errors++; },
  });
  try {
    checkpoint.changed();
    await delay(100);
    assert.equal(attempts, 2);
    assert.equal(errors, 1);
  } finally { checkpoint.close(); }
});

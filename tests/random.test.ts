import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "../src/client/lib/random.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("randomUUID uses the native implementation when available", () => {
  assert.match(randomUUID(), UUID_V4);
});

test("randomUUID falls back when crypto.randomUUID is missing on an insecure origin", () => {
  // Non-secure contexts (plain HTTP to a LAN host or IP) do not expose
  // crypto.randomUUID, which is what used to break opening a file.
  const host = globalThis.crypto as Crypto & { randomUUID?: () => string };
  const own = Object.getOwnPropertyDescriptor(host, "randomUUID");
  try {
    Object.defineProperty(host, "randomUUID", { value: undefined, configurable: true });
    assert.equal(typeof (host as { randomUUID?: unknown }).randomUUID, "undefined");
    assert.match(randomUUID(), UUID_V4);
    assert.notEqual(randomUUID(), randomUUID());
  } finally {
    // randomUUID normally lives on Crypto.prototype; restore the exact own
    // descriptor if there was one, otherwise drop the own property we added.
    if (own) Object.defineProperty(host, "randomUUID", own);
    else delete (host as { randomUUID?: () => string }).randomUUID;
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { zipSync, strToU8 } from "fflate";
import { createPaperServer, safeRelativePath } from "../src/server/main.ts";
import { parseReviews, stripReviewStorage } from "../src/shared/review.ts";

import { execFileAsync, testGit, createIncomingBranch, withServer, waitFor, sha256, createFakeLatexmk, createFakeBwrap } from "./helpers/server.ts";

test("review storage parses without leaking into visible source", () => {
  const source = "A \\cmtbg{c1}{Ada}claim\\cmted{Needs evidence\\cmtrpl{m1}{Lin}{Added a citation}\\cmtrpl{m2}{Ada}{Thanks}}; "
    + "\\revbg{r0}{Mo}modern wording\\reved{old wording}; "
    + "\\delbg{r1}{Lin}unclear text\\deled"
    + "\\addbg{r1}{Lin}clear text\\added.";
  const reviews = parseReviews(source);
  assert.deepEqual(reviews.map(item => [item.kind, item.id, item.author, item.body, item.note]), [
    ["comment", "c1", "Ada", "claim", "Needs evidence"],
    ["revision", "r0", "Mo", "modern wording", "old wording"],
    ["deletion", "r1", "Lin", "unclear text", ""],
    ["addition", "r1", "Lin", "clear text", ""],
  ]);
  assert.deepEqual(reviews[0].messages.map(message => [message.id, message.author, message.body, message.root]), [
    ["c1", "Ada", "Needs evidence", true],
    ["m1", "Lin", "Added a citation", false],
    ["m2", "Ada", "Thanks", false],
  ]);
  assert.equal(reviews[0].repliesValid, true);
  assert.equal(stripReviewStorage(source), "A claim; modern wording; clear text.");
});

test("concurrent comment replies remain complete and parseable", () => {
  const initial = "A \\cmtbg{c1}{Ada}claim\\cmted{Needs evidence}.";
  const base = new Y.Doc();
  base.getText("content").insert(0, initial);
  const baseUpdate = Y.encodeStateAsUpdate(base);
  const left = new Y.Doc();
  const right = new Y.Doc();
  Y.applyUpdate(left, baseUpdate);
  Y.applyUpdate(right, baseUpdate);
  const insertAt = parseReviews(initial)[0].replyInsertAt;
  left.getText("content").insert(insertAt, "\\cmtrpl{m1}{Lin}{Added a citation}");
  right.getText("content").insert(insertAt, "\\cmtrpl{m2}{Mo}{Checked the source}");
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
  assert.equal(left.getText("content").toString(), right.getText("content").toString());
  const thread = parseReviews(left.getText("content").toString())[0];
  assert.equal(thread.repliesValid, true);
  assert.deepEqual(new Set(thread.replies.map(reply => reply.body)), new Set(["Added a citation", "Checked the source"]));
  base.destroy();
  left.destroy();
  right.destroy();
});

test("compile projection removes storage macros beside ordinary letters", () => {
  const source = "before \\delbg{r1}{Lin}bad\\deledafter "
    + "\\addbg{r1}{Lin}good\\addedtext";
  const clean = stripReviewStorage(source);
  assert.equal(clean, "before after goodtext");
  assert.doesNotMatch(clean, /\\(?:cmtbg|cmted|cmtrpl|revbg|reved|addbg|added|delbg|deled)\\b/);
});

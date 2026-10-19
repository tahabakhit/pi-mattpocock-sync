import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { durableDirectory, syncPath } from "../src/durable-fs.ts";
import { makeFixture } from "./helpers.ts";

test("durable directory creation flushes its parent chain, including when already created", async () => {
  const f = await makeFixture();
  const path = join(f.root, "new-parent", "new-store");
  for (let attempt = 0; attempt < 2; attempt++) {
    const synced: string[] = [];
    const root = await durableDirectory(path, undefined, async (path, signal) => {
      synced.push(path); await syncPath(path, signal);
    });
    for (let current = root; ; current = dirname(current)) {
      assert.ok(synced.includes(current), "each directory entry's parent must be flushed");
      if (dirname(current) === current) break;
    }
  }
});

test("pre-cancelled durable creation does not create directories", async () => {
  const f = await makeFixture();
  const path = join(f.root, "not-created");
  await assert.rejects(durableDirectory(path, AbortSignal.abort()));
  await assert.rejects(access(path));
});

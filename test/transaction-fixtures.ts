import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcquireSnapshot } from "../src/acquisition.ts";
import { json } from "./helpers.ts";
import { commitA, commitB, put, snapshotFixture } from "./snapshot-fixtures.ts";

export async function transactionFixture() {
  const license = (await readFile(new URL("../LICENSE", import.meta.url), "utf8")).replace(/Copyright[^\n]*/, "Copyright (c) Synthetic Fixture Authors");
  const candidates = [];
  for (const [commit, version, body] of [[commitA, "0.1.0-fixture", "A"], [commitB, "0.2.0-fixture", "B"], ["c".repeat(40), "0.2.0-fixture", "C"]]) {
    const f = await snapshotFixture();
    await put(f.source, "LICENSE", license);
    await put(f.source, "shared/guide.md", `Fixture supporting bytes ${body}\n`);
    await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, version });
    candidates.push({ root: f.source, commit, fixture: f });
  }
  const [a, b, c] = candidates;
  const directory = join(a.fixture.root, "transactional-store");
  let next = a;
  let calls = 0;
  const acquire: AcquireSnapshot = async ({ signal }) => {
    signal.throwIfAborted(); calls++;
    return { root: next.root, commit: next.commit, cleanup: async () => {} };
  };
  return { directory, a, b, c, acquire, choose(candidate: typeof a) { next = candidate; }, get calls() { return calls; } };
}

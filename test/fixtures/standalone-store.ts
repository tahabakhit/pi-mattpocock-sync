import assert from "node:assert/strict";
import { RevisionStore } from "../../src/revision-store.ts";

const [directory, phase] = process.argv.slice(2);
assert(directory && phase);
if (phase === "seed") {
  assert(!process.versions.bun);
  await new RevisionStore(directory).setAutomatic(false);
} else if (phase === "bun") {
  assert(process.versions.bun, "Use the actual standalone Pi runtime");
  const store = new RevisionStore(directory);
  assert.equal((await store.read()).automatic, false, "Read Node-created state");
  await store.setAutomaticBudget(1234);
  let locked!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { locked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = new RevisionStore(directory, { checkpoint: async phase => {
    if (phase === "locked") { locked(); await gate; }
  } });
  const pending = writer.setAutomatic(true);
  await entered;
  try {
    assert.equal((await store.read()).automatic, false, "Readers see committed state");
    await assert.rejects(store.setAutomatic(false, { budgetMs: 30 }), { code: "timeout" });
    // A competing writer must retry Bun's errno=SQLITE_BUSY, then succeed.
    const retry = store.setAutomatic(false, { budgetMs: 3000 });
    release();
    await pending;
    await retry;
  } finally { release(); await pending; }
  assert.equal((await store.read()).automatic, false);
  const failing = new RevisionStore(directory, { checkpoint: async phase => {
    if (phase === "state-written") throw new Error("Injected before commit");
  } });
  await assert.rejects(failing.setAutomatic(true), { code: "state" });
  assert.equal((await store.read()).automatic, false, "Failed write rolled back");
  await store.setAutomatic(true);
} else if (phase === "verify") {
  assert(!process.versions.bun);
  const state = await new RevisionStore(directory).read();
  assert.equal(state.automatic, true, "Node reads Bun-committed state");
  assert.equal(state.automaticBudgetMs, 1234);
  // The subsequent empty-cache CLI check must stay offline.
  await new RevisionStore(directory).setAutomatic(false);
} else throw new Error("Unknown phase");
console.log(`PASS: ${phase}`);

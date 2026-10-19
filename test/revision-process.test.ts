import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RevisionStore, type SyncPhase } from "../src/revision-store.ts";
import { SyncFailure } from "../src/sync-operation.ts";
import { transactionFixture } from "./transaction-fixtures.ts";

function worker(t: TestContext, config: Record<string, unknown>) {
  const child = fork(fileURLToPath(new URL("./fixtures/store-worker.ts", import.meta.url)), [JSON.stringify(config)], {
    execArgv: ["--import", fileURLToPath(new URL("./deny-network.mjs", import.meta.url)), "--import", import.meta.resolve("tsx")],
    env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-8000); });
  const seen = new Set<string>();
  let failure: string | undefined;
  const waiting = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
  child.on("message", value => {
    const message = value as { phase?: string; failure?: string };
    if (message.failure) failure = message.failure;
    if (!message.phase) return;
    seen.add(message.phase);
    for (const waiter of waiting.get(message.phase) ?? []) waiter.resolve();
    waiting.delete(message.phase);
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const list of waiting.values()) for (const waiter of list) waiter.reject(new Error(`Worker exited before checkpoint: ${stderr}`));
      resolve({ code, signal });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  });
  return {
    child, exit,
    get failure() { return failure; },
    phase(phase: SyncPhase | "download-partial") {
      if (seen.has(phase)) return Promise.resolve();
      if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error(`Worker already exited: ${stderr}`));
      return new Promise<void>((resolve, reject) => { waiting.set(phase, [...(waiting.get(phase) ?? []), { resolve, reject }]); });
    },
    release() { child.send({ continue: true }); },
  };
}

for (const phase of ["locked", "download-partial", "acquired", "staged", "published", "state-written", "committed"] satisfies (SyncPhase | "download-partial")[]) {
  test(`process death at ${phase} leaves exactly one complete selected revision`, { timeout: 15000 }, async t => {
    const f = await transactionFixture();
    const store = new RevisionStore(f.directory, { acquire: f.acquire });
    await store.update();
    const old = await store.loadSelected();
    const child = worker(t, { directory: f.directory, source: f.b.root, commit: f.b.commit, pause: phase });
    await child.phase(phase);
    if (["download-partial", "acquired", "staged", "published"].includes(phase)) {
      const abandoned = (await readdir(join(f.directory, "downloads"))).filter(name => name.startsWith(".acquire-"));
      assert.equal(abandoned.length, 1, "the crash must leave a real acquisition tree to recover");
      if (phase === "download-partial") assert.equal(await readFile(join(f.directory, "downloads", abandoned[0], "partial-download"), "utf8"), "incomplete fixture bytes");
    }
    child.child.kill("SIGKILL");
    assert.equal((await child.exit).signal, "SIGKILL");
    const restarted = new RevisionStore(f.directory, { acquire: f.acquire });
    const selected = await restarted.loadSelected();
    assert.equal(selected?.commit, phase === "committed" ? f.b.commit : f.a.commit);
    assert.match(await readFile(join(old!.root, "shared/guide.md"), "utf8"), /bytes A/);
    await restarted.setAutomatic(false); // Obtaining the next writer lock also removes abandoned stages.
    assert.ok(!(await readdir(join(f.directory, "revisions"))).some(name => name.startsWith(".stage-")));
    assert.ok(!(await readdir(join(f.directory, "downloads"))).some(name => name.startsWith(".acquire-")));
  });
}

test("first initialization cannot commit halfway through a pinned state read", { timeout: 15000 }, async t => {
  const f = await transactionFixture();
  let pinned!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { pinned = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const reader = new RevisionStore(f.directory, { checkpoint: async phase => {
    if (phase === "read-snapshot") { pinned(); await held; }
  } });
  const reading = reader.read();
  await ready;
  try {
    const child = worker(t, { directory: f.directory, source: f.b.root, commit: f.b.commit, budgetMs: 2000 });
    await child.phase("locked");
    assert.equal((await child.exit).code, 1, "the first writer cannot commit across the pinned reader generation");
    assert.equal(child.failure, "timeout", "the writer must time out on contention, not fail for an unrelated reason");
  } finally { release(); }
  assert.equal((await reading).selected, null);
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  f.choose(f.b); await store.update();
  assert.equal((await store.loadSelected())?.commit, f.b.commit);
});

test("two processes serialize; contention is bounded and rollback wins before future automatic checks", { timeout: 20000 }, async t => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  const updating = worker(t, { directory: f.directory, source: f.b.root, commit: f.b.commit, pause: "locked" });
  await updating.phase("locked");
  // Readers can still use the prior committed selection while a writer owns the lock.
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
  await assert.rejects(store.setAutomatic(false, { budgetMs: 40 }), error => error instanceof SyncFailure && error.code === "timeout");
  const rollingBack = worker(t, { directory: f.directory, source: f.c.root, commit: f.c.commit, operation: "rollback" });
  updating.release();
  assert.equal((await updating.exit).code, 0);
  assert.equal((await rollingBack.exit).code, 0);
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
  assert.equal((await store.read()).automatic, false);
  const automatic = worker(t, { directory: f.directory, source: f.c.root, commit: f.c.commit, operation: "automatic" });
  assert.equal((await automatic.exit).code, 0);
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
});

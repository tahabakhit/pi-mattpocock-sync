import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSyncExtension } from "../src/extension.ts";
import { RevisionStore } from "../src/revision-store.ts";
import { operationBudget, SyncFailure } from "../src/sync-operation.ts";
import { transactionFixture } from "./transaction-fixtures.ts";

const options = { timeout: 15000 };
function reports(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => lines.push(args.join(" ")));
  return () => lines.join("\n");
}

test("nested budgets preserve an outer timeout rather than misreport cancellation", options, async () => {
  const outer = operationBudget(20), inner = operationBudget(10000, outer.signal);
  try {
    await assert.rejects(delay(10000, undefined, { signal: inner.signal }));
    assert.ok(inner.signal.reason instanceof SyncFailure);
    assert.equal(inner.signal.reason.code, "timeout");
  } finally { inner.dispose(); outer.dispose(); }
});

test("bounded first-run bootstrap timeout is nonfatal and correctly classified", options, async t => {
  const report = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: async ({ signal }) => {
    await delay(10000, undefined, { signal }); throw new Error("unreachable");
  } });
  await store.setAutomaticBudget(40);
  const app = await f.a.fixture.boot([f.a.fixture.provider], [createSyncExtension({ store })]); t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills, []);
  await app.session.prompt("/mattpocock status");
  assert.match(report(), /"operation":"bootstrap","outcome":"failed","reason":"timeout"/);
  assert.equal((await store.read()).lastCheck, null);
  assert.deepEqual(app.errors, []);
});

for (const action of ["auto off", "rollback"]) {
  test(`${action} cancels an in-flight local automatic check before acquiring the writer lock`, options, async t => {
    const report = reports(t), f = await transactionFixture();
    const seed = new RevisionStore(f.directory, { acquire: f.acquire });
    await seed.update(); f.choose(f.b); await seed.update();
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let aborted = false;
    const store = new RevisionStore(f.directory, { acquire: async ({ signal }) => {
      enter();
      try { await delay(10000, undefined, { signal }); }
      finally { aborted = signal.aborted; }
      throw new Error("unreachable");
    } });
    const app = await f.a.fixture.boot([f.a.fixture.provider], [createSyncExtension({ store })]); t.after(() => app.close());
    await entered;
    await app.session.prompt(`/mattpocock ${action}`);
    assert.equal(aborted, true);
    const state = await seed.read();
    assert.equal(state.automatic, false);
    assert.equal(state.selected?.commit, action === "rollback" ? f.a.commit : f.b.commit);
    await app.session.prompt("/mattpocock status");
    assert.match(report(), /"operation":"automatic update","outcome":"failed","reason":"cancelled"/);
    assert.match(report(), /Last control operation: .*"outcome":"ok"/);
  });
}

test("corrupt cached content withholds resources without an automatic acquisition", options, async t => {
  const report = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update();
  const snapshot = await store.loadSelected(); assert.ok(snapshot);
  await rm(join(snapshot.root, "shared/guide.md"));
  const before = f.calls;
  const app = await f.a.fixture.boot([f.a.fixture.provider], [createSyncExtension({ store })]); t.after(() => app.close());
  assert.equal(f.calls, before);
  assert.deepEqual(app.loader.getSkills().skills, []);
  assert.match(report(), /cached load failed \(state\)/);
});

test("unknown parent ID withholds child skills and suppresses every sync control", options, async t => {
  const report = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update();
  const calls = f.calls;
  const app = await f.a.fixture.boot([f.a.fixture.provider], [createSyncExtension({ store })], "missing-parent-id"); t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills, []);
  for (const command of ["retry", "update", "rollback", "auto off", "budget 1"]) await app.session.prompt(`/mattpocock ${command}`);
  assert.equal(f.calls, calls);
  assert.match(report(), /Parent snapshot is unavailable/);
  assert.equal((await store.read()).automatic, true);
});

test("native file-path parent headers use fresh discovery, not the child-ID heuristic", options, async t => {
  reports(t); const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update(); await store.setAutomatic(false);
  const app = await f.a.fixture.boot([f.a.fixture.provider], [createSyncExtension({ store })], join(f.a.fixture.root, "saved-parent.jsonl")); t.after(() => app.close());
  assert.ok(app.loader.getSkills().skills.length);
});

for (const kind of ["unavailable", "withheld", "loaded"] as const) {
  test(`child inherits a ${kind} parent contribution and survives parent shutdown`, options, async t => {
    reports(t); const f = await transactionFixture(), fixture = f.a.fixture;
    const store = new RevisionStore(f.directory, { acquire: f.acquire });
    if (kind !== "unavailable") await store.update();
    await store.setAutomatic(false);
    if (kind === "withheld") await fixture.skill(join(fixture.agentDir, "skills"), "kept", "User-owned fixture");
    const parent = await fixture.boot([fixture.provider], [createSyncExtension({ store })]); t.after(() => parent.close());
    const parentId = parent.session.sessionManager.getSessionId();
    if (kind === "withheld") await rm(join(fixture.agentDir, "skills"), { recursive: true });
    f.choose(f.b); await store.update();
    const child = await fixture.boot([fixture.provider], [createSyncExtension({ store })], parentId); t.after(() => child.close());
    await parent.close();
    if (kind === "loaded") {
      assert.ok(child.loader.getSkills().skills.every(s => s.filePath.includes(f.a.commit)));
      assert.match(await child.invoke("kept"), /Original kept bytes/);
      const grandchild = await fixture.boot([fixture.provider], [createSyncExtension({ store })], child.session.sessionManager.getSessionId()); t.after(() => grandchild.close());
      assert.ok(grandchild.loader.getSkills().skills.length);
      assert.ok(grandchild.loader.getSkills().skills.every(s => s.filePath.includes(f.a.commit)));
    } else assert.deepEqual(child.loader.getSkills().skills, []);
    assert.deepEqual(child.errors, []);
  });
}

test("an inherited child checks its own ordinary skill collisions", options, async t => {
  reports(t); const f = await transactionFixture(), fixture = f.a.fixture;
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update(); await store.setAutomatic(false);
  const parent = await fixture.boot([fixture.provider], [createSyncExtension({ store })]); t.after(() => parent.close());
  const ordinary = await fixture.skill(join(fixture.agentDir, "skills"), "kept", "Child-specific user bytes");
  const before = await readFile(ordinary.path);
  const child = await fixture.boot([fixture.provider], [createSyncExtension({ store })], parent.session.sessionManager.getSessionId()); t.after(() => child.close());
  assert.deepEqual(child.loader.getSkills().skills.map(s => s.name), ["kept"]);
  assert.match(await child.invoke("kept"), /Child-specific user bytes/);
  assert.deepEqual(await readFile(ordinary.path), before);
  assert.equal(parent.loader.getSkills().skills.length, 3);
});

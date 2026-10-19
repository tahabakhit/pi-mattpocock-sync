import assert from "node:assert/strict";
import { readFile, symlink, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RevisionStore } from "../src/revision-store.ts";
import { SyncFailure } from "../src/sync-operation.ts";
import { put } from "./snapshot-fixtures.ts";
import { transactionFixture } from "./transaction-fixtures.ts";

const options = { timeout: 15000 };

test("durable selection, cached offline loading, rollback and automatic opt-out", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  assert.equal((await store.read()).selected, null);
  assert.equal(await store.loadSelected(), undefined);
  await assert.rejects(store.rollback());
  assert.equal((await store.read()).automatic, true);
  const first = await store.update();
  assert.equal(first.selected?.commit, f.a.commit);
  assert.equal(first.selected?.version, "0.1.0-fixture");
  const cached = await new RevisionStore(f.directory).loadSelected();
  assert.equal(cached?.commit, f.a.commit);
  f.choose(f.b);
  const second = await store.update();
  assert.equal(second.previous?.commit, f.a.commit);
  assert.equal(second.selected?.commit, f.b.commit);
  assert.match(await readFile(join(cached!.root, "shared/guide.md"), "utf8"), /bytes A/);
  const rolledBack = await store.rollback();
  assert.equal(rolledBack.selected?.commit, f.a.commit);
  assert.equal(rolledBack.automatic, false);
  f.choose(f.c);
  const calls = f.calls;
  await store.update({ automatic: true });
  assert.equal(f.calls, calls, "disabled automatic updates must not acquire content");
  const explicit = await store.update();
  assert.equal(explicit.selected?.commit, f.c.commit);
  assert.equal(explicit.automatic, false, "explicit update must not opt back in");
  assert.equal(explicit.previous?.commit, f.a.commit);
  const unchanged = await store.update();
  assert.equal(unchanged.lastCheck?.outcome, "unchanged");
  assert.equal(unchanged.previous?.commit, f.a.commit);
  assert.equal((await new RevisionStore(f.directory).read()).automatic, false);
});

test("a changed commit with the same manifest version is still an update", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  f.choose(f.b); const b = await store.update();
  f.choose(f.c); const c = await store.update();
  assert.equal(c.selected?.version, b.selected?.version);
  assert.equal(c.selected?.commit, f.c.commit);
  assert.equal(c.previous?.commit, f.b.commit);
  assert.equal(c.lastCheck?.outcome, "updated");
});

test("failed acquisition and invalid candidates preserve the last good revision", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  const offline = new RevisionStore(f.directory, { acquire: async () => { throw new SyncFailure("network"); } });
  await assert.rejects(offline.update(), error => error instanceof SyncFailure && error.code === "network");
  assert.equal((await store.read()).lastCheck?.reason, "network");
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
  f.choose(f.b);
  await put(f.b.root, "skills/engineering/kept/SKILL.md", "not valid metadata");
  await assert.rejects(store.update());
  assert.equal((await store.read()).lastCheck?.reason, "invalid");
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
});

test("license changes and missing actual Markdown references require review", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  f.choose(f.b);
  await put(f.b.root, "LICENSE", "MIT License\nChanged terms\n");
  await assert.rejects(store.update(), error => error instanceof SyncFailure && error.code === "license");
  f.choose(f.c);
  await put(f.c.root, "skills/engineering/kept/SKILL.md", "---\nname: kept\ndescription: Fixture\n---\n[Missing](./missing.md)\n");
  await assert.rejects(store.update(), error => error instanceof SyncFailure && error.code === "invalid");
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
  await put(f.c.root, "skills/engineering/kept/SKILL.md", "---\nname: kept\ndescription: Fixture\n---\n```md\n[Example](./missing.md)\n```\n[External](https://example.invalid/missing.md)\n[Shared][support]\n\n[support]: ../../../shared/guide.md\n");
  await store.update();
  assert.equal((await store.loadSelected())?.commit, f.c.commit);
});

test("deadline expiration releases the writer lock without changing selection", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  const before = await store.read();
  const stalled = new RevisionStore(f.directory, { acquire: async ({ signal }) => {
    await delay(10000, undefined, { signal });
    return { root: f.b.root, commit: f.b.commit, cleanup: async () => {} };
  } });
  await assert.rejects(stalled.update({ budgetMs: 40 }), error => error instanceof SyncFailure && error.code === "timeout");
  assert.deepEqual(await store.read(), before);
  f.choose(f.b);
  await store.update();
  assert.equal((await store.loadSelected())?.commit, f.b.commit);
});

test("failure after state write rolls back the transaction", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  const before = await store.read();
  f.choose(f.b);
  const faulty = new RevisionStore(f.directory, { acquire: f.acquire, checkpoint: async phase => {
    if (phase === "state-written") throw new Error("fixture fault");
  } });
  await assert.rejects(faulty.update());
  assert.deepEqual(await store.read(), before);
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
  await store.update();
  assert.equal((await store.loadSelected())?.commit, f.b.commit, "a fully published orphan can be validated and reused");
});

test("corrupted cached content fails closed and a validated rollback can recover", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update(); f.choose(f.b); await store.update();
  const current = await store.loadSelected();
  await writeFile(join(current!.root, "shared/guide.md"), "corrupted");
  await assert.rejects(store.loadSelected(), error => error instanceof SyncFailure && error.code === "state");
  await store.rollback();
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
  await assert.rejects(store.rollback(), error => error instanceof SyncFailure && error.code === "state");
  assert.equal((await store.loadSelected())?.commit, f.a.commit);
});

test("an unexpected SQLite trigger cannot silently defeat opt-out", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  const db = new DatabaseSync(join(f.directory, "state.sqlite"));
  try {
    const before = db.prepare("SELECT value FROM sync_state WHERE id=1").get()?.value;
    // This name also checks that a SQL LIKE underscore cannot hide the trigger.
    db.exec("CREATE TRIGGER sqlitexignore BEFORE UPDATE ON sync_state BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(store.setAutomatic(false), error => error instanceof SyncFailure && error.code === "state");
    assert.equal(db.prepare("SELECT value FROM sync_state WHERE id=1").get()?.value, before);
  } finally { db.close(); }
});

test("malformed state and symlinked database files are never trusted or overwritten", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  await store.update();
  const db = new DatabaseSync(join(f.directory, "state.sqlite"));
  try { db.prepare("UPDATE sync_state SET value=?").run('{"format":999}'); } finally { db.close(); }
  await assert.rejects(store.read(), error => error instanceof SyncFailure && error.code === "state");
  await assert.rejects(store.update(), error => error instanceof SyncFailure && error.code === "state");
  const g = await transactionFixture();
  await mkdir(g.directory);
  const outside = await put(g.a.fixture.root, "outside", "do not modify");
  await symlink(outside, join(g.directory, "state.sqlite"));
  await assert.rejects(new RevisionStore(g.directory).read());
  assert.equal(await readFile(outside, "utf8"), "do not modify");
});

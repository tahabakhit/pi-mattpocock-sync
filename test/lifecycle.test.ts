import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getSubagentsService } from "@gotgenes/pi-subagents";
import { getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { createSyncExtension } from "../src/extension.ts";
import { RevisionStore } from "../src/revision-store.ts";
import { SyncFailure } from "../src/sync-operation.ts";
import type { AcquireSnapshot } from "../src/acquisition.ts";
import { json } from "./helpers.ts";
import { put } from "./snapshot-fixtures.ts";
import { transactionFixture } from "./transaction-fixtures.ts";

const options = { timeout: 15000 };
function reports(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => lines.push(args.join(" ")));
  return { lines, text: () => lines.join("\n") };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function heldAcquire(acquire: AcquireSnapshot) {
  const entered = barrier(), released = barrier(), aborted = barrier();
  const held: AcquireSnapshot = async input => {
    entered.release();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { aborted.release(); reject(input.signal.reason); };
      input.signal.addEventListener("abort", abort, { once: true });
      void released.promise.then(() => { input.signal.removeEventListener("abort", abort); resolve(); });
      if (input.signal.aborted) abort();
    });
    return acquire(input);
  };
  return { acquire: held, entered: entered.promise, release: released.release, aborted: aborted.promise };
}
async function launch(f: Awaited<ReturnType<typeof transactionFixture>>, store: RevisionStore) {
  return f.a.fixture.boot([f.a.fixture.provider], [createSyncExtension({ store })]);
}
async function changed(f: Awaited<ReturnType<typeof transactionFixture>>) {
  await json(join(f.b.root, ".claude-plugin/plugin.json"), { ...f.b.fixture.manifest, version: "0.2.0-fixture", skills: ["./skills/engineering/kept", "./skills/engineering/added"] });
  await put(f.b.root, "skills/engineering/kept/SKILL.md", "---\nname: kept\ndescription: Kept\n---\nChanged B bytes.\n");
  await put(f.b.root, "skills/engineering/added/SKILL.md", "---\nname: added\ndescription: Added\n---\nAdded B bytes.\n");
}

test("persisted automatic budget is validated and legacy M2 state migrates atomically", options, async () => {
  const f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  assert.equal((await store.read()).automaticBudgetMs, 5000);
  await store.update();
  const db = new DatabaseSync(join(f.directory, "state.sqlite"));
  try {
    const legacy = JSON.parse(db.prepare("SELECT value FROM sync_state").get()!.value as string);
    legacy.format = 1; delete legacy.automaticBudgetMs;
    db.prepare("UPDATE sync_state SET value=?").run(JSON.stringify(legacy));
    assert.equal((await store.read()).automaticBudgetMs, 5000);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM sync_state").get()!.value as string).format, 1, "a read must not rewrite state");
    await store.setAutomaticBudget(1234);
    assert.equal((await new RevisionStore(f.directory).read()).automaticBudgetMs, 1234);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM sync_state").get()!.value as string).format, 2);
    for (const value of [0, -1, 1.5, 300001, NaN, Infinity]) await assert.rejects(store.setAutomaticBudget(value));
    assert.equal((await store.read()).automaticBudgetMs, 1234);
  } finally { db.close(); }
});

test("production adapter bootstraps selected skills and keeps user-only invocation intact", options, async t => {
  const r = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  const app = await launch(f, store); t.after(() => app.close());
  assert.equal(f.calls, 1);
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["kept", "manual", "removed"]);
  assert.doesNotMatch(app.session.systemPrompt, /<name>manual<|nested-hidden|<name>excluded</);
  assert.match(await app.invoke("manual"), /Manual fixture body/);
  await app.session.prompt("/mattpocock status");
  assert.match(r.text(), /Loaded: "0.1.0-fixture" @ a{40}; 3\/3/);
  assert.match(r.text(), /Missing optional worker tools: subagent, get_subagent_result, steer_subagent/);
  const prompt = getCurrentSystemPrompt((app.requests.at(-1) as TranscriptContext).messages);
  assert.match(prompt, /When upstream says to call the Skill tool/);
  assert.match(prompt, /Stop worktree-dependent workflows/);
  assert.match(prompt, /Do not autonomously load a skill marked disable-model-invocation/);
  assert.equal(app.session.getActiveToolNames().includes("subagent"), false);
});

test("cached-first background update, second startup, reload additions/removals and empty manifest", options, async t => {
  const r = reports(t), f = await transactionFixture(); await changed(f);
  const seed = new RevisionStore(f.directory, { acquire: f.acquire }); await seed.update(); f.choose(f.b);
  const held = heldAcquire(f.acquire), committed = barrier();
  const app = await launch(f, new RevisionStore(f.directory, { acquire: held.acquire, checkpoint: async phase => { if (phase === "committed") committed.release(); } })); t.after(() => app.close());
  await held.entered;
  assert.match(await app.invoke("kept"), /Original kept bytes/);
  const oldPath = app.loader.getSkills().skills.find(s => s.name === "kept")!.filePath;
  assert.equal((await seed.read()).selected?.commit, f.a.commit);
  held.release();
  await committed.promise;
  await app.session.prompt("/mattpocock auto off");
  assert.equal((await seed.read()).selected?.commit, f.b.commit);
  assert.equal(app.loader.getSkills().skills.find(s => s.name === "kept")!.filePath, oldPath);
  assert.match(await app.invoke("kept"), /Original kept bytes/);
  await app.session.prompt("/mattpocock status");
  assert.match(r.text(), /Loaded: "0.1.0-fixture"/);
  assert.match(r.text(), /Available \(selected\): "0.2.0-fixture" @ b{40}/);
  const second = await launch(f, seed); t.after(() => second.close());
  assert.deepEqual(second.loader.getSkills().skills.map(s => s.name).sort(), ["added", "kept"]);
  await app.session.reload();
  assert.match(await app.invoke("kept"), /Changed B bytes/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>removed</);
  await json(join(f.c.root, ".claude-plugin/plugin.json"), { ...f.c.fixture.manifest, skills: [] });
  f.choose(f.c); await seed.update(); await app.session.reload();
  assert.deepEqual(app.loader.getSkills().skills, []);
  assert.doesNotMatch(await app.invoke("removed"), /<skill name=\\?"removed/);
  assert.deepEqual(app.errors, []);
});

test("two automatic launches stage a newer revision without a manual update command", options, async t => {
  reports(t); const f = await transactionFixture(); await changed(f);
  const store = new RevisionStore(f.directory, { acquire: f.acquire });
  const first = await launch(f, store); await first.close();
  assert.equal(f.calls, 1); f.choose(f.b);
  const committed = barrier();
  const nextStore = new RevisionStore(f.directory, { acquire: f.acquire, checkpoint: async phase => { if (phase === "committed") committed.release(); } });
  const second = await launch(f, nextStore); t.after(() => second.close());
  await committed.promise;
  assert.equal(f.calls, 2);
  assert.equal((await store.read()).selected?.commit, f.b.commit);
  assert.match(await second.invoke("kept"), /Original kept bytes/);
  await second.close();
  const third = await launch(f, store); t.after(() => third.close());
  assert.match(await third.invoke("kept"), /Changed B bytes/);
});

test("first-run offline is nonfatal, sanitized, and explicit retry needs reload", options, async t => {
  const r = reports(t), f = await transactionFixture();
  let offline = true;
  const store = new RevisionStore(f.directory, { acquire: async input => {
    if (offline) throw new Error("secret downloaded response /private/example");
    return f.acquire(input);
  } });
  const app = await launch(f, store); t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills, []);
  assert.match(r.text(), /No synced skills loaded/);
  assert.doesNotMatch(r.text(), /secret|\/private\/example/);
  offline = false;
  await app.session.prompt("/mattpocock retry 30000");
  assert.deepEqual(app.loader.getSkills().skills, []);
  await app.session.reload();
  assert.ok(app.loader.getSkills().skills.length);
});

test("automatic opt-out suppresses bootstrap and explicit updates never re-enable it", options, async t => {
  const r = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.setAutomatic(false);
  const app = await launch(f, store); t.after(() => app.close());
  assert.equal(f.calls, 0); assert.deepEqual(app.loader.getSkills().skills, []);
  await app.session.prompt("/mattpocock update");
  assert.equal(f.calls, 1); assert.equal((await store.read()).automatic, false);
  await app.session.prompt("/mattpocock budget 2345");
  assert.equal((await store.read()).automaticBudgetMs, 2345);
  for (const args of ["budget 0", "budget 1.5", "update 300001", "auto maybe", "rollback extra", "auto off extra"]) await app.session.prompt(`/mattpocock ${args}`);
  assert.equal(f.calls, 1); assert.equal((await store.read()).automaticBudgetMs, 2345);
  assert.match(r.text(), /Budgets: 1–300000 ms/);
  await app.session.prompt("/mattpocock auto on");
  assert.equal((await store.read()).automatic, true);
  assert.equal(f.calls, 1, "enabling auto does not secretly start a check");
});

test("cached offline startup preserves resources and reports a latest timeout separately from old committed success", options, async t => {
  const r = reports(t), f = await transactionFixture();
  const seed = new RevisionStore(f.directory, { acquire: f.acquire }); await seed.update(); await seed.setAutomaticBudget(40);
  const before = (await seed.read()).lastCheck;
  const store = new RevisionStore(f.directory, { acquire: async ({ signal }) => {
    await delay(10000, undefined, { signal }); throw new SyncFailure("network");
  } });
  const app = await launch(f, store); t.after(() => app.close());
  await app.session.prompt("/mattpocock auto off");
  // A separate explicit timeout exercises the longer-retry path without an
  // automatic background check racing its latest-attempt record.
  await app.session.prompt("/mattpocock retry 40");
  await app.session.prompt("/mattpocock status");
  assert.equal((await seed.read()).selected?.commit, f.a.commit);
  assert.deepEqual((await seed.read()).lastCheck, before);
  assert.match(r.text(), /"operation":"explicit update","outcome":"failed","reason":"timeout"/);
  assert.match(r.text(), /Last committed check .*"outcome":"updated"/);
  assert.match(await app.invoke("kept"), /Original kept bytes/);
});

for (const reason of ["reload", "shutdown"] as const) {
  test(`production ${reason} cancels and awaits background work`, options, async t => {
    reports(t); const f = await transactionFixture();
    const seed = new RevisionStore(f.directory, { acquire: f.acquire }); await seed.update(); f.choose(f.b);
    const held = heldAcquire(f.acquire);
    const app = await f.a.fixture.boot([f.a.fixture.provider], [
      createSyncExtension({ store: new RevisionStore(f.directory, { acquire: held.acquire }) }),
      pi => { pi.on("session_shutdown", async event => { if (event.reason === "reload") await seed.setAutomatic(false); }); },
    ]); t.after(() => app.close());
    await held.entered;
    if (reason === "reload") await app.session.reload();
    else await app.close();
    await held.aborted;
    held.release();
    assert.equal((await seed.read()).selected?.commit, f.a.commit);
    assert.deepEqual(app.errors, []);
  });
}

test("rollback command pauses updates and changes only the next resource selection", options, async t => {
  const r = reports(t), f = await transactionFixture(); await changed(f);
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update(); f.choose(f.b); await store.update(); await store.setAutomatic(false);
  const app = await launch(f, store); t.after(() => app.close());
  assert.match(await app.invoke("kept"), /Changed B bytes/);
  await app.session.prompt("/mattpocock rollback");
  assert.equal((await store.read()).automatic, false);
  assert.equal((await store.read()).selected?.commit, f.a.commit);
  assert.match(await app.invoke("kept"), /Changed B bytes/);
  assert.match(r.text(), /Rollback selected; automatic updates paused/);
  await app.session.reload();
  assert.match(await app.invoke("kept"), /Original kept bytes/);
});

test("production collision withholds all synced resources and preserves the user's skill", options, async t => {
  const r = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update(); await store.setAutomatic(false);
  const user = await f.a.fixture.skill(join(f.a.fixture.agentDir, "skills"), "kept", "User-owned bytes");
  const before = await readFile(user.path);
  const app = await launch(f, store); t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name), ["kept"]);
  assert.match(await app.invoke("kept"), /User-owned bytes/);
  await app.session.prompt("/mattpocock status");
  assert.match(r.text(), /Loaded: none;.*contribution: withheld/);
  assert.deepEqual(await readFile(user.path), before);
});

test("status reports a known partial contribution under unsupported dynamic collisions", options, async t => {
  const r = reports(t), f = await transactionFixture();
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update(); await store.setAutomatic(false);
  const other = await f.a.fixture.skill(join(f.a.fixture.root, "other-dynamic"), "kept", "Other dynamic bytes");
  const app = await f.a.fixture.boot([f.a.fixture.provider], [
    pi => { pi.on("resources_discover", () => ({ skillPaths: [other.path] })); },
    createSyncExtension({ store }),
  ]); t.after(() => app.close());
  assert.match(await app.invoke("kept"), /Other dynamic bytes/);
  assert.equal(app.loader.getSkills().diagnostics.filter(d => d.type === "collision").length, 1);
  await app.session.prompt("/mattpocock status");
  assert.match(r.text(), /2\/3 selected paths registered; contribution: offered/);
  assert.match(r.text(), /dynamic skill collisions are unsupported/);
});

test("native new and saved-session resume use current selection rather than historical content", options, async t => {
  reports(t); const f = await transactionFixture(); await changed(f);
  const store = new RevisionStore(f.directory, { acquire: f.acquire }); await store.update(); await store.setAutomatic(false);
  const app = await launch(f, store); t.after(() => app.close());
  await app.invoke("kept"); const saved = app.session.sessionFile; assert.ok(saved);
  f.choose(f.b); await store.update();
  await app.runtime.newSession(); assert.match(await app.invoke("kept"), /Changed B bytes/);
  await app.runtime.switchSession(saved); assert.match(await app.invoke("kept"), /Changed B bytes/);
  assert.deepEqual(app.errors, []);
});

test("real optional subagent uses production file entrypoint, parent's snapshot, and no child sync", { timeout: 30000 }, async t => {
  reports(t); const f = await transactionFixture(); await changed(f);
  const fixture = f.a.fixture;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  const store = new RevisionStore(join(fixture.agentDir, "mattpocock-sync"), { acquire: f.acquire });
  await store.update(); await store.setAutomatic(false);
  await mkdir(join(fixture.agentDir, "agents"), { recursive: true });
  await writeFile(join(fixture.agentDir, "agents", "fixture-worker.md"), "---\ntools: read\nmodel: m0-fixture/echo\nmax_turns: 2\n---\nReturn a fixture answer.\n");
  const subagents = fileURLToPath(new URL("../index.ts", import.meta.resolve("@gotgenes/pi-subagents")));
  const extension = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
  const app = await fixture.boot([fixture.provider, extension, subagents]); t.after(() => app.close());
  assert.ok(app.session.getActiveToolNames().includes("subagent"));
  await app.invoke("kept");
  assert.match(getCurrentSystemPrompt((app.requests.at(-1) as TranscriptContext).messages), /Use the existing subagent, get_subagent_result, and steer_subagent tools/);
  const oldPath = app.loader.getSkills().skills.find(s => s.name === "kept")!.filePath;
  f.choose(f.b); await store.update();
  // A child must not start acquisition even though the shared store opts in.
  await store.setAutomatic(true);
  const before = await store.read();
  const service = getSubagentsService(); assert.ok(service);
  const id = service.spawn("fixture-worker", "Return a fixture answer.", { foreground: true, model: "m0-fixture/echo", maxTurns: 2 });
  await service.waitForAll();
  const record = service.getRecord(id);
  assert.equal(record?.status, "completed", record?.error ?? "child must complete");
  assert.match(record?.result ?? "", /fixture answer/);
  const requests = (await readFile(join(fixture.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const child = requests.find(r => r.sessionId !== app.session.sessionManager.getSessionId()); assert.ok(child);
  const prompt = getCurrentSystemPrompt(child.context.messages);
  assert.ok(prompt.includes(oldPath));
  assert.match(prompt, /<name>removed</); assert.doesNotMatch(prompt, /<name>added</);
  assert.match(prompt, /Stop worktree-dependent workflows/);
  assert.deepEqual(await store.read(), before, "child must not perform a failing network check or change settings");
  assert.deepEqual(app.errors, []);
});

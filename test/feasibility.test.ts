import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getSubagentsService } from "@gotgenes/pi-subagents";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { eventOnce, makeFixture } from "./helpers.ts";

// These exercise Pi's real loader and AgentSession, not mocked event handlers.
const options = { timeout: 15000 };

test("loads only supplied paths, preserves user-only invocation, and expands actual bytes", options, async t => {
  const f = await makeFixture();
  const a = await f.revision("a", [["keep", "revision A — ünicode"], ["manual", "manual bytes", true]]);
  await f.revision("not-selected", [["hidden", "must not be discovered"]]);
  await f.writeState({ selected: a });
  const app = await f.boot();
  t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["keep", "manual"]);
  assert.match(app.session.systemPrompt, /<name>keep<\/name>/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>manual<\/name>|<name>hidden<\/name>/);
  assert.match(await app.invoke("keep", "extra argument"), /revision A — ünicode/);
  assert.match(await app.invoke("manual"), /manual bytes/);
  const commands = eventOnce(app.bus, "m0:commands");
  await app.session.prompt("/m0-commands");
  assert.match(JSON.stringify(await commands), /skill:manual/);
});

test("already-loaded ordinary collision withholds the entire contribution", options, async t => {
  const f = await makeFixture();
  const a = await f.revision("a", [["shared", "upstream"], ["unique", "must be withheld"]]);
  const ordinary = await f.skill(join(f.agentDir, "skills"), "shared", "user-authored");
  const before = await readFile(ordinary.path);
  await f.writeState({ selected: a });
  const app = await f.boot();
  t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name), ["shared"]);
  assert.match(await app.invoke("shared"), /user-authored/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>unique<\/name>/);
  assert.deepEqual(await readFile(ordinary.path), before);
  assert.match(JSON.stringify(app.observations), /collision/);
});

for (const oursFirst of [true, false]) {
  test(`documents unsupported dynamic collision: ours ${oursFirst ? "first" : "last"}`, options, async t => {
    const f = await makeFixture();
    const a = await f.revision("a", [["shared", "ours"], ["unique", "ours unique"]]);
    const other = await f.revision("other", [["shared", "theirs"]]);
    const otherExtension = join(f.root, "other.ts");
    await writeFile(otherExtension, `export default function(pi) { pi.on("resources_discover", () => ({ skillPaths: ${JSON.stringify(other.skills.map(s => s.path))} })); }`);
    await f.writeState({ selected: a });
    const app = await f.boot([f.provider, ...(oursFirst ? [f.extension, otherExtension] : [otherExtension, f.extension])]);
    t.after(() => app.close());
    assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["shared", "unique"]);
    assert.equal(app.loader.getSkills().skills.find(s => s.name === "shared")?.filePath,
      (oursFirst ? a : other).skills[0].path);
    assert.equal(app.loader.getSkills().diagnostics.filter(d => d.type === "collision").length, 1);
    assert.deepEqual((app.observations[0] as { seen: string[] }).seen, [],
      "other dynamic contributions must still be invisible during our discovery handler");
  });
}

test("background staging keeps active bytes stable; explicit reload changes/adds/removes", options, async t => {
  const f = await makeFixture();
  const a = await f.revision("a", [["keep", "old bytes"], ["removed", "removed bytes"]]);
  const b = await f.revision("b", [["keep", "new bytes"], ["added", "added bytes"]]);
  await f.writeState({ selected: a, backgroundTarget: b });
  const app = await f.boot();
  t.after(() => app.close());
  assert.equal((await f.readState()).selected?.id, "a", "bind must finish while update is held");
  assert.match(app.session.systemPrompt, /<name>removed<\/name>/);
  assert.match(await app.invoke("keep"), /old bytes/);
  const staged = eventOnce(app.bus, "m0:update", d => (d as { status: string }).status === "staged");
  app.bus.emit("m0:release-update", undefined);
  await staged;
  assert.equal((await f.readState()).selected?.id, "b");
  assert.equal(app.loader.getSkills().skills[0].filePath, a.skills[0].path);
  const stillOld = await app.invoke("keep");
  assert.match(stillOld, /old bytes/);
  assert.doesNotMatch(stillOld, /new bytes/);
  await app.session.reload();
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["added", "keep"]);
  const nowNew = await app.invoke("keep");
  assert.match(nowNew, /new bytes/);
  assert.doesNotMatch(nowNew, /old bytes/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>removed<\/name>/);
  assert.doesNotMatch(await app.invoke("removed"), /<skill name=\\?"removed/);
});

test("reload to an empty contribution removes old skills from catalog and invocation", options, async t => {
  const f = await makeFixture();
  const a = await f.revision("a", [["gone", "obsolete bytes"]]);
  await f.writeState({ selected: a });
  const app = await f.boot();
  t.after(() => app.close());
  assert.match(app.session.systemPrompt, /<name>gone<\/name>/);
  await f.writeState({ selected: { id: "empty", skills: [] } });
  await app.session.reload();
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.loader.getSkills().skills, []);
  assert.doesNotMatch(app.session.systemPrompt, /<name>gone<\/name>/);
  assert.doesNotMatch(await app.invoke("gone"), /obsolete bytes/);
});

test("fresh session adopts a staged revision without changing another active session", options, async t => {
  const f = await makeFixture();
  const a = await f.revision("a", [["keep", "A"]]);
  const b = await f.revision("b", [["keep", "B"]]);
  await f.writeState({ selected: a });
  const first = await f.boot();
  t.after(() => first.close());
  await f.writeState({ selected: b });
  const second = await f.boot();
  t.after(() => second.close());
  assert.equal(first.loader.getSkills().skills[0].filePath, a.skills[0].path);
  assert.equal(second.loader.getSkills().skills[0].filePath, b.skills[0].path);
});

test("native new-session and saved-session resume adopt current resources", options, async t => {
  const f = await makeFixture();
  const a = await f.revision("a", [["keep", "first session bytes"]]);
  const b = await f.revision("b", [["keep", "later session bytes"]]);
  await f.writeState({ selected: a });
  const app = await f.boot();
  t.after(() => app.close());
  await app.invoke("keep");
  const saved = app.session.sessionFile;
  assert.ok(saved);
  const originalId = app.session.sessionManager.getSessionId();
  await f.writeState({ selected: b });
  assert.equal((await app.runtime.newSession()).cancelled, false);
  assert.notEqual(app.session.sessionManager.getSessionId(), originalId);
  assert.equal(app.loader.getSkills().skills[0].filePath, b.skills[0].path);
  assert.equal((await app.runtime.switchSession(saved)).cancelled, false);
  assert.equal(app.session.sessionManager.getSessionId(), originalId);
  assert.equal(app.loader.getSkills().skills[0].filePath, b.skills[0].path);
  assert.match(await app.invoke("keep"), /later session bytes/);
});

for (const reason of ["reload", "quit"] as const) {
  test(`${reason} cancels a delayed update without publishing stale work`, options, async t => {
    const f = await makeFixture();
    const a = await f.revision("a", [["keep", "A"]]);
    const b = await f.revision("b", [["keep", "B"]]);
    await f.writeState({ selected: a, backgroundTarget: b });
    const app = await f.boot();
    t.after(() => app.close());
    const aborted = eventOnce(app.bus, "m0:update", d => (d as { status: string }).status === "aborted");
    // The replacement runtime must not launch another job in this assertion.
    await f.writeState({ selected: a });
    if (reason === "reload") await app.session.reload();
    else await app.close();
    await aborted;
    app.bus.emit("m0:release-update", undefined);
    assert.equal((await f.readState()).selected?.id, "a");
    assert.deepEqual(app.errors, []);
  });
}

for (const inheritParent of [false, true]) {
  test(`real optional subagent ${inheritParent ? "inherits via minimal public-header bridge" : "rediscovers without a bridge"}`, { timeout: 30000 }, async t => {
    const f = await makeFixture();
    const a = await f.revision("a", [["keep", "parent revision"]]);
    const b = await f.revision("b", [["keep", "newer revision"]]);
    await f.writeState({ selected: a, inheritParent });
    await mkdir(join(f.agentDir, "agents"), { recursive: true });
    await writeFile(join(f.agentDir, "agents", "fixture-worker.md"), "---\ntools: read\nmodel: m0-fixture/echo\nmax_turns: 2\n---\nReturn a fixture answer.\n");
    const subagents = fileURLToPath(new URL("../index.ts", import.meta.resolve("@gotgenes/pi-subagents")));
    const app = await f.boot([...f.extensions, subagents]);
    t.after(() => app.close());
    assert.ok(app.session.getActiveToolNames().includes("subagent"));
    const service = getSubagentsService();
    assert.ok(service, "the real optional package must expose its public service");
    const c = await f.revision("c", [["keep", "future revision"]]);
    await f.writeState({ selected: b, backgroundTarget: c, inheritParent });
    const id = service.spawn("fixture-worker", "Return a fixture answer.", { foreground: true, model: "m0-fixture/echo", maxTurns: 2 });
    await service.waitForAll();
    const record = service.getRecord(id);
    assert.equal(record?.status, "completed", record?.error ?? "child must complete");
    assert.match(record?.result ?? "", /fixture answer/);
    const observations = (await readFile(join(f.root, "observations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const child = observations.find(o => o.channel === "m0:discovery" && o.sessionId !== app.session.sessionManager.getSessionId());
    assert.ok(child, "the real child must run native dynamic resource discovery");
    assert.equal(child.loaded, inheritParent ? "a" : "b");
    assert.equal(child.inherited, inheritParent);
    const childUpdates = observations.filter(o => o.channel === "m0:update" && o.sessionId === child.sessionId && o.status === "pending");
    assert.equal(childUpdates.length, inheritParent ? 0 : 1);
    const requests = (await readFile(join(f.root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const childRequest = requests.find(r => r.sessionId === child.sessionId);
    assert.ok(childRequest, "the child must actually reach the fake provider after discovery");
    const prompt = getCurrentSystemPrompt(childRequest.context.messages);
    assert.match(prompt, /<name>keep<\/name>/);
    assert.ok(prompt.includes((inheritParent ? a : b).skills[0].path));
    assert.ok(!prompt.includes((inheritParent ? b : a).skills[0].path));
    assert.equal(app.loader.getSkills().skills[0].filePath, a.skills[0].path);
    assert.deepEqual(app.errors, []);
  });
}

test("failed binding disposes the runtime and cancels already-started work", options, async () => {
  const f = await makeFixture();
  const a = await f.revision("a", [["keep", "A"]]);
  const b = await f.revision("b", [["keep", "B"]]);
  await f.writeState({ selected: a, backgroundTarget: b });
  const broken = join(f.root, "broken.ts");
  await writeFile(broken, 'export default function(pi) { pi.on("session_start", () => { throw new Error("synthetic binding failure"); }); }');
  await assert.rejects(f.boot([...f.extensions, broken]), /fixture binding must succeed/);
  const observations = (await readFile(join(f.root, "observations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(observations.filter(o => o.channel === "m0:update").map(o => o.status), ["pending", "aborted"]);
  assert.equal((await f.readState()).selected?.id, "a");
});

test("no cached revision contributes nothing, rather than inventing loaded skills", options, async t => {
  const f = await makeFixture();
  const app = await f.boot();
  t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills, []);
  assert.match(JSON.stringify(app.observations), /no-cache/);
});

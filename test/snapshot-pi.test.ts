import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { LocalSnapshotStore } from "../src/local-snapshot-store.ts";
import { createSnapshotExtension, type ResourceStatus } from "../src/pi-resources.ts";
import { json } from "./helpers.ts";
import { commitA, commitB, put, snapshotFixture } from "./snapshot-fixtures.ts";

const options = { timeout: 15000 };

test("manifest-to-store-to-Pi slice preserves content and reloads additions, changes and removals", options, async t => {
  const f = await snapshotFixture();
  const store = new LocalSnapshotStore(join(f.root, "store"));
  const a = await store.select(f.source, commitA);
  const statuses: ResourceStatus[] = [];
  const app = await f.boot([f.provider], [createSnapshotExtension(store, status => statuses.push(status))]);
  t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["kept", "manual", "removed"]);
  assert.deepEqual(app.loader.getSkills().diagnostics, []);
  assert.match(app.session.systemPrompt, /<name>kept<\/name>/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>manual<\/name>|<name>excluded<\/name>|<name>nested-hidden<\/name>/);
  assert.match(await app.invoke("kept"), /Original kept bytes/);
  assert.match(await app.invoke("manual"), /Manual fixture body/);
  assert.equal(statuses.at(-1)?.commit, commitA);
  assert.equal(statuses.at(-1)?.version, f.manifest.version);
  assert.equal(statuses.at(-1)?.status, "offered");
  const oldBytes = await readFile(join(a.root, "skills/engineering/kept/SKILL.md"));

  await put(f.source, "skills/engineering/kept/SKILL.md", "---\nname: kept\ndescription: New fixture\n---\nChanged kept bytes.\n");
  await put(f.source, "skills/productivity/added/SKILL.md", "---\nname: added\ndescription: Added fixture\n---\nAdded body.\n");
  await json(join(f.source, ".claude-plugin/plugin.json"), {
    ...f.manifest, version: "9.8.7-fixture", skills: ["./skills/engineering/kept", "./skills/productivity/added"],
  });
  const b = await store.select(f.source, commitB);
  assert.match(await app.invoke("kept"), /Original kept bytes/);
  assert.deepEqual(await readFile(join(a.root, "skills/engineering/kept/SKILL.md")), oldBytes);
  await app.session.reload();
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["added", "kept"]);
  assert.deepEqual(app.loader.getSkills().diagnostics, []);
  assert.match(await app.invoke("kept"), /Changed kept bytes/);
  assert.match(await app.invoke("added"), /Added body/);
  assert.doesNotMatch(await app.invoke("removed"), /Original removed bytes/);
  assert.doesNotMatch(app.session.systemPrompt, /<name>removed<\/name>|<name>manual<\/name>/);
  assert.equal(statuses.at(-1)?.commit, commitB);
  assert.equal(statuses.at(-1)?.version, "9.8.7-fixture");
  assert.ok(app.loader.getSkills().skills.every(s => s.filePath.startsWith(b.root + "/")));
  assert.deepEqual(await readFile(join(b.root, "shared/guide.md")), await readFile(join(a.root, "shared/guide.md")));

  // Empty is a valid declared set, not an invitation to recursively scan.
  await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, skills: [] });
  await store.select(f.source, "c".repeat(40));
  await app.session.reload();
  assert.deepEqual(app.loader.getSkills().skills, []);
  assert.deepEqual(statuses.at(-1)?.offeredNames, []);
  assert.doesNotMatch(await app.invoke("added"), /Added body/);
});

test("the real resource adapter withholds the complete set on an ordinary collision", options, async t => {
  const f = await snapshotFixture();
  await f.skill(join(f.agentDir, "skills"), "kept", "User-owned body.");
  const store = new LocalSnapshotStore(join(f.root, "store"));
  await store.select(f.source, commitA);
  const statuses: ResourceStatus[] = [];
  const app = await f.boot([f.provider], [createSnapshotExtension(store, status => statuses.push(status))]);
  t.after(() => app.close());
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name), ["kept"]);
  assert.match(await app.invoke("kept"), /User-owned body/);
  assert.equal(statuses.at(-1)?.status, "withheld");
  assert.deepEqual(statuses.at(-1)?.conflicts, ["kept"]);
  assert.deepEqual(statuses.at(-1)?.offeredNames, []);
});

for (const descriptionAfterPrefix of [false, true]) {
  test(`rejects headers that Pi would ${descriptionAfterPrefix ? "omit" : "expose despite user-only metadata"}`, options, async t => {
    const f = await snapshotFixture();
    const store = new LocalSnapshotStore(join(f.root, "store"));
    const previous = await store.select(f.source, commitA);
    const app = await f.boot([f.provider], [createSnapshotExtension(store)]);
    t.after(() => app.close());
    const malformed = `---\nname: manual\n${descriptionAfterPrefix ? "" : "description: Explicit only\n"}---extra: ignored\n${descriptionAfterPrefix ? "description: Hidden from Pi parser\n" : ""}disable-model-invocation: true\n---\nMismatched body.\n`;
    const path = await put(f.source, "skills/productivity/manual/SKILL.md", malformed);
    const rawPi = loadSkills({ cwd: f.cwd, agentDir: f.agentDir, skillPaths: [path], includeDefaults: false });
    if (descriptionAfterPrefix) assert.equal(rawPi.skills.length, 0);
    else assert.equal(rawPi.skills[0]?.disableModelInvocation, false);
    await assert.rejects(store.select(f.source, commitB), /delimiter|frontmatter/i);
    assert.equal(store.current(), previous);
    await app.session.reload();
    assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["kept", "manual", "removed"]);
    assert.doesNotMatch(app.session.systemPrompt, /<name>manual<\/name>/);
    assert.match(await app.invoke("manual"), /Manual fixture body/);
  });
}

test("unsupported manifest resources are reported but never activated", options, async t => {
  const f = await snapshotFixture();
  await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, hooks: "./hooks.json", mcpServers: { unused: {} } });
  await put(f.source, "hooks.json", '{"SessionStart":[{"command":"touch SHOULD_NEVER_RUN"}]}');
  const store = new LocalSnapshotStore(join(f.root, "store"));
  await store.select(f.source, commitA);
  const statuses: ResourceStatus[] = [];
  const app = await f.boot([f.provider], [createSnapshotExtension(store, status => statuses.push(status))]);
  t.after(() => app.close());
  assert.deepEqual(statuses.at(-1)?.unsupportedFields, ["hooks", "mcpServers"]);
  assert.deepEqual(app.session.getActiveToolNames(), ["read"]);
  assert.deepEqual(app.loader.getSkills().skills.map(s => s.name).sort(), ["kept", "manual", "removed"]);
});

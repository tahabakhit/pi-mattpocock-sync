import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readlink, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { resolveManifest, inspectSnapshot } from "../src/snapshot.ts";
import { LocalSnapshotStore } from "../src/local-snapshot-store.ts";
import { json } from "./helpers.ts";
import { commitA, commitB, licenseText, put, snapshotFixture } from "./snapshot-fixtures.ts";

const options = { timeout: 10000 };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

test("manifest alone determines paths, version, and unsupported resource reporting", () => {
  const result = resolveManifest({ name: "plugin", version: "7.2.1-test", license: "MIT",
    skills: ["./any/skill-one", "./different/skill-two"], hooks: { unused: true } });
  assert.deepEqual(result.skillDirectories, ["any/skill-one", "different/skill-two"]);
  assert.equal(result.version, "7.2.1-test");
  assert.deepEqual(result.unsupportedFields, ["hooks"]);
  assert.deepEqual(resolveManifest({ name: "empty", version: "0", license: "MIT", skills: [] }).skillDirectories, []);
});

for (const skills of [undefined, "./skills/one", ["../escape"], ["/absolute"], ["./a/../b"],
  ["./a\\b"], ["./a//b"], ["./a", "./a"], ["./a", "./A"], [3]]) {
  test(`rejects invalid manifest selection ${JSON.stringify(skills)}`, () => {
    assert.throws(() => resolveManifest({ name: "plugin", version: "1", license: "MIT", skills }));
  });
}

for (const change of [{ name: "" }, { version: 2 }, { license: null }]) {
  test(`rejects invalid manifest metadata ${JSON.stringify(change)}`, () => {
    assert.throws(() => resolveManifest({ name: "plugin", version: "1", license: "MIT", skills: [], ...change }));
  });
}

test("inspection derives names and provenance without normalizing source bytes", options, async () => {
  const f = await snapshotFixture();
  const snapshot = await inspectSnapshot(f.source, commitA);
  assert.equal(snapshot.commit, commitA);
  assert.equal(snapshot.version, f.manifest.version);
  assert.equal(snapshot.repository, "https://github.com/mattpocock/skills");
  assert.deepEqual(snapshot.skills.map(s => s.name), ["kept", "manual", "removed"]);
  assert.equal(snapshot.skills[0].description, "Fixture kept description");
  assert.equal(snapshot.skills[1].disableModelInvocation, true);
  assert.equal(snapshot.files.find(f => f.path === "LICENSE")?.sha256, hash(licenseText));
  for (const entry of snapshot.files.filter(f => f.kind === "file")) {
    assert.equal(entry.sha256, hash(await readFile(join(f.source, entry.path))));
  }
  assert.ok(snapshot.files.some(f => f.path.includes("excluded/SKILL.md")), "unselected supporting tree is retained, not registered");
});

test("imports byte-identical supporting content, notices, modes and safe relative links", options, async () => {
  const f = await snapshotFixture();
  await symlink("shared/guide.md", join(f.source, "GUIDE.md"));
  const store = new LocalSnapshotStore(join(f.root, "store"));
  const imported = await store.select(f.source, commitA);
  assert.equal(store.current(), imported);
  for (const entry of imported.files.filter(f => f.kind === "file")) {
    assert.deepEqual(await readFile(join(imported.root, entry.path)), await readFile(join(f.source, entry.path)));
  }
  assert.equal(await readlink(join(imported.root, "GUIDE.md")), "shared/guide.md");
  assert.deepEqual(await readFile(join(imported.root, "GUIDE.md")), await readFile(join(f.source, "shared/guide.md")));
  const skillDirectory = join(imported.root, "skills/engineering/kept");
  assert.deepEqual(await readFile(join(skillDirectory, "../../../shared/guide.md")), await readFile(join(f.source, "shared/guide.md")));
  assert.equal((await stat(join(skillDirectory, "scripts/helper.sh"))).mode & 0o777, 0o755);
  await assert.rejects(access(join(imported.root, "SHOULD_NEVER_RUN")));
  assert.ok(!imported.files.some(f => f.path === "provenance.json"), "adapter metadata must live outside upstream content");
  const provenance = JSON.parse(await readFile(join(imported.root, "../provenance.json"), "utf8"));
  assert.equal(provenance.commit, commitA);
  assert.equal(provenance.version, f.manifest.version);
});

test("same commit is reused, never overwritten with different bytes", options, async () => {
  const f = await snapshotFixture();
  const store = new LocalSnapshotStore(join(f.root, "store"));
  const first = await store.select(f.source, commitA);
  assert.equal((await store.select(f.source, commitA)).root, first.root);
  await put(f.source, "shared/guide.md", "different bytes under same commit");
  await assert.rejects(store.select(f.source, commitA), /different|mismatch/i);
  assert.equal(store.current()?.root, first.root);
  assert.notEqual(await readFile(join(first.root, "shared/guide.md"), "utf8"), "different bytes under same commit");
});

test("changed source creates a new revision and an invalid selection preserves the old one", options, async () => {
  const f = await snapshotFixture();
  const store = new LocalSnapshotStore(join(f.root, "store"));
  const a = await store.select(f.source, commitA);
  await put(f.source, "skills/engineering/kept/SKILL.md", "---\nname: renamed\ndescription: Fresh name\n---\nNEW\n");
  await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, version: "0.2.0-fixture", skills: [f.manifest.skills[0]] });
  const b = await store.select(f.source, commitB);
  assert.equal(b.version, "0.2.0-fixture");
  assert.deepEqual(b.skills.map(s => s.name), ["renamed"]);
  assert.notEqual(a.root, b.root);
  assert.match(await readFile(join(a.root, "skills/engineering/kept/SKILL.md"), "utf8"), /Original kept bytes/);
  await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, skills: ["./missing"] });
  await assert.rejects(store.select(f.source, "c".repeat(40)));
  assert.equal(store.current(), b);
  assert.ok(!(await readdir(join(f.root, "store"))).some(name => name.startsWith(".stage-")));
});

for (const content of ["missing frontmatter", "---\nname: bad--name\ndescription: Bad\n---\nbody",
  "---\nname: kept\n---\nbody", "---\nname: kept\ndescription: [not, a, string]\n---\nbody",
  "---\nname: kept\nname: duplicate-key\ndescription: Bad\n---\nbody",
  '---\nname: kept\ndescription: Bad\ndisable-model-invocation: "false"\n---\nbody']) {
  test(`rejects incompatible frontmatter ${content.slice(0, 48)}`, options, async () => {
    const f = await snapshotFixture();
    await put(f.source, "skills/engineering/kept/SKILL.md", content);
    await assert.rejects(inspectSnapshot(f.source, commitA));
  });
}

test("rejects duplicate effective names, missing license and invalid commit IDs", options, async () => {
  const f = await snapshotFixture();
  await put(f.source, "skills/engineering/removed/SKILL.md", "---\nname: kept\ndescription: Collision\n---\nbody");
  await assert.rejects(inspectSnapshot(f.source, commitA), /duplicate/i);
  await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, skills: [] });
  await put(f.source, "LICENSE", "");
  await assert.rejects(inspectSnapshot(f.source, commitA), /license/i);
  await assert.rejects(inspectSnapshot(f.source, "../../unsafe"), /commit/i);
});

test("rejects duplicate JSON keys and canonical skill-file aliases", options, async () => {
  const f = await snapshotFixture();
  await put(f.source, ".claude-plugin/plugin.json", '{"name":"fixture","version":"1","license":"MIT","skills":[],"skills":[]}');
  await assert.rejects(inspectSnapshot(f.source, commitA), /duplicate/i);
  await put(f.source, "skills/engineering/kept/SKILL.md", "---\ndescription: Directory fallback name\n---\nbody\n");
  await symlink("skills/engineering/kept", join(f.source, "alias"));
  await json(join(f.source, ".claude-plugin/plugin.json"), { ...f.manifest, skills: ["./skills/engineering/kept", "./alias"] });
  await assert.rejects(inspectSnapshot(f.source, commitA), /duplicate/i);
});

test("resolves dot-dot after intervening symlinks, not before them", options, async () => {
  const f = await snapshotFixture();
  await symlink(".", join(f.source, "alias"));
  await symlink("alias/../LICENSE", join(f.source, "escape"));
  await assert.rejects(inspectSnapshot(f.source, commitA), /link|outside/i);

  const g = await snapshotFixture();
  await put(g.source, "real/deep/file", "nested");
  await put(g.source, "real/guide.md", "correct target");
  await symlink("real/deep", join(g.source, "alias"));
  await symlink("alias/../guide.md", join(g.source, "reference"));
  const imported = await new LocalSnapshotStore(join(g.root, "store")).select(g.source, commitA);
  assert.equal(await readFile(join(imported.root, "reference"), "utf8"), "correct target");
  assert.equal(await readlink(join(imported.root, "reference")), "alias/../guide.md");
});

for (const target of ["missing/../LICENSE", "LICENSE/../shared/guide.md", "loop"]) {
  test(`rejects a broken, non-directory or cyclic link: ${target}`, options, async () => {
    const f = await snapshotFixture();
    await symlink(target, join(f.source, "loop"));
    await assert.rejects(inspectSnapshot(f.source, commitA), /path|link|directory|cycle/i);
  });
}

test("preserves a valid UTF-8 BOM character in a link target", options, async () => {
  const f = await snapshotFixture();
  await put(f.source, "\uFEFFnotice", "BOM is part of this filename");
  await symlink("\uFEFFnotice", join(f.source, "notice-link"));
  const imported = await new LocalSnapshotStore(join(f.root, "store")).select(f.source, commitA);
  assert.equal(await readlink(join(imported.root, "notice-link")), "\uFEFFnotice");
  assert.equal(await readFile(join(imported.root, "notice-link"), "utf8"), "BOM is part of this filename");
});

test("rejects non-UTF8 link targets rather than changing their bytes", options, async () => {
  const f = await snapshotFixture();
  await put(f.source, "\uFFFD", "replacement-name target");
  await symlink(Buffer.from([0xff]), join(f.source, "invalid-target"));
  await assert.rejects(inspectSnapshot(f.source, commitA), /UTF-8|link/i);
});

test("existing content symlink cannot substitute an external source for an imported revision", options, async () => {
  const f = await snapshotFixture();
  const directory = join(f.root, "store");
  const store = new LocalSnapshotStore(directory);
  const previous = await store.select(f.source, commitA);
  await mkdir(join(directory, commitB));
  await symlink(f.source, join(directory, commitB, "content"));
  await assert.rejects(store.select(f.source, commitB), /content|directory|root/i);
  assert.equal(store.current(), previous);
});

test("rejects escaping links and case-colliding files even outside selected trees", options, async () => {
  const f = await snapshotFixture();
  await put(f.root, "outside.md", "outside");
  await symlink("../outside.md", join(f.source, "escape"));
  await assert.rejects(inspectSnapshot(f.source, commitA), /link|outside/i);
  const g = await snapshotFixture();
  await put(g.source, "readme.md", "one");
  await put(g.source, "README.md", "two");
  await assert.rejects(inspectSnapshot(g.source, commitA), /case|collision/i);
});

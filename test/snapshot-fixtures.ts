import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { json, makeFixture } from "./helpers.ts";

export const commitA = "a".repeat(40);
export const commitB = "b".repeat(40);
export const licenseText = "MIT License\nCopyright (c) Synthetic Fixture Authors\nFixture notice, not upstream content.\n";

export async function put(root: string, relative: string, content: string | Uint8Array) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

export async function snapshotFixture() {
  const fixture = await makeFixture();
  const source = join(fixture.root, "source");
  const manifest = {
    name: "fixture-plugin", version: "0.1.0-fixture", license: "MIT",
    skills: ["./skills/engineering/kept", "./skills/productivity/manual", "./skills/engineering/removed"],
  };
  await json(join(source, ".claude-plugin/plugin.json"), manifest);
  await put(source, "LICENSE", licenseText);
  await put(source, "shared/guide.md", "Shared \r\nreference — exact bytes.\r\n");
  await put(source, "package.json", JSON.stringify({ scripts: { postinstall: "touch SHOULD_NEVER_RUN" } }));
  for (const name of ["kept", "removed", "excluded"]) {
    await put(source, `skills/engineering/${name}/SKILL.md`,
      `---\r\nname: ${name}\r\ndescription: >-\r\n  Fixture ${name}\r\n  description\r\n---\r\nOriginal ${name} bytes. [Shared](../../../shared/guide.md)\r\n`);
  }
  await put(source, "skills/productivity/manual/SKILL.md",
    '---\nname: "manual"\ndescription: "Explicit only"\ndisable-model-invocation: true\n---\nManual fixture body.\n');
  await put(source, "skills/engineering/kept/assets/icon.bin", new Uint8Array([0, 255, 128, 13, 10]));
  const script = await put(source, "skills/engineering/kept/scripts/helper.sh", "#!/bin/sh\nprintf fixture\n");
  await chmod(script, 0o755);
  await put(source, "skills/engineering/kept/nested/SKILL.md", "---\nname: nested-hidden\ndescription: Unselected nested fixture\n---\nNever discover.\n");
  return { ...fixture, source, manifest };
}

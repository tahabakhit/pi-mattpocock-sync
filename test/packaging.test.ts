import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("private candidate manifest has an exact runtime allowlist and no static upstream resources", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, "0.0.0");
  assert.deepEqual(manifest.os, ["linux", "darwin"]);
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.deepEqual(manifest.pi, { extensions: ["./src/extension.ts"], skills: [], prompts: [], themes: [] });
  assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*" });
  assert.equal(new Set(manifest.files).size, manifest.files.length);
  const files = new Set<string>(manifest.files);
  assert.ok(files.has("src/extension.ts") && files.has("LICENSE") && files.has("docs/usage.md"));
  for (const path of files) {
    assert.match(path, /^(?:src\/[a-z-]+\.ts|docs\/(?:usage|release)\.md|README\.md|LICENSE)$/);
    const content = await read(path);
    // Check static relative imports in the authored runtime modules. Actual
    // loading from the installed artifact is the stronger separate check.
    if (path.startsWith("src/")) for (const match of content.matchAll(/from ["']\.\/([^"']+)["']/g)) {
      assert.ok(files.has(`src/${match[1]}`), `runtime import omitted from artifact: ${match[1]}`);
    }
  }
  assert.ok(!Object.keys(manifest.dependencies).some(name => name.startsWith("@earendil-works/") || name.startsWith("@gotgenes/")));
});

test("CI matrix preserves read-only, no-publish Linux/macOS and minimum-Node gates", async () => {
  const text = await read(".github/workflows/verify.yml");
  const workflow = parse(text);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.verify.strategy.matrix, { os: ["ubuntu-latest", "macos-latest"], node: ["22.19.0", "26"] });
  const steps = workflow.jobs.verify.steps;
  assert.equal(steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))?.with["persist-credentials"], false);
  for (const command of ["npm ci --ignore-scripts", "npm run typecheck", "npm test", "npm run test:package", "git diff --check"]) {
    assert.ok(steps.some((step: { run?: string }) => step.run === command));
  }
  assert.equal(workflow.on.schedule, undefined);
  assert.doesNotMatch(text, /npm publish|secrets\.|pull_request_target|write-all/);
});
